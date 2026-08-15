"""Face pool worker: loads the ONNX models once per process (~300 MB), then
detects + embeds per photo. Never touches the DB."""
_engine = None


def pool_init(model_dir: str, det_size: int, det_thresh: float) -> None:
    global _engine
    from pillow_heif import register_heif_opener

    register_heif_opener()
    from ..services.face_engine import FaceEngine

    _engine = FaceEngine(model_dir, det_size, det_thresh)


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
                "faces": [{**f, "embedding": f["embedding"].tobytes()} for f in faces]}
    except Exception as e:
        return {"file_id": file_id, "ok": False, "error": f"{type(e).__name__}: {e}"}
