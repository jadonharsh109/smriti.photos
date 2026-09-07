import { useMutation, useQuery } from "@tanstack/react-query";
import { api, type Root } from "../api/client";
import { stageSentence, stageUnit } from "../lib/stages";
import { openSheet, useUpdates } from "../lib/updates";
import { isDesktop } from "../lib/desktop";
import { jobs, runningJob, selection } from "./store";

interface Stats {
  photos: number;
  videos: number;
}

const n = (x: number) => x.toLocaleString();

/** One strip for everything that used to be a card, a toast or a badge:
 *  library totals, the selection, unplugged drives, background work, and a
 *  waiting update. */
export default function StatusBar() {
  const { data: stats } = useQuery({ queryKey: ["stats"], queryFn: () => api.get<Stats>("/api/stats") });
  const { data: roots } = useQuery({ queryKey: ["roots"], queryFn: () => api.get<Root[]>("/api/roots") });
  const selected = selection.use((s) => s.ids.size);
  const byId = jobs.use((s) => s.byId);
  const toasts = jobs.use((s) => s.toasts);
  const job = runningJob(byId);
  const cancel = useMutation({ mutationFn: (id: number) => api.post(`/api/jobs/${id}/cancel`) });
  const update = useUpdates();

  const offline = [...new Set((roots ?? []).filter((r) => !r.is_online).map((r) => r.label))];
  const pct = job && job.total > 0 ? Math.round((job.done / job.total) * 100) : null;

  return (
    <footer className="status">
      <span className="num">
        {stats ? `${n(stats.photos)} photos · ${n(stats.videos)} videos` : ""}
        {selected > 0 ? ` · ${n(selected)} selected` : ""}
      </span>
      {offline.map((label) => (
        <span key={label} className="drive" title="Plug the drive in and Smriti picks up where it left off">
          <i />
          {label} not connected
        </span>
      ))}
      <span className="grow" />
      {toasts.map((t) => (
        <span key={t.id} className="drive">
          <i className={t.kind === "in" ? "on" : ""} />
          {t.kind === "in" ? "Drive attached" : "Drive removed"} · {t.label}
        </span>
      ))}
      {isDesktop() && update.available && !job && (
        <button className="link" onClick={openSheet}>
          {update.progress ? "Updating…" : `Update to ${update.available.version}`}
        </button>
      )}
      {job && (
        <>
          <span>{stageSentence(job.kind)}</span>
          {job.total > 0 ? (
            <span className="num">
              {n(job.done)} of {n(job.total)} {stageUnit(job.kind)}
            </span>
          ) : job.message ? (
            <span>{job.message}</span>
          ) : null}
          {pct != null && (
            <span className="prog">
              <i style={{ width: `${pct}%` }} />
            </span>
          )}
          <button className="stop" onClick={() => cancel.mutate(job.id)} disabled={cancel.isPending}>
            Stop
          </button>
        </>
      )}
    </footer>
  );
}
