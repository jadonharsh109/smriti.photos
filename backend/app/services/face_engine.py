"""Face detection + embedding via raw onnxruntime on the InsightFace buffalo_l
models (det_10g.onnx SCRFD detector, w600k_r50.onnx ArcFace). Implemented
directly so we don't depend on the insightface package building on py3.12/arm64.
CPU execution provider on purpose — SCRFD is known-flaky on the CoreML EP.
Import-safe for pool workers: no db access."""
import numpy as np

# Canonical 5-point template for ArcFace 112x112 alignment
ARCFACE_DST = np.array(
    [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366],
     [41.5493, 92.3655], [70.7299, 92.2041]], dtype=np.float32)


class FaceEngine:
    def __init__(self, model_dir: str, det_size: int = 640, det_thresh: float = 0.5):
        import onnxruntime as ort

        opts = ort.SessionOptions()
        opts.intra_op_num_threads = 2  # several pool workers share the CPU
        providers = ["CPUExecutionProvider"]
        self.det = ort.InferenceSession(f"{model_dir}/det_10g.onnx", opts, providers=providers)
        self.rec = ort.InferenceSession(f"{model_dir}/w600k_r50.onnx", opts, providers=providers)
        self.det_input = self.det.get_inputs()[0].name
        self.rec_input = self.rec.get_inputs()[0].name
        self.det_size = det_size
        self.det_thresh = det_thresh
        self._centers: dict[int, np.ndarray] = {}

    # -- public --------------------------------------------------------------
    def process(self, pil_img) -> list[dict]:
        """-> [{x,y,w,h (normalized 0..1), score, embedding (512 float32)}]"""
        rgb = np.asarray(pil_img, dtype=np.uint8)
        H, W = rgb.shape[:2]
        dets = self._detect(rgb)
        out = []
        for bbox, kps, score in dets:
            emb = self._embed(pil_img, kps)
            x1, y1, x2, y2 = (float(v) for v in bbox)
            # plain Python floats — np.float32 would bind to SQLite as a BLOB
            out.append({
                "x": max(0.0, x1 / W), "y": max(0.0, y1 / H),
                "w": min(1.0, (x2 - x1) / W), "h": min(1.0, (y2 - y1) / H),
                "score": float(score),
                "embedding": emb,
            })
        return out

    # -- detection (SCRFD) ---------------------------------------------------
    def _detect(self, rgb: np.ndarray):
        size = self.det_size
        H, W = rgb.shape[:2]
        scale = size / max(H, W)
        new_h, new_w = int(round(H * scale)), int(round(W * scale))
        from PIL import Image

        resized = np.asarray(Image.fromarray(rgb).resize((new_w, new_h), Image.BILINEAR))
        canvas = np.zeros((size, size, 3), dtype=np.uint8)
        canvas[:new_h, :new_w] = resized

        blob = ((canvas.astype(np.float32) - 127.5) / 128.0).transpose(2, 0, 1)[None]
        outs = self.det.run(None, {self.det_input: blob})

        strides = (8, 16, 32)
        scores_all, boxes_all, kps_all = [], [], []
        for i, stride in enumerate(strides):
            scores = outs[i].reshape(-1)
            bbox = outs[i + 3].reshape(-1, 4) * stride
            kps = outs[i + 6].reshape(-1, 10) * stride
            centers = self._anchor_centers(size // stride, stride)
            keep = scores >= self.det_thresh
            if not keep.any():
                continue
            c = centers[keep]
            b = bbox[keep]
            boxes = np.stack([c[:, 0] - b[:, 0], c[:, 1] - b[:, 1],
                              c[:, 0] + b[:, 2], c[:, 1] + b[:, 3]], axis=1)
            k = kps[keep].reshape(-1, 5, 2) + c[:, None, :]
            scores_all.append(scores[keep])
            boxes_all.append(boxes)
            kps_all.append(k)
        if not scores_all:
            return []
        scores = np.concatenate(scores_all)
        boxes = np.concatenate(boxes_all) / scale
        kps = np.concatenate(kps_all) / scale
        keep = _nms(boxes, scores, 0.4)
        return [(boxes[i], kps[i], scores[i]) for i in keep]

    def _anchor_centers(self, fm: int, stride: int) -> np.ndarray:
        key = fm * 1000 + stride
        if key not in self._centers:
            xs, ys = np.meshgrid(np.arange(fm), np.arange(fm))
            centers = np.stack([xs, ys], axis=-1).astype(np.float32).reshape(-1, 2) * stride
            self._centers[key] = np.repeat(centers, 2, axis=0)  # 2 anchors per cell
        return self._centers[key]

    # -- embedding (ArcFace) -------------------------------------------------
    def _embed(self, pil_img, kps: np.ndarray) -> np.ndarray:
        from PIL import Image

        T = _similarity_transform(kps.astype(np.float32), ARCFACE_DST)
        Tinv = np.linalg.inv(T)
        aligned = pil_img.transform(
            (112, 112), Image.AFFINE,
            (Tinv[0, 0], Tinv[0, 1], Tinv[0, 2], Tinv[1, 0], Tinv[1, 1], Tinv[1, 2]),
            resample=Image.BILINEAR,
        )
        arr = np.asarray(aligned, dtype=np.float32)
        blob = ((arr - 127.5) / 127.5).transpose(2, 0, 1)[None]
        emb = self.rec.run(None, {self.rec_input: blob})[0].reshape(-1).astype(np.float32)
        n = np.linalg.norm(emb)
        return emb / n if n > 0 else emb


def _similarity_transform(src: np.ndarray, dst: np.ndarray) -> np.ndarray:
    """Umeyama similarity transform (2D): returns 3x3 matrix mapping src -> dst."""
    n = src.shape[0]
    src_mean, dst_mean = src.mean(0), dst.mean(0)
    src_d, dst_d = src - src_mean, dst - dst_mean
    A = dst_d.T @ src_d / n
    d = np.ones(2, dtype=np.float64)
    if np.linalg.det(A) < 0:
        d[1] = -1
    U, S, Vt = np.linalg.svd(A)
    R = U @ np.diag(d) @ Vt
    var_src = src_d.var(axis=0).sum()
    scale = (S * d).sum() / var_src if var_src > 0 else 1.0
    T = np.eye(3)
    T[:2, :2] = scale * R
    T[:2, 2] = dst_mean - scale * R @ src_mean
    return T


def _nms(boxes: np.ndarray, scores: np.ndarray, iou_thresh: float) -> list[int]:
    order = scores.argsort()[::-1]
    x1, y1, x2, y2 = boxes[:, 0], boxes[:, 1], boxes[:, 2], boxes[:, 3]
    areas = np.maximum(0, x2 - x1) * np.maximum(0, y2 - y1)
    keep = []
    while order.size > 0:
        i = order[0]
        keep.append(int(i))
        if order.size == 1:
            break
        rest = order[1:]
        xx1 = np.maximum(x1[i], x1[rest])
        yy1 = np.maximum(y1[i], y1[rest])
        xx2 = np.minimum(x2[i], x2[rest])
        yy2 = np.minimum(y2[i], y2[rest])
        inter = np.maximum(0, xx2 - xx1) * np.maximum(0, yy2 - yy1)
        iou = inter / (areas[i] + areas[rest] - inter + 1e-9)
        order = rest[iou <= iou_thresh]
    return keep
