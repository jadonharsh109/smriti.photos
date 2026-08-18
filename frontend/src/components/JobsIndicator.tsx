import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { Job } from "../api/client";
import { stageLabel } from "../lib/stages";

interface VolToast {
  id: number;
  kind: "in" | "out";
  label: string;
}

let toastSeq = 0;

/** Live sidebar status fed by the SSE stream: running-job progress plus
 * drive attach/remove toasts (queries refresh instantly — no reload). */
export default function JobsIndicator() {
  const [jobs, setJobs] = useState<Record<number, Job>>({});
  const [toasts, setToasts] = useState<VolToast[]>([]);
  const qc = useQueryClient();

  useEffect(() => {
    const es = new EventSource("/api/jobs/stream");
    es.addEventListener("job", (e) => {
      const job: Job = JSON.parse((e as MessageEvent).data);
      setJobs((prev) => ({ ...prev, [job.id]: job }));
      if (job.status !== "running") {
        // refresh whatever the finished job touched
        setTimeout(() => qc.invalidateQueries(), 400);
      }
    });
    es.addEventListener("volumes", (e) => {
      const d: { attached: { label: string }[]; removed: { label: string }[] } = JSON.parse(
        (e as MessageEvent).data
      );
      qc.invalidateQueries({ queryKey: ["volumes"] });
      qc.invalidateQueries({ queryKey: ["roots"] });
      qc.invalidateQueries({ queryKey: ["stats"] });
      qc.invalidateQueries({ queryKey: ["file"] }); // open lightbox reacts to plug/unplug
      const fresh: VolToast[] = [
        ...d.attached.map((a) => ({ id: ++toastSeq, kind: "in" as const, label: a.label })),
        ...d.removed.map((r) => ({ id: ++toastSeq, kind: "out" as const, label: r.label })),
      ];
      if (fresh.length) {
        setToasts((prev) => [...prev, ...fresh]);
        for (const t of fresh) {
          setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== t.id)), 6000);
        }
      }
    });
    return () => es.close();
  }, [qc]);

  const running = Object.values(jobs).filter((j) => j.status === "running");
  const j = running[0];
  const pct = j && j.total > 0 ? Math.round((j.done / j.total) * 100) : null;

  return (
    <>
      {toasts.map((t) => (
        <div key={t.id} className={`jobs-card vol-toast ${t.kind}`}>
          <div className="jc-title">
            <span className="vdot" />
            {t.kind === "in" ? "Drive attached" : "Drive removed"}
          </div>
          <div>{t.label}</div>
        </div>
      ))}
      {j && (
        <div className="jobs-card">
          <div className="jc-title">
            <div className="spin" />
            {stageLabel(j.kind)}
            {running.length > 1 && <span className="faint">+{running.length - 1}</span>}
          </div>
          <div>
            {pct != null ? `${j.done.toLocaleString()} of ${j.total.toLocaleString()} · ${pct}%` : "Working…"}
            {j.message ? ` · ${j.message}` : ""}
          </div>
          {pct != null && (
            <div className="progress">
              <div style={{ width: `${pct}%` }} />
            </div>
          )}
        </div>
      )}
    </>
  );
}
