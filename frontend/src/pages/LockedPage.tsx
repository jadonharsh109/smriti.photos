import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import FlatGrid from "../components/FlatGrid";
import { IconLock, IconMore } from "../components/Icons";
import Portal from "../components/Portal";
import { getLockedToken, lockedApi, lockedQS, setLockedToken, useLockedSession, useLockedToken } from "../lockedStore";
import { openContextMenu } from "../shell/ContextMenu";
import { GridControls } from "../shell/GridToolbar";
import { selection, selectionActions } from "../shell/store";
import { SelectionActions, TbButton, Toolbar } from "../shell/Toolbar";

/** Backup codes, shown exactly once after setup or a passcode change. */
function BackupCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
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
    <div className="lock-card" style={{ width: 440 }}>
      <span className="icon"><IconLock /></span>
      <h2>Save your backup codes</h2>
      <p className="muted small">
        If you ever forget your passcode, one of these codes unlocks the section. Each works once. Store them somewhere safe — <strong>they are shown only now</strong>.
      </p>
      <div className="code-grid">
        {codes.map((c) => (
          <code key={c} className="code-chip">{c}</code>
        ))}
      </div>
      <div className="row" style={{ justifyContent: "center", marginTop: 6 }}>
        <button className="btn" onClick={download}>{saved ? "✓ Downloaded" : "Download"}</button>
        <button className="btn" onClick={() => navigator.clipboard.writeText(codes.join("\n")).then(() => setCopied(true))}>{copied ? "✓ Copied" : "Copy All"}</button>
        <button className="btn primary" onClick={onDone}>I Saved Them</button>
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
      <span className="icon"><IconLock /></span>
      <h2>Set up Locked</h2>
      <p className="muted small">Photos you hide here disappear from every other view until you unlock with your passcode.</p>
      <input type="password" className="input" placeholder="Passcode (at least 4 characters)" value={pw} autoFocus onChange={(e) => setPw(e.target.value)} />
      <input type="password" className="input" placeholder="Confirm passcode" value={confirm} onChange={(e) => setConfirm(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
      {mismatch && <p className="note bad">Passcodes don’t match</p>}
      {error && <p className="note bad">{error}</p>}
      <button className="btn primary" disabled={!ready} onClick={submit} style={{ justifySelf: "center", marginTop: 4 }}>Create Locked Section</button>
    </div>
  );
}

function UnlockCard() {
  const [pw, setPw] = useState("");
  const [code, setCode] = useState("");
  const [useBackup, setUseBackup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();
  const submit = async () => {
    setError(null);
    try {
      const r = useBackup ? await lockedApi.unlockBackup(code) : await lockedApi.unlock(pw);
      setLockedToken(r.token);
      qc.invalidateQueries({ queryKey: ["locked"] });
    } catch (e) {
      setError(String((e as Error).message));
    }
  };
  return (
    <div className="lock-card">
      <span className="icon"><IconLock /></span>
      <h2>Locked</h2>
      <p className="muted small">{useBackup ? "Enter one of your backup codes." : "Enter your passcode to view."}</p>
      {useBackup ? (
        <input type="text" className="input" placeholder="XXXX-XXXX" value={code} autoFocus onChange={(e) => setCode(e.target.value.toUpperCase())} onKeyDown={(e) => e.key === "Enter" && submit()} />
      ) : (
        <input type="password" className="input" placeholder="Passcode" value={pw} autoFocus onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
      )}
      {error && <p className="note bad">{error}</p>}
      <button className="btn primary" onClick={submit} style={{ justifySelf: "center", marginTop: 4 }}>Unlock</button>
      <button className="btn ghost small" onClick={() => { setUseBackup((b) => !b); setError(null); }}>
        {useBackup ? "Use passcode instead" : "Forgot passcode? Use a backup code"}
      </button>
    </div>
  );
}

function ChangePasscode({ onCodes, onClose }: { onCodes: (codes: string[]) => void; onClose: () => void }) {
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
      <div className="scrim" onClick={onClose}>
        <div className="sheet" role="dialog" onClick={(e) => e.stopPropagation()}>
          <header>Change Passcode</header>
          <div className="sbody">
            <input type="password" className="input" autoFocus placeholder="New passcode (at least 4 characters)" value={pw} onChange={(e) => setPw(e.target.value)} />
            <input type="password" className="input" placeholder="Confirm new passcode" value={confirm} onChange={(e) => setConfirm(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
            {confirm.length > 0 && pw !== confirm && <p className="note bad">Passcodes don’t match</p>}
            {error && <p className="note bad">{error}</p>}
            <p>Changing the passcode also issues a fresh set of backup codes.</p>
          </div>
          <div className="sfoot">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={!ready} onClick={submit}>Change Passcode</button>
          </div>
        </div>
      </div>
    </Portal>
  );
}

export default function LockedPage() {
  const qc = useQueryClient();
  const [freshCodes, setFreshCodes] = useState<string[] | null>(null);
  const [changing, setChanging] = useState(false);
  const token = useLockedToken();
  const session = useLockedSession();

  const { data: status } = useQuery({
    queryKey: ["locked", "status", session],
    queryFn: () => lockedApi.status(),
    refetchInterval: 60_000,
  });
  const unlocked = !!status?.unlocked && !!token;

  // re-lock the moment the server says the session is over — never on a
  // client-side guess, since using the section renews the idle clock
  const expiresIn = status?.expires_in;
  useEffect(() => {
    if (!unlocked || expiresIn == null) return;
    const t = window.setTimeout(() => qc.invalidateQueries({ queryKey: ["locked", "status"] }), Math.max(0, expiresIn) * 1000 + 750);
    return () => window.clearTimeout(t);
  }, [unlocked, expiresIn, qc]);
  useEffect(() => {
    if (status && !status.unlocked && token) {
      setLockedToken(null);
      selectionActions.clear();
      qc.invalidateQueries({ queryKey: ["locked"] });
    }
  }, [status, token, qc]);

  const { data: items } = useQuery({ queryKey: ["locked", "items", session], queryFn: () => lockedApi.items(), enabled: unlocked });

  const unhide = useMutation({
    mutationFn: (ids: number[]) => lockedApi.removeItems(ids),
    onSuccess: () => {
      selectionActions.clear();
      qc.invalidateQueries(); // items reappear everywhere
    },
  });
  const lockNow = async () => {
    await lockedApi.lock();
    setLockedToken(null);
    selectionActions.clear();
    qc.invalidateQueries({ queryKey: ["locked"] });
  };

  const more = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openContextMenu({ clientX: r.right - 180, clientY: r.bottom + 4, preventDefault: () => {} }, [{ label: "Change Passcode…", onSelect: () => setChanging(true) }]);
  };

  const n = status?.count ?? items?.length ?? 0;
  const count = unlocked ? `${n.toLocaleString()} hidden · ${status?.codes_remaining ?? 0} backup codes left` : null;
  return (
    <>
      <Toolbar title="Locked" count={count}>
        {unlocked && (
          <>
            <SelectionActions>
              <TbButton onClick={() => unhide.mutate([...selection.get().ids])}>Unhide</TbButton>
            </SelectionActions>
            <TbButton icon={<IconMore size={14} />} title="More" onClick={more} />
            <TbButton icon={<IconLock size={14} />} title="Lock now" primary onClick={lockNow}>Lock</TbButton>
            <GridControls />
          </>
        )}
      </Toolbar>
      {freshCodes ? (
        <div className="page center"><BackupCodes codes={freshCodes} onDone={() => setFreshCodes(null)} /></div>
      ) : !status ? (
        <div className="page center"><div className="row muted small"><div className="spin" />Checking the lock…</div></div>
      ) : !status.configured ? (
        <div className="page center"><SetupCard onComplete={setFreshCodes} /></div>
      ) : !unlocked ? (
        <div className="page center"><UnlockCard /></div>
      ) : items ? (
        <FlatGrid
          items={items}
          qs={lockedQS()}
          positionLabel="Locked"
          emptyText="Nothing hidden yet. Select photos anywhere in your library and choose Hide in Locked."
          menuExtras={(ids) => [{ label: "Unhide", onSelect: () => unhide.mutate(ids) }]}
        />
      ) : null}
      {changing && getLockedToken() && <ChangePasscode onCodes={setFreshCodes} onClose={() => setChanging(false)} />}
    </>
  );
}
