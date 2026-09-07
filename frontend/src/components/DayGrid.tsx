import justifiedLayout from "justified-layout";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, fetchAllItems, filterQS, fmtDay, setFavourite, type Bucket, type Filters, type Item } from "../api/client";
import { actions } from "../shell/actions";
import type { MenuItem } from "../shell/ContextMenu";
import { selection, selectionActions, view } from "../shell/store";
import PhotoGrid, { type Box } from "./PhotoGrid";
import TimeScrubber from "./TimeScrubber";
import Viewer from "./Viewer";

const HEADER_H = 40; // .day is height: 40px (border-box) in shell.css

interface Props {
  filters: Filters;
  emptyText?: string;
  /** Extra context-menu entries, e.g. "Not a document". */
  menuExtras?: (ids: number[]) => MenuItem[];
}

/** The date-grouped grid. Scales to 100k+ items: the tiny buckets payload
 *  builds the full scroll skeleton immediately; items are fetched per visible
 *  day section. Selection, arrow keys and the viewer all live here. */
export default function DayGrid({ filters, emptyText = "Nothing here yet", menuExtras }: Props) {
  const qc = useQueryClient();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const resizeObs = useRef<ResizeObserver | null>(null);
  const [width, setWidth] = useState(1000);
  const [scrollMargin, setScrollMargin] = useState(0);
  const estimateCache = useRef(new Map<string, number>());
  const tileH = view.use((s) => s.tileHeight);
  const [viewing, setViewing] = useState<{ dayIdx: number; itemIdx: number; item: Item } | null>(null);
  // what each day has loaded and where its tiles sit, for the arrow keys
  const loaded = useRef(new Map<string, Item[]>());
  const boxes = useRef(new Map<string, Box[]>());
  const [loadedTick, setLoadedTick] = useState(0);

  const filterKey = JSON.stringify(filters);
  const { data: buckets, isLoading } = useQuery({
    queryKey: ["buckets", filterKey],
    queryFn: () => api.get<Bucket[]>(`/api/timeline/buckets${filterQS(filters)}`),
  });

  const measure = useCallback((el: HTMLDivElement) => {
    setWidth(el.clientWidth);
    const scroller = document.getElementById("main-scroll");
    if (scroller) {
      setScrollMargin(el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop);
    }
  }, []);

  /** A callback ref, because this component returns early while the buckets
   *  load and an effect would never see the node appear. */
  const attachContainer = useCallback(
    (el: HTMLDivElement | null) => {
      containerRef.current = el;
      resizeObs.current?.disconnect();
      resizeObs.current = null;
      if (!el) return;
      const ro = new ResizeObserver(() => measure(el));
      ro.observe(el);
      resizeObs.current = ro;
      measure(el);
    },
    [measure]
  );
  useEffect(() => () => resizeObs.current?.disconnect(), []);

  /** How tall a day will be before its photos are fetched: the day's average
   *  shape repeated `count` times through the same layout the grid uses. */
  const estimate = useCallback(
    (b: Bucket) => {
      const hit = estimateCache.current.get(b.day);
      if (hit !== undefined) return hit;
      const avg = b.ar && b.count ? b.ar / b.count : 1.5;
      const list = Array.from({ length: b.count }, () => ({ width: avg * 1000, height: 1000 }));
      const { containerHeight } = justifiedLayout(list, {
        containerWidth: Math.max(width, 200),
        targetRowHeight: tileH,
        boxSpacing: 4,
        containerPadding: 0,
      });
      const h = HEADER_H + containerHeight + 4;
      estimateCache.current.set(b.day, h);
      return h;
    },
    [width, tileH]
  );
  useEffect(() => {
    estimateCache.current.clear();
  }, [width, tileH]);

  const virtualizer = useVirtualizer({
    count: buckets?.length ?? 0,
    getScrollElement: () => document.getElementById("main-scroll"),
    estimateSize: (i) => estimate(buckets![i]),
    overscan: 3,
    getItemKey: (i) => buckets![i].day,
    scrollMargin,
  });

  // the visible order, for shift-click ranges, ⌘A and the arrow keys
  useEffect(() => {
    if (!buckets) return;
    const order: number[] = [];
    for (const b of buckets) for (const it of loaded.current.get(b.day) ?? []) order.push(it.id);
    selectionActions.setOrder(order);
  }, [buckets, loadedTick]);
  useEffect(() => {
    loaded.current.clear();
    boxes.current.clear();
  }, [filterKey]);

  const favInDay = (day: string) => (id: number, on: boolean) =>
    setFavourite(id, on, (fav) =>
      qc.setQueryData<Item[]>(["items", filterKey, day], (prev) => prev?.map((it) => (it.id === id ? { ...it, fav } : it)))
    )
      .then(() => qc.invalidateQueries({ queryKey: ["albums"] }))
      .catch(() => {});

  const itemsFor = (day: string) =>
    qc.fetchQuery({
      queryKey: ["items", filterKey, day],
      queryFn: () => fetchAllItems(filters, day),
      staleTime: 300_000,
    });

  const openAt = async (dayIdx: number, itemIdx: number) => {
    const items = await itemsFor(buckets![dayIdx].day);
    if (itemIdx < 0) itemIdx = items.length - 1;
    if (itemIdx >= items.length) itemIdx = 0;
    setViewing({ dayIdx, itemIdx, item: items[itemIdx] });
  };

  const step = async (dir: 1 | -1) => {
    if (!viewing || !buckets) return;
    const items = await itemsFor(buckets[viewing.dayIdx].day);
    const nextIdx = viewing.itemIdx + dir;
    if (nextIdx >= 0 && nextIdx < items.length) {
      setViewing({ ...viewing, itemIdx: nextIdx, item: items[nextIdx] });
      return;
    }
    const nd = viewing.dayIdx + dir; // buckets are newest-first: "next" is the older day
    if (nd < 0 || nd >= buckets.length) return;
    const nItems = await itemsFor(buckets[nd].day);
    const ni = dir === 1 ? 0 : nItems.length - 1;
    setViewing({ dayIdx: nd, itemIdx: ni, item: nItems[ni] });
  };

  /** Find an item by id among the loaded days. */
  const locate = (id: number) => {
    if (!buckets) return null;
    for (let d = 0; d < buckets.length; d++) {
      const items = loaded.current.get(buckets[d].day);
      if (!items) continue;
      const i = items.findIndex((it) => it.id === id);
      if (i >= 0) return { dayIdx: d, itemIdx: i, items, box: boxes.current.get(buckets[d].day)?.[i] };
    }
    return null;
  };

  const reveal = (id: number, dayIdx: number) => {
    const el = containerRef.current?.querySelector<HTMLElement>(`.tile[data-id="${id}"]`);
    if (el) el.scrollIntoView({ block: "nearest" });
    else virtualizer.scrollToIndex(dayIdx, { align: "center" });
  };

  /** Arrow keys walk the grid; up and down pick the tile nearest above or
   *  below by geometry, crossing into the neighbouring day at the edges. */
  const move = (dir: "left" | "right" | "up" | "down") => {
    if (!buckets) return;
    const cur = selection.get().last;
    const order = selection.get().order;
    if (cur == null || !order.length) {
      const first = order[0];
      if (first != null) {
        selectionActions.select(first);
        reveal(first, 0);
      }
      return;
    }
    let target: number | null = null;
    let targetDay = 0;
    if (dir === "left" || dir === "right") {
      const i = order.indexOf(cur);
      const j = i + (dir === "right" ? 1 : -1);
      if (j < 0 || j >= order.length) return;
      target = order[j];
      targetDay = locate(target)?.dayIdx ?? 0;
    } else {
      const here = locate(cur);
      if (!here || !here.box) return;
      const cx = here.box.left + here.box.width / 2;
      const rowsOf = (dayIdx: number) => {
        const bs = boxes.current.get(buckets[dayIdx].day) ?? [];
        const its = loaded.current.get(buckets[dayIdx].day) ?? [];
        const tops = [...new Set(bs.map((b) => b.top))].sort((a, b) => a - b);
        return { bs, its, tops };
      };
      const pickInRow = (dayIdx: number, top: number): number | null => {
        const { bs, its } = rowsOf(dayIdx);
        let best: number | null = null;
        let bestD = Infinity;
        bs.forEach((b, i) => {
          if (b.top !== top) return;
          const d = Math.abs(b.left + b.width / 2 - cx);
          if (d < bestD) {
            bestD = d;
            best = its[i]?.id ?? null;
          }
        });
        return best;
      };
      const { tops } = rowsOf(here.dayIdx);
      const ti = tops.indexOf(here.box.top);
      if (dir === "up") {
        if (ti > 0) {
          target = pickInRow(here.dayIdx, tops[ti - 1]);
          targetDay = here.dayIdx;
        } else if (here.dayIdx > 0) {
          targetDay = here.dayIdx - 1;
          const prev = rowsOf(targetDay);
          if (!prev.tops.length) {
            virtualizer.scrollToIndex(targetDay, { align: "end" });
            return;
          }
          target = pickInRow(targetDay, prev.tops[prev.tops.length - 1]);
        }
      } else {
        if (ti < tops.length - 1) {
          target = pickInRow(here.dayIdx, tops[ti + 1]);
          targetDay = here.dayIdx;
        } else if (here.dayIdx < buckets.length - 1) {
          targetDay = here.dayIdx + 1;
          const next = rowsOf(targetDay);
          if (!next.tops.length) {
            virtualizer.scrollToIndex(targetDay, { align: "start" });
            return;
          }
          target = pickInRow(targetDay, next.tops[0]);
        }
      }
    }
    if (target == null) return;
    selectionActions.select(target);
    reveal(target, targetDay);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (viewing || document.querySelector(".scrim")) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, [contenteditable]")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const sel = selection.get();
      switch (e.key) {
        case "ArrowLeft": e.preventDefault(); move("left"); break;
        case "ArrowRight": e.preventDefault(); move("right"); break;
        case "ArrowUp": e.preventDefault(); move("up"); break;
        case "ArrowDown": e.preventDefault(); move("down"); break;
        case "Enter":
        case " ": {
          if (sel.last == null) return;
          e.preventDefault();
          const where = locate(sel.last);
          if (where) setViewing({ dayIdx: where.dayIdx, itemIdx: where.itemIdx, item: where.items[where.itemIdx] });
          break;
        }
        case "Backspace":
        case "Delete":
          if (sel.ids.size) {
            e.preventDefault();
            actions.trash([...sel.ids]);
          }
          break;
        case ".": {
          if (sel.last == null) return;
          const where = locate(sel.last);
          if (where) favInDay(buckets![where.dayIdx].day)(sel.last, !where.items[where.itemIdx].fav);
          break;
        }
        case "Escape":
          if (sel.ids.size) selectionActions.clear();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewing, buckets]);

  const scrubber = useMemo(() => {
    if (!buckets || buckets.length <= 2) return null;
    const scroller = document.getElementById("main-scroll");
    const offset = virtualizer.scrollOffset ?? 0;
    const viewH = scroller?.clientHeight ?? 800;
    const maxScroll = scroller ? Math.max(0, scroller.scrollHeight - scroller.clientHeight) : 0;
    const vItems = virtualizer.getVirtualItems();
    const center = offset + viewH / 2;
    const centerIndex = (vItems.find((v) => v.end > center) ?? vItems[vItems.length - 1])?.index ?? 0;
    const edge = offset <= 2 ? ("top" as const) : maxScroll > 0 && offset >= maxScroll - 2 ? ("bottom" as const) : null;
    return { centerIndex, edge };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buckets, virtualizer.scrollOffset, virtualizer.getVirtualItems().length]);

  if (isLoading)
    return (
      <div className="page" style={{ display: "grid", gap: 12, paddingTop: 16 }}>
        <div className="skel" style={{ height: tileH }} />
        <div className="skel" style={{ height: tileH }} />
      </div>
    );
  if (!buckets || buckets.length === 0)
    return (
      <div className="empty">
        <p>{emptyText}</p>
      </div>
    );

  return (
    <div className="page" style={{ paddingRight: 56 }}>
      <div ref={attachContainer} style={{ position: "relative" }} onClick={() => selectionActions.clear()}>
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((vi) => (
            <div
              key={vi.key}
              data-index={vi.index}
              ref={virtualizer.measureElement}
              style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${vi.start - virtualizer.options.scrollMargin}px)` }}
            >
              <DaySection
                day={buckets[vi.index].day}
                count={buckets[vi.index].count}
                filterKey={filterKey}
                filters={filters}
                width={width}
                estHeight={estimate(buckets[vi.index]) - HEADER_H - 4}
                onOpen={(itemIdx) => openAt(vi.index, itemIdx)}
                onToggleFav={favInDay(buckets[vi.index].day)}
                menuExtras={menuExtras}
                onItems={(items) => {
                  loaded.current.set(buckets[vi.index].day, items);
                  setLoadedTick((t) => t + 1);
                }}
                onLayout={(bs) => boxes.current.set(buckets[vi.index].day, bs)}
              />
            </div>
          ))}
        </div>
      </div>
      {scrubber && (
        <TimeScrubber buckets={buckets} currentIndex={scrubber.centerIndex} edge={scrubber.edge} onJump={(i) => virtualizer.scrollToIndex(i, { align: "start" })} />
      )}
      {viewing && (
        <Viewer
          item={viewing.item}
          position={{ index: viewing.itemIdx + 1, total: loaded.current.get(buckets[viewing.dayIdx].day)?.length ?? buckets[viewing.dayIdx].count, day: buckets[viewing.dayIdx].day }}
          onToggleFav={favInDay(buckets[viewing.dayIdx].day)}
          onClose={() => setViewing(null)}
          onPrev={() => step(-1)}
          onNext={() => step(1)}
        />
      )}
    </div>
  );
}

function DaySection(props: {
  day: string;
  count: number;
  filterKey: string;
  filters: Filters;
  width: number;
  estHeight: number;
  onOpen: (itemIdx: number) => void;
  onToggleFav: (id: number, on: boolean) => void;
  menuExtras?: (ids: number[]) => MenuItem[];
  onItems: (items: Item[]) => void;
  onLayout: (boxes: Box[]) => void;
}) {
  const { data: items } = useQuery({
    queryKey: ["items", props.filterKey, props.day],
    queryFn: () => fetchAllItems(props.filters, props.day),
    staleTime: 300_000,
  });
  const ids = selection.use((s) => s.ids);
  useEffect(() => {
    if (items) props.onItems(items);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  const allSel = !!items && items.length > 0 && items.every((it) => ids.has(it.id));
  const someSel = !allSel && (items?.some((it) => ids.has(it.id)) ?? false);

  return (
    <section>
      <div className="day">
        {fmtDay(props.day)}
        <span className="n num">{props.count.toLocaleString()} {props.count === 1 ? "item" : "items"}</span>
        {items && items.length > 0 && (
          <button
            className={`day-check${allSel ? " on" : someSel ? " part" : ""}`}
            title={allSel ? "Deselect this day" : "Select this day"}
            onClick={(e) => {
              e.stopPropagation();
              selectionActions.setMany(items.map((i) => i.id), !allSel);
            }}
          >
            ✓
          </button>
        )}
      </div>
      {items ? (
        <PhotoGrid items={items} width={props.width} onOpen={props.onOpen} onToggleFav={props.onToggleFav} menuExtras={props.menuExtras} onLayout={props.onLayout} />
      ) : (
        <div className="skel" style={{ height: props.estHeight }} />
      )}
    </section>
  );
}
