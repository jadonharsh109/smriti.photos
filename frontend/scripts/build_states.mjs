// One-time conversion of Natural Earth's admin-1 states (public domain,
// naturalearthdata.com) into a slim quantized TopoJSON for the globe.
// Usage: node scripts/build_states.mjs <ne_50m_admin_1_states_provinces.geojson>
import { readFileSync, writeFileSync } from "node:fs";
import { topology } from "topojson-server";
import { presimplify, quantile, simplify } from "topojson-simplify";

const src = process.argv[2];
const geo = JSON.parse(readFileSync(src, "utf8"));
for (const f of geo.features) {
  f.properties = { name: f.properties.name, admin: f.properties.admin };
}
let topo = topology({ states: geo }, 1e5);
const pre = presimplify(topo);
topo = simplify(pre, quantile(pre, 0.45));
const out = "src/data/states-50m.json";
writeFileSync(out, JSON.stringify(topo));
console.log(`${out}: ${(JSON.stringify(topo).length / 1e6).toFixed(2)} MB, ${geo.features.length} states`);
