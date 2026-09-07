"""Face pool worker: loads the ONNX models once per process (~300 MB), then
detects + embeds per photo. Never touches the DB.

Also cuts the crop the People page shows for each face, from the image it
has just decoded. Doing it here rather than on first request is what stops
opening People from decoding one full-size original per person on the
request thread."""
import io

_engine = None


def pool_init(model_dir: str, det_size: int, det_thresh: float) -> None:
    global _engine
    from pillow_heif import register_heif_opener

    register_heif_opener()
    from ..services.face_engine import FaceEngine

    _engine = FaceEngine(model_dir, det_size, det_thresh)


def _crop_webp(img, f: dict) -> bytes | None:
    from .. import config
    from ..services.thumbs import face_crop_image

    crop = face_crop_image(img, f["x"], f["y"], f["w"], f["h"])
    if crop is None:
        return None
    buf = io.BytesIO()
    crop.save(buf, "WEBP", quality=config.FACE_CROP_WEBP_QUALITY, method=4)
    return buf.getvalue()


def process(file_id: int, path: str) -> dict:
    try:
        from PIL import Image, ImageOps

        img = Image.open(path)
        img.load()
        img = ImageOps.exif_transpose(img)
        if img.mode != "RGB":
            img = img.convert("RGB")
        # Detection quality saturates around ~2000px; downscale monsters first
        if max(img.size) > 2200:
            img.thumbnail((2200, 2200))
        faces = _engine.process(img)
        return {"file_id": file_id, "ok": True,
                "faces": [{**f, "embedding": f["embedding"].tobytes(), "crop": _crop_webp(img, f)}
                          for f in faces]}
    except Exception as e:
        return {"file_id": file_id, "ok": False, "error": f"{type(e).__name__}: {e}"}
