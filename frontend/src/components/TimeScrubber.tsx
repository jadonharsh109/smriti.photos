import { useMemo, useRef, useState } from "react";
import type { Bucket } from "../api/client";
import Portal from "./Portal";

interface Props {
  buckets: Bucket[]; // newest-first
  currentIndex: number; // bucket index at the middle of the viewport
  /** pinned to a rail end when the list is scrolled all the way there */
  edge: "top" | "bottom" | null;
  onJump: (bucketIndex: number) => void;
}

const ms = (day: string) => new Date(day + "T12:00:00").getTime();

/** Google-Photos-style time rail: a slim track where position is proportional
 * to *time* (not scroll height), with year/month markers, a live position dot,
 * a frosted date bubble on hover, and drag-to-scrub. */
export default function TimeScrubber({ buckets, currentIndex, edge, onJump }: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [hoverFrac, setHoverFrac] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);

  const newest = ms(buckets[0].day);
  const oldest = ms(buckets[buckets.length - 1].day);
  const span = Math.max(1, newest - oldest);
  const shortSpan = span < 1000 * 60 * 60 * 24 * 100; // < ~3 months → day-level bubble

  const fracForDay = (day: string) => (newest - ms(day)) / span;

  /** Nearest bucket to the date sitting at rail fraction f. */
  const indexForFrac = (f: number) => {
    const target = newest - f * span;
    let lo = 0;
    let hi = buckets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ms(buckets[mid].day) > target) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0 && ms(buckets[lo].day) < target) {
      const dPrev = Math.abs(ms(buckets[lo - 1].day) - target);
      const dCur = Math.abs(ms(buckets[lo].day) - target);
      if (dPrev < dCur) return lo - 1;
    }
    return lo;
  };

  // year markers (or months when the library spans a single year)
  const ticks = useMemo(() => {
    const out: { label: string; frac: number }[] = [];
    const nd = new Date(newest);
    const od = new Date(oldest);
    const push = (label: string, t: number) => {
      const f = (newest - Math.min(Math.max(t, oldest), newest)) / span;
      out.push({ label, frac: Math.min(1, Math.max(0, f)) });
    };
    if (nd.getFullYear() > od.getFullYear()) {
      for (let y = nd.getFullYear(); y >= od.getFullYear(); y--) {
        push(String(y), new Date(y, 0, 1).getTime());
      }
    } else {
      const cur = new Date(nd.getFullYear(), nd.getMonth(), 1);
      const stop = new Date(od.getFullYear(), od.getMonth(), 1).getTime();
      while (cur.getTime() >= stop) {
        push(cur.toLocaleDateString(undefined, { month: "short" }), cur.getTime());
        cur.setMonth(cur.getMonth() - 1);
      }
    }
    // drop markers that would overlap on the rail
    const sorted = out.sort((a, b) => a.frac - b.frac);
    const spaced: typeof sorted = [];
    for (const t of sorted) {
      if (!spaced.length || t.frac - spaced[spaced.length - 1].frac >= 0.045) spaced.push(t);
    }
    return spaced;
  }, [newest, oldest, span]);

  const fracForY = (clientY: number) => {
    const r = trackRef.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientY - r.top) / r.height));
  };

  const scrubTo = (clientY: number) => {
    const f = fracForY(clientY);
    setHoverFrac(f);
    onJump(indexForFrac(f));
  };

  const bubbleFor = (f: number) => {
    const day = buckets[indexForFrac(f)].day;
    return new Date(ms(day)).toLocaleDateString(
      undefined,
      shortSpan ? { day: "numeric", month: "short", year: "numeric" } : { month: "long", year: "numeric" }
    );
  };

  const currentFrac =
    edge === "top" ? 0 : edge === "bottom" ? 1 : fracForDay(buckets[Math.min(currentIndex, buckets.length - 1)].day);

  return (
    <Portal>
      <div className={`tscrub${dragging ? " drag" : ""}`}>
        <div
          ref={trackRef}
          className="tscrub-track"
          onPointerDown={(e) => {
            e.preventDefault();
            try {
              (e.currentTarget as Element).setPointerCapture(e.pointerId);
            } catch {
              /* capture is best-effort (can throw for exotic pointer types) */
            }
            setDragging(true);
            scrubTo(e.clientY);
          }}
          onPointerMove={(e) => {
            if (dragging) scrubTo(e.clientY);
            else setHoverFrac(fracForY(e.clientY));
          }}
          onPointerUp={() => {
            setDragging(false);
            setHoverFrac(null);
          }}
          onPointerCancel={() => {
            setDragging(false);
            setHoverFrac(null);
          }}
          onPointerLeave={() => {
            if (!dragging) setHoverFrac(null);
          }}
        >
          <div className="tscrub-line" />
          {ticks.map((t) => (
            <div key={t.label} className="tscrub-tick" style={{ top: `${t.frac * 100}%` }}>
              <span>{t.label}</span>
              <i />
            </div>
          ))}
          <div className="tscrub-dot" style={{ top: `${currentFrac * 100}%` }} />
          {hoverFrac != null && (
            <div className="tscrub-bubble" style={{ top: `${hoverFrac * 100}%` }}>
              {bubbleFor(hoverFrac)}
            </div>
          )}
        </div>
      </div>
    </Portal>
  );
}
