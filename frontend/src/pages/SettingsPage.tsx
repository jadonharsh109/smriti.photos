import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, fmtBytes, type Job, type Root, type Volume } from "../api/client";
import Portal from "../components/Portal";

interface FsList {
  path: string;
  parent: string | null;
  dirs: { name: string; path: string }[];
  media_count: number;
}
interface Stats {
  photos: number;
  videos: number;
  missing: number;
  with_gps: number;
  geocoded: number;
  faces: number;
  persons: number;
  face_pending: number;
  db_bytes: number;
  thumbs_bytes: number;
  previews_bytes: number;
  face_model_ready: boolean;
}

export default function SettingsPage() {
  const qc = useQueryClient();
  const [pickerOpen, setPickerOpen] = useState(false);

  const { data: volumes } = useQuery({ queryKey: ["volumes"], queryFn: () => api.get<Volume[]>("/api/volumes") });
  const { data: roots } = useQuery({ queryKey: ["roots"], queryFn: () => api.get<Root[]>("/api/roots") });
  const { data: jobs } = useQuery({
    queryKey: ["jobs"],
    queryFn: () => api.get<Job[]>("/api/jobs?limit=12"),
    refetchInterval: 3000,
  });
  const { data: stats } = useQuery({ queryKey: ["stats"], queryFn: () => api.get<Stats>("/api/stats") });

  const addRoot = useMutation({
    mutationFn: (path: string) => api.post<{ id: number }>("/api/roots", { path }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["roots"] });
      setPickerOpen(false);
    },
  });
  const delRoot = useMutation({
    mutationFn: (id: number) => api.del(`/api/roots/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["roots"] }),
  });
  const scan = useMutation({
    mutationFn: (rootId: number) => api.post("/api/scan", { root_id: rootId }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["jobs"] }),
  });
  const runJob = useMutation({
    mutationFn: (url: string) => api.post(url),
    onSettled: () => qc.invalidateQueries({ queryKey: ["jobs"] }),
  });
  const cancelJob = useMutation({
    mutationFn: (id: number) => api.post(`/api/jobs/${id}/cancel`),
    onSettled: () => qc.invalidateQueries({ queryKey: ["jobs"] }),
  });

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Library setup</h1>
          <p className="sub">
            Drives, folders and background jobs. Indexing never modifies your files; deleting always goes to the
            recoverable macOS Trash.
          </p>
        </div>
      </header>

      <div className="panel">
        <h2>Drives</h2>
        {(volumes ?? []).map((v) => (
          <div className="list-row" key={v.id}>
            <span>{v.internal ? "💻" : "🗄"}</span>
            <strong>{v.label}</strong>
            <span className="muted small">{v.mount_path}</span>
            <span className="spacer" />
            <span className="muted small">
              {v.free_bytes != null ? `${fmtBytes(v.free_bytes)} free of ${fmtBytes(v.total_bytes)}` : ""}
            </span>
            <span className={`badge ${v.is_online ? "green" : "red"}`}>{v.is_online ? "online" : "offline"}</span>
          </div>
        ))}
      </div>

      <div className="panel">
        <div className="row" style={{ marginBottom: 6 }}>
          <h2>Library folders</h2>
          <span className="spacer" />
          <button className="primary" onClick={() => setPickerOpen(true)}>
            + Add folder
          </button>
        </div>
        {(roots ?? []).length === 0 && <p className="muted">Pick the folder on your SSD that holds your photos.</p>}
        {(roots ?? []).map((r) => (
          <div className="list-row" key={r.id}>
            <strong>{r.abs_path}</strong>
            <span className="muted small">{r.file_count} files indexed</span>
            <span className={`badge ${r.is_online ? "green" : "red"}`}>{r.is_online ? "online" : "offline"}</span>
            <span className="spacer" />
            <button onClick={() => scan.mutate(r.id)} disabled={!r.is_online || scan.isPending}>
              Scan
            </button>
            <button className="danger" onClick={() => delRoot.mutate(r.id)}>
              Remove
            </button>
          </div>
        ))}
        {scan.error ? <p className="small" style={{ color: "var(--danger)" }}>{String(scan.error)}</p> : null}
      </div>

      <div className="panel">
        <h2>Processing</h2>
        <div className="row">
          <button onClick={() => runJob.mutate("/api/places/geocode")}>Locate photos (offline geocode)</button>
          <button onClick={() => runJob.mutate("/api/events/rebuild")}>Rebuild events</button>
          <button onClick={() => runJob.mutate("/api/dupes/run")}>Find near-duplicates</button>
          <button onClick={() => runJob.mutate("/api/faces/scan")} disabled={!stats?.face_model_ready}>
            Scan faces
          </button>
          <button onClick={() => runJob.mutate("/api/faces/recluster")} disabled={!stats?.face_model_ready}>
            Group into people
          </button>
        </div>
        {!stats?.face_model_ready && (
          <p className="muted small" style={{ marginTop: 10 }}>
            Face models not downloaded yet — run <code>uv run python scripts/fetch_models.py</code> once (≈280 MB, the
            only download the app ever needs).
          </p>
        )}
        {runJob.error ? <p className="small" style={{ color: "var(--danger)" }}>{String(runJob.error)}</p> : null}
      </div>

      <div className="panel">
        <h2>Recent jobs</h2>
        {(jobs ?? []).length === 0 && <p className="muted small">Nothing has run yet.</p>}
        {(jobs ?? []).map((j) => (
          <div className="list-row" key={j.id}>
            <span className="badge">{j.kind}</span>
            <span
              className={`small ${j.status === "failed" || j.status === "interrupted" ? "" : "muted"}`}
              style={j.status === "failed" ? { color: "var(--danger)" } : undefined}
            >
              {j.status}
            </span>
            {j.status === "running" && j.total > 0 && (
              <div className="progress">
                <div style={{ width: `${Math.round((j.done / j.total) * 100)}%` }} />
              </div>
            )}
            <span className="muted small">
              {j.done}/{j.total} {j.message ?? ""}
            </span>
            <span className="spacer" />
            {j.status === "running" && <button onClick={() => cancelJob.mutate(j.id)}>Cancel</button>}
          </div>
        ))}
      </div>

      {stats && (
        <div className="panel">
          <h2>Storage &amp; index</h2>
          <div className="stat-grid">
            <div className="stat-tile"><div className="v">{stats.photos.toLocaleString()}</div><div className="k">photos</div></div>
            <div className="stat-tile"><div className="v">{stats.videos.toLocaleString()}</div><div className="k">videos</div></div>
            <div className="stat-tile"><div className="v">{stats.missing.toLocaleString()}</div><div className="k">missing (drive offline?)</div></div>
            <div className="stat-tile"><div className="v">{stats.with_gps.toLocaleString()}</div><div className="k">with GPS</div></div>
            <div className="stat-tile"><div className="v">{stats.faces.toLocaleString()}</div><div className="k">faces</div></div>
            <div className="stat-tile"><div className="v">{fmtBytes(stats.db_bytes)}</div><div className="k">database</div></div>
            <div className="stat-tile"><div className="v">{fmtBytes(stats.thumbs_bytes)}</div><div className="k">thumbnails</div></div>
            <div className="stat-tile"><div className="v">{fmtBytes(stats.previews_bytes)}</div><div className="k">previews</div></div>
          </div>
        </div>
      )}

      {pickerOpen && <FolderPicker onPick={(p) => addRoot.mutate(p)} onClose={() => setPickerOpen(false)} />}
    </div>
  );
}

function FolderPicker({ onPick, onClose }: { onPick: (path: string) => void; onClose: () => void }) {
  const [path, setPath] = useState("/Volumes");
  const { data } = useQuery({
    queryKey: ["fs", path],
    queryFn: () => api.get<FsList>(`/api/fs/list?path=${encodeURIComponent(path)}`),
  });
  return (
    <Portal>
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header>Choose a photos folder</header>
        <div className="modal-body">
          <div className="row" style={{ marginBottom: 8 }}>
            <button disabled={!data?.parent} onClick={() => data?.parent && setPath(data.parent)}>
              ↑ Up
            </button>
            <span className="muted small" style={{ wordBreak: "break-all" }}>{data?.path ?? path}</span>
          </div>
          {data?.media_count ? (
            <p className="small muted" style={{ marginBottom: 6 }}>
              {data.media_count} photo/video files directly in this folder
            </p>
          ) : null}
          {(data?.dirs ?? []).map((d) => (
            <div key={d.path} className="dir-row" onClick={() => setPath(d.path)}>
              <span>📁</span> {d.name}
            </div>
          ))}
          {data && data.dirs.length === 0 && <p className="muted small">No subfolders.</p>}
        </div>
        <footer>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => onPick(path)}>
            Use this folder
          </button>
        </footer>
      </div>
    </div>
    </Portal>
  );
}
