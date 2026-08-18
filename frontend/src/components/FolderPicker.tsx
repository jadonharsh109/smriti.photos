import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api/client";
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

/** Server-side folder browser. It has to be server-side: a browser can hand us
 *  a file's contents but never its absolute path, and every path this app deals
 *  in is one the Python process must be able to open. */
export default function FolderPicker({
  onPick,
  onClose,
  title = "Choose a photos folder",
  submitLabel = "Use this folder",
  hint,
}: Props) {
  // "" = the platform's natural starting point (macOS: /Volumes, Windows: drive list)
  const [path, setPath] = useState("");
  const { data } = useQuery({
    queryKey: ["fs", path],
    queryFn: () => api.get<FsList>(`/api/fs/list?path=${encodeURIComponent(path)}`),
  });
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
