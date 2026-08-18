import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, fmtBytes } from "../api/client";
import FolderPicker, { type FsList } from "./FolderPicker";
import { IconClose } from "./Icons";
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

/** Pick the .zip parts of a Takeout export.
 *
 * Google hands out an export as numbered parts, and a photo's metadata
 * routinely sits in a different part from the photo itself — so this is
 * deliberately multi-select, and the summary afterwards says plainly when the
 * set looks incomplete. */
function ZipPicker({
  chosen,
  onDone,
  onClose,
}: {
  chosen: string[];
  onDone: (paths: string[]) => void;
  onClose: () => void;
}) {
  const [path, setPath] = useState("");
  const [sel, setSel] = useState<Record<string, number>>(
    Object.fromEntries(chosen.map((c) => [c, 0]))
  );
  const { data } = useQuery({
    queryKey: ["fs-zip", path],
    queryFn: () => api.get<FsList>(`/api/fs/list?include=zip&path=${encodeURIComponent(path)}`),
  });
  const looksLikeTakeout = (n: string) => /takeout|google/i.test(n);
  const files = [...(data?.files ?? [])].sort(
    (a, b) => Number(looksLikeTakeout(b.name)) - Number(looksLikeTakeout(a.name))
  );
  const takeouts = files.filter((f) => looksLikeTakeout(f.name));
  const toggle = (p: string, size: number) =>
    setSel((prev) => {
      const next = { ...prev };
      if (p in next) delete next[p];
      else next[p] = size;
      return next;
    });
  const count = Object.keys(sel).length;

  return (
    <Portal>
      <div className="modal-back" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <header>Choose your Takeout .zip files</header>
          <div className="modal-body">
            <div className="row" style={{ marginBottom: 8 }}>
              <button disabled={data?.parent == null} onClick={() => data && data.parent != null && setPath(data.parent)}>
                ↑ Up
              </button>
              <button onClick={() => setPath("~")}>Home</button>
              <span className="muted small" style={{ wordBreak: "break-all" }}>{data?.path ?? "…"}</span>
            </div>
            {files.length > 0 && (
              <div className="row" style={{ marginBottom: 8 }}>
                <button
                  className="small"
                  onClick={() =>
                    setSel((prev) => {
                      const next = { ...prev };
                      for (const f of takeouts.length ? takeouts : files) next[f.path] = f.size;
                      return next;
                    })
                  }
                >
                  {takeouts.length
                    ? `Select all ${takeouts.length} Takeout ${takeouts.length === 1 ? "file" : "files"}`
                    : `Select all ${files.length} here`}
                </button>
              </div>
            )}
            {(data?.dirs ?? []).map((d) => (
              <div key={d.path} className="dir-row" onClick={() => setPath(d.path)}>
                <span>📁</span> {d.name}
              </div>
            ))}
            {files.map((f) => (
              <div
                key={f.path}
                className="dir-row"
                onClick={() => toggle(f.path, f.size)}
                style={{ opacity: f.path in sel ? 1 : 0.78 }}
              >
                <span>{f.path in sel ? "☑" : "☐"}</span> {f.name}
                <span className="spacer" />
                <span className="muted small">{fmtBytes(f.size)}</span>
              </div>
            ))}
            {data && data.dirs.length === 0 && files.length === 0 && (
              <p className="muted small">Nothing here. Takeout files are usually in Downloads.</p>
            )}
          </div>
          <footer>
            <button onClick={onClose}>Cancel</button>
            <button className="primary" disabled={count === 0} onClick={() => onDone(Object.keys(sel))}>
              {count === 0 ? "Select files" : `Use ${count} file${count === 1 ? "" : "s"}`}
            </button>
          </footer>
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

  const analyze = useMutation({
    mutationFn: (archives: string[]) =>
      api.post<Analysis>("/api/takeout/analyze", { archives }),
  });
  const start = useMutation({
    mutationFn: () =>
      api.post<{ job_id: number }>("/api/takeout/import", {
        archives: zips,
        destination: dest,
        write_exif: writeExif,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["jobs"] });
      onClose();
    },
  });

  // Reading the archives' tables of contents takes a fraction of a second, so
  // the summary can just appear rather than hiding behind another button.
  useEffect(() => {
    if (zips.length) analyze.mutate(zips);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zips]);

  const a = analyze.data;
  return (
    <>
      <Portal>
        <div className="modal-back" onClick={onClose}>
          <div className="modal" style={{ width: 640 }} onClick={(e) => e.stopPropagation()}>
            <header>
              Import from Google Takeout
              <span className="spacer" />
              <button className="icon-btn" style={{ width: 30, height: 30 }} onClick={onClose}>
                <IconClose size={15} />
              </button>
            </header>
            <div className="modal-body" style={{ display: "grid", gap: 16 }}>
              <p className="muted small">
                Smriti unpacks the export and puts the dates and places Google kept in its
                sidecar files back into the photos. It stops there: you get a folder of
                repaired photos, and whether it joins your library is up to you afterwards.
                Your original .zip files are never modified.
              </p>

              {/* ---- 1. the archives ---- */}
              <div>
                <strong>1 · Your Takeout files</strong>
                <div className="row" style={{ marginTop: 8 }}>
                  <button onClick={() => setPicking("zips")}>
                    {zips.length ? "Change files…" : "Choose .zip files…"}
                  </button>
                  {zips.length > 0 && (
                    <span className="muted small">
                      {zips.length} file{zips.length === 1 ? "" : "s"} selected
                    </span>
                  )}
                </div>
                {zips.length > 0 && (
                  <div className="muted small" style={{ marginTop: 6, wordBreak: "break-all" }}>
                    {zips.map(base).join(" · ")}
                  </div>
                )}
              </div>

              {/* ---- 2. where it lands ---- */}
              <div>
                <strong>2 · Where the photos should go</strong>
                <div className="row" style={{ marginTop: 8 }}>
                  <button onClick={() => setPicking("dest")}>
                    {dest ? "Change folder…" : "Choose a folder…"}
                  </button>
                  {dest && <span className="muted small" style={{ wordBreak: "break-all" }}>{dest}</span>}
                </div>
                {dest && a && (
                  <p className="muted small" style={{ marginTop: 6 }}>
                    The repaired photos go into a “{a.photos_root}” folder there. Nothing is
                    added to your library — add that folder like any other if you want it in.
                  </p>
                )}
              </div>

              {/* ---- 3. what we found ---- */}
              {analyze.isPending && (
                <div className="row" style={{ gap: 10 }}>
                  <div className="spin" />
                  <span className="muted">Reading the archives…</span>
                </div>
              )}
              {analyze.error ? (
                <p className="small" style={{ color: "var(--danger)" }}>{String(analyze.error)}</p>
              ) : null}
              {a && (
                <div className="panel setup-summary" style={{ margin: 0 }}>
                  <div className="ss-counts">
                    <span><strong>{a.photos.toLocaleString()}</strong> photos</span>
                    {a.videos > 0 && <span><strong>{a.videos.toLocaleString()}</strong> videos</span>}
                    <span><strong>{fmtBytes(a.bytes)}</strong> on disk</span>
                  </div>
                  {a.albums.length > 0 && (
                    <p className="muted small">
                      {a.albums.length} album{a.albums.length === 1 ? "" : "s"} —{" "}
                      {a.albums.slice(0, 3).map((al) => `${al.name} (${al.count})`).join(", ")}
                      {a.albums.length > 3 ? ", …" : ""}. Kept as folders, and turned into Smriti
                      albums if you ever add this folder to your library.
                    </p>
                  )}
                  {a.duplicate_paths > 0 && (
                    <p className="muted small">
                      {a.duplicate_paths.toLocaleString()} photos appear both in a year folder and in
                      an album. Takeout stores those twice; Smriti links them, so they cost space once.
                    </p>
                  )}
                  {a.looks_incomplete && (
                    <p className="small" style={{ color: "var(--peach)", marginTop: 6 }}>
                      This looks like part of a larger export — {a.orphan_sidecars.toLocaleString()}{" "}
                      metadata files describe photos that aren’t in the files you picked. Importing
                      anyway is fine: add the remaining parts later and Smriti fills in what was missing.
                    </p>
                  )}
                  {a.unreadable.length > 0 && (
                    <p className="small" style={{ color: "var(--danger)", marginTop: 6 }}>
                      Could not read: {a.unreadable.join(", ")}
                    </p>
                  )}
                </div>
              )}

              <label className="row" style={{ gap: 12, cursor: "pointer", alignItems: "flex-start" }}>
                <button
                  className={`switch${writeExif ? " on" : ""}`}
                  aria-pressed={writeExif}
                  aria-label="Write dates into the photo files"
                  onClick={(e) => { e.preventDefault(); setWriteExif((v) => !v); }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <strong>Write the dates into the photos</strong>
                  <p className="muted small" style={{ marginTop: 2 }}>
                    Fills in the capture date and location on photos that lost them, so other apps
                    see them too. The image itself is never re-encoded, and a photo that already has
                    its own is left alone.
                  </p>
                </div>
              </label>
              {start.error ? (
                <p className="small" style={{ color: "var(--danger)" }}>{String(start.error)}</p>
              ) : null}
            </div>
            <footer>
              <button onClick={onClose}>Cancel</button>
              <button
                className="primary"
                disabled={!zips.length || !dest || !a || start.isPending}
                onClick={() => start.mutate()}
              >
                {start.isPending ? "Starting…" : a ? `Repair ${a.total.toLocaleString()} items` : "Repair"}
              </button>
            </footer>
          </div>
        </div>
      </Portal>

      {picking === "zips" && (
        <ZipPicker
          chosen={zips}
          onDone={(paths) => { setZips(paths); setPicking(null); }}
          onClose={() => setPicking(null)}
        />
      )}
      {picking === "dest" && (
        <FolderPicker
          title="Where should the photos go?"
          submitLabel="Put them here"
          hint="Pick a folder with room to spare — the photos are copied out of the .zip files, so the import needs about as much space again."
          onPick={(p) => { setDest(p); setPicking(null); }}
          onClose={() => setPicking(null)}
        />
      )}
    </>
  );
}
