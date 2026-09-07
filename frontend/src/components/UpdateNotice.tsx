import { useEffect } from "react";
import Portal from "./Portal";
import { isDesktop } from "../lib/desktop";
import type { UpdateProgress } from "../lib/desktop";
import { closeSheet, install, startUpdates, useUpdates } from "../lib/updates";

/** The update sheet. The offer itself lives in the status bar ("Update to
 *  1.5.0"), which is where a desktop app reports background news; this is
 *  what opens when it is clicked: what changed, then the download itself.
 *
 *  While it is downloading there is nothing to go back to — the app is being
 *  replaced under us — so the sheet stops being dismissable. */

const mb = (bytes: number) => Math.round(bytes / 1_048_576);

function progressLabel(p: UpdateProgress): string {
  if (p.phase === "installing") return "Installing…";
  if (p.phase === "restarting") return "Restarting…";
  if (p.downloaded === 0) return "Starting download…";
  return p.total > 0 ? `Downloading… ${mb(p.downloaded)} of ${mb(p.total)} MB` : `Downloading… ${mb(p.downloaded)} MB`;
}

/** The release workflow writes notes as one `- item` per line. */
const bullets = (notes: string) =>
  notes
    .split("\n")
    .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
    .filter(Boolean);

export function UpdateSheet() {
  const s = useUpdates();
  useEffect(startUpdates, []);

  const busy = s.progress !== null;
  useEffect(() => {
    if (!s.sheetOpen || busy) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeSheet();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [s.sheetOpen, busy]);

  if (!isDesktop() || !s.available || !s.sheetOpen) return null;
  const { version, current, notes } = s.available;
  const items = bullets(notes);

  return (
    <Portal>
      <div className="scrim" onClick={busy ? undefined : closeSheet}>
        <div className="sheet" role="dialog" aria-label={`Smriti ${version} is available`} onClick={(e) => e.stopPropagation()}>
          <header>Smriti {version} is available</header>
          <div className="sbody">
            <p>You’re on {current}.</p>
            {items.length > 0 && (
              <ul style={{ margin: "0 0 10px", paddingLeft: 18, display: "grid", gap: 4 }}>
                {items.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            )}
            {s.error && <p className="note bad">{s.error}</p>}
            {busy && (
              <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
                <div className="progress">
                  <i style={{ width: `${Math.max(2, s.progress!.pct)}%` }} />
                </div>
                <p>{progressLabel(s.progress!)}</p>
              </div>
            )}
          </div>
          <div className="sfoot">
            {busy ? (
              <span className="note">Keep the app open — it will restart itself.</span>
            ) : (
              <>
                <button className="btn" onClick={closeSheet}>Later</button>
                <button className="btn primary" onClick={install}>{s.error ? "Try again" : "Update & Restart"}</button>
              </>
            )}
          </div>
        </div>
      </div>
    </Portal>
  );
}
