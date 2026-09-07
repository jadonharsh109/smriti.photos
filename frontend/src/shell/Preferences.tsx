import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, fmtBytes, type Job, type Root, type Volume } from "../api/client";
import { ConfirmDialog } from "../components/Dialogs";
import FolderPicker from "../components/FolderPicker";
import { IconClock, IconContrast, IconDrive, IconFolder, IconSliders } from "../components/Icons";
import Portal from "../components/Portal";
import TakeoutImport from "../components/TakeoutImport";
import { isDesktop } from "../lib/desktop";
import { friendlyError, stageLabel, stageSentence } from "../lib/stages";
import { check as checkForUpdates, openSheet, useUpdates } from "../lib/updates";
import {
  TILE_MAX,
  TILE_MIN,
  closePrefs,
  jobs,
  prefs,
  runningJob,
  setTheme,
  setTileHeight,
  theme,
  view,
  type PrefsTab,
} from "./store";

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
interface AppSettings {
  auto_scan: boolean;
  auto_scan_minutes: number;
}
interface Removal {
  files: number;
  photos: number;
  videos: number;
  faces: number;
  locked: number;
}
interface SearchStatus {
  model_ready: boolean;
  model_mb: number;
  indexed: number;
  pending: number;
  total: number;
}

const n = (x: number | undefined) => (x ?? 0).toLocaleString();

const TABS: { id: PrefsTab; label: string; icon: React.ReactNode }[] = [
  { id: "library", label: "Library", icon: <IconFolder /> },
  { id: "indexing", label: "Indexing", icon: <IconClock /> },
  { id: "appearance", label: "Appearance", icon: <IconContrast /> },
  { id: "advanced", label: "Advanced", icon: <IconSliders /> },
];

/** Preferences, as a sheet over the window: folders, indexing, appearance,
 *  and the machinery that used to fill a whole page. */
export default function Preferences() {
  const tab = prefs.use((s) => s.tab);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector(".scrim ~ .scrim")) closePrefs();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <Portal>
      <div className="scrim" onClick={closePrefs}>
        <div className="sheet wide" role="dialog" aria-label="Preferences" onClick={(e) => e.stopPropagation()}>
          <div className="stabs">
            {TABS.map((t) => (
              <button key={t.id} className={tab === t.id ? "on" : ""} onClick={() => prefs.set({ tab: t.id })}>
                {t.icon}
                {t.label}
              </button>
            ))}
          </div>
          <div className="sbody" style={{ minHeight: 320 }}>
            {tab === "library" && <LibraryTab />}
            {tab === "indexing" && <IndexingTab />}
            {tab === "appearance" && <AppearanceTab />}
            {tab === "advanced" && <AdvancedTab />}
          </div>
          <div className="sfoot">
            <button className="btn primary" onClick={closePrefs}>Done</button>
          </div>
        </div>
      </div>
    </Portal>
  );
}

/* ---- Library --------------------------------------------------------------- */

function LibraryTab() {
  const qc = useQueryClient();
  const { data: roots } = useQuery({ queryKey: ["roots"], queryFn: () => api.get<Root[]>("/api/roots") });
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: () => api.get<AppSettings>("/api/settings") });
  const { data: stats } = useQuery({ queryKey: ["stats"], queryFn: () => api.get<Stats>("/api/stats") });
  const [picker, setPicker] = useState(false);
  const [takeout, setTakeout] = useState(false);
  const [removing, setRemoving] = useState<Root | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const byId = jobs.use((s) => s.byId);
  const running = runningJob(byId);

  const addRoot = useMutation({
    mutationFn: (path: string) => api.post<{ id: number }>("/api/roots", { path }),
    onSuccess: async (r) => {
      qc.invalidateQueries({ queryKey: ["roots"] });
      setPicker(false);
      await api.post("/api/process", { root_id: r.id });
    },
  });
  const rescan = useMutation({ mutationFn: (rootId: number) => api.post("/api/process", { root_id: rootId }) });
  const delRoot = useMutation({
    mutationFn: (id: number) => api.del(`/api/roots/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["roots"] });
      setPicked(null);
    },
  });
  const saveSettings = useMutation({
    mutationFn: (patch: Partial<AppSettings>) => api.post<AppSettings>("/api/settings", patch),
    onSuccess: (s) => qc.setQueryData(["settings"], s),
  });
  const getModels = useMutation({ mutationFn: () => api.post("/api/models/download") });

  const sel = (roots ?? []).find((r) => r.id === picked) ?? null;
  return (
    <>
      <h3>Watched folders</h3>
      <p>Smriti reads these folders where they are. Nothing is moved, copied or changed.</p>
      {(roots ?? []).length === 0 ? (
        <div className="list"><div className="li muted">No folders yet. Add the one where your photos live.</div></div>
      ) : (
        <div className="list">
          {(roots ?? []).map((r) => (
            <div key={r.id} className={`li clickable${picked === r.id ? " picked" : ""}`} onClick={() => setPicked(r.id)}>
              {r.abs_path.startsWith("/Volumes/") ? <IconDrive size={15} /> : <IconFolder size={15} />}
              <span className="path selectable" title={r.abs_path}>{r.abs_path}</span>
              <span className={`st num${r.is_online ? "" : " off"}`}>{r.is_online ? `${n(r.file_count)} items` : "drive not connected"}</span>
            </div>
          ))}
        </div>
      )}
      <div className="lbtns">
        <button className="btn" onClick={() => setPicker(true)}>Add Folder…</button>
        <button className="btn" disabled={!sel} onClick={() => sel && setRemoving(sel)}>Remove</button>
        <span className="grow" />
        <button className="btn" disabled={!sel || !sel.is_online || !!running} onClick={() => sel && rescan.mutate(sel.id)} title="Look for anything new in this folder">
          Rescan
        </button>
      </div>
      {addRoot.error ? <p className="note bad" style={{ marginTop: 6 }}>{friendlyError(addRoot.error)}</p> : null}
      {running && (
        <p className="note" style={{ marginTop: 8 }}>
          {stageSentence(running.kind)}{running.total > 0 ? ` — ${n(running.done)} of ${n(running.total)}` : ""}. You can keep browsing.
        </p>
      )}

      <div className="prow" style={{ marginTop: 10 }}>
        <div>
          <div className="t">Import from Google Takeout</div>
          <div className="d">Repairs an export’s dates and places into an ordinary folder. Adding it to the library is a separate step.</div>
        </div>
        <span className="grow" />
        <button className="btn" onClick={() => setTakeout(true)}>Import…</button>
      </div>
      <div className="prow">
        <div>
          <div className="t">Add new photos automatically</div>
          <div className="d">
            {settings?.auto_scan ? `Check watched folders every ${settings.auto_scan_minutes} minutes.` : "New photos appear only when you rescan a folder."}
          </div>
        </div>
        <span className="grow" />
        {settings?.auto_scan && (
          <span className="seg">
            {[10, 30, 60].map((m) => (
              <button key={m} className={settings.auto_scan_minutes === m ? "on" : ""} onClick={() => saveSettings.mutate({ auto_scan_minutes: m })}>
                {m === 60 ? "1 h" : `${m} min`}
              </button>
            ))}
          </span>
        )}
        <button className={`switch${settings?.auto_scan ? " on" : ""}`} aria-pressed={settings?.auto_scan ?? false} aria-label="Add new photos automatically" onClick={() => saveSettings.mutate({ auto_scan: !settings?.auto_scan })} />
      </div>
      {stats && !stats.face_model_ready && (
        <div className="prow">
          <div>
            <div className="t">People needs its models</div>
            <div className="d">Face recognition runs on this machine once its models are downloaded — about 280 MB, once.</div>
          </div>
          <span className="grow" />
          <button className="btn" disabled={getModels.isPending || running?.kind === "models"} onClick={() => getModels.mutate()}>
            {running?.kind === "models" ? "Downloading…" : "Download"}
          </button>
        </div>
      )}

      {picker && <FolderPicker onPick={(p) => addRoot.mutate(p)} onClose={() => setPicker(false)} />}
      {takeout && <TakeoutImport onClose={() => setTakeout(false)} />}
      {removing && <RemoveDialog root={removing} onConfirm={() => delRoot.mutate(removing.id)} onClose={() => setRemoving(null)} />}
    </>
  );
}

function RemoveDialog({ root, onConfirm, onClose }: { root: Root; onConfirm: () => void; onClose: () => void }) {
  const { data, isPending } = useQuery({ queryKey: ["removal", root.id], queryFn: () => api.get<Removal>(`/api/roots/${root.id}/removal`) });
  return (
    <ConfirmDialog
      title="Remove this folder from your library?"
      confirmLabel={isPending ? "Checking…" : "Remove from Library"}
      danger
      body={
        <>
          <p className="selectable" style={{ wordBreak: "break-word" }}>{root.abs_path}</p>
          {isPending || !data ? (
            <p>Checking what this would remove…</p>
          ) : data.files === 0 ? (
            <p>Smriti stops watching this folder. Nothing was indexed from it, so nothing is lost.</p>
          ) : (
            <>
              <p>
                <strong className="num">{n(data.photos)} photos{data.videos > 0 ? ` and ${n(data.videos)} videos` : ""}</strong> leave your library, along with{" "}
                {data.faces > 0 ? `${n(data.faces)} faces and ` : ""}anything built from them — trips, places and album entries.
              </p>
              {data.locked > 0 && <p className="note bad">{n(data.locked)} of them {data.locked === 1 ? "is" : "are"} in your Locked section.</p>}
              <p><strong>Your files are not deleted.</strong> Every photo stays where it is on disk — add the folder again and Smriti indexes it back.</p>
            </>
          )}
        </>
      }
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}

/* ---- Indexing --------------------------------------------------------------- */

function IndexingTab() {
  const qc = useQueryClient();
  const { data: stats } = useQuery({ queryKey: ["stats"], queryFn: () => api.get<Stats>("/api/stats") });
  const { data: search } = useQuery({ queryKey: ["search-status"], queryFn: () => api.get<SearchStatus>("/api/search/status") });
  const { data: history } = useQuery({ queryKey: ["jobs"], queryFn: () => api.get<Job[]>("/api/jobs?limit=30"), staleTime: 5_000 });
  const byId = jobs.use((s) => s.byId);
  const log = jobs.use((s) => s.log);
  const [confirmReset, setConfirmReset] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const running = runningJob(byId);
  const run = useMutation({ mutationFn: (url: string) => api.post(url), onSettled: () => qc.invalidateQueries({ queryKey: ["jobs"] }) });
  const cancel = useMutation({ mutationFn: (id: number) => api.post(`/api/jobs/${id}/cancel`) });
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log, showLog]);

  const lines = log.length ? log : (history ?? []).slice().reverse().map((j) => `${j.started_at ? new Date(j.started_at * 1000).toLocaleTimeString() : "—"}  ${stageLabel(j.kind)} · ${j.status}${j.message ? ` — ${j.message}` : ""}`);
  const lastFailed = (history ?? []).find((j) => j.status === "failed");

  return (
    <>
      <h3>Background work</h3>
      <div className="list">
        <div className="li">
          <span className="path">
            {running ? (
              <>
                <div className="spin" style={{ display: "inline-block", verticalAlign: -1, marginRight: 8 }} />
                {stageSentence(running.kind)}{running.total > 0 ? ` — ${n(running.done)} of ${n(running.total)}` : ""}
              </>
            ) : "Idle"}
          </span>
          {running ? (
            <button className="btn small" onClick={() => cancel.mutate(running.id)}>Stop</button>
          ) : (
            <button className="btn small" onClick={() => run.mutate("/api/autoscan/run")} disabled={run.isPending}>Check for New Photos</button>
          )}
          <button className="btn small" onClick={() => setShowLog((s) => !s)}>{showLog ? "Hide Log" : "Show Log"}</button>
        </div>
      </div>
      {showLog && (
        <div className="logbox" ref={logRef} style={{ marginTop: 6 }}>
          {lines.length ? lines.join("\n") : "Nothing yet — add a folder to start."}
        </div>
      )}
      {!running && lastFailed && <p className="note bad" style={{ marginTop: 6 }}>{friendlyError(lastFailed.message, lastFailed.kind)}</p>}

      <h3 style={{ marginTop: 16 }}>People</h3>
      <div className="prow">
        <div>
          <div className="t">{stats?.face_model_ready ? "Face recognition is on" : "Face models not downloaded"}</div>
          <div className="d">
            {stats?.face_model_ready
              ? `${n(stats.faces)} faces found · ${n(stats.people_visible)} ${stats.people_visible === 1 ? "person" : "people"}` + (stats.face_pending > 0 ? ` · ${n(stats.face_pending)} ${stats.face_pending === 1 ? "photo" : "photos"} still to check` : "")
              : "About 280 MB, downloaded once. Everything then runs on this machine."}
          </div>
        </div>
        <span className="grow" />
        {stats?.face_model_ready ? (
          <>
            <button className="btn small" disabled={!!running} onClick={() => run.mutate("/api/faces/scan")}>Scan Faces</button>
            <button className="btn small" disabled={!!running} onClick={() => run.mutate("/api/faces/recluster")}>Group People</button>
            <button className="btn small danger" disabled={!!running} onClick={() => setConfirmReset(true)}>Reset…</button>
          </>
        ) : (
          <button className="btn small" disabled={!!running} onClick={() => run.mutate("/api/models/download")}>Download</button>
        )}
      </div>

      <h3 style={{ marginTop: 16 }}>Search</h3>
      <div className="prow">
        <div>
          <div className="t">{search?.model_ready ? "Search by what a photo shows is on" : "Search model not downloaded"}</div>
          <div className="d">
            {search?.model_ready
              ? `${n(search.indexed)} photos searchable${search.pending > 0 ? ` · ${n(search.pending)} still to read` : ""}`
              : `About ${search?.model_mb ?? 219} MB, downloaded once. Queries never leave this machine.`}
          </div>
        </div>
        <span className="grow" />
        {search?.model_ready ? (
          <button className="btn small" disabled={!!running || !search.pending} onClick={() => run.mutate("/api/search/index")}>Index the Rest</button>
        ) : (
          <button className="btn small" disabled={!!running} onClick={() => run.mutate("/api/search/models/download")}>Download</button>
        )}
      </div>

      <h3 style={{ marginTop: 16 }}>Run one step again</h3>
      <p>These all run on their own after a scan. Use them only to redo one step.</p>
      <div className="row wrap">
        {[
          ["Locate photos", "/api/places/geocode"],
          ["Rebuild events", "/api/events/rebuild"],
          ["Find near-duplicates", "/api/dupes/run"],
          ["Sort documents", "/api/kinds/classify"],
          ["Find Live Photos", "/api/motion/scan"],
          ["Check sharpness", "/api/cleanup/blur/scan"],
        ].map(([label, url]) => (
          <button key={url} className="btn small" disabled={!!running} onClick={() => run.mutate(url)}>{label}</button>
        ))}
      </div>
      {run.error ? <p className="note bad" style={{ marginTop: 6 }}>{friendlyError(run.error)}</p> : null}

      {confirmReset && (
        <ConfirmDialog
          title="Reset all people?"
          body="Every person is forgotten — names, merges and manual fixes included — and all faces are regrouped from scratch. Face detection is kept, so this only takes a moment."
          confirmLabel="Reset & Regroup"
          danger
          onConfirm={() => run.mutate("/api/faces/reset")}
          onClose={() => setConfirmReset(false)}
        />
      )}
    </>
  );
}

/* ---- Appearance ------------------------------------------------------------- */

function AppearanceTab() {
  const mode = theme.use((s) => s.mode);
  const tile = view.use((s) => s.tileHeight);
  return (
    <>
      <h3>Appearance</h3>
      <div className="prow">
        <div>
          <div className="t">Theme</div>
          <div className="d">Follow the system, or pick one.</div>
        </div>
        <span className="grow" />
        <span className="seg">
          {(["system", "light", "dark"] as const).map((m) => (
            <button key={m} className={mode === m ? "on" : ""} onClick={() => setTheme(m)}>{m[0].toUpperCase() + m.slice(1)}</button>
          ))}
        </span>
      </div>
      <div className="prow">
        <div>
          <div className="t">Thumbnail size</div>
          <div className="d">Also on the toolbar, and ⌘+ / ⌘− anywhere.</div>
        </div>
        <span className="grow" />
        <input type="range" min={TILE_MIN} max={TILE_MAX} step={2} value={tile} onChange={(e) => setTileHeight(Number(e.target.value))} />
      </div>
    </>
  );
}

/* ---- Advanced --------------------------------------------------------------- */

function AdvancedTab() {
  const { data: volumes } = useQuery({ queryKey: ["volumes"], queryFn: () => api.get<Volume[]>("/api/volumes") });
  const { data: stats } = useQuery({ queryKey: ["stats"], queryFn: () => api.get<Stats>("/api/stats") });
  const { data: version } = useQuery({ queryKey: ["health"], queryFn: () => api.get<{ version: string }>("/api/health"), staleTime: Infinity });
  const update = useUpdates();
  const updateLine = update.available
    ? `Smriti ${update.available.version} is ready to install.`
    : update.answer === "current"
      ? "You’re on the latest version."
      : update.answer === "offline"
        ? "Couldn’t reach the update server — check your connection and try again."
        : "Smriti checks for updates on its own shortly after it starts.";
  return (
    <>
      <h3>Drives</h3>
      <div className="list">
        {(volumes ?? []).map((v) => (
          <div className="li" key={v.id}>
            <IconDrive size={15} />
            <span className="path"><strong>{v.label}</strong> <span className="muted">{v.mount_path}</span></span>
            <span className="st num">{v.free_bytes != null ? `${fmtBytes(v.free_bytes)} free of ${fmtBytes(v.total_bytes)}` : ""}</span>
            <span className={`pill ${v.is_online ? "good" : ""}`}>{v.is_online ? "online" : "offline"}</span>
          </div>
        ))}
      </div>
      {stats && (
        <>
          <h3 style={{ marginTop: 16 }}>Storage &amp; index</h3>
          <div className="stat-grid">
            <div className="stat"><div className="v num">{n(stats.photos)}</div><div className="k">photos</div></div>
            <div className="stat"><div className="v num">{n(stats.videos)}</div><div className="k">videos</div></div>
            <div className="stat"><div className="v num">{n(stats.missing)}</div><div className="k">missing</div></div>
            <div className="stat"><div className="v num">{n(stats.with_gps)}</div><div className="k">with GPS</div></div>
            <div className="stat"><div className="v num">{n(stats.faces)}</div><div className="k">faces</div></div>
            <div className="stat"><div className="v num">{fmtBytes(stats.db_bytes)}</div><div className="k">database</div></div>
            <div className="stat"><div className="v num">{fmtBytes(stats.thumbs_bytes)}</div><div className="k">thumbnails</div></div>
            <div className="stat"><div className="v num">{fmtBytes(stats.previews_bytes)}</div><div className="k">previews</div></div>
          </div>
        </>
      )}
      <div className="prow" style={{ marginTop: 14 }}>
        <div>
          <div className="t">Smriti {version?.version ?? ""}</div>
          <div className="d">{isDesktop() ? updateLine : "Updates are handled by however you installed Smriti."}</div>
        </div>
        <span className="grow" />
        {isDesktop() && (
          <button className={`btn small${update.available ? " primary" : ""}`} disabled={update.checking || update.progress !== null} onClick={() => (update.available ? openSheet() : checkForUpdates())}>
            {update.checking ? "Checking…" : update.available ? `Update to ${update.available.version}` : "Check for Updates"}
          </button>
        )}
      </div>
      <p className="note" style={{ marginTop: 10 }}>
        Smriti is free software under the GNU AGPL v3. Source and issues: github.com/jadonharsh109/smriti.photos
      </p>
    </>
  );
}
