import { useCallback, useEffect, useRef, useState } from "react";
import type { Item } from "../api/client";
import { actions } from "../shell/actions";
import type { MenuItem } from "../shell/ContextMenu";
import { selection, selectionActions } from "../shell/store";
import PhotoGrid, { type Box } from "./PhotoGrid";
import Viewer from "./Viewer";

interface Props {
  items: Item[];
  /** appended to media URLs — the Locked section's token */
  qs?: string;
  onToggleFav?: (id: number, on: boolean) => void;
  menuExtras?: (ids: number[]) => MenuItem[];
  emptyText?: string;
  /** Replaces Move to Trash in the viewer and on Backspace. */
  deleteAction?: { label: string; run: (ids: number[]) => void };
  /** Shown in the viewer bar after "n of m". */
  positionLabel?: string;
}

/** One justified grid for a list that is already in hand — an album, a
 *  search, the Locked section. Selection, arrow keys and the viewer behave
 *  exactly as they do in the day-grouped grid. */
export default function FlatGrid({ items, qs = "", onToggleFav, menuExtras, emptyText = "Nothing here", deleteAction, positionLabel }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const resizeObs = useRef<ResizeObserver | null>(null);
  const [width, setWidth] = useState(1000);
  const [viewing, setViewing] = useState<number | null>(null);
  const boxes = useRef<Box[]>([]);

  const attachContainer = useCallback((el: HTMLDivElement | null) => {
    containerRef.current = el;
    resizeObs.current?.disconnect();
    resizeObs.current = null;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    resizeObs.current = ro;
    setWidth(el.clientWidth);
  }, []);
  useEffect(() => () => resizeObs.current?.disconnect(), []);

  useEffect(() => {
    selectionActions.setOrder(items.map((i) => i.id));
  }, [items]);

  // the list can shrink under an open viewer (unhide, remove from album)
  useEffect(() => {
    if (viewing != null && viewing >= items.length) setViewing(items.length ? items.length - 1 : null);
  }, [items, viewing]);

  const reveal = (id: number) => {
    containerRef.current?.querySelector<HTMLElement>(`.tile[data-id="${id}"]`)?.scrollIntoView({ block: "nearest" });
  };

  const move = (dir: "left" | "right" | "up" | "down") => {
    const cur = selection.get().last;
    const i = cur == null ? -1 : items.findIndex((it) => it.id === cur);
    if (i < 0) {
      if (items[0]) {
        selectionActions.select(items[0].id);
        reveal(items[0].id);
      }
      return;
    }
    let j = -1;
    if (dir === "left") j = i - 1;
    else if (dir === "right") j = i + 1;
    else {
      const b = boxes.current[i];
      if (!b) return;
      const cx = b.left + b.width / 2;
      const tops = [...new Set(boxes.current.map((x) => x.top))].sort((a, c) => a - c);
      const ti = tops.indexOf(b.top);
      const nt = tops[ti + (dir === "down" ? 1 : -1)];
      if (nt === undefined) return;
      let bestD = Infinity;
      boxes.current.forEach((x, k) => {
        if (x.top !== nt) return;
        const d = Math.abs(x.left + x.width / 2 - cx);
        if (d < bestD) {
          bestD = d;
          j = k;
        }
      });
    }
    if (j < 0 || j >= items.length) return;
    selectionActions.select(items[j].id);
    reveal(items[j].id);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (viewing != null || document.querySelector(".scrim")) return;
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
          const i = items.findIndex((it) => it.id === sel.last);
          if (i >= 0) setViewing(i);
          break;
        }
        case "Backspace":
        case "Delete":
          if (sel.ids.size) {
            e.preventDefault();
            if (deleteAction) deleteAction.run([...sel.ids]);
            else actions.trash([...sel.ids]);
          }
          break;
        case ".": {
          if (sel.last == null || !onToggleFav) return;
          const it = items.find((x) => x.id === sel.last);
          if (it) onToggleFav(it.id, !it.fav);
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
  }, [viewing, items, deleteAction, onToggleFav]);

  if (items.length === 0)
    return (
      <div className="empty">
        <p>{emptyText}</p>
      </div>
    );

  const cur = viewing != null ? items[viewing] : null;
  return (
    <div className="page">
      <div ref={attachContainer} onClick={() => selectionActions.clear()}>
        <PhotoGrid
          items={items}
          width={width}
          qs={qs}
          onOpen={setViewing}
          onToggleFav={onToggleFav}
          menuExtras={menuExtras}
          onLayout={(bs) => {
            boxes.current = bs;
          }}
        />
      </div>
      {cur && (
        <Viewer
          item={cur}
          qs={qs}
          position={{ index: viewing! + 1, total: items.length, label: positionLabel }}
          onToggleFav={onToggleFav}
          onClose={() => setViewing(null)}
          onPrev={viewing! > 0 ? () => setViewing(viewing! - 1) : undefined}
          onNext={viewing! < items.length - 1 ? () => setViewing(viewing! + 1) : undefined}
          deleteAction={deleteAction ? { label: deleteAction.label, run: () => deleteAction.run([cur.id]) } : undefined}
        />
      )}
    </div>
  );
}
