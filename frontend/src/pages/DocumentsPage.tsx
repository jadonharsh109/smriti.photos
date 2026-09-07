import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Filters } from "../api/client";
import DayGrid from "../components/DayGrid";
import { IconMore } from "../components/Icons";
import { actions } from "../shell/actions";
import { openContextMenu } from "../shell/ContextMenu";
import { GridControls, StandardSelection } from "../shell/GridToolbar";
import { jobs, runningJob, selection } from "../shell/store";
import { Segmented, TbButton, Toolbar } from "../shell/Toolbar";

interface KindSummary {
  kinds: { kind: string; label: string; count: number }[];
  total: number;
}

/** Screenshots and scans, sorted out of the main timeline. The sorter is a
 *  suggestion, not a verdict: "Not a Document" sends one back for good. */
export default function DocumentsPage() {
  const qc = useQueryClient();
  const [kind, setKind] = useState<string>("any");
  const { data: summary, isLoading } = useQuery({ queryKey: ["kinds"], queryFn: () => api.get<KindSummary>("/api/kinds/summary") });
  const running = runningJob(jobs.use((s) => s.byId));
  const sort = useMutation({ mutationFn: () => api.post("/api/kinds/classify"), onSettled: () => qc.invalidateQueries() });

  const filters: Filters = { kind: kind as Filters["kind"] };
  const kinds = summary?.kinds ?? [];
  const more = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openContextMenu({ clientX: r.right - 180, clientY: r.bottom + 4, preventDefault: () => {} }, [
      { label: "Sort Again", disabled: !!running, onSelect: () => sort.mutate() },
    ]);
  };

  return (
    <>
      <Toolbar title="Documents" count={summary?.total ? `${summary.total.toLocaleString()} kept out of Photos` : null}>
        <StandardSelection>
          <TbButton title="Send these back to Photos — the sorter will not pick them up again" onClick={() => actions.notDocument([...selection.get().ids])}>
            Not a Document
          </TbButton>
        </StandardSelection>
        {kinds.length > 1 && (
          <Segmented
            value={kind}
            options={[{ value: "any", label: "All" }, ...kinds.map((k) => ({ value: k.kind, label: k.label }))]}
            onChange={setKind}
          />
        )}
        <TbButton icon={<IconMore size={14} />} title="More" onClick={more} />
        <GridControls />
      </Toolbar>
      {isLoading ? null : summary?.total === 0 ? (
        <div className="empty">
          <h2>Nothing sorted out yet</h2>
          <p>Smriti looks for screenshots and scans in what is already indexed. Your photos are untouched — these are only labelled.</p>
          <div className="row">
            <button className="btn primary" disabled={!!running} onClick={() => sort.mutate()}>Look for Documents</button>
          </div>
        </div>
      ) : (
        <DayGrid filters={filters} emptyText="Nothing of this kind" menuExtras={(ids) => [{ label: "Not a Document", onSelect: () => actions.notDocument(ids) }]} />
      )}
    </>
  );
}
