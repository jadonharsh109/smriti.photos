import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, fmtBytes } from "../api/client";
import { getLockedToken, lockedApi, setLockedToken } from "../lockedStore";
import { ConfirmDialog, TextDialog } from "./Dialogs";
import { IconDownload, IconLock } from "./Icons";
import Portal from "./Portal";

interface Album {
  id: number;
  name: string;
  count: number;
}

/** Hide-in-Locked flow: set-up hint / inline unlock / confirm, in one dialog. */
function HideInLockedDialog({ ids, onDone, onClose }: { ids: number[]; onDone: () => void; onClose: () => void }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [pw, setPw] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { data: status } = useQuery({ queryKey: ["locked", "status", !!getLockedToken()], queryFn: () => lockedApi.status() });

  const hide = async () => {
    await lockedApi.addItems(ids);
    qc.invalidateQueries(); // vanish from every view
    onDone();
    onClose();
  };

  const unlockAndHide = async () => {
    setError(null);
    try {
      const r = await lockedApi.unlock(pw);
      setLockedToken(r.token);
      await hide();
    } catch (e) {
      setError(String((e as Error).message));
    }
  };

  const n = ids.length;
  const unlocked = status?.unlocked && !!getLockedToken();
  return (
    <Portal>
      <div className="modal-back" onClick={onClose}>
        <div className="modal" style={{ width: 430 }} onClick={(e) => e.stopPropagation()}>
          <header>Hide {n} {n === 1 ? "item" : "items"} in Locked</header>
          <div className="modal-body" style={{ padding: "10px 24px 8px", display: "grid", gap: 10 }}>
            {!status ? null : !status.configured ? (
              <p className="muted">
                The Locked section isn't set up yet. Create a passcode first — then hidden photos
                disappear from Photos, Albums, People, Places, Map and Events.
              </p>
            ) : unlocked ? (
              <p className="muted">
                They'll disappear from every view and only show inside Locked after entering your passcode.
              </p>
            ) : (
              <>
                <p className="muted">Enter your Locked passcode to hide them.</p>
                <input
                  type="password"
                  autoFocus
                  placeholder="Passcode"
                  value={pw}
                  onChange={(e) => setPw(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && unlockAndHide()}
                />
                {error && <p className="small" style={{ color: "var(--danger)" }}>{error}</p>}
              </>
            )}
          </div>
          <footer>
            <button onClick={onClose}>Cancel</button>
            {!status ? null : !status.configured ? (
              <button className="primary" onClick={() => nav("/locked")}>Set up Locked</button>
            ) : unlocked ? (
              <button className="primary" onClick={hide}>Hide in Locked</button>
            ) : (
              <button className="primary" disabled={!pw} onClick={unlockAndHide}>Unlock & hide</button>
            )}
          </footer>
        </div>
      </div>
    </Portal>
  );
}

interface Props {
  selected: Set<number>;
  onClear: () => void;
  onSelectAll?: () => void;
  extraActions?: React.ReactNode;
}

export default function SelectionBar({ selected, onClear, onSelectAll, extraActions }: Props) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [naming, setNaming] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [hiding, setHiding] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [note, setNote] = useState<{ text: string; err: boolean } | null>(null);
  const qc = useQueryClient();
  const { data: albums } = useQuery({
    queryKey: ["albums"],
    queryFn: () => api.get<Album[]>("/api/albums"),
    enabled: pickerOpen,
  });

  if (selected.size === 0) return null;

  const addTo = async (albumId: number) => {
    await api.post(`/api/albums/${albumId}/items`, { file_ids: [...selected] });
    qc.invalidateQueries({ queryKey: ["albums"] });
    qc.invalidateQueries({ queryKey: ["album"] });
    setPickerOpen(false);
    onClear();
  };

  const createAndAdd = async (name: string) => {
    const r = await api.post<{ id: number }>("/api/albums", { name });
    setNaming(false);
    await addTo(r.id);
  };

  const moveToTrash = async () => {
    await api.post("/api/files/delete", { file_ids: [...selected] });
    qc.invalidateQueries();
    onClear();
  };

  /** Copy the selected originals into a zip and save it.
   *
   * Two steps on purpose: the server validates the selection and returns a
   * token, then a plain <a download> GET streams the archive straight to disk.
   * Fetching it as a blob instead would hold the entire export — potentially
   * many GB of originals — in browser memory. */
  const exportZip = async () => {
    setExporting(true);
    setNote(null);
    try {
      const r = await api.post<{
        token: string; filename: string; count: number; bytes: number; skipped_offline: number;
      }>("/api/files/export", { file_ids: [...selected] });
      const a = document.createElement("a");
      // filename goes in the path, not just the download attribute: the
      // desktop webview names the saved file from the URL's last segment
      a.href = `/api/files/export/${r.token}/${encodeURIComponent(r.filename)}`;
      a.download = r.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setNote({
        text:
          `✓ ${r.count} ${r.count === 1 ? "file" : "files"} · ${fmtBytes(r.bytes)}` +
          (r.skipped_offline ? ` · ${r.skipped_offline} offline` : ""),
        err: false,
      });
      setTimeout(() => setNote(null), 6000);
    } catch (e) {
      setNote({ text: String((e as Error).message), err: true });
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <Portal>
      <div className="selbar">
        <strong>{selected.size} selected</strong>
        {onSelectAll && <button onClick={onSelectAll}>Select all</button>}
        <button onClick={() => setPickerOpen((o) => !o)}>Add to album</button>
        {pickerOpen && (
          <div className="album-picks">
            {(albums ?? []).map((a) => (
              <button key={a.id} onClick={() => addTo(a.id)}>
                {a.name}
              </button>
            ))}
            <button className="primary" onClick={() => setNaming(true)}>
              + New
            </button>
          </div>
        )}
        {extraActions}
        <button
          onClick={exportZip}
          disabled={exporting}
          title="Copy the original files into a .zip and save it — your library is not changed"
        >
          <span style={{ display: "inline-flex", verticalAlign: "-3px", marginRight: 6 }}>
            <IconDownload size={15} />
          </span>
          {exporting ? "Preparing…" : "Export as ZIP"}
        </button>
        <button onClick={() => setHiding(true)} title="Hide in the passcode-protected Locked section">
          <span style={{ display: "inline-flex", verticalAlign: "-3px", marginRight: 6 }}><IconLock size={15} /></span>
          Hide in Locked
        </button>
        <button className="danger" onClick={() => setConfirmingDelete(true)}>
          Delete
        </button>
        <button className="ghost" onClick={onClear}>
          Clear
        </button>
        {note && <span className={`sel-note${note.err ? " err" : ""}`}>{note.text}</span>}
      </div>
      </Portal>
      {confirmingDelete && (
        <ConfirmDialog
          title={`Move ${selected.size} ${selected.size === 1 ? "item" : "items"} to Trash?`}
          body="Originals go to the system Trash (recoverable there) and disappear from the library. Items on offline drives are skipped."
          confirmLabel="Move to Trash"
          danger
          onConfirm={moveToTrash}
          onClose={() => setConfirmingDelete(false)}
        />
      )}
      {hiding && (
        <HideInLockedDialog ids={[...selected]} onDone={onClear} onClose={() => setHiding(false)} />
      )}
      {naming && (
        <TextDialog
          title="New album"
          placeholder="Album name"
          submitLabel="Create & add"
          onSubmit={createAndAdd}
          onClose={() => setNaming(false)}
        />
      )}
    </>
  );
}
