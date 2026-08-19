/** Placeholders shaped like the thing that is coming.
 *
 *  These pages used to render their empty state while the request was still in
 *  flight — "No albums yet" on a library full of albums, for the half second
 *  before the data landed. Saying nothing would be better than that; saying
 *  "here is the shape of what is loading" is better still, because the layout
 *  does not jump when the real cards arrive. */

/** Cards with a cover image: albums, events, places. */
export function CardGridSkeleton({ count = 8, wide = false }: { count?: number; wide?: boolean }) {
  return (
    <div className="card-grid" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div className="card skel-card" key={i} style={{ animationDelay: `${Math.min(i * 45, 450)}ms` }}>
          <div className={`skeleton cover${wide ? " wide" : ""}`} />
          <div className="meta">
            <div className="skeleton line" style={{ width: "62%" }} />
            <div className="skeleton line short" style={{ width: "34%" }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Cards with a circular face: People. */
export function PeopleGridSkeleton({ count = 10 }: { count?: number }) {
  return (
    <div className="card-grid" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div className="card skel-card" key={i} style={{ animationDelay: `${Math.min(i * 45, 450)}ms` }}>
          <div className="face-wrap">
            <div className="skeleton face-cover" />
          </div>
          <div className="meta" style={{ textAlign: "center" }}>
            <div className="skeleton line" style={{ width: "52%", margin: "0 auto" }} />
            <div className="skeleton line short" style={{ width: "34%", margin: "6px auto 0" }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** A justified photo grid, for pages that show photos without day headers. */
export function PhotoGridSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div style={{ display: "grid", gap: 14, paddingTop: 8 }} aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div className="skeleton" key={i} style={{ height: 220, animationDelay: `${i * 120}ms` }} />
      ))}
    </div>
  );
}

/** Last resort for a page whose content has no predictable shape yet. */
export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="row loading-row">
      <div className="spin" />
      <span className="muted">{label}</span>
    </div>
  );
}
