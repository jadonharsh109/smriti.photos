import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Filters } from "../api/client";
import { ArtFolder } from "../components/Illustrations";
import { PhotoGridSkeleton } from "../components/Skeletons";
import TimelineGrid from "../components/TimelineGrid";

interface KindSummary {
  kinds: { kind: string; label: string; count: number }[];
  total: number;
}

/** Screenshots and scans, sorted out of the main timeline.
 *
 * Nothing here is a new kind of file — these are photos already in the
 * library, recognised from their metadata. Everything is reversible from the
 * selection bar, because the classifier is a suggestion, not a verdict. */
export default function DocumentsPage() {
  const qc = useQueryClient();
  const [kind, setKind] = useState<"any" | string>("any");

  const { data: summary, isLoading } = useQuery({
    queryKey: ["kinds"],
    queryFn: () => api.get<KindSummary>("/api/kinds/summary"),
  });

  const sort = useMutation({
    mutationFn: () => api.post("/api/kinds/classify"),
    onSettled: () => qc.invalidateQueries(),
  });

  const filters: Filters = { kind: kind as Filters["kind"] };
  const chips = summary?.kinds ?? [];

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Documents</h1>
          <p className="sub">
            {summary && summary.total > 0
              ? `${summary.total.toLocaleString()} kept out of your timeline — ` +
                summary.kinds.map((k) => `${k.count.toLocaleString()} ${k.label.toLowerCase()}`).join(", ") +
                ". Your photos are untouched; these are only labelled."
              : "Screenshots and scans, kept out of your timeline. Your photos are untouched — these are only labelled."}
          </p>
        </div>
        <div className="actions">
          {chips.length > 1 && (
            <div className="seg">
              <button className={kind === "any" ? "on" : ""} onClick={() => setKind("any")}>
                All{summary ? ` · ${summary.total.toLocaleString()}` : ""}
              </button>
              {chips.map((k) => (
                <button key={k.kind} className={kind === k.kind ? "on" : ""} onClick={() => setKind(k.kind)}>
                  {k.label} · {k.count.toLocaleString()}
                </button>
              ))}
            </div>
          )}
          <button onClick={() => sort.mutate()} disabled={sort.isPending}>
            {sort.isPending ? "Sorting…" : "Sort again"}
          </button>
        </div>
      </header>

      {isLoading ? (
        <PhotoGridSkeleton />
      ) : summary?.total === 0 ? (
        <div className="empty">
          <ArtFolder className="art" />
          <p>
            Nothing sorted out yet. Press <strong>Sort again</strong> to look through your
            library for screenshots and scans — it reads only what is already indexed, so it
            takes a moment.
          </p>
        </div>
      ) : (
        <TimelineGrid
          filters={filters}
          emptyText="Nothing of this kind"
          selectionActions={(sel, clear) => (
            <button
              title="Send these back to the timeline — the sorter will not pick them up again"
              onClick={async () => {
                await api.post("/api/kinds/not-document", { file_ids: [...sel] });
                qc.invalidateQueries();
                clear();
              }}
            >
              Not a document
            </button>
          )}
        />
      )}
    </div>
  );
}
