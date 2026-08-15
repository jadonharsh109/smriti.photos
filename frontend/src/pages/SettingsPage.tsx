import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, fmtBytes, type Job, type Root, type Volume } from "../api/client";
import { ConfirmDialog, PasswordDialog } from "../components/Dialogs";
import Portal from "../components/Portal";
import { useLocked, type LockedStatus } from "../locked/LockedContext";

interface FsList {
  path: string;
  parent: string | null;
  dirs: { name: string; path: string }[];
  media_count: number;
}
interface AppSettings {
  auto_scan: boolean;
  auto_scan_minutes: number;
  locked_auto_minutes: number;
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

const STAGES: { kind: string; label: string }[] = [
  { kind: "scan", label: "Index" },
  { kind: "geocode", label: "Locate" },
  { kind: "events", label: "Events" },
  { kind: "neardup", label: "Duplicates" },
  { kind: "faces", label: "Faces" },
  { kind: "recluster", label: "People" },
];
const STAGE_LABEL = Object.fromEntries(STAGES.map((s) => [s.kind, s.label]));

const fmtLine = (time: string, j: Job) =>
  `${time}  ${STAGE_LABEL[j.kind] ?? j.kind} · ${j.status}` +
  (j.total > 0 ? ` ${j.done}/${j.total}` : "") +
  (j.errors ? ` (${j.errors} errors)` : "") +
  (j.message ? ` — ${j.message}` : "");

export default function SettingsPage() {
  const qc = useQueryClient();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [lockedDlg, setLockedDlg] = useState<
    null | { kind: "current" } | { kind: "new"; current: string } | { kind: "unlock"; then: "enroll" | "remove" }
  >(null);
  const [lockedNote, setLockedNote] = useState<string | null>(null);
  const lockedApi = useLocked();
  const [showLogs, setShowLogs] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  const { data: volumes } = useQuery({ queryKey: ["volumes"], queryFn: () => api.get<Volume[]>("/api/volumes") });
  const { data: roots } = useQuery({ queryKey: ["roots"], queryFn: () => api.get<Root[]>("/api/roots") });
  const { data: jobs } = useQuery({
    queryKey: ["jobs"],
    queryFn: () => api.get<Job[]>("/api/jobs?limit=30"),
    refetchInterval: 2500,
  });
  const { data: stats } = useQuery({ queryKey: ["stats"], queryFn: () => api.get<Stats>("/api/stats") });
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: () => api.get<AppSettings>("/api/settings") });
  const { data: lockedStatus } = useQuery({
    queryKey: ["locked", "status"],
    queryFn: () => api.get<LockedStatus>("/api/locked/status"),
  });

  // live log: seed with recent history once, then append from the SSE stream
  useEffect(() => {
    let dead = false;
    api.get<Job[]>("/api/jobs?limit=30").then((history) => {
      if (dead) return;
      const lines = [...history]
        .reverse()
        .map((j) => fmtLine(j.started_at ? new Date(j.started_at * 1000).toLocaleTimeString() : "—", j));
      setLog(lines);
    });
    const es = new EventSource("/api/jobs/stream");
    es.addEventListener("job", (e) => {
      const j: Job = JSON.parse((e as MessageEvent).data);
      setLog((prev) => [...prev.slice(-299), fmtLine(new Date().toLocaleTimeString(), j)]);
    });
    return () => {
      dead = true;
      es.close();
    };
  }, []);

  // keep the console pinned to the latest line
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log, showLogs]);

  const addRoot = useMutation({
    mutationFn: (path: string) => api.post<{ id: number }>("/api/roots", { path }),
    onSuccess: async (r) => {
      qc.invalidateQueries({ queryKey: ["roots"] });
      setPickerOpen(false);
      await api.post("/api/process", { root_id: r.id }); // index + everything else, automatically
      setShowLogs(true);
      qc.invalidateQueries({ queryKey: ["jobs"] });
    },
  });
  const reprocess = useMutation({
    mutationFn: (rootId: number) => api.post("/api/process", { root_id: rootId }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["jobs"] }),
  });
  const delRoot = useMutation({
    mutationFn: (id: number) => api.del(`/api/roots/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["roots"] }),
  });
  const runJob = useMutation({
    mutationFn: (url: string) => api.post(url),
    onSettled: () => qc.invalidateQueries({ queryKey: ["jobs"] }),
  });
  const cancelJob = useMutation({
    mutationFn: (id: number) => api.post(`/api/jobs/${id}/cancel`),
    onSettled: () => qc.invalidateQueries({ queryKey: ["jobs"] }),
  });
  const saveSettings = useMutation({
    mutationFn: (patch: Partial<AppSettings>) => api.post<AppSettings>("/api/settings", patch),
    onSuccess: (s) => qc.setQueryData(["settings"], s),
  });
  const checkNow = useMutation({
    mutationFn: () => api.post("/api/autoscan/run"),
    onSuccess: () => {
      setShowLogs(true);
      qc.invalidateQueries({ queryKey: ["jobs"] });
    },
  });

  const doTouchId = async (what: "enroll" | "remove") => {
    setLockedNote(null);
    try {
      if (what === "enroll") {
        await lockedApi.enrollTouchId();
        setLockedNote("Touch ID enabled for unlocking.");
      } else {
        await lockedApi.removeTouchId();
        setLockedNote("Touch ID removed.");
      }
    } catch (e) {
      setLockedNote(String((e as Error).message ?? e));
    }
  };
  const touchId = (what: "enroll" | "remove") => {
    if (lockedApi.token) doTouchId(what);
    else setLockedDlg({ kind: "unlock", then: what });
  };

  // latest job per stage drives the pipeline strip
  const latest: Record<string, Job> = {};
  for (const j of jobs ?? []) if (!latest[j.kind]) latest[j.kind] = j;
  const running = (jobs ?? []).find((j) => j.status === "running");

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Library setup</h1>
          <p className="sub">
            Add a folder and Smriti does the rest — indexing, locations, events, duplicates, faces and people
            all run automatically.
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
        {(roots ?? []).length === 0 && (
          <p className="muted">
            Pick the folder that holds your photos — everything else happens on its own.
          </p>
        )}
        {(roots ?? []).map((r) => (
          <div className="list-row" key={r.id}>
            <strong>{r.abs_path}</strong>
            <span className="muted small">{r.file_count} files indexed</span>
            <span className={`badge ${r.is_online ? "green" : "red"}`}>{r.is_online ? "online" : "offline"}</span>
            <span className="spacer" />
            <button
              onClick={() => reprocess.mutate(r.id)}
              disabled={!r.is_online || !!running}
              title="Re-index this folder and re-run all processing"
            >
              Re-process
            </button>
            <button className="danger" onClick={() => delRoot.mutate(r.id)}>
              Remove
            </button>
          </div>
        ))}
        {(addRoot.error || reprocess.error) && (
          <p className="small" style={{ color: "var(--danger)" }}>{String(addRoot.error ?? reprocess.error)}</p>
        )}

        {/* pipeline status strip */}
        <div className="row" style={{ marginTop: 14, gap: 8 }}>
          {STAGES.map((s) => {
            const j = latest[s.kind];
            const state =
              j?.status === "running" ? "run" : j?.status === "done" ? "done" : j?.status === "failed" ? "fail" : "";
            return (
              <span key={s.kind} className={`chip stage ${state}`} title={j?.message ?? ""}>
                {state === "run" ? <span className="spin" /> : <span className="dot" />}
                {s.label}
                {state === "run" && j!.total > 0 && (
                  <span className="faint">{Math.round((j!.done / j!.total) * 100)}%</span>
                )}
              </span>
            );
          })}
          {running && (
            <button className="small" onClick={() => cancelJob.mutate(running.id)}>
              Cancel
            </button>
          )}
        </div>
        {!stats?.face_model_ready && (
          <p className="muted small" style={{ marginTop: 10 }}>
            Faces &amp; People will be skipped until the models are downloaded — run{" "}
            <code>uv run python scripts/fetch_models.py</code> once (≈280 MB, the only download the app ever needs).
          </p>
        )}
      </div>

      <div className="panel">
        <div className="row">
          <h2 style={{ marginBottom: 0 }}>Automatic scanning</h2>
          <span className="spacer" />
          <button className="small" onClick={() => checkNow.mutate()} disabled={!!running || checkNow.isPending}>
            Check now
          </button>
          <button
            className={`switch${settings?.auto_scan ? " on" : ""}`}
            aria-pressed={settings?.auto_scan ?? false}
            title={settings?.auto_scan ? "Turn off automatic scanning" : "Turn on automatic scanning"}
            onClick={() => saveSettings.mutate({ auto_scan: !settings?.auto_scan })}
          />
        </div>
        <p className="muted small" style={{ marginTop: 8 }}>
          Smriti watches your folders for new photos and processes them automatically
          {settings?.auto_scan ? ` — checking every ${settings.auto_scan_minutes} minutes.` : " — currently off."}
        </p>
        {settings?.auto_scan && (
          <div className="row" style={{ marginTop: 10 }}>
            <span className="muted small">Check every</span>
            <div className="seg">
              {[10, 30, 60].map((m) => (
                <button
                  key={m}
                  className={settings.auto_scan_minutes === m ? "on" : ""}
                  onClick={() => saveSettings.mutate({ auto_scan_minutes: m })}
                >
                  {m === 60 ? "1 hour" : `${m} min`}
                </button>
              ))}
            </div>
          </div>
        )}
        {checkNow.error && <p className="small" style={{ color: "var(--danger)" }}>{String(checkNow.error)}</p>}
      </div>

      <div className="panel">
        <div className="row">
          <h2 style={{ marginBottom: 0 }}>Locked folder</h2>
          <span className="spacer" />
          {lockedStatus?.configured && (
            <>
              <button className="small" onClick={() => setLockedDlg({ kind: "current" })}>
                Change PIN
              </button>
              {lockedApi.touchIdAvailable &&
                (lockedStatus.webauthn_enrolled ? (
                  <button className="small" onClick={() => touchId("remove")}>Remove Touch ID</button>
                ) : (
                  <button className="small" onClick={() => touchId("enroll")}>Enable Touch ID</button>
                ))}
            </>
          )}
        </div>
        {!lockedStatus?.configured ? (
          <p className="muted small" style={{ marginTop: 8 }}>
            Not set up yet — open the <Link to="/locked">Locked Folder</Link> to create a PIN and start
            hiding private photos.
          </p>
        ) : (
          <>
            <p className="muted small" style={{ marginTop: 8 }}>
              Photos in the Locked Folder are encrypted and hidden everywhere else. It relocks when the tab
              is hidden, after inactivity, or on demand. A forgotten PIN cannot be recovered.
            </p>
            <div className="row" style={{ marginTop: 10 }}>
              <span className="muted small">Auto-lock after</span>
              <div className="seg">
                {[1, 5, 15].map((m) => (
                  <button
                    key={m}
                    className={settings?.locked_auto_minutes === m ? "on" : ""}
                    onClick={() => saveSettings.mutate({ locked_auto_minutes: m })}
                  >
                    {m} min
                  </button>
                ))}
              </div>
            </div>
            {!lockedApi.touchIdAvailable && lockedStatus.webauthn_enrolled === false && (
              <p className="muted small" style={{ marginTop: 8 }}>
                Tip: open the app at http://localhost to enable Touch ID unlock.
              </p>
            )}
          </>
        )}
        {lockedNote && <p className="small muted" style={{ marginTop: 8 }}>{lockedNote}</p>}
      </div>

      <div className="panel">
        <div className="row">
          <h2 style={{ marginBottom: 0 }}>Activity</h2>
          <span className="muted small">
            {running
              ? `${STAGE_LABEL[running.kind] ?? running.kind} running${running.total > 0 ? ` — ${running.done}/${running.total}` : ""}…`
              : "idle"}
          </span>
          <span className="spacer" />
          <button onClick={() => setShowLogs((s) => !s)}>{showLogs ? "Hide logs" : "Show logs"}</button>
        </div>
        {showLogs && (
          <div className="logbox" ref={logRef}>
            {log.length === 0 ? (
              <span className="faint">Nothing yet — add a folder to start.</span>
            ) : (
              log.map((l, i) => (
                <div key={i} className="log-line">
                  {l}
                </div>
              ))
            )}
          </div>
        )}
      </div>

      <div className="panel">
        <h2>Manual steps</h2>
        <p className="muted small" style={{ marginBottom: 10 }}>
          Everything above runs automatically — use these only to re-run a single step.
        </p>
        <div className="row">
          <button onClick={() => runJob.mutate("/api/places/geocode")}>Locate photos</button>
          <button onClick={() => runJob.mutate("/api/events/rebuild")}>Rebuild events</button>
          <button onClick={() => runJob.mutate("/api/dupes/run")}>Find near-duplicates</button>
          <button onClick={() => runJob.mutate("/api/faces/scan")} disabled={!stats?.face_model_ready}>
            Scan faces
          </button>
          <button onClick={() => runJob.mutate("/api/faces/recluster")} disabled={!stats?.face_model_ready}>
            Group into people
          </button>
          <button className="danger" onClick={() => setConfirmingReset(true)} disabled={!stats?.face_model_ready}>
            Reset people…
          </button>
        </div>
        {runJob.error ? <p className="small" style={{ color: "var(--danger)" }}>{String(runJob.error)}</p> : null}
      </div>

      {confirmingReset && (
        <ConfirmDialog
          title="Reset all people?"
          body="Every person is forgotten — names, merges and manual fixes included — and all faces are regrouped from scratch. Face detection is kept, so this only takes a moment."
          confirmLabel="Reset & regroup"
          danger
          onConfirm={() => {
            runJob.mutate("/api/faces/reset");
            setShowLogs(true);
          }}
          onClose={() => setConfirmingReset(false)}
        />
      )}

      {lockedDlg?.kind === "current" && (
        <PasswordDialog
          title="Change Locked Folder PIN"
          body="Enter your current PIN first."
          placeholder="Current PIN"
          submitLabel="Next"
          onSubmit={(pin) => setLockedDlg({ kind: "new", current: pin })}
          onClose={() => setLockedDlg(null)}
        />
      )}
      {lockedDlg?.kind === "new" && (
        <PasswordDialog
          title="Choose a new PIN"
          body="At least 6 characters — longer is stronger. There is no recovery if you forget it."
          placeholder="New PIN"
          submitLabel="Change PIN"
          onSubmit={async (pin) => {
            const current = lockedDlg.current;
            setLockedDlg(null);
            setLockedNote(null);
            try {
              await api.post("/api/locked/change-pin", { current_pin: current, new_pin: pin });
              setLockedNote("PIN changed.");
            } catch (e) {
              setLockedNote(String((e as Error).message ?? e));
            }
          }}
          onClose={() => setLockedDlg(null)}
        />
      )}
      {lockedDlg?.kind === "unlock" && (
        <PasswordDialog
          title="Unlock Locked Folder"
          body="Managing Touch ID needs the vault unlocked."
          onSubmit={async (pin) => {
            const then = lockedDlg.then;
            setLockedDlg(null);
            try {
              await lockedApi.unlockPin(pin);
              await doTouchId(then);
            } catch (e) {
              setLockedNote(String((e as Error).message ?? e));
            }
          }}
          onClose={() => setLockedDlg(null)}
        />
      )}

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
  // "" = the platform's natural starting point (macOS: /Volumes, Windows: drive list)
  const [path, setPath] = useState("");
  const { data } = useQuery({
    queryKey: ["fs", path],
    queryFn: () => api.get<FsList>(`/api/fs/list?path=${encodeURIComponent(path)}`),
  });
  const atSyntheticRoot = data?.path === "This PC";
  return (
    <Portal>
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header>Choose a photos folder</header>
        <div className="modal-body">
          <div className="row" style={{ marginBottom: 8 }}>
            <button
              disabled={data?.parent == null}
              onClick={() => data && data.parent != null && setPath(data.parent)}
            >
              ↑ Up
            </button>
            <button onClick={() => setPath("~")}>Home</button>
            <span className="muted small" style={{ wordBreak: "break-all" }}>{data?.path ?? "…"}</span>
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
          <button
            className="primary"
            disabled={!data || atSyntheticRoot}
            onClick={() => data && onPick(data.path)}
          >
            Use this folder &amp; process everything
          </button>
        </footer>
      </div>
    </div>
    </Portal>
  );
}
