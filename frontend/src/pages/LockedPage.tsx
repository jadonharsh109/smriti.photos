import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { Item } from "../api/client";
import { IconLock } from "../components/Icons";
import JustifiedGrid from "../components/JustifiedGrid";
import Lightbox from "../components/Lightbox";
import Portal from "../components/Portal";
import { Loading } from "../components/Skeletons";
import { getLockedToken, lockedApi, lockedQS, setLockedToken } from "../lockedStore";

/** Backup codes, shown exactly once after setup or a passcode change. */
function BackupCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);

  /* A file, because the clipboard is the wrong place to leave the only copy of
     something shown once — the next thing you copy destroys it, and it is gone
     without ever having said so. In the desktop app the shell catches this and
     writes it to Downloads; in a browser it is an ordinary download. */
  const download = () => {
    const body = [
      "Smriti — backup codes for the Locked section",
      `Saved ${new Date().toLocaleString()}`,
      "",
      "Each code unlocks the Locked section once, if you forget your passcode.",
      "Keep this file somewhere only you can reach.",
      "",
      ...codes,
      "",
    ].join("\n");
    const url = URL.createObjectURL(new Blob([body], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "smriti-backup-codes.txt";
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    setSaved(true);
  };

  return (
    <div className="lock-card wide">
      <span className="lock-icon"><IconLock size={30} /></span>
      <h2>Save your backup codes</h2>
      <p className="muted">
        If you ever forget your passcode, one of these codes unlocks the section. Each works
        once. Store them somewhere safe — <strong>they are shown only now</strong>.
      </p>
      <div className="code-grid">
        {codes.map((c) => (
          <code key={c} className="code-chip">{c}</code>
        ))}
      </div>
      <div className="row" style={{ justifyContent: "center", marginTop: 18 }}>
        <button onClick={download}>{saved ? "✓ Downloaded" : "Download codes"}</button>
        <button
          className="ghost"
          onClick={() => {
            navigator.clipboard.writeText(codes.join("\n")).then(() => setCopied(true));
          }}
        >
          {copied ? "✓ Copied" : "Copy all"}
        </button>
        <button className="primary" onClick={onDone}>
          I saved them — continue
        </button>
      </div>
    </div>
  );
}

function SetupCard({ onComplete }: { onComplete: (codes: string[]) => void }) {
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();
  const mismatch = confirm.length > 0 && pw !== confirm;
  const ready = pw.length >= 4 && pw === confirm;

  const submit = async () => {
    if (!ready) return;
    try {
      const r = await lockedApi.setup(pw);
      setLockedToken(r.token);
      qc.invalidateQueries({ queryKey: ["locked"] });
      onComplete(r.backup_codes);
    } catch (e) {
      setError(String((e as Error).message));
    }
  };

  return (
    <div className="lock-card">
      <span className="lock-icon"><IconLock size={30} /></span>
      <h2>Set up Locked</h2>
      <p className="muted">
        Photos you move here disappear from Photos, Albums, People, Places, Map and Events
        until you unlock with your passcode.
      </p>
      <input
        type="password"
        className="lock-input"
        placeholder="Passcode (min 4 characters)"
        value={pw}
        autoFocus
        onChange={(e) => setPw(e.target.value)}
      />
      <input
        type="password"
        className="lock-input"
        placeholder="Confirm passcode"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
      />
      {mismatch && <p className="small" style={{ color: "var(--danger)" }}>Passcodes don't match</p>}
      {error && <p className="small" style={{ color: "var(--danger)" }}>{error}</p>}
      <button className="primary" disabled={!ready} onClick={submit} style={{ marginTop: 10 }}>
        Create Locked section
      </button>
    </div>
  );
}

function UnlockCard() {
  const [pw, setPw] = useState("");
  const [code, setCode] = useState("");
  const [useBackup, setUseBackup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usedBackup, setUsedBackup] = useState(false);
  const qc = useQueryClient();

  const submit = async () => {
    setError(null);
    try {
      if (useBackup) {
        const r = await lockedApi.unlockBackup(code);
        setLockedToken(r.token);
        setUsedBackup(true);
      } else {
        const r = await lockedApi.unlock(pw);
        setLockedToken(r.token);
      }
      qc.invalidateQueries({ queryKey: ["locked"] });
    } catch (e) {
      setError(String((e as Error).message));
    }
  };
  void usedBackup;

  return (
    <div className="lock-card">
      <span className="lock-icon"><IconLock size={30} /></span>
      <h2>Locked</h2>
      <p className="muted">{useBackup ? "Enter one of your backup codes." : "Enter your passcode to view."}</p>
      {useBackup ? (
        <input
          type="text"
          className="lock-input"
          placeholder="XXXX-XXXX"
          value={code}
          autoFocus
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
      ) : (
        <input
          type="password"
          className="lock-input"
          placeholder="Passcode"
          value={pw}
          autoFocus
          onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
      )}
      {error && <p className="small" style={{ color: "var(--danger)" }}>{error}</p>}
      <button className="primary" onClick={submit} style={{ marginTop: 10 }}>
        Unlock
      </button>
      <button className="ghost small" style={{ marginTop: 8 }} onClick={() => { setUseBackup((b) => !b); setError(null); }}>
        {useBackup ? "← Use passcode" : "Forgot passcode? Use a backup code"}
      </button>
    </div>
  );
}

function ChangePasscodeDialog({ onCodes, onClose }: { onCodes: (codes: string[]) => void; onClose: () => void }) {
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const ready = pw.length >= 4 && pw === confirm;
  const submit = async () => {
    if (!ready) return;
    try {
      const r = await lockedApi.changePassword(pw);
      onCodes(r.backup_codes);
      onClose();
    } catch (e) {
      setError(String((e as Error).message));
    }
  };
  return (
    <Portal>
      <div className="modal-back" onClick={onClose}>
        <div className="modal" style={{ width: 420 }} onClick={(e) => e.stopPropagation()}>
          <header>Change passcode</header>
          <div className="modal-body" style={{ padding: "12px 24px 6px", display: "grid", gap: 10 }}>
            <input type="password" autoFocus placeholder="New passcode (min 4 characters)" value={pw} onChange={(e) => setPw(e.target.value)} />
            <input type="password" placeholder="Confirm new passcode" value={confirm} onChange={(e) => setConfirm(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
            {confirm.length > 0 && pw !== confirm && <p className="small" style={{ color: "var(--danger)" }}>Passcodes don't match</p>}
            {error && <p className="small" style={{ color: "var(--danger)" }}>{error}</p>}
            <p className="muted small">Changing the passcode also issues a fresh set of backup codes.</p>
          </div>
          <footer>
            <button onClick={onClose}>Cancel</button>
            <button className="primary" disabled={!ready} onClick={submit}>Change passcode</button>
          </footer>
        </div>
      </div>
    </Portal>
  );
}

export default function LockedPage() {
  const qc = useQueryClient();
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1000);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);
  const [freshCodes, setFreshCodes] = useState<string[] | null>(null);
  const [changing, setChanging] = useState(false);

  const { data: status } = useQuery({
    queryKey: ["locked", "status", !!getLockedToken()],
    queryFn: () => lockedApi.status(),
    refetchInterval: 60_000, // notice server-side expiry
  });
  const unlocked = status?.unlocked && !!getLockedToken();

  /* Re-lock the moment the session expires.
     The timer only asks the server again — it never locks on its own say-so.
     `expires_in` is a snapshot, and using this section renews the idle clock
     without the page hearing about it, so a client-side countdown would throw
     somebody out mid-scroll. The server is the one that knows. */
  const expiresIn = status?.expires_in;
  useEffect(() => {
    if (!unlocked || expiresIn == null) return;
    const t = window.setTimeout(
      () => qc.invalidateQueries({ queryKey: ["locked", "status"] }),
      Math.max(0, expiresIn) * 1000 + 750
    );
    return () => window.clearTimeout(t);
  }, [unlocked, expiresIn, qc]);

  /* The server has locked us out — drop the token rather than keep sending a
     dead one on every thumbnail URL. */
  useEffect(() => {
    if (status && !status.unlocked && getLockedToken()) {
      setLockedToken(null);
      setSelected(new Set());
      setLightboxIdx(null);
      qc.invalidateQueries({ queryKey: ["locked"] });
    }
  }, [status, qc]);

  const { data: items } = useQuery({
    queryKey: ["locked", "items"],
    queryFn: () => lockedApi.items(),
    enabled: !!unlocked,
  });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [unlocked]);

  const unhide = useMutation({
    mutationFn: (ids: number[]) => lockedApi.removeItems(ids),
    onSuccess: () => {
      setSelected(new Set());
      qc.invalidateQueries(); // items reappear everywhere
    },
  });

  const lockNow = async () => {
    await lockedApi.lock();
    setLockedToken(null);
    setSelected(new Set());
    setLightboxIdx(null);
    qc.invalidateQueries({ queryKey: ["locked"] });
  };

  if (freshCodes) {
    return (
      <div className="page lock-center">
        <BackupCodes codes={freshCodes} onDone={() => setFreshCodes(null)} />
      </div>
    );
  }

  // Blank reads as broken, and this is the one page where a blank screen also
  // looks like it might be hiding something.
  if (!status)
    return (
      <div className="page lock-center">
        <Loading label="Checking the lock…" />
      </div>
    );

  if (!status.configured) {
    return (
      <div className="page lock-center">
        <SetupCard onComplete={(codes) => setFreshCodes(codes)} />
      </div>
    );
  }

  if (!unlocked) {
    return (
      <div className="page lock-center">
        <UnlockCard />
      </div>
    );
  }

  const list = items ?? [];
  return (
    <div className="page" ref={containerRef}>
      <header className="page-head">
        <div>
          <h1>Locked</h1>
          <p className="sub">
            {status.count ?? list.length} hidden {(status.count ?? list.length) === 1 ? "item" : "items"} ·{" "}
            {status.codes_remaining ?? 0} backup codes left
          </p>
        </div>
        <div className="actions">
          {selected.size > 0 && (
            <button onClick={() => unhide.mutate([...selected])}>
              Unhide {selected.size} — back to library
            </button>
          )}
          <button onClick={() => setChanging(true)}>Change passcode</button>
          <button className="primary" onClick={lockNow}>
            <span style={{ display: "inline-flex", verticalAlign: "-3px", marginRight: 6 }}><IconLock size={16} /></span>
            Lock now
          </button>
        </div>
      </header>
      {list.length === 0 ? (
        <div className="empty">
          <span className="lock-icon big"><IconLock size={44} /></span>
          <p>
            Nothing hidden yet. Select photos anywhere in your library and choose{" "}
            <strong>Hide in Locked</strong>.
          </p>
        </div>
      ) : (
        <JustifiedGrid
          items={list}
          width={width - 40}
          thumbQS={lockedQS()}
          onOpen={setLightboxIdx}
          selected={selected}
          onToggleSelect={(fid) =>
            setSelected((prev) => {
              const next = new Set(prev);
              if (next.has(fid)) next.delete(fid);
              else next.add(fid);
              return next;
            })
          }
        />
      )}
      {lightboxIdx != null && list[lightboxIdx] && (
        <Lightbox
          item={list[lightboxIdx] as Item}
          qs={lockedQS()}
          onClose={() => setLightboxIdx(null)}
          onPrev={lightboxIdx > 0 ? () => setLightboxIdx(lightboxIdx - 1) : undefined}
          onNext={lightboxIdx < list.length - 1 ? () => setLightboxIdx(lightboxIdx + 1) : undefined}
        />
      )}
      {changing && <ChangePasscodeDialog onCodes={setFreshCodes} onClose={() => setChanging(false)} />}
    </div>
  );
}
