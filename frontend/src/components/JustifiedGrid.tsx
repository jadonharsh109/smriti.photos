import justifiedLayout from "justified-layout";
import { useMemo } from "react";
import { fmtDuration, type Item } from "../api/client";

interface Props {
  items: Item[];
  width: number;
  onOpen: (index: number) => void;
  selected?: Set<number>;
  onToggleSelect?: (id: number) => void;
  targetRowHeight?: number;
}

/** Flickr-style justified rows of thumbnails (pure layout, no virtualization). */
export default function JustifiedGrid({ items, width, onOpen, selected, onToggleSelect, targetRowHeight = 220 }: Props) {
  const layout = useMemo(
    () =>
      justifiedLayout(
        items.map((it) => ({ width: it.width || 3, height: it.height || 2 })),
        { containerWidth: Math.max(width, 200), targetRowHeight, boxSpacing: 4, containerPadding: 0 }
      ),
    [items, width, targetRowHeight]
  );

  return (
    <div style={{ position: "relative", height: layout.containerHeight }}>
      {items.map((it, i) => {
        const b = layout.boxes[i];
        const isSel = selected?.has(it.id) ?? false;
        return (
          <div
            key={it.id}
            className={`tl-item${isSel ? " selected" : ""}`}
            style={{ top: b.top, left: b.left, width: b.width, height: b.height }}
            onClick={(e) => {
              if (selected && selected.size > 0 && onToggleSelect) onToggleSelect(it.id);
              else onOpen(i);
              e.stopPropagation();
            }}
          >
            <img
              src={`/api/thumb/${it.id}`}
              loading="lazy"
              alt=""
              ref={(el) => {
                if (el && el.complete) el.classList.add("ld");
              }}
              onLoad={(e) => e.currentTarget.classList.add("ld")}
            />
            <span className="tl-shade" />
            {it.media_type === "video" && (
              <>
                <span className="vid-badge">▶</span>
                {it.duration_s != null && <span className="dur">{fmtDuration(it.duration_s)}</span>}
              </>
            )}
            {onToggleSelect && (
              <span
                className="check"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleSelect(it.id);
                }}
              >
                ✓
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
