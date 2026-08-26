"""One-time download of the MobileCLIP-S0 ONNX models (~218 MB) into the data
dir, for semantic search. Like the face pack, this is a deliberate one-off
network call — everything at runtime is offline, including every query.

Three plain files rather than the face pack's single zip: a vision tower that
runs once per photo, a text tower that runs once per search, and the tokenizer
vocabulary the text tower's input is built from.
"""
import urllib.request
from pathlib import Path

from . import config

_BASE = "https://huggingface.co/Xenova/mobileclip_s0/resolve/main"

# name on disk -> (url, approximate MB, what it is)
FILES = {
    "vision_model.onnx": (f"{_BASE}/onnx/vision_model.onnx", 46, "image encoder"),
    "text_model.onnx": (f"{_BASE}/onnx/text_model.onnx", 170, "text encoder"),
    "tokenizer.json": (f"{_BASE}/tokenizer.json", 3, "tokenizer"),
}
NEEDED = tuple(FILES)
TOTAL_MB = sum(mb for _, mb, _ in FILES.values())


def present(model_dir: Path | None = None) -> bool:
    d = model_dir or config.CLIP_MODEL_DIR
    return all((d / n).exists() for n in NEEDED)


def download() -> None:
    dest = config.CLIP_MODEL_DIR
    dest.mkdir(parents=True, exist_ok=True)
    if present(dest):
        print(f"CLIP models already present in {dest}")
        return
    for name, (url, mb, what) in FILES.items():
        if (dest / name).exists():
            continue
        print(f"downloading {what} (~{mb} MB) …")

        def hook(blocks, bs, total):
            done = blocks * bs
            if total > 0:
                pct = min(100, done * 100 // total)
                print(f"\r  {done // 1048576} MB / {total // 1048576} MB ({pct}%)", end="", flush=True)

        # .part first: a truncated .onnx that looks complete is worse than an
        # absent one, because nothing re-downloads it and onnxruntime's failure
        # is a protobuf parse error that says nothing about the cause.
        tmp = dest / f"{name}.part"
        urllib.request.urlretrieve(url, tmp, reporthook=hook)
        tmp.replace(dest / name)
        print()
    print(f"done — CLIP models in {dest}")
