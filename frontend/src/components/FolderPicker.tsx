import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { isDesktop, pickFolder } from "../lib/desktop";
import Portal from "./Portal";

export interface FsList {
  path: string;
  parent: string | null;
  dirs: { name: string; path: string }[];
  media_count: number;
  files?: { name: string; path: string; size: number }[];
}

interface Props {
  onPick: (path: string) => void;
  onClose: () => void;
  title?: string;
  submitLabel?: string;
  /** Shown under the path when the folder is a candidate destination rather
   *  than a folder to index. */
  hint?: React.ReactNode;
}

/** Choose a folder.
 *
 *  In the desktop app that means the system chooser — Finder, or Explorer on
 *  Windows — which already knows the user's sidebar, their recent places and
 *  their network volumes. This component then renders nothing and exists only
 *  to raise it, so the two call sites do not each need to know which world they
 *  are in.
 *
 *  In a plain browser it is the server-side browser below, and that has to be
 *  server-side: a browser can hand us a file's contents but never its absolute
 *  path, and every path this app deals in is one the Python process must be
 *  able to open. It is the fallback, not the preference. */
export default function FolderPicker({
  onPick,
  onClose,
  title = "Choose a photos folder",
  submitLabel = "Use this folder",
  hint,
}: Props) {
  // Decided once per mount: a component that changed which kind of picker it
  // was halfway through would be a very strange thing to be looking at.
  const [native, setNative] = useState(isDesktop);
  // "" = the platform's natural starting point (macOS: /Volumes, Windows: drive list)
  const [path, setPath] = useState("");
  const { data } = useQuery({
    queryKey: ["fs", path],
    queryFn: () => api.get<FsList>(`/api/fs/list?path=${encodeURIComponent(path)}`),
    enabled: !native,
  });

  // Exactly once per mount, and the answer always lands.
  //
  // StrictMode runs effects twice in development. Raising the chooser twice
  // would put two Finder windows over the app, so a ref — which survives the
  // remount where a state flag would not — keeps it to one. But an unmount
  // guard cannot then be used to ignore a late reply: the cleanup that runs
  // between the two passes belongs to the call that is still open, and it would
  // throw away the only answer we are going to get. There is nothing to guard
  // against anyway. The chooser is modal, the reply is the user's, and both
  // handlers do to the parent exactly what its own Cancel button does.
  const asked = useRef(false);
  useEffect(() => {
    if (!native || asked.current) return;
    asked.current = true;
    // Cancelling is a real answer, not a failure.
    pickFolder(title).then(
      (picked) => (picked ? onPick(picked) : onClose()),
      // The shell could not raise it — a missing command, an ACL that does not
      // grant it, a plugin that failed. Fall back to the browser we still have
      // rather than close on someone who asked to choose something: this is the
      // only route to adding a folder to the library, and a dead end there is a dead end for the feature.
      () => setNative(false)
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [native]);

  if (native) return null;

  const atSyntheticRoot = data?.path === "This PC";
  const subfolders = data?.dirs.length ?? 0;
  return (
    <Portal>
      <div className="modal-back" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <header>{title}</header>
          <div className="modal-body">
            <div className="row" style={{ marginBottom: 8 }}>
              <button disabled={data?.parent == null} onClick={() => data && data.parent != null && setPath(data.parent)}>
                ↑ Up
              </button>
              <button onClick={() => setPath("~")}>Home</button>
              <span className="muted small" style={{ wordBreak: "break-all" }}>{data?.path ?? "…"}</span>
            </div>
            {hint ? (
              <p className="small muted" style={{ marginBottom: 6 }}>{hint}</p>
            ) : (
              /* Scanning recurses, so the direct-only count used to read as "this
                 folder is empty" when someone picked the right parent folder. */
              data && !atSyntheticRoot && (
                <p className="small muted" style={{ marginBottom: 6 }}>
                  {data.media_count > 0
                    ? `${data.media_count.toLocaleString()} photos and videos here`
                    : "Nothing directly in this folder"}
                  {subfolders > 0
                    ? ` — Smriti will also look inside ${subfolders === 1 ? "the folder" : `all ${subfolders} folders`} within it.`
                    : "."}
                </p>
              )
            )}
            {(data?.dirs ?? []).map((d) => (
              <div key={d.path} className="dir-row" onClick={() => setPath(d.path)}>
                <span>📁</span> {d.name}
              </div>
            ))}
            {data && data.dirs.length === 0 && <p className="muted small">No subfolders.</p>}
          </div>
          <footer>
            <button onClick={onClose}>Cancel</button>
            <button className="primary" disabled={!data || atSyntheticRoot} onClick={() => data && onPick(data.path)}>
              {submitLabel}
            </button>
          </footer>
        </div>
      </div>
    </Portal>
  );
}
