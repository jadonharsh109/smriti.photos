"""CLIP pool worker: loads the vision tower once per process (~45 MB), then
embeds one image per call. Never touches the DB."""
_engine = None


def pool_init(model_dir: str) -> None:
    global _engine
    from pillow_heif import register_heif_opener

    register_heif_opener()
    from ..services.clip_engine import ClipEngine

    _engine = ClipEngine(model_dir)
    _engine.vision  # pay the session load here, not on the first photo


def process(file_id: int, path: str) -> dict:
    try:
        from PIL import Image

        img = Image.open(path)
        img.load()
        return {"file_id": file_id, "ok": True,
                "embedding": _engine.encode_image(img).tobytes()}
    except Exception as e:
        return {"file_id": file_id, "ok": False, "error": f"{type(e).__name__}: {e}"}
