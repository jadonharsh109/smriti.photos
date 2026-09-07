import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, fmtBytes, type Item } from "../api/client";
import { ConfirmDialog } from "../components/Dialogs";
import { IconExpand, IconMore, IconTrash } from "../components/Icons";
import Viewer from "../components/Viewer";
import { thumbUrl } from "../lib/images";
import { actions } from "../shell/actions";
import { openContextMenu } from "../shell/ContextMenu";
import { jobs, runningJob } from "../shell/store";
import { InfoToggle, Segmented, TbButton, Toolbar } from "../shell/Toolbar";

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
const SENS = [
  { value: "gentle", label: "Only the worst" },
  { value: "normal", label: "Normal" },
  { value: "aggressive", label: "Catch more" },
];

/** What the viewer needs, from a row that was never a timeline item. */
const asItem = (r: { id: number; media_type?: string; width?: number | null; height?: number | null }): Item => ({
  id: r.id,
  media_type: r.media_type === "video" ? "video" : "photo",
  width: r.width ?? null,
  height: r.height ?? null,
  duration_s: null,
  day: "",
});

function PreviewButton({ id, onOpen }: { id: number; onOpen: (id: number) => void }) {
  return (
    <button className="preview" title="Look closer" aria-label="Look closer" onClick={(e) => { e.stopPropagation(); onOpen(id); }}>
      <IconExpand />
    </button>
  );
}

/** Everything worth deleting, in one place: exact copies, near-duplicates,
 *  blurry shots, and photos whose files are already gone. Nothing leaves
 *  until you say so, and deleting goes to the system Trash. */
export default function CleanupPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("exact");
  const [sens, setSens] = useState("normal");
  const [discards, setDiscards] = useState<Set<number>>(new Set());
  const [missingSel, setMissingSel] = useState<Set<number>>(new Set());
  const [confirmForgetAll, setConfirmForgetAll] = useState(false);
  const [preview, setPreview] = useState<{ list: Item[]; idx: number } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const byId = jobs.use((s) => s.byId);
  const running = runningJob(byId);
  const isDupeTab = tab === "exact" || tab === "near";
  // the newest job of a kind this window has seen — what the empty states
  // report on, so pressing a button visibly does something
  const latest = (kind: string) => Object.values(byId).filter((j) => j.kind === kind).sort((a, b) => b.id - a.id)[0];
  const dupeJob = latest("neardup");
  const blurJob = latest("blur");
  const findSimilar = () => {
    setTab("near");
    setNote(null);
    run.mutate("/api/dupes/run");
  };

  const { data: groups, isLoading: dupesLoading } = useQuery({ queryKey: ["dupes", tab], queryFn: () => api.get<Group[]>(`/api/dupes/${tab}`), enabled: isDupeTab });
  const { data: blurry, isLoading: blurryLoading } = useQuery({ queryKey: ["blurry", sens], queryFn: () => api.get<Blurry>(`/api/cleanup/blurry?sensitivity=${sens}`), enabled: tab === "blurry" });
  const { data: missing, isLoading: missingLoading } = useQuery({ queryKey: ["missing"], queryFn: () => api.get<Missing>("/api/cleanup/missing"), enabled: tab === "missing" });

  const run = useMutation({ mutationFn: (url: string) => api.post(url), onSettled: () => qc.invalidateQueries() });
  const forgetAll = useMutation({
    mutationFn: () => api.post<{ forgotten: number }>("/api/cleanup/missing/forget", {}),
    onSuccess: (r) => {
      setNote(`Forgot ${r.forgotten.toLocaleString()} ${r.forgotten === 1 ? "entry" : "entries"}`);
      setMissingSel(new Set());
      qc.invalidateQueries();
    },
  });
  const dismissGroup = useMutation({ mutationFn: (gid: number) => api.post(`/api/dupes/groups/${gid}/dismiss`), onSuccess: () => qc.invalidateQueries({ queryKey: ["dupes"] }) });

  const toggleIn = (set: (f: (p: Set<number>) => Set<number>) => void) => (id: number) =>
    set((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleDiscard = toggleIn(setDiscards);
  const toggleMissing = toggleIn(setMissingSel);

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

  const markNonKeepers = () => {
    const next = new Set(discards);
    for (const g of groups ?? []) for (const it of g.items) if (!it.is_suggested_keeper) next.add(it.id);
    setDiscards(next);
  };
  const exportList = async () => {
    const r = await fetch("/api/dupes/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file_ids: [...discards] }) });
    setNote(`Discard list saved under data/exports — ${(await r.text()).trim()}`);
  };
  const wasted = (groups ?? []).reduce((s, g) => s + g.items.filter((i) => !i.is_suggested_keeper).reduce((x, i) => x + i.size_bytes, 0), 0);

  const more = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const items = [];
    if (isDupeTab) {
      items.push({ label: "Find Near-Duplicates", disabled: !!running, onSelect: () => run.mutate("/api/dupes/run") });
      if ((groups ?? []).length) {
        items.push({ label: "Mark All Non-Keepers", onSelect: markNonKeepers });
        items.push({ label: `Export Discard List (${discards.size})`, disabled: discards.size === 0, onSelect: exportList });
      }
    } else if (tab === "blurry") {
      items.push({ label: blurry && blurry.unscored > 0 ? `Check ${blurry.unscored.toLocaleString()} Photos` : "Check Again", disabled: !!running, onSelect: () => run.mutate("/api/cleanup/blur/scan?rescore=false") });
    } else {
      items.push({ label: `Forget All ${(missing?.total ?? 0).toLocaleString()}`, danger: true, disabled: !missing?.total, onSelect: () => setConfirmForgetAll(true) });
    }
    openContextMenu({ clientX: r.right - 220, clientY: r.bottom + 4, preventDefault: () => {} }, items);
  };

  const count = isDupeTab && wasted > 0 ? `${fmtBytes(wasted)} recoverable` : tab === "missing" && missing ? `${missing.total.toLocaleString()} missing` : null;
  return (
    <>
      <Toolbar title="Cleanup" count={count}>
        {(isDupeTab || tab === "blurry") && discards.size > 0 && (
          <span className="tsel">
            <span className="n num">{discards.size} marked</span>
            <TbButton icon={<IconTrash size={14} />} title="Move marked to Trash" danger onClick={() => actions.trash([...discards])}>Move to Trash</TbButton>
            <TbButton onClick={() => setDiscards(new Set())}>Clear</TbButton>
          </span>
        )}
        {tab === "missing" && missingSel.size > 0 && (
          <span className="tsel">
            <span className="n num">{missingSel.size} picked</span>
            <TbButton danger onClick={() => actions.forgetMissing([...missingSel])}>Forget</TbButton>
            <TbButton onClick={() => setMissingSel(new Set())}>Clear</TbButton>
          </span>
        )}
        <Segmented
          value={tab}
          options={[{ value: "exact", label: "Exact" }, { value: "near", label: "Similar" }, { value: "blurry", label: "Blurry" }, { value: "missing", label: "Missing" }]}
          onChange={(t) => { setTab(t); setNote(null); }}
        />
        {tab === "blurry" && <Segmented value={sens} options={SENS} onChange={setSens} />}
        <TbButton icon={<IconMore size={14} />} title="More" onClick={more} />
        <InfoToggle />
      </Toolbar>

      <div className="page">
        {note && (
          <div className="row" style={{ padding: "8px 0" }}>
            <span className="pill good">{note}</span>
            <button className="btn ghost small" onClick={() => setNote(null)}>Dismiss</button>
          </div>
        )}

        {isDupeTab && dupesLoading && <div className="empty"><div className="spin" /><p>Looking through your library…</p></div>}
        {isDupeTab && !dupesLoading &&
          (tab === "near" && dupeJob?.status === "running" ? (
            <div className="empty">
              <div className="spin" />
              <p>{dupeJob.total > 0 ? `Comparing ${dupeJob.done.toLocaleString()} of ${dupeJob.total.toLocaleString()} photos…` : "Comparing photos…"}</p>
            </div>
          ) : (groups ?? []).length === 0 ? (
            tab === "exact" ? (
              <div className="empty">
                <h2>No exact copies</h2>
                <p>Every file is hashed as it is indexed, so this list is always up to date. Photos that are nearly the same — resized, re-saved, lightly edited — are found separately.</p>
                <div className="row"><button className="btn" disabled={!!running} onClick={findSimilar}>Find Similar Photos</button></div>
              </div>
            ) : dupeJob && dupeJob.status !== "failed" ? (
              <div className="empty">
                <h2>Nothing similar</h2>
                <p>Compared {dupeJob.total.toLocaleString()} photos; none were close enough to count as copies of each other.</p>
                <div className="row"><button className="btn" disabled={!!running} onClick={findSimilar}>Look Again</button></div>
              </div>
            ) : (
              <div className="empty">
                <h2>{dupeJob ? "The last search didn’t finish" : "Similar photos haven’t been looked for yet"}</h2>
                <p>{dupeJob?.message ?? "Smriti compares every photo’s fingerprint against the rest and groups the ones that are nearly the same — resized, re-saved, lightly edited."}</p>
                <div className="row"><button className="btn primary" disabled={!!running} onClick={findSimilar}>Find Similar Photos</button></div>
              </div>
            )
          ) : (
            <>
              <p className="note" style={{ padding: "8px 0 0" }}>Click a photo to mark it for the Trash. The one Smriti would keep is outlined in green.</p>
              {groups!.map((g, gi) => (
                <div key={g.group_id ?? gi} className="dupe-group">
                  <div className="row">
                    <span className="pill">{g.kind === "video-quick" ? "video · quick-hash match" : g.kind}</span>
                    <span className="muted small num">{g.items.length} files</span>
                    <span className="grow" />
                    {g.kind === "near" && g.group_id != null && (
                      <button className="btn small" onClick={() => dismissGroup.mutate(g.group_id!)}>Not Duplicates</button>
                    )}
                  </div>
                  <div className="dupe-items">
                    {g.items.map((it) => (
                      <div key={it.id} className={`dupe-item${discards.has(it.id) ? " discard" : it.is_suggested_keeper ? " keep" : ""}`} onClick={() => toggleDiscard(it.id)}>
                        <div className="thumb">
                          <img src={thumbUrl(it.id)} loading="lazy" alt="" />
                          <PreviewButton id={it.id} onOpen={openPreview} />
                        </div>
                        <div className="num" style={{ marginTop: 4 }}>
                          {it.is_suggested_keeper && <span className="pill good" style={{ marginRight: 4 }}>keep</span>}
                          {discards.has(it.id) && <span className="pill bad" style={{ marginRight: 4 }}>discard</span>}
                          {it.width && it.height ? `${it.width}×${it.height} · ` : ""}{fmtBytes(it.size_bytes)}
                        </div>
                        <div className="path" title={it.rel_path}>{it.rel_path}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </>
          ))}

        {tab === "blurry" && blurryLoading && <div className="empty"><div className="spin" /><p>Reading sharpness scores…</p></div>}
        {tab === "blurry" && !blurryLoading && blurJob?.status === "running" && (
          <div className="empty">
            <div className="spin" />
            <p>{blurJob.total > 0 ? `Checking ${blurJob.done.toLocaleString()} of ${blurJob.total.toLocaleString()} photos…` : "Checking photos…"}</p>
          </div>
        )}
        {tab === "blurry" && !blurryLoading && blurJob?.status !== "running" &&
          (blurry == null ? null : blurry.scored === 0 ? (
            <div className="empty">
              <p>Smriti hasn’t checked your photos for blur yet. It reads the thumbnails it already has, so this is quick and changes nothing.</p>
              <div className="row"><button className="btn primary" disabled={!!running} onClick={() => run.mutate("/api/cleanup/blur/scan?rescore=false")}>Check for Blur</button></div>
            </div>
          ) : blurry.items.length === 0 ? (
            <div className="empty"><p>Nothing blurry at this setting{sens !== "aggressive" ? " — try Catch more for softer shots." : "."}</p></div>
          ) : (
            <>
              <p className="note" style={{ padding: "8px 0 0" }}>
                Softest first. Fog, snow or a plain sky has little detail by nature and can land here without being a bad photo — look before you delete.
                {blurry.unscored > 0 ? ` ${blurry.unscored.toLocaleString()} photos still to check.` : ""}
              </p>
              <div className="dupe-items">
                {blurry.items.map((it) => (
                  <div key={it.id} className={`dupe-item${discards.has(it.id) ? " discard" : ""}`} onClick={() => toggleDiscard(it.id)}>
                    <div className="thumb">
                      <img src={thumbUrl(it.id)} loading="lazy" alt="" />
                      <PreviewButton id={it.id} onOpen={openPreview} />
                    </div>
                    <div style={{ marginTop: 4 }}>{discards.has(it.id) && <span className="pill bad">discard</span>}</div>
                    <div className="path" title={it.filename}>{it.filename}</div>
                  </div>
                ))}
              </div>
            </>
          ))}

        {tab === "missing" && missingLoading && <div className="empty"><div className="spin" /><p>Checking for missing files…</p></div>}
        {tab === "missing" &&
          (missing == null ? null : missing.total === 0 ? (
            <div className="empty"><p>Nothing missing — every photo in your library is still where Smriti left it.</p></div>
          ) : (
            <>
              <p className="note" style={{ padding: "8px 0" }}>
                Files that are no longer on disk. They were deleted outside Smriti, so they have already gone from Photos — forgetting them clears the leftover entries and their thumbnails.
                A disconnected drive never appears here.
              </p>
              <div className="list">
                {missing.items.map((it) => (
                  <div key={it.id} className={`li clickable${missingSel.has(it.id) ? " picked" : ""}`} onClick={() => toggleMissing(it.id)}>
                    <span className={`check${missingSel.has(it.id) ? " on" : ""}`}>✓</span>
                    <div className="dupe-item" style={{ width: 44 }}>
                      <div className="thumb" style={{ width: 44, height: 32 }}>
                        <img src={thumbUrl(it.id)} loading="lazy" alt="" />
                        <PreviewButton id={it.id} onOpen={openPreview} />
                      </div>
                    </div>
                    <span className="path"><strong>{it.filename}</strong> <span className="muted">{it.rel_path}</span></span>
                    <span className="st">{it.volume}</span>
                  </div>
                ))}
              </div>
              {missing.total > missing.items.length && <p className="note" style={{ padding: "8px 0" }}>Showing the first {missing.items.length.toLocaleString()} of {missing.total.toLocaleString()}.</p>}
            </>
          ))}
      </div>

      {preview && (
        <Viewer
          item={preview.list[preview.idx]}
          position={{ index: preview.idx + 1, total: preview.list.length, label: "Cleanup" }}
          onClose={() => setPreview(null)}
          onPrev={preview.idx > 0 ? () => stepPreview(-1) : undefined}
          onNext={preview.idx < preview.list.length - 1 ? () => stepPreview(1) : undefined}
          deleteAction={tab === "missing" ? { label: "Forget This Entry", run: () => actions.forgetMissing([preview.list[preview.idx].id]) } : undefined}
        />
      )}
      {confirmForgetAll && (
        <ConfirmDialog
          title={`Forget ${missing?.total.toLocaleString()} missing photos?`}
          body="These files are already gone from disk — Smriti is only holding empty entries for them. Forgetting clears those entries and their thumbnails. If a file ever comes back, the next scan picks it up again."
          confirmLabel="Forget Them"
          danger
          onConfirm={() => forgetAll.mutate()}
          onClose={() => setConfirmForgetAll(false)}
        />
      )}
    </>
  );
}
