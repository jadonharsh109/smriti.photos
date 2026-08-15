import { useEffect, useState } from "react";
import Portal from "./Portal";

/** Glass sheet replacements for window.prompt / window.confirm. */

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
    <div className="modal-back" onClick={onClose}>
      <div className="modal" style={{ width: 420 }} onClick={(e) => e.stopPropagation()}>
        <header>{title}</header>
        <div className="modal-body" style={{ padding: "12px 24px 6px" }}>
          <input
            type="text"
            autoFocus
            style={{ width: "100%" }}
            placeholder={placeholder}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </div>
        <footer>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!value.trim()} onClick={submit}>
            {submitLabel}
          </button>
        </footer>
      </div>
    </div>
    </Portal>
  );
}

export function PasswordDialog({
  title,
  body,
  placeholder = "PIN or passphrase",
  submitLabel = "Unlock",
  minLength = 6,
  onSubmit,
  onClose,
}: {
  title: string;
  body?: string;
  placeholder?: string;
  submitLabel?: string;
  minLength?: number;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState("");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = () => {
    if (value.length >= minLength) onSubmit(value);
  };

  return (
    <Portal>
    <div className="modal-back" onClick={onClose}>
      <div className="modal" style={{ width: 420 }} onClick={(e) => e.stopPropagation()}>
        <header>{title}</header>
        <div className="modal-body" style={{ padding: "12px 24px 6px" }}>
          {body && <p className="muted small" style={{ marginBottom: 10 }}>{body}</p>}
          <input
            type="password"
            autoFocus
            autoComplete="off"
            style={{ width: "100%" }}
            placeholder={placeholder}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </div>
        <footer>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={value.length < minLength} onClick={submit}>
            {submitLabel}
          </button>
        </footer>
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
  body?: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <Portal>
    <div className="modal-back" onClick={onClose}>
      <div className="modal" style={{ width: 420 }} onClick={(e) => e.stopPropagation()}>
        <header>{title}</header>
        {body && (
          <div className="modal-body muted" style={{ padding: "6px 24px 10px" }}>
            {body}
          </div>
        )}
        <footer>
          <button onClick={onClose}>Cancel</button>
          <button className={danger ? "danger" : "primary"} onClick={() => { onConfirm(); onClose(); }}>
            {confirmLabel}
          </button>
        </footer>
      </div>
    </div>
    </Portal>
  );
}
