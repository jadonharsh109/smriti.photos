import { useQuery, useQueryClient } from "@tanstack/react-query";
import { geoBounds, geoCentroid, geoDistance, geoGraticule10, geoOrthographic, geoPath } from "d3-geo";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { feature, mesh } from "topojson-client";
import type { FeatureCollection, GeoJsonProperties, Geometry } from "geojson";
import world110 from "world-atlas/countries-110m.json";
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

const MAX_ZOOM = 24;
const DETAIL_ZOOM = 4; // past this, swap in the high-res 50m coastlines

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
  // adaptive detail: light 110m topology at overview, 50m + states when zoomed
  const [detailTopo, setDetailTopo] = useState<unknown>(null);
  const [statesTopo, setStatesTopo] = useState<unknown>(null);
  const detailLoaded = useRef(false);
  // gesture zoom: while the wheel is active the already-rendered scene is
  // scaled with ONE GPU transform (no re-projection); geometry re-renders
  // once when the gesture settles
  const [gzoom, setGzoom] = useState(1);
  const gzoomRef = useRef(1);
  const wheelAccum = useRef(0);
  const wheelRaf = useRef<number | null>(null);
  const wheelIdleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // drag rotation batched to one view update per frame
  const dragAccum = useRef<{ dx: number; dy: number } | null>(null);
  const dragRaf = useRef<number | null>(null);
  const animRef = useRef<number | null>(null);
  const dragRef = useRef<{ x: number; y: number; lambda: number; phi: number; moved: number } | null>(null);
  // flick-to-spin: track drag velocity, coast with friction on release
  const [coasting, setCoasting] = useState(false);
  const inertiaRef = useRef<number | null>(null);
  const velRef = useRef({ x: 0, y: 0, t: 0, vl: 0, vp: 0 });

  const { data: points, isLoading: pointsLoading } = useQuery({
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

  // fetch the detailed coastlines + state boundaries once the user zooms in
  useEffect(() => {
    if (view.scale >= DETAIL_ZOOM && !detailLoaded.current) {
      detailLoaded.current = true;
      Promise.all([
        import("world-atlas/countries-50m.json"),
        import("../data/states-50m.json"),
      ]).then(
        ([c, s]) => {
          setDetailTopo((c as { default?: unknown }).default ?? c);
          setStatesTopo((s as { default?: unknown }).default ?? s);
        },
        () => {
          detailLoaded.current = false; // retry on the next zoom
        }
      );
    }
  }, [view.scale]);

  const toCountries = (t: unknown) => {
    const topo = t as Parameters<typeof feature>[0];
    const objects = topo.objects as unknown as { countries: Parameters<typeof feature>[1] };
    return feature(topo, objects.countries) as unknown as FeatureCollection;
  };
  const countriesBase = useMemo(() => toCountries(world110), []);
  const countriesDetail = useMemo(() => (detailTopo ? toCountries(detailTopo) : null), [detailTopo]);
  // LOD: heavy 50m geometry only when actually zoomed in
  const countries =
    view.scale >= DETAIL_ZOOM && countriesDetail ? countriesDetail : countriesBase;
  // per-feature centroid + angular radius, for skipping off-screen countries
  const countryMeta = useMemo(
    () =>
      countries.features.map((f) => {
        const c = geoCentroid(f);
        const b = geoBounds(f);
        const r = Math.max(geoDistance(c, b[0]), geoDistance(c, b[1]));
        return { c, r: r > 1.2 ? Math.PI : r }; // dateline-spanning giants: never cull
      }),
    [countries]
  );
  const states = useMemo(() => {
    if (!statesTopo) return null;
    const t = statesTopo as Parameters<typeof feature>[0];
    const obj = (t.objects as unknown as { states: Parameters<typeof feature>[1] }).states;
    const feats = feature(t, obj) as unknown as FeatureCollection<Geometry, GeoJsonProperties>;
    return {
      // interior borders as ONE path (cheap to render every frame)
      borders: mesh(t, obj as Parameters<typeof mesh>[1], (a, b) => a !== b) as Geometry,
      // polygons only carry hover titles
      feats,
      meta: feats.features.map((f) => {
        const c = geoCentroid(f);
        const b = geoBounds(f);
        const r = Math.max(geoDistance(c, b[0]), geoDistance(c, b[1]));
        return { c, r: r > 1.2 ? Math.PI : r };
      }),
    };
  }, [statesTopo]);
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
  // fewer digits = far smaller `d` strings to build, parse and diff
  const path = useMemo(() => geoPath(projection).digits(1), [projection]);

  // idle auto-rotation: a lazy drift at half frame-rate; stops for good the
  // moment the user interacts (the ▶ control re-enables it) — a permanently
  // spinning globe re-projects the world forever and burns CPU for nothing
  useEffect(() => {
    if (!spinning || dragging || selected || coasting) return;
    let raf: number;
    let last = performance.now();
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      const dt = t - last;
      if (dt < 30) return; // ~30fps is plenty for ambience at a lazy drift
      last = t;
      setView((v) => ({ ...v, lambda: v.lambda + Math.min(dt, 80) * 0.0012 }));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [spinning, dragging, selected, coasting]);

  // wheel zoom: transform-only while the gesture lasts, one geometry commit
  // 150ms after it ends
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      cancelFly();
      setSpinning(false);
      wheelAccum.current += e.deltaY;
      if (wheelRaf.current == null) {
        wheelRaf.current = requestAnimationFrame(() => {
          const dy = wheelAccum.current;
          wheelAccum.current = 0;
          wheelRaf.current = null;
          const live = clamp(viewRef.current.scale * gzoomRef.current * Math.exp(-dy * 0.0013), 1, MAX_ZOOM);
          gzoomRef.current = live / viewRef.current.scale;
          setGzoom(gzoomRef.current);
        });
      }
      if (wheelIdleTimer.current) clearTimeout(wheelIdleTimer.current);
      wheelIdleTimer.current = setTimeout(() => {
        // commit: re-project once at the final scale, reset the transform
        const g = gzoomRef.current;
        gzoomRef.current = 1;
        setView((v) => ({ ...v, scale: clamp(v.scale * g, 1, MAX_ZOOM) }));
        setGzoom(1);
      }, 150);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      if (wheelRaf.current != null) cancelAnimationFrame(wheelRaf.current);
      if (wheelIdleTimer.current) clearTimeout(wheelIdleTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cancelCoast = () => {
    if (inertiaRef.current != null) {
      cancelAnimationFrame(inertiaRef.current);
      inertiaRef.current = null;
      setCoasting(false);
    }
  };

  const cancelFly = () => {
    if (animRef.current != null) {
      cancelAnimationFrame(animRef.current);
      animRef.current = null;
    }
    cancelCoast();
  };

  const startCoast = (vl0: number, vp0: number) => {
    // half the hand's velocity, tightly capped: a hard flick ≈ a quarter turn
    let vl = clamp(vl0 * 0.5, -0.14, 0.14);
    let vp = clamp(vp0 * 0.5, -0.08, 0.08);
    let last = performance.now();
    setCoasting(true);
    const tick = (t: number) => {
      const dt = Math.min(t - last, 50);
      last = t;
      const decay = Math.exp(-dt / 650); // friction time-constant
      vl *= decay;
      vp *= decay;
      setView((v) => ({
        ...v,
        lambda: v.lambda + vl * dt,
        phi: clamp(v.phi + vp * dt, -85, 85),
      }));
      if (Math.abs(vl) < 0.0015 && Math.abs(vp) < 0.0015) {
        inertiaRef.current = null;
        setCoasting(false); // idle drift takes over
        return;
      }
      inertiaRef.current = requestAnimationFrame(tick);
    };
    inertiaRef.current = requestAnimationFrame(tick);
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

  // drag to rotate (with flick momentum)
  const onPointerDown = (e: React.PointerEvent) => {
    cancelFly();
    setSpinning(false); // user has taken the wheel — no more ambient burn
    dragRef.current = { x: e.clientX, y: e.clientY, lambda: viewRef.current.lambda, phi: viewRef.current.phi, moved: 0 };
    velRef.current = { x: e.clientX, y: e.clientY, t: performance.now(), vl: 0, vp: 0 };
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    d.moved = Math.max(d.moved, Math.abs(dx) + Math.abs(dy));
    const k = 0.28 / viewRef.current.scale;
    // velocity math per event (cheap); the expensive setView once per frame
    const vel = velRef.current;
    const now = performance.now();
    const dt = Math.max(1, now - vel.t);
    vel.vl = 0.7 * (((e.clientX - vel.x) * k) / dt) + 0.3 * vel.vl;
    vel.vp = 0.7 * ((-(e.clientY - vel.y) * k) / dt) + 0.3 * vel.vp;
    vel.x = e.clientX;
    vel.y = e.clientY;
    vel.t = now;
    dragAccum.current = { dx, dy };
    if (dragRaf.current == null) {
      dragRaf.current = requestAnimationFrame(() => {
        dragRaf.current = null;
        const a = dragAccum.current;
        if (!a || !dragRef.current) return;
        setView((v) => ({ ...v, lambda: d.lambda + a.dx * k, phi: clamp(d.phi - a.dy * k, -85, 85) }));
      });
    }
  };
  const endDrag = () => {
    const wasDragging = dragRef.current != null;
    dragRef.current = null;
    setDragging(false);
    if (!wasDragging) return;
    const { vl, vp, t } = velRef.current;
    const held = performance.now() - t > 120; // paused before letting go: no flick
    if (!held && (Math.abs(vl) > 0.01 || Math.abs(vp) > 0.01)) {
      startCoast(vl, vp);
    }
  };
  const wasDrag = () => (dragRef.current?.moved ?? 0) > 5;

  const center: [number, number] = [-view.lambda, -view.phi];
  // angular radius of the viewport on the sphere (+margin covering gesture
  // zoom-outs); features whose bounding circle falls outside are skipped
  const visAngle = Math.min(Math.PI, (Math.hypot(W, H) / 2) / (R * view.scale) + 0.45);
  const showHover = !dragging && !coasting;
  const maxN = Math.max(1, ...(points ?? []).map((p) => p.n));
  const globeR = R * view.scale;

  // memoized geometry layers: re-projected only when the committed view
  // changes — pin hovers, gesture zoom and popup state reuse them untouched
  const worldLayer = useMemo(
    () => (
      <>
        <path d={path({ type: "Sphere" }) ?? undefined} fill="url(#ocean)" stroke="rgba(124,196,255,0.3)" strokeWidth={1} />
        <path d={path(graticule) ?? undefined} fill="none" stroke="rgba(255,255,255,0.045)" strokeWidth={0.6} />
        {countries.features.map((f, i) => {
          const m = countryMeta[i];
          if (visAngle < Math.PI / 2 && geoDistance(m.c, center) - m.r > visAngle) return null;
          return <path key={i} d={path(f) ?? undefined} fill="#2f3865" stroke="#4a5896" strokeWidth={0.55} />;
        })}
      </>
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [path, countries, countryMeta, visAngle]
  );

  const statesLayer = useMemo(() => {
    if (!states || view.scale < DETAIL_ZOOM) return null;
    return (
      <g>
        <path
          d={path(states.borders) ?? undefined}
          fill="none"
          stroke="rgba(211, 231, 255, 0.22)"
          strokeWidth={0.6}
          strokeDasharray="3 2"
          pointerEvents="none"
        />
        {showHover &&
          states.feats.features.map((f, i) => {
            const m = states.meta[i];
            if (visAngle < Math.PI / 2 && geoDistance(m.c, center) - m.r > visAngle) return null;
            return (
              <path key={i} className="state-poly" d={path(f) ?? undefined}>
                <title>{`${f.properties?.name ?? "?"}, ${f.properties?.admin ?? ""}`}</title>
              </path>
            );
          })}
      </g>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, states, visAngle, showHover, view.scale]);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Map</h1>
          <p className="sub">Drag to rotate · scroll to zoom · click a pin to fly there</p>
        </div>
        <div className="actions">
          <span className="chip">
            {pointsLoading ? (
              <>
                <span className="spin" />
                &nbsp;finding your places…
              </>
            ) : (
              <>
                <span className="dot" />
                <strong>{(points ?? []).reduce((s, p) => s + p.n, 0).toLocaleString()}</strong>&nbsp;located photos · fully offline
              </>
            )}
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

            {/* gesture group: scaled as one GPU transform while the wheel is
                active, so zoom costs zero re-projection until it settles */}
            <g
              transform={
                gzoom !== 1
                  ? `translate(${W / 2} ${H / 2}) scale(${gzoom}) translate(${-(W / 2)} ${-(H / 2)})`
                  : undefined
              }
              style={{ willChange: gzoom !== 1 ? "transform" : undefined }}
            >
            {/* atmosphere glow */}
            <circle cx={W / 2} cy={H / 2} r={globeR * 1.14} fill="url(#atmo)" pointerEvents="none" />
            {worldLayer}
            {statesLayer}
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
            </g>
          </svg>

          {/* floating controls */}
          <div className="globe-ctl">
            <button className="icon-btn" title="Zoom in" onClick={() => { cancelFly(); setSpinning(false); setView((v) => ({ ...v, scale: clamp(v.scale * 1.45, 1, MAX_ZOOM) })); }}>＋</button>
            <button className="icon-btn" title="Zoom out" onClick={() => { cancelFly(); setSpinning(false); setView((v) => ({ ...v, scale: clamp(v.scale / 1.45, 1, MAX_ZOOM) })); }}>－</button>
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
