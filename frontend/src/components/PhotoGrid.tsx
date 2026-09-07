import justifiedLayout from "justified-layout";
import { useEffect, useMemo } from "react";
import { canRevealFiles, fmtDuration, type Item } from "../api/client";
import { thumbUrl } from "../lib/images";
import { actions } from "../shell/actions";
import { openContextMenu, type MenuItem } from "../shell/ContextMenu";
import { inspector, selection, selectionActions, view } from "../shell/store";
import { IconHeart } from "./Icons";

export interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface Props {
  items: Item[];
  width: number;
  /** Open the viewer on this index. */
  onOpen: (index: number) => void;
  /** Appended to thumbnail URLs — the Locked section's token. */
  qs?: string;
  /** Omit to leave the heart off entirely (Locked has no use for it). */
  onToggleFav?: (id: number, on: boolean) => void;
  /** Extra context-menu entries a page adds, e.g. "Not a document". */
  menuExtras?: (ids: number[]) => MenuItem[];
  /** Lets the owner know where the tiles landed, for arrow-key movement. */
  onLayout?: (boxes: Box[]) => void;
  /** Off for pages where a click means something else (Cleanup picks). */
  selectable?: boolean;
  rowHeight?: number;
}

/** Justified rows of thumbnails, the way Photos lays them out. Click selects,
 *  double-click opens, right-click asks what to do, the heart hearts. */
export default function PhotoGrid({ items, width, onOpen, qs = "", onToggleFav, menuExtras, onLayout, selectable = true, rowHeight }: Props) {
  const tileH = view.use((s) => s.tileHeight);
  const selecting = view.use((s) => s.selecting);
  const ids = selection.use((s) => s.ids);
  const targetRowHeight = rowHeight ?? tileH;

  const layout = useMemo(
    () =>
      justifiedLayout(
        items.map((it) => ({ width: it.width || 3, height: it.height || 2 })),
        { containerWidth: Math.max(width, 200), targetRowHeight, boxSpacing: 4, containerPadding: 0 }
      ),
    [items, width, targetRowHeight]
  );
  useEffect(() => {
    onLayout?.(layout.boxes as Box[]);
  }, [layout, onLayout]);

  const menuFor = (it: Item): MenuItem[] => {
    const sel = selection.get().ids;
    const target = sel.has(it.id) ? [...sel] : [it.id];
    const one = target.length === 1;
    const base: MenuItem[] = [
      { label: "Open", shortcut: "↩", onSelect: () => onOpen(items.findIndex((x) => x.id === it.id)) },
    ];
    if (canRevealFiles() && one) base.push({ label: "Show in Finder", onSelect: () => actions.reveal(it.id, qs) });
    base.push("sep", { label: "Add to Album…", onSelect: () => actions.addToAlbum(target), disabled: !!qs });
    if (onToggleFav) {
      base.push({
        label: one ? (it.fav ? "Unfavourite" : "Favourite") : "Favourite",
        shortcut: one ? "." : undefined,
        onSelect: () => (one ? onToggleFav(it.id, !it.fav) : actions.favourite(target, true)),
      });
    }
    if (!qs) base.push({ label: "Hide in Locked", onSelect: () => actions.hideInLocked(target) });
    base.push({ label: "Export as ZIP…", onSelect: () => actions.exportZip(target) });
    if (menuExtras) base.push(...menuExtras(target));
    base.push("sep", { label: "Move to Trash", shortcut: "⌫", danger: true, onSelect: () => actions.trash(target) });
    return base;
  };

  return (
    <div className={`pgrid${selecting ? " selecting" : ""}`} style={{ position: "relative", height: layout.containerHeight }}>
      {items.map((it, i) => {
        const b = layout.boxes[i];
        const isSel = ids.has(it.id);
        return (
          <div
            key={it.id}
            className={`tile${isSel ? " sel" : ""}`}
            data-id={it.id}
            style={{ top: b.top, left: b.left, width: b.width, height: b.height }}
            onClick={(e) => {
              e.stopPropagation();
              if (!selectable) {
                onOpen(i);
                return;
              }
              if (e.shiftKey) selectionActions.range(it.id);
              else if (e.metaKey || e.ctrlKey || selecting) selectionActions.toggle(it.id);
              else selectionActions.select(it.id);
              inspector.set({ qs });
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              onOpen(i);
            }}
            onContextMenu={(e) => {
              if (!selectable) return;
              if (!selection.get().ids.has(it.id)) selectionActions.select(it.id);
              inspector.set({ qs });
              openContextMenu(e, menuFor(it));
            }}
          >
            <img
              src={thumbUrl(it.id, qs)}
              loading="lazy"
              decoding="async"
              alt=""
              draggable={false}
              ref={(el) => {
                if (el && el.complete) el.classList.add("ld");
              }}
              onLoad={(e) => e.currentTarget.classList.add("ld")}
            />
            {it.live === 1 && <span className="badge live">LIVE</span>}
            {it.media_type === "video" && it.duration_s != null && <span className="badge num">{fmtDuration(it.duration_s)}</span>}
            {onToggleFav && (
              <button
                className={`fav${it.fav ? " on" : ""}`}
                title={it.fav ? "Remove from Favourites" : "Add to Favourites"}
                aria-pressed={!!it.fav}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleFav(it.id, !it.fav);
                }}
                onDoubleClick={(e) => e.stopPropagation()}
              >
                <IconHeart size={13} filled={!!it.fav} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
