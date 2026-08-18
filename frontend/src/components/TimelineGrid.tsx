import justifiedLayout from "justified-layout";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, fetchAllItems, filterQS, fmtDay, type Bucket, type Filters, type Item } from "../api/client";
import { ArtPhotos } from "./Illustrations";
import JustifiedGrid from "./JustifiedGrid";
import TimeScrubber from "./TimeScrubber";
import Lightbox from "./Lightbox";
import SelectionBar from "./SelectionBar";

const ROW_H = 220;
const HEADER_H = 46;   // .day-header is height:46px (border-box) in styles.css

interface Props {
  filters: Filters;
  emptyText?: string;
  /** Extra buttons for the selection bar, e.g. "Not a document". A render
   *  prop because the action needs the live selection, which lives here. */
  selectionActions?: (selected: Set<number>, clear: () => void) => React.ReactNode;
}

/** The Google-Photos-style date-grouped grid. Scales to 100k+ items:
 * the tiny buckets payload builds the full scroll skeleton immediately;
 * items are fetched per visible day section (section-level virtualization). */
export default function TimelineGrid({ filters, emptyText = "Nothing here yet", selectionActions }: Props) {
  const qc = useQueryClient();
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1000);
  const [scrollMargin, setScrollMargin] = useState(0);
  const estimateCache = useRef(new Map<string, number>());
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [lightbox, setLightbox] = useState<{ dayIdx: number; itemIdx: number; item: Item } | null>(null);

  const filterKey = JSON.stringify(filters);
  const { data: buckets, isLoading } = useQuery({
    queryKey: ["buckets", filterKey],
    queryFn: () => api.get<Bucket[]>(`/api/timeline/buckets${filterQS(filters)}`),
  });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      setWidth(el.clientWidth);
      // where the list starts inside the scroll container (page header above it)
      const scroller = document.getElementById("main-scroll");
      if (scroller) {
        setScrollMargin(el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop);
      }
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    // remeasure once the page-enter animation has finished shifting layout
    const t = setTimeout(measure, 450);
    return () => {
      ro.disconnect();
      clearTimeout(t);
    };
  }, []);

  /** How tall a day will be, before any of its photos have been fetched.
   *
   *  This has to be close, because the virtualizer builds the entire scroll
   *  range out of these numbers and then corrects each one as it is measured.
   *  A correction to a day ABOVE the viewport forces a compensating scroll —
   *  which is felt as the timeline lurching under the cursor. The old guess
   *  assumed every photo was landscape 3:2 and over-estimated a portrait-heavy
   *  day by more than 40%, so every day corrected, and the whole scroll range
   *  shrank as you went.
   *
   *  So run the real layout algorithm rather than approximating it: the day's
   *  average shape, repeated `count` times, packed by the same function the
   *  grid itself uses. Memoized per (day, width) because the virtualizer asks
   *  for these constantly. */
  const estimate = useCallback(
    (b: Bucket) => {
      // Keyed by day alone: the cache is emptied whenever the width changes,
      // so an entry can never describe a layout that is no longer on screen.
      const hit = estimateCache.current.get(b.day);
      if (hit !== undefined) return hit;
      const avg = b.ar && b.count ? b.ar / b.count : 1.5;
      const boxes = Array.from({ length: b.count }, () => ({ width: avg * 1000, height: 1000 }));
      const { containerHeight } = justifiedLayout(boxes, {
        containerWidth: Math.max(width, 200),
        targetRowHeight: ROW_H,
        boxSpacing: 4,
        containerPadding: 0,
      });
      const h = HEADER_H + containerHeight;
      estimateCache.current.set(b.day, h);
      return h;
    },
    [width]
  );

  // A resize re-lays out every day, so every cached height is now wrong.
  useEffect(() => {
    estimateCache.current.clear();
  }, [width]);

  const virtualizer = useVirtualizer({
    count: buckets?.length ?? 0,
    getScrollElement: () => document.getElementById("main-scroll"),
    estimateSize: (i) => estimate(buckets![i]),
    overscan: 4,
    getItemKey: (i) => buckets![i].day,
    scrollMargin,
  });

  const itemsFor = (day: string) =>
    qc.fetchQuery({
      queryKey: ["items", filterKey, day],
      queryFn: () => api.get<Item[]>(`/api/timeline/items${filterQS(filters, { day })}`),
      staleTime: 300_000,
    });

  const openAt = async (dayIdx: number, itemIdx: number) => {
    const items = await itemsFor(buckets![dayIdx].day);
    if (itemIdx < 0) itemIdx = items.length - 1;
    if (itemIdx >= items.length) itemIdx = 0;
    setLightbox({ dayIdx, itemIdx, item: items[itemIdx] });
  };

  const step = async (dir: 1 | -1) => {
    if (!lightbox || !buckets) return;
    const items = await itemsFor(buckets[lightbox.dayIdx].day);
    const nextIdx = lightbox.itemIdx + dir;
    if (nextIdx >= 0 && nextIdx < items.length) {
      setLightbox({ ...lightbox, itemIdx: nextIdx, item: items[nextIdx] });
      return;
    }
    // buckets are newest-first: "next" (dir=1) moves to the older day
    const nd = lightbox.dayIdx + dir;
    if (nd < 0 || nd >= buckets.length) return;
    const nItems = await itemsFor(buckets[nd].day);
    const ni = dir === 1 ? 0 : nItems.length - 1;
    setLightbox({ dayIdx: nd, itemIdx: ni, item: nItems[ni] });
  };

  const toggleSelect = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const selectMany = (ids: number[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  const selectAll = async () => {
    const all = await fetchAllItems(filters);
    setSelected(new Set(all.map((i) => i.id)));
  };

  if (isLoading)
    return (
      <div style={{ display: "grid", gap: 14, paddingTop: 20 }}>
        <div className="skeleton" style={{ height: 220 }} />
        <div className="skeleton" style={{ height: 220, animationDelay: "0.15s" }} />
      </div>
    );
  if (!buckets || buckets.length === 0)
    return (
      <div className="empty">
        <ArtPhotos className="art" />
        <p>{emptyText}</p>
      </div>
    );

  return (
    <div ref={containerRef} style={{ position: "relative", paddingRight: 70 }}>
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((vi) => (
          <div
            key={vi.key}
            data-index={vi.index}
            ref={virtualizer.measureElement}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${vi.start - virtualizer.options.scrollMargin}px)`,
            }}
          >
            <DaySection
              day={buckets[vi.index].day}
              count={buckets[vi.index].count}
              filterKey={filterKey}
              filters={filters}
              width={width - 70}
              estHeight={estimate(buckets[vi.index]) - HEADER_H}
              onOpen={(itemIdx) => openAt(vi.index, itemIdx)}
              selected={selected}
              onToggleSelect={toggleSelect}
              onSelectMany={selectMany}
            />
          </div>
        ))}
      </div>
      {buckets.length > 2 && (() => {
        // the dot mirrors the *middle* of what's on screen, pinned to the rail
        // ends at the scroll extremes so it always reaches newest/oldest
        const scroller = document.getElementById("main-scroll");
        const offset = virtualizer.scrollOffset ?? 0;
        const viewH = scroller?.clientHeight ?? 800;
        const maxScroll = scroller ? Math.max(0, scroller.scrollHeight - scroller.clientHeight) : 0;
        const vItems = virtualizer.getVirtualItems();
        const center = offset + viewH / 2;
        const centerIndex = (vItems.find((v) => v.end > center) ?? vItems[vItems.length - 1])?.index ?? 0;
        const edge = offset <= 2 ? ("top" as const) : maxScroll > 0 && offset >= maxScroll - 2 ? ("bottom" as const) : null;
        return (
          <TimeScrubber
            buckets={buckets}
            currentIndex={centerIndex}
            edge={edge}
            onJump={(i) => virtualizer.scrollToIndex(i, { align: "start" })}
          />
        );
      })()}
      <SelectionBar
        selected={selected}
        onClear={() => setSelected(new Set())}
        onSelectAll={selectAll}
        extraActions={selectionActions?.(selected, () => setSelected(new Set()))}
      />
      {lightbox && (
        <Lightbox
          item={lightbox.item}
          onClose={() => setLightbox(null)}
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
  selected: Set<number>;
  onToggleSelect: (id: number) => void;
  onSelectMany: (ids: number[], on: boolean) => void;
}) {
  const { data: items } = useQuery({
    queryKey: ["items", props.filterKey, props.day],
    queryFn: () => api.get<Item[]>(`/api/timeline/items${filterQS(props.filters, { day: props.day })}`),
    staleTime: 300_000,
  });

  const allSel = !!items && items.length > 0 && items.every((it) => props.selected.has(it.id));
  const someSel = !allSel && (items?.some((it) => props.selected.has(it.id)) ?? false);

  return (
    <section className="day-sec">
      <div className="day-header">
        <span>{fmtDay(props.day)}</span>
        {items && items.length > 0 && (
          <button
            className={`day-check${allSel ? " on" : someSel ? " part" : ""}`}
            title={allSel ? "Deselect this day" : "Select this day"}
            onClick={() => props.onSelectMany(items.map((i) => i.id), !allSel)}
          >
            ✓
          </button>
        )}
      </div>
      {items ? (
        <JustifiedGrid
          items={items}
          width={props.width}
          onOpen={props.onOpen}
          selected={props.selected}
          onToggleSelect={props.onToggleSelect}
        />
      ) : (
        <div className="skeleton" style={{ height: props.estHeight }} />
      )}
    </section>
  );
}
