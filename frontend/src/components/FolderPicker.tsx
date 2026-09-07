import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { isDesktop, pickFolder } from "../lib/desktop";
import { IconFolder } from "./Icons";
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
  /** Shown under the path when the folder is a destination rather than a
   *  folder to index. */
  hint?: React.ReactNode;
}

/** Choose a folder.
 *
 *  In the desktop app that means the system chooser — Finder, or Explorer on
 *  Windows. This component then renders nothing and exists only to raise it.
 *  In a plain browser it is the server-side browser below, because a browser
 *  can never hand us an absolute path. */
export default function FolderPicker({ onPick, onClose, title = "Choose a photos folder", submitLabel = "Use This Folder", hint }: Props) {
  const [native, setNative] = useState(isDesktop);
  const [path, setPath] = useState("");
  const { data } = useQuery({
    queryKey: ["fs", path],
    queryFn: () => api.get<FsList>(`/api/fs/list?path=${encodeURIComponent(path)}`),
    enabled: !native,
  });

  // Exactly once per mount, and the answer always lands — a ref survives the
  // StrictMode double-run where a state flag would not.
  const asked = useRef(false);
  useEffect(() => {
    if (!native || asked.current) return;
    asked.current = true;
    pickFolder(title).then(
      (picked) => (picked ? onPick(picked) : onClose()),
      () => setNative(false)   // the shell could not raise it: fall back to ours
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [native]);

  if (native) return null;

  const atSyntheticRoot = data?.path === "This PC";
  const subfolders = data?.dirs.length ?? 0;
  return (
    <Portal>
      <div className="scrim" onClick={onClose}>
        <div className="sheet wide" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
          <header>{title}</header>
          <div className="sbody">
            <div className="row" style={{ marginBottom: 6 }}>
              <button className="btn small" disabled={data?.parent == null} onClick={() => data && data.parent != null && setPath(data.parent)}>↑ Up</button>
              <button className="btn small" onClick={() => setPath("~")}>Home</button>
              <span className="muted small selectable" style={{ wordBreak: "break-all" }}>{data?.path ?? "…"}</span>
            </div>
            {hint ? (
              <p>{hint}</p>
            ) : (
              data && !atSyntheticRoot && (
                <p>
                  {data.media_count > 0 ? `${data.media_count.toLocaleString()} photos and videos here` : "Nothing directly in this folder"}
                  {subfolders > 0 ? ` — Smriti also looks inside ${subfolders === 1 ? "the folder" : `all ${subfolders} folders`} within it.` : "."}
                </p>
              )
            )}
            <div className="dir-list">
              {(data?.dirs ?? []).map((d) => (
                <div key={d.path} className="dir-row" onClick={() => setPath(d.path)}>
                  <IconFolder size={14} /> {d.name}
                </div>
              ))}
              {data && data.dirs.length === 0 && <p style={{ padding: 6 }}>No subfolders.</p>}
            </div>
          </div>
          <div className="sfoot">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={!data || atSyntheticRoot} onClick={() => data && onPick(data.path)}>{submitLabel}</button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
