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
interface Blurry {
  items: { id: number; filename: string; sharpness: number }[];
  scored: number;
  unscored: number;
  sensitivity: string;
  ceiling: number;
}
interface Missing {
  items: { id: number; filename: string; rel_path: string; volume: string }[];
  total: number;
}

type Tab = "exact" | "near" | "blurry" | "missing";

const SENSITIVITIES = [
  { key: "gentle", label: "Only the worst" },
  { key: "normal", label: "Normal" },
  { key: "aggressive", label: "Catch more" },
] as const;

/** Everything worth deleting, in one place: exact copies, near-duplicates,
 *  blurry shots, and photos whose files are already gone. */
export default function CleanupPage() {
  const [tab, setTab] = useState<Tab>("exact");
  const [sens, setSens] = useState<string>("normal");
  const [discards, setDiscards] = useState<Set<number>>(new Set());
  const [exportResult, setExportResult] = useState<string | null>(null);
  const [confirmingTrash, setConfirmingTrash] = useState(false);
  const [confirmingForget, setConfirmingForget] = useState(false);
  const [trashResult, setTrashResult] = useState<string | null>(null);
  const qc = useQueryClient();

  const isDupeTab = tab === "exact" || tab === "near";

  const { data: groups } = useQuery({
    queryKey: ["dupes", tab],
    queryFn: () => api.get<Group[]>(`/api/dupes/${tab}`),
    enabled: isDupeTab,
  });
  const { data: blurry } = useQuery({
    queryKey: ["blurry", sens],
    queryFn: () => api.get<Blurry>(`/api/cleanup/blurry?sensitivity=${sens}`),
    enabled: tab === "blurry",
  });
  const { data: missing } = useQuery({
    queryKey: ["missing"],
    queryFn: () => api.get<Missing>("/api/cleanup/missing"),
    enabled: tab === "missing",
  });

  const run = useMutation({
    mutationFn: () => api.post("/api/dupes/run"),
    onSettled: () => qc.invalidateQueries({ queryKey: ["dupes"] }),
  });
  const scanBlur = useMutation({
    mutationFn: (rescore: boolean) => api.post(`/api/cleanup/blur/scan?rescore=${rescore}`),
    onSettled: () => qc.invalidateQueries({ queryKey: ["blurry"] }),
  });
  const forget = useMutation({
    mutationFn: () => api.post<{ forgotten: number }>("/api/cleanup/missing/forget", {}),
    onSuccess: (r) => {
      setTrashResult(`Forgot ${r.forgotten.toLocaleString()} photos that were already gone`);
      qc.invalidateQueries();
    },
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
      `Moved ${r.trashed} ${r.trashed === 1 ? "file" : "files"} to the system Trash` +
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
          <h1>Cleanup</h1>
          <p className="sub">
            Copies, near-copies, blurry shots and photos whose files are gone. Nothing is deleted
            until you say so, and deleting goes to the system Trash — recoverable, never erased.
          </p>
        </div>
        <div className="actions">
          {isDupeTab && wasted > 0 && (
            <span className="chip">
              <span className="dot" />
              potential savings&nbsp;<strong>{fmtBytes(wasted)}</strong>
            </span>
          )}
          {isDupeTab && (
            <button className="primary" onClick={() => run.mutate()} disabled={run.isPending}>
              Find near-duplicates
            </button>
          )}
          {tab === "blurry" && (
            <button className="primary" onClick={() => scanBlur.mutate(false)} disabled={scanBlur.isPending}>
              {blurry && blurry.unscored > 0
                ? `Check ${blurry.unscored.toLocaleString()} photos`
                : "Check again"}
            </button>
          )}
        </div>
      </header>

      <div className="row" style={{ marginBottom: 18, flexWrap: "wrap" }}>
        <div className="seg">
          <button className={tab === "exact" ? "on" : ""} onClick={() => setTab("exact")}>
            Exact copies
          </button>
          <button className={tab === "near" ? "on" : ""} onClick={() => setTab("near")}>
            Similar
          </button>
          <button className={tab === "blurry" ? "on" : ""} onClick={() => setTab("blurry")}>
            Blurry
          </button>
          <button className={tab === "missing" ? "on" : ""} onClick={() => setTab("missing")}>
            Missing
          </button>
        </div>
        <span className="spacer" />
        {tab === "blurry" && (
          <div className="seg" title="How soft a photo has to be before it shows up here">
            {SENSITIVITIES.map((s) => (
              <button key={s.key} className={sens === s.key ? "on" : ""} onClick={() => setSens(s.key)}>
                {s.label}
              </button>
            ))}
          </div>
        )}
        {isDupeTab && (groups ?? []).length > 0 && (
          <>
            <button onClick={checkNonKeepers}>Mark all non-keepers</button>
            <button onClick={doExport} disabled={discards.size === 0}>
              Export list ({discards.size})
            </button>
          </>
        )}
        {(isDupeTab || tab === "blurry") && discards.size > 0 && (
          <button className="danger" onClick={() => setConfirmingTrash(true)}>
            Move to Trash ({discards.size})
          </button>
        )}
        {tab === "missing" && (missing?.total ?? 0) > 0 && (
          <button className="danger" onClick={() => setConfirmingForget(true)}>
            Forget all {missing!.total.toLocaleString()}
          </button>
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

      {/* ---- exact / similar ------------------------------------------- */}
      {isDupeTab &&
        ((groups ?? []).length === 0 ? (
          <div className="empty">
            <ArtDupes className="art" />
            <p>{tab === "exact" ? "No exact copies found." : "No similar photos found — run the finder above."}</p>
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
        ))}

      {/* ---- blurry ----------------------------------------------------- */}
      {tab === "blurry" &&
        (blurry == null ? null : blurry.scored === 0 ? (
          <div className="empty">
            <ArtDupes className="art" />
            <p>
              Smriti hasn&rsquo;t checked your photos for blur yet. It reads the thumbnails it
              already has, so this is quick and changes nothing.
            </p>
          </div>
        ) : blurry.items.length === 0 ? (
          <div className="empty">
            <ArtDupes className="art" />
            <p>
              Nothing blurry at this setting
              {sens !== "aggressive" ? " — try Catch more if you're looking for softer shots." : "."}
            </p>
          </div>
        ) : (
          <>
            <p className="muted small" style={{ marginBottom: 12 }}>
              Softest first. A photo of fog, snow or a plain sky has little detail by nature and can
              land here without being a bad photo — so have a look before you delete.
              {blurry.unscored > 0
                ? ` ${blurry.unscored.toLocaleString()} photos still to check.`
                : ""}
            </p>
            <div className="dupe-items">
              {blurry.items.map((it) => (
                <div
                  key={it.id}
                  className={`dupe-item ${discards.has(it.id) ? "discard" : ""}`}
                  onClick={() => toggleDiscard(it.id)}
                >
                  <img src={`/api/thumb/${it.id}`} loading="lazy" alt="" />
                  <div style={{ margin: "5px 0 2px" }}>
                    {discards.has(it.id) && <span className="badge red">discard</span>}
                  </div>
                  <div className="path">{it.filename}</div>
                </div>
              ))}
            </div>
          </>
        ))}

      {/* ---- missing ---------------------------------------------------- */}
      {tab === "missing" &&
        (missing == null ? null : missing.total === 0 ? (
          <div className="empty">
            <ArtDupes className="art" />
            <p>Nothing missing — every photo in your library is still where Smriti left it.</p>
          </div>
        ) : (
          <div className="panel">
            <p className="muted" style={{ marginBottom: 12 }}>
              <strong>{missing.total.toLocaleString()} photos</strong> whose files are no longer on
              disk. You deleted these outside Smriti, so they have already gone from your timeline
              — forgetting them clears the leftover entries and frees their thumbnails.
            </p>
            <p className="muted small" style={{ marginBottom: 14 }}>
              A disconnected drive never appears here: an interrupted scan deliberately marks
              nothing as missing, so unplugging a drive can&rsquo;t cost you anything.
            </p>
            {missing.items.map((it) => (
              <div className="list-row" key={it.id}>
                <strong style={{ wordBreak: "break-word" }}>{it.filename}</strong>
                <span className="muted small">{it.volume}</span>
                <span className="spacer" />
                <span className="muted small path">{it.rel_path}</span>
              </div>
            ))}
            {missing.total > missing.items.length && (
              <p className="muted small" style={{ marginTop: 10 }}>
                Showing the first {missing.items.length.toLocaleString()} of{" "}
                {missing.total.toLocaleString()}.
              </p>
            )}
          </div>
        ))}

      {confirmingTrash && (
        <ConfirmDialog
          title={`Move ${discards.size} ${discards.size === 1 ? "photo" : "photos"} to Trash?`}
          body="Marked files go to the system Trash (recoverable there) and leave the library. Anything you didn't mark stays untouched."
          confirmLabel="Move to Trash"
          danger
          onConfirm={trashDiscards}
          onClose={() => setConfirmingTrash(false)}
        />
      )}
      {confirmingForget && (
        <ConfirmDialog
          title={`Forget ${missing?.total.toLocaleString()} missing photos?`}
          body={
            <>
              <p style={{ marginBottom: 10 }}>
                These files are already gone from your disk — Smriti is only holding empty entries
                for them. Forgetting clears those entries and their thumbnails.
              </p>
              <p>
                <strong>Nothing on disk is touched</strong>, because there is nothing left to touch.
                If a file ever comes back, the next scan will pick it up again.
              </p>
            </>
          }
          confirmLabel="Forget them"
          danger
          onConfirm={() => forget.mutate()}
          onClose={() => setConfirmingForget(false)}
        />
      )}
    </div>
  );
}
