import { useEffect } from "react";
import { IconDownload } from "./Icons";
import Portal from "./Portal";
import { isDesktop } from "../lib/desktop";
import type { UpdateProgress } from "../lib/desktop";
import {
  closeSheet,
  install,
  openSheet,
  startUpdates,
  useUpdates,
} from "../lib/updates";

/** The update notice, in the app rather than in front of it.
 *
 * The shell used to say all of this in native dialogs, which open as a window —
 * or, on a Mac set to prefer tabs, a tab — of their own: detached from the app
 * they were about, easy to miss behind it, and gone for good once dismissed.
 * Here it is a card pinned to the rail that waits as long as it takes, and a
 * sheet that shows what changed and then the download itself. */

const mb = (bytes: number) => Math.round(bytes / 1_048_576);

function progressLabel(p: UpdateProgress): string {
  if (p.phase === "installing") return "Installing…";
  if (p.phase === "restarting") return "Restarting…";
  if (p.downloaded === 0) return "Starting download…";
  return p.total > 0
    ? `Downloading… ${mb(p.downloaded)} of ${mb(p.total)} MB`
    : `Downloading… ${mb(p.downloaded)} MB`;
}

/** The release workflow writes notes as one `- item` per line. */
const bullets = (notes: string) =>
  notes
    .split("\n")
    .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
    .filter(Boolean);

export default function UpdateNotice() {
  const s = useUpdates();
  useEffect(startUpdates, []);

  const busy = s.progress !== null;
  useEffect(() => {
    if (!s.sheetOpen || busy) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeSheet();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [s.sheetOpen, busy]);

  if (!isDesktop() || !s.available) return null;
  const { version, current, notes } = s.available;
  const items = bullets(notes);

  return (
    <>
      <button className="jobs-card update-card" onClick={openSheet}>
        <div className="jc-title">
          <IconDownload size={14} />
          {busy ? "Updating Smriti" : "Update available"}
        </div>
        <div>{busy ? progressLabel(s.progress!) : `Smriti ${version} is ready to install`}</div>
        {busy && (
          <div className="progress">
            <div style={{ width: `${Math.max(2, s.progress!.pct)}%` }} />
          </div>
        )}
      </button>

      {s.sheetOpen && (
        <Portal>
          {/* While it is downloading there is nothing to go back to — the app is
              being replaced under us — so the sheet stops being dismissable. */}
          <div className="modal-back" onClick={busy ? undefined : closeSheet}>
            <div className="modal" style={{ width: 480 }} onClick={(e) => e.stopPropagation()}>
              <header>Smriti {version} is available</header>
              <div className="modal-body">
                <p className="muted small">You’re on {current}.</p>
                {items.length > 0 && (
                  <ul className="update-notes">
                    {items.map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ul>
                )}
                {s.error && <p className="setup-problem small">{s.error}</p>}
                {busy && (
                  <div className="update-progress">
                    <div className="progress">
                      <div style={{ width: `${Math.max(2, s.progress!.pct)}%` }} />
                    </div>
                    <p className="muted small">{progressLabel(s.progress!)}</p>
                  </div>
                )}
              </div>
              <footer>
                {busy ? (
                  <span className="muted small">Keep the app open — it will restart itself.</span>
                ) : (
                  <>
                    <button onClick={closeSheet}>Later</button>
                    <button className="primary" onClick={install}>
                      {s.error ? "Try again" : "Update & Restart"}
                    </button>
                  </>
                )}
              </footer>
            </div>
          </div>
        </Portal>
      )}
    </>
  );
}
