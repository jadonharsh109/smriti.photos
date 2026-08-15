import { useQuery, useQueryClient } from "@tanstack/react-query";
import { geoDistance, geoGraticule10, geoOrthographic, geoPath } from "d3-geo";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { feature } from "topojson-client";
import type { FeatureCollection } from "geojson";
import world from "world-atlas/countries-110m.json";
import { api, filterQS, type Bucket, type Filters, type Item } from "../api/client";
import { IconClose } from "../components/Icons";

interface Point {
  lat: number;
  lon: number;
  n: number;
  city: string | null;
  country: string | null;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

interface View {
  lambda: number;
  phi: number;
  scale: number;
}

/** Offline interactive globe: drag to rotate, scroll to zoom, click a pin to
 * fly there. No tiles, no network — bundled TopoJSON + d3-geo. */
export default function MapPage() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const svgRef = useRef<SVGSVGElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  // the canvas fills the stage; sphere size follows the measured frame
  const [dim, setDim] = useState({ w: 960, h: 560 });
  const W = dim.w;
  const H = dim.h;
  const R = (Math.min(W, H) / 2) * 0.86; // 14% headroom so the atmosphere glow never clips
  const [view, setView] = useState<View>({ lambda: -78, phi: -22, scale: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [spinning, setSpinning] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [selected, setSelected] = useState<Point | null>(null);
  const animRef = useRef<number | null>(null);
  const dragRef = useRef<{ x: number; y: number; lambda: number; phi: number; moved: number } | null>(null);

  const { data: points } = useQuery({
    queryKey: ["map-points"],
    queryFn: () => api.get<Point[]>("/api/places/points?precision=1"),
  });

  const { data: previewItems } = useQuery({
    queryKey: ["place-preview", selected?.country, selected?.city],
    queryFn: () =>
      api.get<Item[]>(
        `/api/timeline/items${filterQS(
          { country: selected!.country ?? undefined, city: selected!.city ?? undefined },
          { limit: 4 }
        )}`
      ),
    enabled: selected != null && selected.country != null,
  });

  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setDim({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setDim({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const countries = useMemo(() => {
    const topo = world as unknown as Parameters<typeof feature>[0];
    const objects = topo.objects as unknown as { countries: Parameters<typeof feature>[1] };
    return feature(topo, objects.countries) as unknown as FeatureCollection;
  }, []);
  const graticule = useMemo(() => geoGraticule10(), []);

  const projection = useMemo(
    () =>
      geoOrthographic()
        .translate([W / 2, H / 2])
        .scale(R * view.scale)
        .rotate([view.lambda, view.phi])
        .clipAngle(90),
    [view, W, H, R]
  );
  const path = useMemo(() => geoPath(projection), [projection]);

  // idle auto-rotation (pauses on interaction / selection)
  useEffect(() => {
    if (!spinning || dragging || selected) return;
    let raf: number;
    let last = performance.now();
    const tick = (t: number) => {
      const dt = Math.min(t - last, 64);
      last = t;
      setView((v) => ({ ...v, lambda: v.lambda + dt * 0.0035 }));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [spinning, dragging, selected]);

  // wheel zoom needs a non-passive native listener
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      cancelFly();
      setView((v) => ({ ...v, scale: clamp(v.scale * Math.exp(-e.deltaY * 0.0013), 1, 8) }));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const cancelFly = () => {
    if (animRef.current != null) {
      cancelAnimationFrame(animRef.current);
      animRef.current = null;
    }
  };

  const flyTo = (target: View, done?: () => void) => {
    cancelFly();
    setSpinning(false);
    const from = { ...viewRef.current };
    const dL = ((target.lambda - from.lambda + 540) % 360) - 180; // shortest way around
    const dur = 700;
    const start = performance.now();
    const tick = (t: number) => {
      const p = clamp((t - start) / dur, 0, 1);
      const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2; // easeInOutCubic
      setView({
        lambda: from.lambda + dL * e,
        phi: from.phi + (target.phi - from.phi) * e,
        scale: from.scale + (target.scale - from.scale) * e,
      });
      if (p < 1) animRef.current = requestAnimationFrame(tick);
      else {
        animRef.current = null;
        done?.();
      }
    };
    animRef.current = requestAnimationFrame(tick);
  };

  const focusPin = (p: Point) => {
    // show the place card immediately — previews load while the globe flies
    setSelected(p);
    if (p.country) {
      // warm the timeline for this place so "View photos" opens instantly
      const filters: Filters = { country: p.country, city: p.city ?? undefined };
      qc.prefetchQuery({
        queryKey: ["buckets", JSON.stringify(filters)],
        queryFn: () => api.get<Bucket[]>(`/api/timeline/buckets${filterQS(filters)}`),
      });
    }
    flyTo({ lambda: -p.lon, phi: -p.lat, scale: 3.1 });
  };

  const resetView = () => {
    setSelected(null);
    flyTo({ lambda: viewRef.current.lambda, phi: -22, scale: 1 }, () => setSpinning(true));
  };

  // drag to rotate
  const onPointerDown = (e: React.PointerEvent) => {
    cancelFly();
    dragRef.current = { x: e.clientX, y: e.clientY, lambda: viewRef.current.lambda, phi: viewRef.current.phi, moved: 0 };
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    d.moved = Math.max(d.moved, Math.abs(dx) + Math.abs(dy));
    const k = 0.28 / viewRef.current.scale;
    setView((v) => ({ ...v, lambda: d.lambda + dx * k, phi: clamp(d.phi - dy * k, -85, 85) }));
  };
  const endDrag = () => {
    dragRef.current = null;
    setDragging(false);
  };
  const wasDrag = () => (dragRef.current?.moved ?? 0) > 5;

  const center: [number, number] = [-view.lambda, -view.phi];
  const maxN = Math.max(1, ...(points ?? []).map((p) => p.n));
  const globeR = R * view.scale;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Map</h1>
          <p className="sub">Drag to rotate · scroll to zoom · click a pin to fly there</p>
        </div>
        <div className="actions">
          <span className="chip">
            <span className="dot" />
            <strong>{(points ?? []).reduce((s, p) => s + p.n, 0).toLocaleString()}</strong>&nbsp;located photos · fully offline
          </span>
        </div>
      </header>

      <div className="globe-frame" ref={frameRef}>
        <svg
            ref={svgRef}
            className={`globe-svg${dragging ? " dragging" : ""}`}
            width={W}
            height={H}
            viewBox={`0 0 ${W} ${H}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerLeave={endDrag}
          >
            <defs>
              <radialGradient id="ocean" cx="38%" cy="30%" r="75%">
                <stop offset="0%" stopColor="#2c3a78" />
                <stop offset="55%" stopColor="#17204d" />
                <stop offset="100%" stopColor="#090d22" />
              </radialGradient>
              <radialGradient id="atmo" cx="50%" cy="50%" r="50%">
                <stop offset="76%" stopColor="rgba(124,196,255,0)" />
                <stop offset="92%" stopColor="rgba(124,196,255,0.18)" />
                <stop offset="100%" stopColor="rgba(124,196,255,0)" />
              </radialGradient>
              <radialGradient id="sheen" cx="32%" cy="24%" r="60%">
                <stop offset="0%" stopColor="rgba(255,255,255,0.14)" />
                <stop offset="45%" stopColor="rgba(255,255,255,0.03)" />
                <stop offset="100%" stopColor="rgba(255,255,255,0)" />
              </radialGradient>
            </defs>

            {/* atmosphere glow */}
            <circle cx={W / 2} cy={H / 2} r={globeR * 1.14} fill="url(#atmo)" pointerEvents="none" />
            {/* sphere */}
            <path d={path({ type: "Sphere" }) ?? undefined} fill="url(#ocean)" stroke="rgba(124,196,255,0.3)" strokeWidth={1} />
            <path d={path(graticule) ?? undefined} fill="none" stroke="rgba(255,255,255,0.045)" strokeWidth={0.6} />
            {countries.features.map((f, i) => (
              <path key={i} d={path(f) ?? undefined} fill="#2f3865" stroke="#4a5896" strokeWidth={0.55} />
            ))}
            {/* light sheen on top of land for the 3D feel */}
            <path d={path({ type: "Sphere" }) ?? undefined} fill="url(#sheen)" pointerEvents="none" />

            {/* photo pins */}
            {(points ?? []).map((p, i) => {
              const dist = geoDistance([p.lon, p.lat], center);
              if (dist > Math.PI / 2 - 0.03) return null; // back side of the globe
              const xy = projection([p.lon, p.lat]);
              if (!xy) return null;
              const fade = clamp((Math.PI / 2 - dist) / 0.4, 0.15, 1);
              const r = 3.5 + Math.sqrt(p.n / maxN) * 9;
              const isSel = selected != null && selected.lat === p.lat && selected.lon === p.lon;
              return (
                <g
                  key={i}
                  className="pin"
                  transform={`translate(${xy[0]},${xy[1]})`}
                  opacity={fade}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!wasDrag()) focusPin(p);
                  }}
                >
                  <circle className="ring" r={r + 3} fill="none" stroke="#7cc4ff" strokeWidth={1.4} style={{ animationDelay: `${(i % 7) * 0.3}s` }} />
                  <circle className="dot" r={r} fill={isSel ? "rgba(185,107,255,0.85)" : "rgba(124,196,255,0.8)"} stroke={isSel ? "#e9d6ff" : "#d3e7ff"} strokeWidth={1.4} />
                  <title>{`${p.city ?? "?"}, ${p.country ?? "?"} · ${p.n} photos`}</title>
                </g>
              );
            })}
          </svg>

          {/* floating controls */}
          <div className="globe-ctl">
            <button className="icon-btn" title="Zoom in" onClick={() => { cancelFly(); setView((v) => ({ ...v, scale: clamp(v.scale * 1.45, 1, 8) })); }}>＋</button>
            <button className="icon-btn" title="Zoom out" onClick={() => { cancelFly(); setView((v) => ({ ...v, scale: clamp(v.scale / 1.45, 1, 8) })); }}>－</button>
            <button className="icon-btn" title="Reset view" onClick={resetView}>⟲</button>
            <button
              className={`icon-btn${spinning && !selected ? " on" : ""}`}
              title={spinning ? "Pause rotation" : "Resume rotation"}
              onClick={() => setSpinning((s) => !s)}
            >
              {spinning ? "❚❚" : "▶"}
            </button>
          </div>

          {/* place card after fly-to */}
          {selected && (
            <div className="place-pop">
              <div className="row" style={{ gap: 8 }}>
                <strong>{selected.city ?? "Unknown place"}</strong>
                <span className="muted small">{selected.country ?? ""}</span>
                <span className="spacer" />
                <button className="icon-btn" style={{ width: 30, height: 30 }} onClick={() => setSelected(null)}>
                  <IconClose size={15} />
                </button>
              </div>
              <div className="muted small">{selected.n} photos here</div>
              {previewItems && previewItems.length > 0 && (
                <div className="thumbs">
                  {previewItems.map((it, i) => (
                    <img key={it.id} src={`/api/thumb/${it.id}`} alt="" style={{ animationDelay: `${i * 0.06}s` }} />
                  ))}
                </div>
              )}
              {selected.country && (
                <button
                  className="primary"
                  style={{ width: "100%", marginTop: 8 }}
                  onClick={() =>
                    nav(
                      selected.city
                        ? `/places/view?country=${encodeURIComponent(selected.country!)}&city=${encodeURIComponent(selected.city)}`
                        : `/places/view?country=${encodeURIComponent(selected.country!)}`
                    )
                  }
                >
                  View photos
                </button>
              )}
            </div>
          )}
      </div>
    </div>
  );
}
