import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { Item } from "../api/client";
import { IconLock } from "../components/Icons";
import JustifiedGrid from "../components/JustifiedGrid";
import Lightbox from "../components/Lightbox";
import Portal from "../components/Portal";
import { getLockedToken, lockedApi, lockedQS, setLockedToken } from "../lockedStore";

/** Backup codes, shown exactly once after setup or a passcode change. */
function BackupCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
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
        <button
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

  if (!status) return <div className="page" />;

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
