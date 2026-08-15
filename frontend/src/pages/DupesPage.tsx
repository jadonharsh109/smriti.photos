import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, fmtBytes } from "../api/client";
import { ConfirmDialog } from "../components/Dialogs";
import { ArtDupes } from "../components/Illustrations";

interface DupeItem {
  id: number;
  rel_path: string;
  filename: string;
  size_bytes: number;
  media_type: string;
  width: number | null;
  height: number | null;
  is_suggested_keeper: boolean;
}
interface Group {
  kind: string;
  group_id?: number;
  items: DupeItem[];
}

export default function DupesPage() {
  const [tab, setTab] = useState<"exact" | "near">("exact");
  const [discards, setDiscards] = useState<Set<number>>(new Set());
  const [exportResult, setExportResult] = useState<string | null>(null);
  const [confirmingTrash, setConfirmingTrash] = useState(false);
  const [trashResult, setTrashResult] = useState<string | null>(null);
  const qc = useQueryClient();

  const { data: groups } = useQuery({
    queryKey: ["dupes", tab],
    queryFn: () => api.get<Group[]>(`/api/dupes/${tab}`),
  });
  const run = useMutation({
    mutationFn: () => api.post("/api/dupes/run"),
    onSettled: () => qc.invalidateQueries({ queryKey: ["dupes"] }),
  });
  const dismissGroup = useMutation({
    mutationFn: (gid: number) => api.post(`/api/dupes/groups/${gid}/dismiss`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dupes"] }),
  });

  const toggleDiscard = (id: number) =>
    setDiscards((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const checkNonKeepers = () => {
    const next = new Set(discards);
    for (const g of groups ?? []) for (const it of g.items) if (!it.is_suggested_keeper) next.add(it.id);
    setDiscards(next);
  };

  const doExport = async () => {
    const r = await fetch("/api/dupes/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_ids: [...discards] }),
    });
    setExportResult(await r.text());
  };

  const trashDiscards = async () => {
    const r = await api.post<{ trashed: number; skipped_offline: number; errors: unknown[] }>(
      "/api/files/delete",
      { file_ids: [...discards] }
    );
    setDiscards(new Set());
    setTrashResult(
      `Moved ${r.trashed} ${r.trashed === 1 ? "file" : "files"} to the macOS Trash` +
        (r.skipped_offline ? ` · ${r.skipped_offline} skipped (drive offline)` : "") +
        (r.errors.length ? ` · ${r.errors.length} failed` : "")
    );
    qc.invalidateQueries();
  };

  const wasted = (groups ?? []).reduce(
    (s, g) => s + g.items.filter((i) => !i.is_suggested_keeper).reduce((x, i) => x + i.size_bytes, 0),
    0
  );

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Duplicates</h1>
          <p className="sub">
            Mark what to discard, then move it to the macOS Trash — always recoverable, never permanently erased.
          </p>
        </div>
        <div className="actions">
          {wasted > 0 && (
            <span className="chip">
              <span className="dot" />
              potential savings&nbsp;<strong>{fmtBytes(wasted)}</strong>
            </span>
          )}
          <button className="primary" onClick={() => run.mutate()} disabled={run.isPending}>
            Find near-duplicates
          </button>
        </div>
      </header>
      <div className="row" style={{ marginBottom: 18 }}>
        <div className="seg">
          <button className={tab === "exact" ? "on" : ""} onClick={() => setTab("exact")}>
            Exact copies
          </button>
          <button className={tab === "near" ? "on" : ""} onClick={() => setTab("near")}>
            Near duplicates
          </button>
        </div>
        <span className="spacer" />
        {(groups ?? []).length > 0 && (
          <>
            <button onClick={checkNonKeepers}>Mark all non-keepers</button>
            <button onClick={doExport} disabled={discards.size === 0}>
              Export list ({discards.size})
            </button>
            <button className="danger" onClick={() => setConfirmingTrash(true)} disabled={discards.size === 0}>
              Move to Trash ({discards.size})
            </button>
          </>
        )}
      </div>
      {trashResult && (
        <div className="row" style={{ marginBottom: 14 }}>
          <span className="chip"><span className="dot" />{trashResult}</span>
          <button className="ghost small" onClick={() => setTrashResult(null)}>Dismiss</button>
        </div>
      )}
      {exportResult != null && (
        <div className="panel">
          <h2>Discard list (saved under data/exports/)</h2>
          <pre className="small" style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{exportResult}</pre>
        </div>
      )}
      {(groups ?? []).length === 0 ? (
        <div className="empty">
          <ArtDupes className="art" />
          <p>{tab === "exact" ? "No exact copies found." : "No near-duplicates found — run the finder above."}</p>
        </div>
      ) : (
        groups!.map((g, gi) => (
          <div key={g.group_id ?? gi} className="dupe-group">
            <div className="row">
              <span className="badge">{g.kind === "video-quick" ? "video · quick-hash match" : g.kind}</span>
              <span className="muted small">{g.items.length} files</span>
              <span className="spacer" />
              {g.kind === "near" && g.group_id != null && (
                <button className="small" onClick={() => dismissGroup.mutate(g.group_id!)}>
                  Not duplicates
                </button>
              )}
            </div>
            <div className="dupe-items">
              {g.items.map((it) => (
                <div
                  key={it.id}
                  className={`dupe-item ${discards.has(it.id) ? "discard" : it.is_suggested_keeper ? "keeper" : ""}`}
                  onClick={() => toggleDiscard(it.id)}
                >
                  <img src={`/api/thumb/${it.id}`} loading="lazy" alt="" />
                  <div style={{ margin: "5px 0 2px" }}>
                    {it.is_suggested_keeper && <span className="badge green">keep</span>}{" "}
                    {discards.has(it.id) && <span className="badge red">discard</span>}
                  </div>
                  <div>
                    {it.width && it.height ? `${it.width}×${it.height} · ` : ""}
                    {fmtBytes(it.size_bytes)}
                  </div>
                  <div className="path">{it.rel_path}</div>
                </div>
              ))}
            </div>
          </div>
        ))
      )}
      {confirmingTrash && (
        <ConfirmDialog
          title={`Move ${discards.size} ${discards.size === 1 ? "duplicate" : "duplicates"} to Trash?`}
          body="Marked files go to the macOS Trash (recoverable there) and leave the library. Suggested keepers stay untouched."
          confirmLabel="Move to Trash"
          danger
          onConfirm={trashDiscards}
          onClose={() => setConfirmingTrash(false)}
        />
      )}
    </div>
  );
}
