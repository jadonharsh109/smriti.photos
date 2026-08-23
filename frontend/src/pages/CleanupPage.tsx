import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, fmtBytes, type Item } from "../api/client";
import { ConfirmDialog } from "../components/Dialogs";
import { IconExpand } from "../components/Icons";
import { ArtDupes } from "../components/Illustrations";
import Lightbox from "../components/Lightbox";
import { Loading } from "../components/Skeletons";

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
interface MissingItem {
  id: number;
  filename: string;
  rel_path: string;
  media_type: string;
  volume: string;
}
interface Missing {
  items: MissingItem[];
  total: number;
}

type Tab = "exact" | "near" | "blurry" | "missing";

const SENSITIVITIES = [
  { key: "gentle", label: "Only the worst" },
  { key: "normal", label: "Normal" },
  { key: "aggressive", label: "Catch more" },
] as const;

/** What the viewer needs to open something, from a row that was never a
 *  timeline item. Cleanup lists carry only what their own tab is about, so the
 *  shape is filled in and the viewer fetches the rest by id, exactly as it does
 *  for a photo opened from the grid. */
const asItem = (r: {
  id: number;
  media_type?: string;
  width?: number | null;
  height?: number | null;
}): Item => ({
  id: r.id,
  media_type: r.media_type === "video" ? "video" : "photo",
  width: r.width ?? null,
  height: r.height ?? null,
  duration_s: null,
  day: "",
});

/** The magnifier that sits on a card. Its own button so that clicking the card
 *  still means "mark this one", which is the action the page is for — looking
 *  closer is the second thought, not the first.
 *
 *  Declared out here rather than inside the page: a component defined during
 *  render is a new type every render, and React would unmount and rebuild every
 *  one of these — one per row, and Missing shows hundreds — each time a single
 *  row was picked. */
function PreviewButton({ id, label, onOpen }: { id: number; label: string; onOpen: (id: number) => void }) {
  return (
    <button
      className="preview-btn"
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onOpen(id);
      }}
    >
      <IconExpand size={16} />
    </button>
  );
}

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
  // Which list the viewer is stepping through, and where in it. Held as the
  // list rather than a single item so ←/→ work here the way they do in the
  // timeline — reviewing a pile of near-copies is exactly the job where you
  // want to flick between them rather than open and close each one.
  const [preview, setPreview] = useState<{ list: Item[]; idx: number } | null>(null);
  const [missingSel, setMissingSel] = useState<Set<number>>(new Set());
  const qc = useQueryClient();

  const isDupeTab = tab === "exact" || tab === "near";

  const { data: groups, isLoading: dupesLoading } = useQuery({
    queryKey: ["dupes", tab],
    queryFn: () => api.get<Group[]>(`/api/dupes/${tab}`),
    enabled: isDupeTab,
  });
  const { data: blurry, isLoading: blurryLoading } = useQuery({
    queryKey: ["blurry", sens],
    queryFn: () => api.get<Blurry>(`/api/cleanup/blurry?sensitivity=${sens}`),
    enabled: tab === "blurry",
  });
  const { data: missing, isLoading: missingLoading } = useQuery({
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
    // undefined = every missing file; a list = exactly those. Never send an
    // empty list dressed up as "all" — see the endpoint.
    mutationFn: (ids?: number[]) =>
      api.post<{ forgotten: number }>(
        "/api/cleanup/missing/forget",
        ids ? { file_ids: ids } : {}
      ),
    onSuccess: (r) => {
      setTrashResult(
        `Forgot ${r.forgotten.toLocaleString()} ${r.forgotten === 1 ? "entry" : "entries"} for files that were already gone`
      );
      setMissingSel(new Set());
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

  const toggleMissingSel = (id: number) =>
    setMissingSel((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** Every card in the tab currently on screen, in the order it is drawn — so
   *  the viewer's ←/→ walk the page rather than one group. */
  const previewList = (): Item[] => {
    if (isDupeTab) return (groups ?? []).flatMap((g) => g.items.map(asItem));
    if (tab === "blurry") return (blurry?.items ?? []).map((it) => asItem({ ...it, media_type: "photo" }));
    return (missing?.items ?? []).map(asItem);
  };

  const openPreview = (id: number) => {
    const list = previewList();
    const idx = list.findIndex((it) => it.id === id);
    if (idx >= 0) setPreview({ list, idx });
  };

  const stepPreview = (dir: 1 | -1) =>
    setPreview((p) => {
      if (!p) return p;
      const idx = p.idx + dir;
      return idx < 0 || idx >= p.list.length ? p : { ...p, idx };
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
          <>
            {missingSel.size > 0 && (
              <>
                <button onClick={() => setMissingSel(new Set())}>Clear ({missingSel.size})</button>
                <button className="danger" onClick={() => forget.mutate([...missingSel])}>
                  Forget selected ({missingSel.size})
                </button>
              </>
            )}
            <button className="danger" onClick={() => setConfirmingForget(true)}>
              Forget all {missing!.total.toLocaleString()}
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

      {/* ---- exact / similar ------------------------------------------- */}
      {isDupeTab && dupesLoading && <Loading label="Looking through your library…" />}
      {isDupeTab && !dupesLoading &&
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
                    <div className="dupe-thumb">
                      <img src={`/api/thumb/${it.id}`} loading="lazy" alt="" />
                      <PreviewButton id={it.id} label={`Preview ${it.filename}`} onOpen={openPreview} />
                    </div>
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
      {tab === "blurry" && blurryLoading && <Loading label="Reading sharpness scores…" />}
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
                  <div className="dupe-thumb">
                    <img src={`/api/thumb/${it.id}`} loading="lazy" alt="" />
                    <PreviewButton id={it.id} label={`Preview ${it.filename}`} onOpen={openPreview} />
                  </div>
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
      {tab === "missing" && missingLoading && <Loading label="Checking for missing files…" />}
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
              nothing as missing, so unplugging a drive can&rsquo;t cost you anything. Click a row
              to pick it, or open the preview to see what the thumbnail still remembers of it.
            </p>
            {missing.items.map((it) => (
              <div
                className={`list-row missing-row${missingSel.has(it.id) ? " picked" : ""}`}
                key={it.id}
                onClick={() => toggleMissingSel(it.id)}
              >
                <span className={`row-check${missingSel.has(it.id) ? " on" : ""}`} aria-hidden="true">
                  ✓
                </span>
                {/* The thumbnail outlives the original — it is the only picture
                    of this photo left, and the whole reason to look before you
                    forget it. */}
                <div className="missing-thumb">
                  <img src={`/api/thumb/${it.id}`} loading="lazy" alt="" />
                  <PreviewButton id={it.id} label={`Preview ${it.filename}`} onOpen={openPreview} />
                </div>
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

      {preview && (
        <Lightbox
          item={preview.list[preview.idx]}
          onClose={() => setPreview(null)}
          onPrev={preview.idx > 0 ? () => stepPreview(-1) : undefined}
          onNext={preview.idx < preview.list.length - 1 ? () => stepPreview(1) : undefined}
          // On Missing there is no original left to send to the Trash — the
          // only thing still here is the row, so that is what the button offers.
          deleteAction={
            tab === "missing"
              ? {
                  tooltip: "Forget this entry",
                  title: "Forget this entry?",
                  body: "The file itself is already gone from your disk. This clears the entry Smriti is still holding for it, and its thumbnail.",
                  confirmLabel: "Forget it",
                  run: async () => {
                    await api.post("/api/cleanup/missing/forget", {
                      file_ids: [preview.list[preview.idx].id],
                    });
                  },
                }
              : undefined
          }
        />
      )}

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
          onConfirm={() => forget.mutate(undefined)}
          onClose={() => setConfirmingForget(false)}
        />
      )}
    </div>
  );
}
