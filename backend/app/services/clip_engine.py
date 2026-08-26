"""MobileCLIP-S0 image and text encoders, via raw onnxruntime.

Both towers project into one shared 512-dimensional space, which is the whole
trick: a sentence and a photograph become comparable, and "two people on a
beach" can be ranked against a library that was never tagged. Everything runs
here, on this machine — the query never leaves it, which is the only way a
photo library gets to have search at all without also having a server.

Import-safe for pool workers: no db access. The two towers load independently,
so the scan (image only) never pays for the text tower, and a search never
pays for the vision one.
"""
import numpy as np

from .. import config


def _session(path: str):
    import onnxruntime as ort

    opts = ort.SessionOptions()
    opts.intra_op_num_threads = 2  # several pool workers share the CPU
    # CPU on purpose, as with the face models: CoreML's gains do not survive
    # the per-call conversion at this model size, and its fp16 accumulation
    # moves embeddings enough to reorder near-ties in a result page.
    return ort.InferenceSession(path, opts, providers=["CPUExecutionProvider"])


def _l2(v: np.ndarray) -> np.ndarray:
    """Unit-length, so a dot product is a cosine and scores are comparable."""
    n = np.linalg.norm(v, axis=-1, keepdims=True)
    return np.divide(v, n, out=np.zeros_like(v), where=n > 0)


class ClipEngine:
    def __init__(self, model_dir: str):
        self.model_dir = str(model_dir)
        self._vision = None
        self._text = None
        self._tok = None

    # -- images --------------------------------------------------------------
    @property
    def vision(self):
        if self._vision is None:
            self._vision = _session(f"{self.model_dir}/vision_model.onnx")
        return self._vision

    def preprocess(self, pil_img) -> np.ndarray:
        """-> (1, 3, S, S) float32 in 0..1.

        Short edge to S, centre crop, and *no* mean/std step. MobileCLIP's
        preprocessor sets do_normalize: false — applying CLIP's usual
        normalisation here is the kind of mistake that costs most of the
        accuracy while every test still passes."""
        from PIL import Image, ImageOps

        img = ImageOps.exif_transpose(pil_img)
        if img.mode != "RGB":
            img = img.convert("RGB")
        S = config.CLIP_IMAGE_SIZE
        w, h = img.size
        scale = S / min(w, h)
        img = img.resize((max(S, round(w * scale)), max(S, round(h * scale))), Image.BILINEAR)
        w, h = img.size
        left, top = (w - S) // 2, (h - S) // 2
        img = img.crop((left, top, left + S, top + S))
        arr = np.asarray(img, dtype=np.float32) / 255.0
        return arr.transpose(2, 0, 1)[None]

    def encode_image(self, pil_img) -> np.ndarray:
        """-> (512,) float32, unit length."""
        blob = self.preprocess(pil_img)
        out = self.vision.run(None, {"pixel_values": blob})[0]
        return _l2(out.reshape(-1).astype(np.float32))

    # -- text ----------------------------------------------------------------
    @property
    def text(self):
        if self._text is None:
            self._text = _session(f"{self.model_dir}/text_model.onnx")
        return self._text

    @property
    def tokenizer(self):
        if self._tok is None:
            from .clip_tokenizer import ClipTokenizer

            self._tok = ClipTokenizer(f"{self.model_dir}/tokenizer.json", config.CLIP_CONTEXT_LEN)
        return self._tok

    def encode_text(self, texts: str | list[str]) -> np.ndarray:
        """-> (N, 512) float32, unit length. Batched: prompt ensembling asks
        the same question several ways and averages, which is how CLIP is meant
        to be queried."""
        if isinstance(texts, str):
            texts = [texts]
        ids = np.array([self.tokenizer.encode(t) for t in texts], dtype=np.int64)
        out = self.text.run(None, {"input_ids": ids})[0]
        return _l2(out.astype(np.float32))
