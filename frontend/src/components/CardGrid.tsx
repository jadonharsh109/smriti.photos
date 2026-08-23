import { useCallback, useEffect, useRef } from "react";

/** The card grid, told how tall its own cards are.
 *
 *  A real library reaches 606 events and 253 people, and every card was laid
 *  out, painted and its cover decoded whether or not it was on screen.
 *  `content-visibility: auto` lets the engine skip the ones that are not — but
 *  only if it can guess how tall a skipped card would be, and a card's height
 *  follows its column width, which the grid decides. No constant in the
 *  stylesheet can be right at every window size, and a wrong one is felt
 *  directly: the scroll range is built out of guesses, so each card corrects as
 *  it comes into view and the scrollbar drifts under the cursor.
 *
 *  So measure one real card and hand CSS the answer. Re-measured only when the
 *  grid's width changes, because that is the only thing that changes it.
 *
 *  Not every card agrees: a row holding a title long enough to wrap is one line
 *  taller than the rest, which on 606 events is about a third of them and grows
 *  the scroll range by ~3% as you go. Left alone deliberately. The alternative
 *  is clipping titles to one line, and the wrapped line is usually the date —
 *  worth more than a scrollbar that is 3% off on its first pass and exact
 *  forever after, since `auto` remembers each card's real height once seen.
 */
export default function CardGrid({ children }: { children: React.ReactNode }) {
  const obs = useRef<ResizeObserver | null>(null);

  const attach = useCallback((el: HTMLDivElement | null) => {
    obs.current?.disconnect();
    obs.current = null;
    if (!el) return;

    const measure = () => {
      const card = el.querySelector<HTMLElement>(".card");
      if (!card) return;
      const h = Math.round(card.getBoundingClientRect().height);
      if (h > 0) el.style.setProperty("--card-h", `${h}px`);
    };

    // Width only. Setting --card-h changes the grid's own height, so reacting
    // to height would have this observer answering its own notification.
    let lastWidth = -1;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      if (w === lastWidth) return;
      lastWidth = w;
      measure();
    });
    ro.observe(el);
    obs.current = ro;
    measure();
  }, []);

  useEffect(() => () => obs.current?.disconnect(), []);

  return (
    <div className="card-grid" ref={attach}>
      {children}
    </div>
  );
}
