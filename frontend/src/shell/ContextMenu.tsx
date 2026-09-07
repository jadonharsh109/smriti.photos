import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createStore } from "./store";

export type MenuItem =
  | { label: string; shortcut?: string; danger?: boolean; disabled?: boolean; onSelect: () => void }
  | "sep";

const menu = createStore<{ x: number; y: number; items: MenuItem[] | null }>({ x: 0, y: 0, items: null });

/** Open a menu at the pointer. Call from an onContextMenu handler; the event
 *  is consumed so the webview's own menu never shows. */
export function openContextMenu(e: { clientX: number; clientY: number; preventDefault(): void }, items: MenuItem[]) {
  e.preventDefault();
  menu.set({ x: e.clientX, y: e.clientY, items });
}
export const closeContextMenu = () => menu.set({ items: null });

/** Mounted once by the shell. Closes on any click elsewhere, Escape, scroll,
 *  or the window losing focus — the ways a native menu closes. */
export function ContextMenuHost() {
  const items = menu.use((s) => s.items);
  const x = menu.use((s) => s.x);
  const y = menu.use((s) => s.y);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    if (!items) return;
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - r.width - 6);
    const top = Math.min(y, window.innerHeight - r.height - 6);
    setPos({ left: Math.max(6, left), top: Math.max(6, top) });
    const close = () => closeContextMenu();
    const onDown = (ev: MouseEvent) => {
      if (!el.contains(ev.target as Node)) close();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") close();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [items, x, y]);

  if (!items) return null;
  return createPortal(
    <div ref={ref} className="cmenu" role="menu" style={pos} onContextMenu={(e) => e.preventDefault()}>
      {items.map((it, i) =>
        it === "sep" ? (
          <hr key={i} />
        ) : (
          <button
            key={i}
            role="menuitem"
            className={it.danger ? "danger" : undefined}
            disabled={it.disabled}
            onClick={() => {
              closeContextMenu();
              it.onSelect();
            }}
          >
            {it.label}
            {it.shortcut && <span className="k">{it.shortcut}</span>}
          </button>
        )
      )}
    </div>,
    document.body
  );
}
