import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, fmtBytes, type Job, type Root, type Volume } from "../api/client";
import { ConfirmDialog } from "../components/Dialogs";
import { ArtFolder } from "../components/Illustrations";
import Portal from "../components/Portal";
import { friendlyError, stageLabel, stageNote, stageSentence, stageUnit } from "../lib/stages";

interface FsList {
  path: string;
  parent: string | null;
  dirs: { name: string; path: string }[];
  media_count: number;
}
interface Removal {
  files: number;
  photos: number;
  videos: number;
  faces: number;
  locked: number;
}
interface AppSettings {
  auto_scan: boolean;
  auto_scan_minutes: number;
}
interface Stats {
  photos: number;
  videos: number;
  missing: number;
  with_gps: number;
  geocoded: number;
  faces: number;
  persons: number;
  people_visible: number;
  face_pending: number;
  db_bytes: number;
  thumbs_bytes: number;
  previews_bytes: number;
  face_model_ready: boolean;
}

/** Stages the pipeline runs by itself, in order — used only by the Advanced
 *  log, since the calm view shows one sentence rather than six dots. */
const STAGES = ["scan", "classify", "geocode", "events", "neardup", "faces", "recluster"] as const;

const fmtLine = (time: string, j: Job) =>
  `${time}  ${stageLabel(j.kind)} · ${j.status}` +
  (j.total > 0 ? ` ${j.done}/${j.total}` : "") +
  (j.errors ? ` (${j.errors} errors)` : "") +
  (j.message ? ` — ${j.message}` : "");

const n = (x: number | undefined) => (x ?? 0).toLocaleString();

export default function SettingsPage() {
  const qc = useQueryClient();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState<Root | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [live, setLive] = useState<Record<number, Job>>({});
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

  // live log: seed with recent history once, then append from the SSE stream
  useEffect(() => {
    let dead = false;
    api.get<Job[]>("/api/jobs?limit=30").then((history) => {
      if (dead) return;
      setLog(
        [...history]
          .reverse()
          .map((j) => fmtLine(j.started_at ? new Date(j.started_at * 1000).toLocaleTimeString() : "—", j))
      );
    });
    const es = new EventSource("/api/jobs/stream");
    es.addEventListener("job", (e) => {
      const j: Job = JSON.parse((e as MessageEvent).data);
      setLog((prev) => [...prev.slice(-299), fmtLine(new Date().toLocaleTimeString(), j)]);
      setLive((prev) => ({ ...prev, [j.id]: j }));
    });
    return () => {
      dead = true;
      es.close();
    };
  }, []);

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

  // The 2.5s poll is the history; SSE is the present. Merging them (live wins)
  // keeps this page's progress identical to the sidebar card's, which reads the
  // same stream — otherwise the two show different percentages side by side.
  const byId = new Map<number, Job>();
  for (const j of jobs ?? []) byId.set(j.id, j);
  for (const j of Object.values(live)) byId.set(j.id, j);
  const allJobs = [...byId.values()].sort((a, b) => b.id - a.id);

  const latest: Record<string, Job> = {};
  for (const j of allJobs) if (!latest[j.kind]) latest[j.kind] = j;
  const running = allJobs.find((j) => j.status === "running");

  // ---- which of the four faces is this page wearing? ----------------------
  const rootList = roots ?? [];
  const media = (stats?.photos ?? 0) + (stats?.videos ?? 0);
  const offline = rootList.filter((r) => !r.is_online);
  const allOffline = rootList.length > 0 && offline.length === rootList.length;
  const lastFailed = allJobs.find((j) => j.status === "failed");

  // Progress takes the whole page only during the very first index, when there
  // is genuinely nothing else to show. Once photos exist, a running job — an
  // automatic scan, say — is a banner above the normal page, so opening this
  // page mid-scan never hides the folders or the settings.
  const firstIndex = !!running && media === 0;
  const view: "invite" | "working" | "attention" | "ready" =
    rootList.length === 0 ? "invite"
    : firstIndex ? "working"
    : running ? "ready"
    : allOffline || media === 0 ? "attention"
    : "ready";

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Your library</h1>
          <p className="sub">
            {view === "invite"
              ? "Point Smriti at a folder and it takes care of the rest."
              : "The folders Smriti watches, and what it has found in them."}
          </p>
        </div>
      </header>

      {view === "invite" && <Invite onChoose={() => setPickerOpen(true)} error={addRoot.error} />}

      {view === "working" && (
        <Working job={running!} onStop={() => cancelJob.mutate(running!.id)} />
      )}

      {view === "attention" && (
        <Attention
          roots={rootList}
          allOffline={allOffline}
          onChoose={() => setPickerOpen(true)}
          onRefresh={(id) => reprocess.mutate(id)}
          onRemove={(r) => setConfirmingRemove(r)}
        />
      )}

      {view === "ready" && running && (
        <Working job={running} onStop={() => cancelJob.mutate(running.id)} />
      )}

      {view === "ready" && (
        <Ready
          roots={rootList}
          stats={stats}
          onChoose={() => setPickerOpen(true)}
          onRefresh={(id) => reprocess.mutate(id)}
          onRemove={(r) => setConfirmingRemove(r)}
          onEnablePeople={() => runJob.mutate("/api/models/download")}
        />
      )}

      {/* Auto-scan is a single decision, so it reads as a single sentence.
          The 10/30/60 interval is tuning, and lives in Advanced. */}
      {view !== "invite" && (
        <div className="panel setup-row">
          <div>
            <strong>Add new photos automatically</strong>
            <p className="muted small" style={{ marginTop: 3 }}>
              {settings?.auto_scan
                ? "Smriti checks your folders now and then and picks up anything new."
                : "New photos won't appear until you refresh a folder yourself."}
            </p>
          </div>
          <span className="spacer" />
          <button
            className={`switch${settings?.auto_scan ? " on" : ""}`}
            aria-pressed={settings?.auto_scan ?? false}
            aria-label="Add new photos automatically"
            onClick={() => saveSettings.mutate({ auto_scan: !settings?.auto_scan })}
          />
        </div>
      )}

      {/* Everything below is machinery: kept in full, closed by default. */}
      <details className="adv">
        <summary>Advanced</summary>

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
          <div className="row">
            <h2 style={{ marginBottom: 0 }}>Activity</h2>
            <span className="muted small">
              {running
                ? `${stageLabel(running.kind)}${running.total > 0 ? ` — ${running.done}/${running.total}` : ""}…`
                : "idle"}
            </span>
            <span className="spacer" />
            <button className="small" onClick={() => checkNow.mutate()} disabled={!!running || checkNow.isPending}>
              Check now
            </button>
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
          {/* the stage strip: precise, and now only where precision is wanted */}
          <div className="row" style={{ marginTop: 12, gap: 8, flexWrap: "wrap" }}>
            {STAGES.map((kind) => {
              const j = latest[kind];
              const state =
                j?.status === "running" ? "run" : j?.status === "done" ? "done" : j?.status === "failed" ? "fail" : "";
              return (
                <span key={kind} className={`chip stage ${state}`} title={j?.message ?? ""}>
                  {state === "run" ? <span className="spin" /> : <span className="dot" />}
                  {stageLabel(kind)}
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
          {settings?.auto_scan && (
            <div className="row" style={{ marginTop: 12 }}>
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
        </div>

        <div className="panel">
          <h2>Re-run a single step</h2>
          <p className="muted small" style={{ marginBottom: 10 }}>
            These all run on their own after a scan. Use them only to redo one step.
          </p>
          <div className="row" style={{ flexWrap: "wrap" }}>
            <button onClick={() => runJob.mutate("/api/places/geocode")}>Locate photos</button>
            <button onClick={() => runJob.mutate("/api/events/rebuild")}>Rebuild events</button>
            <button onClick={() => runJob.mutate("/api/dupes/run")}>Find near-duplicates</button>
            <button onClick={() => runJob.mutate("/api/kinds/classify")}>Sort documents</button>
            <button onClick={() => runJob.mutate("/api/faces/scan")} disabled={!stats?.face_model_ready}>
              Scan faces
            </button>
            <button onClick={() => runJob.mutate("/api/faces/recluster")} disabled={!stats?.face_model_ready}>
              Group into people
            </button>
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="danger" onClick={() => setConfirmingReset(true)} disabled={!stats?.face_model_ready}>
              Reset people…
            </button>
          </div>
          {runJob.error ? (
            <p className="small" style={{ color: "var(--danger)", marginTop: 8 }}>{String(runJob.error)}</p>
          ) : null}
        </div>

        {stats && (
          <div className="panel">
            <h2>Storage &amp; index</h2>
            <div className="stat-grid">
              <div className="stat-tile"><div className="v">{n(stats.photos)}</div><div className="k">photos</div></div>
              <div className="stat-tile"><div className="v">{n(stats.videos)}</div><div className="k">videos</div></div>
              <div className="stat-tile"><div className="v">{n(stats.missing)}</div><div className="k">missing (drive offline?)</div></div>
              <div className="stat-tile"><div className="v">{n(stats.with_gps)}</div><div className="k">with GPS</div></div>
              <div className="stat-tile"><div className="v">{n(stats.faces)}</div><div className="k">faces</div></div>
              <div className="stat-tile"><div className="v">{fmtBytes(stats.db_bytes)}</div><div className="k">database</div></div>
              <div className="stat-tile"><div className="v">{fmtBytes(stats.thumbs_bytes)}</div><div className="k">thumbnails</div></div>
              <div className="stat-tile"><div className="v">{fmtBytes(stats.previews_bytes)}</div><div className="k">previews</div></div>
            </div>
          </div>
        )}
      </details>

      {/* A failure is worth surfacing outside Advanced — but as a sentence. */}
      {!running && lastFailed && (
        <p className="setup-problem small">{friendlyError(lastFailed.message, lastFailed.kind)}</p>
      )}

      {confirmingRemove && (
        <RemoveDialog
          root={confirmingRemove}
          onConfirm={() => delRoot.mutate(confirmingRemove.id)}
          onClose={() => setConfirmingRemove(null)}
        />
      )}

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

      {pickerOpen && <FolderPicker onPick={(p) => addRoot.mutate(p)} onClose={() => setPickerOpen(false)} />}
    </div>
  );
}

/* ---- the four faces ------------------------------------------------------ */

function Invite({ onChoose, error }: { onChoose: () => void; error: unknown }) {
  return (
    <div className="setup-hero">
      <ArtFolder className="art" />
      <h2>Let&rsquo;s find your photos</h2>
      <p>
        Choose the folder where your photos live — Smriti looks inside it and every folder
        within. It reads them where they are: nothing is moved, copied or changed.
      </p>
      <button className="primary big" onClick={onChoose}>
        Choose a folder
      </button>
      {error ? <p className="setup-problem small">{friendlyError(error)}</p> : null}
    </div>
  );
}

function Working({ job, onStop }: { job: Job; onStop: () => void }) {
  const pct = job.total > 0 ? Math.round((job.done / job.total) * 100) : null;
  const note = stageNote(job.kind);
  return (
    <div className="panel setup-progress">
      <div className="sp-head">
        <span className="spin" />
        <strong>{stageSentence(job.kind)}</strong>
        <span className="spacer" />
        {pct != null && <span className="sp-pct">{pct}%</span>}
        <button className="small sp-stop" onClick={onStop}>
          Stop
        </button>
      </div>
      {pct != null && (
        <div className="progress">
          <div style={{ width: `${pct}%` }} />
        </div>
      )}
      <p className="muted small sp-count">
        {job.total > 0 ? `${n(job.done)} ${stageUnit(job.kind)}` : "Getting started…"}
        {job.errors ? ` · ${n(job.errors)} skipped` : ""}
      </p>
      <p className="muted small">
        {note ?? "You can start browsing — this keeps going in the background."}
      </p>
    </div>
  );
}

function Attention({
  roots,
  allOffline,
  onChoose,
  onRefresh,
  onRemove,
}: {
  roots: Root[];
  allOffline: boolean;
  onChoose: () => void;
  onRefresh: (id: number) => void;
  onRemove: (r: Root) => void;
}) {
  const names = roots.filter((r) => !r.is_online).map((r) => r.label);
  return (
    <>
      <div className="panel setup-note">
        {allOffline ? (
          <>
            <strong>
              {names.length === 1 ? `${names[0]} isn't connected` : "Your photo drives aren't connected"}
            </strong>
            <p className="muted">
              Plug {names.length === 1 ? "it" : "them"} back in and Smriti picks up exactly where it left off.
              Nothing has been lost — your photos, people and albums are all still here.
            </p>
          </>
        ) : (
          <>
            <strong>No photos or videos in that folder</strong>
            <p className="muted">
              Smriti looked through it and everything inside, and didn&rsquo;t find any photos or
              videos it recognises. Try a different folder.
            </p>
            <button className="primary" onClick={onChoose} style={{ marginTop: 12 }}>
              Choose another folder
            </button>
          </>
        )}
      </div>
      <FolderList roots={roots} onRefresh={onRefresh} onRemove={onRemove} onChoose={onChoose} />
    </>
  );
}

function Ready({
  roots,
  stats,
  onChoose,
  onRefresh,
  onRemove,
  onEnablePeople,
}: {
  roots: Root[];
  stats?: Stats;
  onChoose: () => void;
  onRefresh: (id: number) => void;
  onRemove: (r: Root) => void;
  onEnablePeople: () => void;
}) {
  return (
    <>
      <div className="panel setup-summary">
        <div className="ss-counts">
          <span>
            <strong>{n(stats?.photos)}</strong> photos
          </span>
          {(stats?.videos ?? 0) > 0 && (
            <span>
              <strong>{n(stats?.videos)}</strong> videos
            </span>
          )}
          {(stats?.persons ?? 0) > 0 && (
            <span>
              <strong>{n(stats?.persons)}</strong> people
            </span>
          )}
        </div>
        <p className="muted small">Ready to browse. Your originals are untouched, exactly where you put them.</p>
      </div>

      <FolderList roots={roots} onRefresh={onRefresh} onRemove={onRemove} onChoose={onChoose} />

      {/* The one optional thing on the page — so it gets to be the only card. */}
      {stats && !stats.face_model_ready && (
        <div className="panel setup-card">
          <div>
            <strong>Recognise people in your photos</strong>
            <p className="muted small" style={{ marginTop: 4 }}>
              Smriti can group every photo of the same person together. It needs a one-time
              280 MB download, then runs entirely on this machine — your photos never leave it.
            </p>
          </div>
          <span className="spacer" />
          <button className="primary" onClick={onEnablePeople}>
            Turn on People
          </button>
        </div>
      )}
      {/* Only offer People when People has somebody in it. Faces alone do not
          make a person: a face joins a group once enough of them cluster
          together, so a handful of faces across a handful of photos correctly
          produces nobody — and linking there anyway sends someone to an empty
          page wondering what they did wrong. */}
      {stats?.face_model_ready && (stats?.faces ?? 0) > 0 && (
        (stats?.people_visible ?? 0) > 0 ? (
          <p className="muted small setup-quiet">
            {n(stats.people_visible)} {stats.people_visible === 1 ? "person" : "people"} found
            {(stats.persons ?? 0) > 0 ? `, ${n(stats.persons)} named` : ""} —{" "}
            <Link to="/people">open People</Link>
          </p>
        ) : (
          <p className="muted small setup-quiet">
            No one grouped yet — Smriti needs to see the same person in several photos before it
            can tell them apart. It keeps trying as more photos come in.
          </p>
        )
      )}
    </>
  );
}

/** Asks before removing a folder, using the numbers this removal would really
 *  touch rather than a guess. Photos still covered by another watched folder
 *  are not counted, because they are not going anywhere. */
function RemoveDialog({
  root,
  onConfirm,
  onClose,
}: {
  root: Root;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { data, isPending } = useQuery({
    queryKey: ["removal", root.id],
    queryFn: () => api.get<Removal>(`/api/roots/${root.id}/removal`),
  });
  return (
    <ConfirmDialog
      title="Remove this folder from your library?"
      confirmLabel={isPending ? "Checking…" : "Remove from library"}
      danger
      body={
        <>
          <p style={{ marginBottom: 10, wordBreak: "break-word" }}>{root.abs_path}</p>
          {isPending || !data ? (
            <p>Checking what this would remove…</p>
          ) : data.files === 0 ? (
            <p>Smriti will stop watching this folder. Nothing was indexed from it, so nothing is lost.</p>
          ) : (
            <>
              <p style={{ marginBottom: 10 }}>
                <strong>
                  {n(data.photos)} photos{data.videos > 0 ? ` and ${n(data.videos)} videos` : ""}
                </strong>{" "}
                will be taken out of your library, along with{" "}
                {data.faces > 0 ? `${n(data.faces)} faces and ` : ""}anything built from them —
                trips, places and album entries.
              </p>
              {data.locked > 0 && (
                <p style={{ marginBottom: 10, color: "var(--danger)" }}>
                  {n(data.locked)} of them {data.locked === 1 ? "is" : "are"} in your Locked
                  section.
                </p>
              )}
              <p>
                <strong>Your files are not deleted.</strong> Every photo stays exactly where it is
                on disk — add the folder again and Smriti will index it back.
              </p>
            </>
          )}
        </>
      }
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}

function FolderList({
  roots,
  onRefresh,
  onRemove,
  onChoose,
}: {
  roots: Root[];
  onRefresh: (id: number) => void;
  onRemove: (r: Root) => void;
  onChoose: () => void;
}) {
  return (
    <div className="panel">
      <div className="row" style={{ marginBottom: 6 }}>
        <h2>Folders</h2>
        <span className="spacer" />
        <button onClick={onChoose}>+ Add another folder</button>
      </div>
      {roots.map((r) => (
        <div className="list-row" key={r.id}>
          <strong>{r.abs_path}</strong>
          <span className="muted small">
            {r.is_online ? `${n(r.file_count)} photos and videos` : "drive not connected"}
          </span>
          <span className="spacer" />
          <button onClick={() => onRefresh(r.id)} disabled={!r.is_online} title="Look for anything new in this folder">
            Refresh
          </button>
          <button className="danger" onClick={() => onRemove(r)} title="Take this folder out of your library — your files on disk are not touched">
            Remove
          </button>
        </div>
      ))}
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
  const subfolders = data?.dirs.length ?? 0;
  return (
    <Portal>
      <div className="modal-back" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <header>Choose a photos folder</header>
          <div className="modal-body">
            <div className="row" style={{ marginBottom: 8 }}>
              <button disabled={data?.parent == null} onClick={() => data && data.parent != null && setPath(data.parent)}>
                ↑ Up
              </button>
              <button onClick={() => setPath("~")}>Home</button>
              <span className="muted small" style={{ wordBreak: "break-all" }}>{data?.path ?? "…"}</span>
            </div>
            {/* Scanning recurses, so the direct-only count used to read as "this
                folder is empty" when someone picked the right parent folder. */}
            {data && !atSyntheticRoot && (
              <p className="small muted" style={{ marginBottom: 6 }}>
                {data.media_count > 0
                  ? `${data.media_count.toLocaleString()} photos and videos here`
                  : "Nothing directly in this folder"}
                {subfolders > 0
                  ? ` — Smriti will also look inside ${subfolders === 1 ? "the folder" : `all ${subfolders} folders`} within it.`
                  : "."}
              </p>
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
              Use this folder
            </button>
          </footer>
        </div>
      </div>
    </Portal>
  );
}
