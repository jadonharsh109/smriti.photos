import { useEffect, useState } from "react";
import Portal from "./Portal";

/** Sheets in place of window.prompt / window.confirm. */

export function TextDialog({
  title,
  placeholder = "",
  initial = "",
  submitLabel = "Save",
  onSubmit,
  onClose,
}: {
  title: string;
  placeholder?: string;
  initial?: string;
  submitLabel?: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = () => {
    const v = value.trim();
    if (v) onSubmit(v);
  };

  return (
    <Portal>
      <div className="scrim" onClick={onClose}>
        <div className="sheet" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
          <header>{title}</header>
          <div className="sbody">
            <input
              className="input"
              type="text"
              autoFocus
              placeholder={placeholder}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
          </div>
          <div className="sfoot">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={!value.trim()} onClick={submit}>{submitLabel}</button>
          </div>
        </div>
      </div>
    </Portal>
  );
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel = "Confirm",
  danger = false,
  onConfirm,
  onClose,
}: {
  title: string;
  body?: React.ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      // the confirm is the primary action; return runs it, like a native alert
      if (e.key === "Enter" && !busy) {
        e.preventDefault();
        go();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, busy]);

  const go = async () => {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
      onClose();
    }
  };

  return (
    <Portal>
      <div className="scrim" onClick={onClose}>
        <div className="sheet" role="alertdialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
          <header>{title}</header>
          {body && <div className="sbody">{typeof body === "string" ? <p>{body}</p> : body}</div>}
          <div className="sfoot">
            <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
            <button className={`btn ${danger ? "danger" : "primary"}`} onClick={go} disabled={busy}>
              {busy ? "Working…" : confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
