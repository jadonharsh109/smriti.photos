import { geoAzimuthalEqualArea, geoBounds, geoCentroid, geoContains, geoDistance, geoPath } from "d3-geo";
import type { Feature, FeatureCollection, GeoJsonProperties, Geometry } from "geojson";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { feature, mesh } from "topojson-client";

/** Where a photo was taken, on the finest map this app carries offline.
 *
 * Smriti fetches no tiles, so there is no street to zoom to. That is the point:
 * a tile request is the photo's location, handed to somebody else's server
 * along with your address — the one genuinely sensitive thing a photo library
 * derives about you. What it can do honestly is a locator: the smallest region
 * the bundled data knows the point falls inside, drawn with its neighbours for
 * context and the exact coordinates marked on it. That is a province in the
 * nine countries big enough to ship admin-1 boundaries for, and a country
 * everywhere else — which is as fine as public-domain vector data gets without
 * turning into a download.
 */

interface Meta {
  c: [number, number];
  r: number;
}
interface Atlas {
  countries: FeatureCollection<Geometry, GeoJsonProperties>;
  countryMeta: Meta[];
  countryBorders: Geometry;
  states: FeatureCollection<Geometry, GeoJsonProperties>;
  stateMeta: Meta[];
  stateBorders: Geometry;
}

/** Centroid plus the angular radius that covers the feature, so a point or a
 *  viewport can reject most of the world without touching its geometry. */
const metaOf = (f: Feature<Geometry, GeoJsonProperties>): Meta => {
  const c = geoCentroid(f);
  const b = geoBounds(f);
  const r = Math.max(geoDistance(c, b[0]), geoDistance(c, b[1]));
  return { c, r: r > 1.2 ? Math.PI : r }; // dateline-spanning giants: never reject
};

let pending: Promise<Atlas> | null = null;

/** Parsed once per session and shared by every lightbox opened after — the same
 *  two chunks the globe lazy-loads, so opening the map first makes this free. */
function loadAtlas(): Promise<Atlas> {
  pending ??= Promise.all([
    import("world-atlas/countries-50m.json"),
    import("../data/states-50m.json"),
  ])
    .then(([c, s]) => {
      const world = ((c as { default?: unknown }).default ?? c) as Parameters<typeof feature>[0];
      const admin = ((s as { default?: unknown }).default ?? s) as Parameters<typeof feature>[0];
      const countryObj = (world.objects as unknown as { countries: Parameters<typeof feature>[1] }).countries;
      const stateObj = (admin.objects as unknown as { states: Parameters<typeof feature>[1] }).states;
      const countries = feature(world, countryObj) as unknown as FeatureCollection<Geometry, GeoJsonProperties>;
      const states = feature(admin, stateObj) as unknown as FeatureCollection<Geometry, GeoJsonProperties>;
      return {
        countries,
        countryMeta: countries.features.map(metaOf),
        countryBorders: mesh(world, countryObj as Parameters<typeof mesh>[1], (a, b) => a !== b) as Geometry,
        states,
        stateMeta: states.features.map(metaOf),
        stateBorders: mesh(admin, stateObj as Parameters<typeof mesh>[1], (a, b) => a !== b) as Geometry,
      };
    })
    .catch((e) => {
      pending = null; // a failed chunk load must not poison every later open
      throw e;
    });
  return pending;
}

/** First feature that actually contains the point, cheap rejections first. */
function containing(
  features: Feature<Geometry, GeoJsonProperties>[],
  meta: Meta[],
  point: [number, number]
) {
  for (let i = 0; i < features.length; i++) {
    if (geoDistance(meta[i].c, point) > meta[i].r) continue;
    if (geoContains(features[i], point)) return features[i];
  }
  return null;
}

/** The piece of land the point is actually standing on.
 *
 * Fitting to a whole feature goes wrong twice over. France carries its overseas
 * departments in the same polygon, so fitting "France" for a photo in Paris
 * spans a quarter of the planet and pins Paris to the top edge; Japan would be
 * framed to include Okinawa. Fitting to the containing polygon frames the
 * landmass you were on, which is what the eye is looking for. The whole feature
 * is still drawn — only the framing narrows. */
function fitTarget(f: Feature<Geometry, GeoJsonProperties>, point: [number, number]) {
  if (f.geometry.type !== "MultiPolygon") return f;
  for (const coordinates of f.geometry.coordinates) {
    const piece = {
      type: "Feature",
      properties: null,
      geometry: { type: "Polygon", coordinates },
    } as Feature<Geometry, GeoJsonProperties>;
    if (geoContains(piece, point)) return piece;
  }
  return f;
}

const PAD = 9;
const HEIGHT = 152;
/** Angular radius, in radians, of the corner of the box from the point.
 *  ~0.0157 rad is 100km: closer than that and 50m coastlines are a shapeless
 *  blob, so Singapore or Malta would fill the frame saying nothing. */
const MIN_REACH = 0.0157;
/** Used when no region contains the point at all — mid-ocean, or just outside
 *  a simplified coastline. ~320km, enough to show the nearest land. */
const NO_REGION_REACH = 0.05;

export default function PlaceInset({ lat, lon }: { lat: number; lon: number }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [atlas, setAtlas] = useState<Atlas | null>(null);
  const [failed, setFailed] = useState(false);
  const [width, setWidth] = useState(0);
  const seaId = useId();

  useEffect(() => {
    let dead = false;
    loadAtlas().then(
      (a) => !dead && setAtlas(a),
      () => !dead && setFailed(true)
    );
    return () => {
      dead = true;
    };
  }, []);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const scene = useMemo(() => {
    if (!atlas || width < 60) return null;
    const point: [number, number] = [lon, lat];

    // Finest boundary first. Admin-1 is bundled only for the nine countries
    // whose own outline would not say where inside them you had been.
    const focus =
      containing(atlas.states.features, atlas.stateMeta, point) ??
      containing(atlas.countries.features, atlas.countryMeta, point);

    const projection = geoAzimuthalEqualArea().rotate([-lon, -lat]);
    /** Centre the point and cover `r` radians out to the corner of the box. */
    const window = (r: number) =>
      projection
        .translate([width / 2, HEIGHT / 2])
        .scale(Math.hypot(width / 2, HEIGHT / 2) / (2 * Math.sin(r / 2)));

    if (focus) {
      projection.fitExtent(
        [
          [PAD, PAD],
          [width - PAD, HEIGHT - PAD],
        ],
        fitTarget(focus, point) as Parameters<typeof projection.fitExtent>[1]
      );
    } else {
      window(NO_REGION_REACH);
    }

    // What the box actually covers, from its own corner — both the floor on
    // zoom and the cull below are in these terms.
    const corner = projection.invert?.([0, 0]);
    let reach = corner ? geoDistance(corner, point) : Math.PI;
    if (reach < MIN_REACH) {
      // A region small enough to hit this has nothing to show at its own scale.
      window(MIN_REACH);
      reach = MIN_REACH;
    }
    const near = atlas.countries.features.filter(
      (_, i) => geoDistance(atlas.countryMeta[i].c, point) - atlas.countryMeta[i].r < reach * 1.1
    );

    const path = geoPath(projection).digits(1);
    const name = focus
      ? [focus.properties?.name, focus.properties?.admin].filter(Boolean).join(", ")
      : null;

    return {
      land: path({ type: "FeatureCollection", features: near } as Parameters<typeof path>[0]),
      borders: path(atlas.countryBorders),
      provinces: reach < 0.6 ? path(atlas.stateBorders) : null, // clutter when zoomed out
      focus: focus ? path(focus as Parameters<typeof path>[0]) : null,
      xy: projection([lon, lat]),
      name,
    };
  }, [atlas, width, lat, lon]);

  if (failed) return null;

  return (
    <div className="place-inset" ref={boxRef} style={{ height: HEIGHT }}>
      {scene && (
        <svg viewBox={`0 0 ${width} ${HEIGHT}`} width={width} height={HEIGHT} role="img">
          {scene.name && <title>{scene.name}</title>}
          <defs>
            <radialGradient id={seaId} cx="38%" cy="26%" r="82%">
              <stop offset="0%" stopColor="#2c3a78" />
              <stop offset="60%" stopColor="#17204d" />
              <stop offset="100%" stopColor="#090d22" />
            </radialGradient>
          </defs>
          <rect width={width} height={HEIGHT} fill={`url(#${seaId})`} />
          <path d={scene.land ?? undefined} fill="#2f3865" />
          {scene.provinces && (
            <path
              d={scene.provinces}
              fill="none"
              stroke="rgba(211,231,255,0.16)"
              strokeWidth={0.5}
              strokeDasharray="3 2"
            />
          )}
          <path d={scene.borders ?? undefined} fill="none" stroke="#4a5896" strokeWidth={0.7} />
          {scene.focus && (
            <path
              d={scene.focus}
              fill="rgba(124,196,255,0.13)"
              stroke="rgba(124,196,255,0.5)"
              strokeWidth={1}
            />
          )}
          {scene.xy && (
            <g className="pin" transform={`translate(${scene.xy[0]},${scene.xy[1]})`}>
              <circle className="ring" r={6.5} fill="none" stroke="#7cc4ff" strokeWidth={1.4} />
              <circle className="dot" r={3.6} fill="rgba(185,107,255,0.9)" stroke="#e9d6ff" strokeWidth={1.4} />
            </g>
          )}
        </svg>
      )}
    </div>
  );
}
