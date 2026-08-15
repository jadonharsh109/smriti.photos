import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { Job } from "../api/client";

const LABELS: Record<string, string> = {
  scan: "Indexing",
  faces: "Finding faces",
  recluster: "Grouping people",
  geocode: "Locating",
  neardup: "Finding duplicates",
  events: "Building events",
};

/** Live job progress card in the sidebar, fed by the SSE stream. */
export default function JobsIndicator() {
  const [jobs, setJobs] = useState<Record<number, Job>>({});
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
    return () => es.close();
  }, [qc]);

  const running = Object.values(jobs).filter((j) => j.status === "running");
  if (running.length === 0) return null;
  const j = running[0];
  const pct = j.total > 0 ? Math.round((j.done / j.total) * 100) : null;
  return (
    <div className="jobs-card">
      <div className="jc-title">
        <div className="spin" />
        {LABELS[j.kind] ?? j.kind}
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
  );
}
