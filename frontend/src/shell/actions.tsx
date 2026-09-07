/** The things you can do to a photo or a selection, in one place.
 *
 *  Context menus, the toolbar, the inspector and the viewer all offer the same
 *  verbs — add to album, favourite, hide in Locked, export, move to Trash —
 *  and each used to carry its own dialog. Now they call `actions.*`, and the
 *  one `ActionsHost` the shell mounts shows whatever needs asking. */
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, fmtBytes, revealFile } from "../api/client";
import AlbumPicker from "../components/AlbumPicker";
import { ConfirmDialog } from "../components/Dialogs";
import { getLockedToken, lockedApi, setLockedToken } from "../lockedStore";
import { createStore, selectionActions } from "./store";

type Pending =
  | { kind: "album"; ids: number[] }
  | { kind: "trash"; ids: number[] }
  | { kind: "lock"; ids: number[] }
  | { kind: "forget"; ids: number[] }
  | null;

const pending = createStore<{ p: Pending; note: { text: string; bad?: boolean } | null }>({ p: null, note: null });

let qcRef: QueryClient | null = null;
const refresh = () => qcRef?.invalidateQueries();
const say = (text: string, bad = false) => {
  pending.set({ note: { text, bad } });
  setTimeout(() => pending.set((s) => (s.note?.text === text ? { note: null } : {})), 6000);
};

export const actions = {
  addToAlbum: (ids: number[]) => ids.length && pending.set({ p: { kind: "album", ids } }),
  trash: (ids: number[]) => ids.length && pending.set({ p: { kind: "trash", ids } }),
  hideInLocked: (ids: number[]) => ids.length && pending.set({ p: { kind: "lock", ids } }),
  forgetMissing: (ids: number[]) => ids.length && pending.set({ p: { kind: "forget", ids } }),
  favourite: async (ids: number[], on: boolean) => {
    if (!ids.length) return;
    await api.post("/api/favourites", { file_ids: ids, on });
    refresh();
  },
  notDocument: async (ids: number[]) => {
    if (!ids.length) return;
    await api.post("/api/kinds/not-document", { file_ids: ids });
    selectionActions.clear();
    refresh();
  },
  reveal: async (id: number, qs = "") => {
    try {
      await revealFile(id, qs);
    } catch (e) {
      say(e instanceof Error ? e.message : String(e), true);
    }
  },
  /** Copy the originals into a zip and save it. Two steps: the server checks
   *  the selection and hands back a token, then a plain download GET streams
   *  the archive — fetching it as a blob would hold gigabytes in memory. */
  exportZip: async (ids: number[]) => {
    if (!ids.length) return;
    try {
      const r = await api.post<{ token: string; filename: string; count: number; bytes: number; skipped_offline: number }>(
        "/api/files/export",
        { file_ids: ids }
      );
      const a = document.createElement("a");
      a.href = `/api/files/export/${r.token}/${encodeURIComponent(r.filename)}`;
      a.download = r.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      say(`Exporting ${r.count} ${r.count === 1 ? "file" : "files"} · ${fmtBytes(r.bytes)}` + (r.skipped_offline ? ` · ${r.skipped_offline} on an unplugged drive skipped` : ""));
    } catch (e) {
      say(e instanceof Error ? e.message : String(e), true);
    }
  },
};

/** The transient line the status bar shows after an action. */
export const useActionNote = () => pending.use((s) => s.note);

export function ActionsHost() {
  const qc = useQueryClient();
  qcRef = qc;
  const p = pending.use((s) => s.p);
  const close = () => pending.set({ p: null });
  if (!p) return null;
  const n = p.ids.length;
  if (p.kind === "album") {
    const add = async (albumId: number) => {
      await api.post(`/api/albums/${albumId}/items`, { file_ids: p.ids });
      qc.invalidateQueries({ queryKey: ["albums"] });
      qc.invalidateQueries({ queryKey: ["album"] });
      say(`Added ${n} ${n === 1 ? "item" : "items"} to the album`);
    };
    return (
      <AlbumPicker
        title={`Add ${n} ${n === 1 ? "item" : "items"} to an album`}
        onPick={add}
        onCreate={async (name) => {
          const r = await api.post<{ id: number }>("/api/albums", { name });
          await add(r.id);
        }}
        onClose={close}
      />
    );
  }
  if (p.kind === "trash") {
    return (
      <ConfirmDialog
        title={`Move ${n === 1 ? "this item" : `${n} items`} to Trash?`}
        body="Originals go to the system Trash, where they can be recovered, and leave the library. Items on drives that are not connected are skipped."
        confirmLabel="Move to Trash"
        danger
        onConfirm={async () => {
          const r = await api.post<{ trashed: number; skipped_offline: number; errors: unknown[] }>("/api/files/delete", { file_ids: p.ids });
          selectionActions.clear();
          refresh();
          say(
            `Moved ${r.trashed} ${r.trashed === 1 ? "file" : "files"} to the Trash` +
              (r.skipped_offline ? ` · ${r.skipped_offline} skipped (drive offline)` : "") +
              (r.errors.length ? ` · ${r.errors.length} failed` : ""),
            r.errors.length > 0
          );
        }}
        onClose={close}
      />
    );
  }
  if (p.kind === "forget") {
    return (
      <ConfirmDialog
        title={`Forget ${n === 1 ? "this entry" : `${n} entries`}?`}
        body="The files are already gone from disk. This clears the entries Smriti still holds for them, and their thumbnails."
        confirmLabel="Forget"
        danger
        onConfirm={async () => {
          const r = await api.post<{ forgotten: number }>("/api/cleanup/missing/forget", { file_ids: p.ids });
          selectionActions.clear();
          refresh();
          say(`Forgot ${r.forgotten} ${r.forgotten === 1 ? "entry" : "entries"}`);
        }}
        onClose={close}
      />
    );
  }
  return <HideInLocked ids={p.ids} onClose={close} />;
}

/** Hide-in-Locked: set-up hint, inline unlock, or confirm — one dialog. */
function HideInLocked({ ids, onClose }: { ids: number[]; onClose: () => void }) {
  const nav = useNavigate();
  const [pw, setPw] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { data: status } = useQuery({ queryKey: ["locked", "status", !!getLockedToken()], queryFn: () => lockedApi.status() });
  const n = ids.length;
  const unlocked = status?.unlocked && !!getLockedToken();

  const hide = async () => {
    await lockedApi.addItems(ids);
    selectionActions.clear();
    refresh();
    say(`Hid ${n} ${n === 1 ? "item" : "items"} in Locked`);
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
  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet" role="dialog" onClick={(e) => e.stopPropagation()}>
        <header>Hide {n} {n === 1 ? "item" : "items"} in Locked</header>
        <div className="sbody">
          {!status ? null : !status.configured ? (
            <p>The Locked section isn’t set up yet. Create a passcode first; hidden photos then disappear from every other view.</p>
          ) : unlocked ? (
            <p>They will disappear from every view and show only inside Locked, after the passcode.</p>
          ) : (
            <>
              <p>Enter your Locked passcode to hide them.</p>
              <input className="input" type="password" autoFocus placeholder="Passcode" value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === "Enter" && unlockAndHide()} />
              {error && <p className="note bad">{error}</p>}
            </>
          )}
        </div>
        <div className="sfoot">
          <button className="btn" onClick={onClose}>Cancel</button>
          {!status ? null : !status.configured ? (
            <button className="btn primary" onClick={() => { onClose(); nav("/locked"); }}>Set up Locked</button>
          ) : unlocked ? (
            <button className="btn primary" onClick={hide}>Hide in Locked</button>
          ) : (
            <button className="btn primary" disabled={!pw} onClick={unlockAndHide}>Unlock & Hide</button>
          )}
        </div>
      </div>
    </div>
  );
}
