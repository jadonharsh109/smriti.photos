import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, fmtDuration } from "../api/client";
import { ConfirmDialog } from "../components/Dialogs";
import { IconLock } from "../components/Icons";
import { ArtShield } from "../components/Illustrations";
import Portal from "../components/Portal";
import { useLocked, type LockedItem, type LockedStatus } from "../locked/LockedContext";
import LockedViewer from "../locked/LockedViewer";

function LockedThumb({ item, onClick, selected, onToggleSelect }: {
  item: LockedItem;
  onClick: () => void;
  selected: boolean;
  onToggleSelect: () => void;
}) {
  const { loadImage } = useLocked();
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let dead = false;
    loadImage(`/api/locked/thumb/${item.vault_id}`)
      .then((u) => !dead && setSrc(u))
      .catch(() => !dead && setFailed(true));
    return () => {
      dead = true;
    };
  }, [item.vault_id, loadImage]);
  return (
    <button className={`locked-tile${selected ? " sel" : ""}`} onClick={onClick} title={item.filename}>
      {src ? (
        <img src={src} alt="" draggable={false} />
      ) : (
        <span className="locked-tile-ph">{failed ? item.filename.split(".").pop()?.toUpperCase() : ""}</span>
      )}
      {item.media_type === "video" && (
        <span className="locked-badge">{item.duration_s ? fmtDuration(item.duration_s) : "video"}</span>
      )}
      <span
        className={`check${selected ? " on" : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          onToggleSelect();
        }}
      />
    </button>
  );
}

function PinForm({ label, busy, onSubmit }: {
  label: string;
  busy: boolean;
  onSubmit: (pin: string) => void;
}) {
  const [pin, setPin] = useState("");
  return (
    <form
      className="locked-pin-row"
      onSubmit={(e) => {
        e.preventDefault();
        if (pin.length >= 6) onSubmit(pin);
      }}
    >
      <input
        type="password"
        autoFocus
        autoComplete="off"
        placeholder="PIN or passphrase"
        value={pin}
        onChange={(e) => setPin(e.target.value)}
      />
      <button className="primary" disabled={busy || pin.length < 6} type="submit">
        {label}
      </button>
    </form>
  );
}

export default function LockedPage() {
  const locked = useLocked();
  const { token } = locked;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmPin, setConfirmPin] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [viewing, setViewing] = useState<number | null>(null);
  const [confirming, setConfirming] = useState<"restore" | "delete" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const { data: status } = useQuery({
    queryKey: ["locked", "status"],
    queryFn: () => api.get<LockedStatus>("/api/locked/status"),
    staleTime: 5_000,
  });
  const { data: items, refetch } = useQuery({
    queryKey: ["locked", "items"],
    queryFn: () => locked.authedJson<LockedItem[]>("GET", "/api/locked/items"),
    enabled: !!token,
    staleTime: 0,
    gcTime: 0,
  });

  const run = async (fn: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  // ---- not yet configured: first-time setup ----
  if (status && !status.configured) {
    return (
      <div className="page">
        <header className="page-head">
          <div>
            <h1>Locked Folder</h1>
            <p className="sub">A private, encrypted space — photos in it exist nowhere else in the app.</p>
          </div>
        </header>
        <div className="empty">
          <ArtShield className="art" />
          <p>
            Set a PIN or passphrase to create your Locked Folder. Moved photos are encrypted and removed
            from your photo folders. <strong>If you forget it, they are gone forever</strong> — longer is stronger.
          </p>
          <div className="cta locked-setup">
            <PinForm label="Continue" busy={busy} onSubmit={(pin) => setConfirmPin(pin)} />
            {error && <p className="small" style={{ color: "var(--danger)" }}>{error}</p>}
          </div>
        </div>
        {confirmPin && (
          <ConfirmDialog
            title="Create Locked Folder?"
            body="Remember this PIN — there is no recovery. Anything you lock is encrypted with it."
            confirmLabel="Create"
            onConfirm={() => run(() => locked.setupPin(confirmPin))}
            onClose={() => setConfirmPin("")}
          />
        )}
      </div>
    );
  }

  // ---- configured but locked: unlock screen ----
  if (!token) {
    return (
      <div className="page">
        <header className="page-head">
          <div>
            <h1>Locked Folder</h1>
            <p className="sub">Unlock to view your private photos and videos.</p>
          </div>
        </header>
        <div className="empty">
          <div className="locked-glyph">
            <IconLock size={44} />
          </div>
          {status?.damaged ? (
            <p style={{ color: "var(--danger)" }}>
              The vault metadata could not be read. Nothing was deleted — check the data directory backup.
            </p>
          ) : (
            <>
              {status && status.lockout_seconds > 0 ? (
                <p>Too many attempts — try again in about {Math.ceil(status.lockout_seconds / 60)} min.</p>
              ) : (
                <div className="cta locked-setup">
                  <PinForm label="Unlock" busy={busy} onSubmit={(pin) => run(() => locked.unlockPin(pin))} />
                  {status?.webauthn_enrolled && locked.touchIdAvailable && (
                    <button className="ghost" disabled={busy} onClick={() => run(locked.unlockTouchId)}>
                      Unlock with Touch ID
                    </button>
                  )}
                  {status?.webauthn_enrolled && !locked.touchIdAvailable && (
                    <p className="muted small">Touch ID needs the app open at http://localhost</p>
                  )}
                </div>
              )}
              {error && <p className="small" style={{ color: "var(--danger)" }}>{error}</p>}
            </>
          )}
        </div>
      </div>
    );
  }

  // ---- unlocked ----
  const list = items ?? [];
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const bulk = async (kind: "restore" | "delete") => {
    const ids = [...selected];
    setNotice(null);
    try {
      if (kind === "restore") {
        const r = await locked.authedJson<{ restored: number; skipped_offline: number; outside_library: number }>(
          "POST", "/api/locked/restore", { vault_ids: ids });
        let msg = `${r.restored} restored to their original folders`;
        if (r.skipped_offline) msg += ` · ${r.skipped_offline} skipped (drive offline)`;
        if (r.outside_library) msg += ` · ${r.outside_library} outside your library folders`;
        setNotice(msg);
      } else {
        const r = await locked.authedJson<{ deleted: number }>("POST", "/api/locked/delete", { vault_ids: ids });
        setNotice(`${r.deleted} permanently deleted`);
      }
    } catch (e) {
      setNotice(String((e as Error).message ?? e));
    }
    setSelected(new Set());
    setViewing(null);
    refetch();
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Locked Folder</h1>
          <p className="sub">
            {list.length} {list.length === 1 ? "item" : "items"} · encrypted · relocks automatically
          </p>
        </div>
        <div className="actions">
          <button onClick={() => locked.lock()}>
            <IconLock size={16} /> Lock now
          </button>
        </div>
      </header>
      {notice && <p className="sub" style={{ marginTop: -6 }}>{notice}</p>}
      {list.length === 0 ? (
        <div className="empty">
          <ArtShield className="art" />
          <p>Nothing here yet. Select photos anywhere in the library and choose "Move to Locked".</p>
        </div>
      ) : (
        <div className="locked-grid">
          {list.map((it, i) => (
            <LockedThumb
              key={it.vault_id}
              item={it}
              selected={selected.has(it.vault_id)}
              onToggleSelect={() => toggle(it.vault_id)}
              onClick={() => (selected.size > 0 ? toggle(it.vault_id) : setViewing(i))}
            />
          ))}
        </div>
      )}
      {selected.size > 0 && (
        <Portal>
          <div className="selbar">
            <strong>{selected.size} selected</strong>
            <button onClick={() => setConfirming("restore")}>Restore to library</button>
            <button className="danger" onClick={() => setConfirming("delete")}>
              Delete forever
            </button>
            <button className="ghost" onClick={() => setSelected(new Set())}>
              Clear
            </button>
          </div>
        </Portal>
      )}
      {confirming === "restore" && (
        <ConfirmDialog
          title={`Restore ${selected.size} ${selected.size === 1 ? "item" : "items"}?`}
          body="Files are decrypted and moved back to their original folders, then re-indexed into the library."
          confirmLabel="Restore"
          onConfirm={() => bulk("restore")}
          onClose={() => setConfirming(null)}
        />
      )}
      {confirming === "delete" && (
        <ConfirmDialog
          title={`Permanently delete ${selected.size} ${selected.size === 1 ? "item" : "items"}?`}
          body="This deletes the encrypted originals. It cannot be undone — they are not in the Trash."
          confirmLabel="Delete forever"
          danger
          onConfirm={() => bulk("delete")}
          onClose={() => setConfirming(null)}
        />
      )}
      {viewing !== null && list[viewing] && (
        <LockedViewer
          items={list}
          index={viewing}
          onClose={() => setViewing(null)}
          onStep={(d) => setViewing((v) => Math.max(0, Math.min(list.length - 1, (v ?? 0) + d)))}
          onRestore={(id) => {
            setSelected(new Set([id]));
            setConfirming("restore");
          }}
          onDelete={(id) => {
            setSelected(new Set([id]));
            setConfirming("delete");
          }}
        />
      )}
    </div>
  );
}
