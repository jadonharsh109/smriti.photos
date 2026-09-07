import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, fmtBytes } from "../api/client";
import FolderPicker, { type FsList } from "./FolderPicker";
import { isDesktop, pickZipFiles } from "../lib/desktop";
import { IconFolder } from "./Icons";
import Portal from "./Portal";

interface Analysis {
  archives: string[];
  unreadable: string[];
  photos: number;
  videos: number;
  total: number;
  bytes: number;
  duplicate_paths: number;
  with_metadata: number;
  orphan_sidecars: number;
  looks_incomplete: boolean;
  photos_root: string;
  albums: { name: string; count: number }[];
  year_folders: string[];
}

/** Pick the .zip parts of a Takeout export. Google splits an export across
 *  numbered parts and files a photo's metadata in a different part from the
 *  photo, so this is deliberately multi-select. The desktop app uses the
 *  system chooser; the list below is the browser's fallback. */
function ZipPicker({ chosen, onDone, onClose }: { chosen: string[]; onDone: (paths: string[]) => void; onClose: () => void }) {
  const [native, setNative] = useState(isDesktop);
  const [path, setPath] = useState("");
  const [sel, setSel] = useState<Record<string, number>>(Object.fromEntries(chosen.map((c) => [c, 0])));
  const { data } = useQuery({
    queryKey: ["fs-zip", path],
    queryFn: () => api.get<FsList>(`/api/fs/list?include=zip&path=${encodeURIComponent(path)}`),
    enabled: !native,
  });

  const asked = useRef(false);
  useEffect(() => {
    if (!native || asked.current) return;
    asked.current = true;
    pickZipFiles("Choose your Takeout .zip files").then(
      (picked) => (picked.length ? onDone([...new Set([...chosen, ...picked])]) : onClose()),
      () => setNative(false)
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [native]);

  const looksLikeTakeout = (n: string) => /takeout|google/i.test(n);
  const files = [...(data?.files ?? [])].sort((a, b) => Number(looksLikeTakeout(b.name)) - Number(looksLikeTakeout(a.name)));
  const takeouts = files.filter((f) => looksLikeTakeout(f.name));
  const toggle = (p: string, size: number) =>
    setSel((prev) => {
      const next = { ...prev };
      if (p in next) delete next[p];
      else next[p] = size;
      return next;
    });
  const count = Object.keys(sel).length;

  if (native) return null;

  return (
    <Portal>
      <div className="scrim" onClick={onClose}>
        <div className="sheet wide" role="dialog" onClick={(e) => e.stopPropagation()}>
          <header>Choose your Takeout .zip files</header>
          <div className="sbody">
            <div className="row" style={{ marginBottom: 6 }}>
              <button className="btn small" disabled={data?.parent == null} onClick={() => data && data.parent != null && setPath(data.parent)}>↑ Up</button>
              <button className="btn small" onClick={() => setPath("~")}>Home</button>
              <span className="muted small selectable" style={{ wordBreak: "break-all" }}>{data?.path ?? "…"}</span>
              <span className="grow" />
              {files.length > 0 && (
                <button
                  className="btn small"
                  onClick={() =>
                    setSel((prev) => {
                      const next = { ...prev };
                      for (const f of takeouts.length ? takeouts : files) next[f.path] = f.size;
                      return next;
                    })
                  }
                >
                  {takeouts.length ? `Select all ${takeouts.length} Takeout ${takeouts.length === 1 ? "file" : "files"}` : `Select all ${files.length} here`}
                </button>
              )}
            </div>
            <div className="dir-list">
              {(data?.dirs ?? []).map((d) => (
                <div key={d.path} className="dir-row" onClick={() => setPath(d.path)}>
                  <IconFolder size={14} /> {d.name}
                </div>
              ))}
              {files.map((f) => (
                <div key={f.path} className="dir-row" onClick={() => toggle(f.path, f.size)}>
                  <span className={`check${f.path in sel ? " on" : ""}`}>✓</span> {f.name}
                  <span className="grow" />
                  <span className="muted small num">{fmtBytes(f.size)}</span>
                </div>
              ))}
              {data && data.dirs.length === 0 && files.length === 0 && <p style={{ padding: 6 }}>Nothing here. Takeout files are usually in Downloads.</p>}
            </div>
          </div>
          <div className="sfoot">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={count === 0} onClick={() => onDone(Object.keys(sel))}>
              {count === 0 ? "Select files" : `Use ${count} file${count === 1 ? "" : "s"}`}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}

const base = (p: string) => p.split(/[\\/]/).pop() ?? p;

export default function TakeoutImport({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [zips, setZips] = useState<string[]>([]);
  const [dest, setDest] = useState<string | null>(null);
  const [writeExif, setWriteExif] = useState(true);
  const [picking, setPicking] = useState<"zips" | "dest" | null>(null);

  const analyze = useMutation({ mutationFn: (archives: string[]) => api.post<Analysis>("/api/takeout/analyze", { archives }) });
  const start = useMutation({
    mutationFn: () => api.post<{ job_id: number }>("/api/takeout/import", { archives: zips, destination: dest, write_exif: writeExif }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["jobs"] });
      onClose();
    },
  });

  useEffect(() => {
    if (zips.length) analyze.mutate(zips);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zips]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !picking && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, picking]);

  const a = analyze.data;
  return (
    <>
      <Portal>
        <div className="scrim" onClick={onClose}>
          <div className="sheet wide" role="dialog" aria-label="Import from Google Takeout" onClick={(e) => e.stopPropagation()}>
            <header>Import from Google Takeout</header>
            <div className="sbody" style={{ display: "grid", gap: 12 }}>
              <p>
                Smriti unpacks the export and puts the dates and places Google kept in sidecar files back into the photos.
                It stops there: you get a folder of repaired photos, and whether it joins your library is up to you afterwards.
                Your .zip files are never modified.
              </p>
              <div>
                <h3>1 · Your Takeout files</h3>
                <div className="row">
                  <button className="btn" onClick={() => setPicking("zips")}>{zips.length ? "Change Files…" : "Choose .zip Files…"}</button>
                  {zips.length > 0 && <span className="muted small">{zips.length} file{zips.length === 1 ? "" : "s"} selected</span>}
                </div>
                {zips.length > 0 && <div className="muted small selectable" style={{ marginTop: 4, wordBreak: "break-all" }}>{zips.map(base).join(" · ")}</div>}
              </div>
              <div>
                <h3>2 · Where the photos should go</h3>
                <div className="row">
                  <button className="btn" onClick={() => setPicking("dest")}>{dest ? "Change Folder…" : "Choose a Folder…"}</button>
                  {dest && <span className="muted small selectable" style={{ wordBreak: "break-all" }}>{dest}</span>}
                </div>
                {dest && a && <p style={{ marginTop: 4 }}>The repaired photos go into a “{a.photos_root}” folder there. Nothing is added to your library — add that folder like any other if you want it in.</p>}
              </div>
              {analyze.isPending && (
                <div className="row"><div className="spin" /><span className="muted">Reading the archives…</span></div>
              )}
              {analyze.error ? <p className="note bad">{String(analyze.error)}</p> : null}
              {a && (
                <div className="panel" style={{ margin: 0 }}>
                  <div className="row wrap" style={{ gap: 16, marginBottom: 4 }}>
                    <span><strong className="num">{a.photos.toLocaleString()}</strong> photos</span>
                    {a.videos > 0 && <span><strong className="num">{a.videos.toLocaleString()}</strong> videos</span>}
                    <span><strong className="num">{fmtBytes(a.bytes)}</strong> on disk</span>
                  </div>
                  {a.albums.length > 0 && (
                    <p>
                      {a.albums.length} album{a.albums.length === 1 ? "" : "s"} — {a.albums.slice(0, 3).map((al) => `${al.name} (${al.count})`).join(", ")}
                      {a.albums.length > 3 ? ", …" : ""}. Kept as folders, and turned into Smriti albums if you add this folder to your library.
                    </p>
                  )}
                  {a.duplicate_paths > 0 && <p>{a.duplicate_paths.toLocaleString()} photos appear both in a year folder and in an album. Takeout stores those twice; Smriti links them, so they cost space once.</p>}
                  {a.looks_incomplete && (
                    <p className="note warn">
                      This looks like part of a larger export — {a.orphan_sidecars.toLocaleString()} metadata files describe photos that aren’t in the files you picked.
                      Importing anyway is fine: add the remaining parts later and Smriti fills in what was missing.
                    </p>
                  )}
                  {a.unreadable.length > 0 && <p className="note bad">Could not read: {a.unreadable.join(", ")}</p>}
                </div>
              )}
              <div className="prow" style={{ borderTop: 0, paddingTop: 0 }}>
                <button className={`switch${writeExif ? " on" : ""}`} aria-pressed={writeExif} aria-label="Write dates into the photo files" onClick={() => setWriteExif((v) => !v)} />
                <div>
                  <div className="t">Write the dates into the photos</div>
                  <div className="d">Fills in the capture date and location on photos that lost them, so other apps see them too. The image itself is never re-encoded; a photo that already has its own is left alone.</div>
                </div>
              </div>
              {start.error ? <p className="note bad">{String(start.error)}</p> : null}
            </div>
            <div className="sfoot">
              <button className="btn" onClick={onClose}>Cancel</button>
              <button className="btn primary" disabled={!zips.length || !dest || !a || start.isPending} onClick={() => start.mutate()}>
                {start.isPending ? "Starting…" : a ? `Repair ${a.total.toLocaleString()} Items` : "Repair"}
              </button>
            </div>
          </div>
        </div>
      </Portal>
      {picking === "zips" && <ZipPicker chosen={zips} onDone={(paths) => { setZips(paths); setPicking(null); }} onClose={() => setPicking(null)} />}
      {picking === "dest" && (
        <FolderPicker
          title="Where should the photos go?"
          submitLabel="Put Them Here"
          hint="Pick a folder with room to spare — the photos are copied out of the .zip files, so the import needs about as much space again."
          onPick={(p) => { setDest(p); setPicking(null); }}
          onClose={() => setPicking(null)}
        />
      )}
    </>
  );
}
