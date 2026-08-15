import { useEffect, useState } from "react";
import Portal from "../components/Portal";
import { useLocked, type LockedItem } from "./LockedContext";

/** Minimal lightbox for Locked Folder items. Photos render from the encrypted
 * webp preview via an Object URL (HEIC-safe, no browser caching); videos and
 * downloads use a per-item stream token that dies the moment the vault
 * relocks. */
export default function LockedViewer({ items, index, onClose, onStep, onRestore, onDelete }: {
  items: LockedItem[];
  index: number;
  onClose: () => void;
  onStep: (delta: number) => void;
  onRestore: (vaultId: string) => void;
  onDelete: (vaultId: string) => void;
}) {
  const { loadImage, mintStreamToken } = useLocked();
  const item = items[index];
  const [src, setSrc] = useState<string | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let dead = false;
    setSrc(null);
    setErr(false);
    if (item.media_type === "photo") {
      loadImage(`/api/locked/preview/${item.vault_id}`)
        .then((u) => !dead && setSrc(u))
        .catch(() => !dead && setErr(true));
    } else {
      mintStreamToken(item.vault_id)
        .then((st) => !dead && setSrc(`/api/locked/media/${item.vault_id}?st=${st}`))
        .catch(() => !dead && setErr(true));
    }
    return () => {
      dead = true;
    };
  }, [item.vault_id, item.media_type, loadImage, mintStreamToken]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft") onStep(-1);
      if (e.key === "ArrowRight") onStep(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onStep]);

  const download = async () => {
    try {
      const st = await mintStreamToken(item.vault_id);
      const a = document.createElement("a");
      a.href = `/api/locked/media/${item.vault_id}?st=${st}&download=1`;
      a.download = item.filename;
      a.click();
    } catch {
      /* session died — page flips to the lock screen */
    }
  };

  return (
    <Portal>
      <div className="lightbox locked-viewer" onClick={onClose}>
        <div className="lb-top" onClick={(e) => e.stopPropagation()}>
          <button className="icon-btn" title="Download" onClick={download}>⇩</button>
          <button className="icon-btn" title="Restore to library" onClick={() => onRestore(item.vault_id)}>⤴</button>
          <button className="icon-btn" title="Delete forever" onClick={() => onDelete(item.vault_id)}>🗑</button>
          <button className="icon-btn" title="Close" onClick={onClose}>✕</button>
        </div>
        <div className="lb-stage" onClick={(e) => e.stopPropagation()}>
          {err && <p className="muted">Could not load this item.</p>}
          {!err && item.media_type === "photo" && src && <img className="lb-media" src={src} alt="" />}
          {!err && item.media_type === "video" && src && (
            <video className="lb-media" src={src} controls autoPlay playsInline />
          )}
        </div>
        {index > 0 && (
          <button className="lb-btn prev" onClick={(e) => { e.stopPropagation(); onStep(-1); }}>‹</button>
        )}
        {index < items.length - 1 && (
          <button className="lb-btn next" onClick={(e) => { e.stopPropagation(); onStep(1); }}>›</button>
        )}
      </div>
    </Portal>
  );
}
