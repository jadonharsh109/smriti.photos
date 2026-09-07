import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { IconGlobe, IconMore } from "../components/Icons";
import { thumbUrl } from "../lib/images";
import { openContextMenu } from "../shell/ContextMenu";
import { jobs, runningJob } from "../shell/store";
import { TbButton, Toolbar, ToolbarSearch } from "../shell/Toolbar";

interface CityEntry {
  city: string;
  count: number;
  cover: number;
}
interface StateEntry {
  state: string | null;
  count: number;
  cities: CityEntry[];
}
interface CountryEntry {
  country: string;
  count: number;
  cover?: number;
  states: StateEntry[];
}

export default function PlacesPage() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const { data: places, isLoading } = useQuery({ queryKey: ["places"], queryFn: () => api.get<CountryEntry[]>("/api/places/summary") });
  const [query, setQuery] = useState("");
  const running = runningJob(jobs.use((s) => s.byId));

  /** A match keeps everything under it and the headings above it. */
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return places ?? [];
    const out: CountryEntry[] = [];
    for (const c of places ?? []) {
      if (c.country.toLowerCase().includes(needle)) {
        out.push(c);
        continue;
      }
      const states: StateEntry[] = [];
      for (const st of c.states) {
        if (st.state?.toLowerCase().includes(needle)) {
          states.push(st);
          continue;
        }
        const cities = st.cities.filter((ct) => ct.city.toLowerCase().includes(needle));
        if (cities.length) states.push({ ...st, cities, count: cities.reduce((n, ct) => n + ct.count, 0) });
      }
      if (states.length) out.push({ ...c, states, count: states.reduce((n, st) => n + st.count, 0) });
    }
    return out;
  }, [places, query]);
  const searching = query.trim().length > 0;
  const countCities = (list: CountryEntry[]) => list.reduce((n, c) => n + c.states.reduce((m, st) => m + st.cities.length, 0), 0);
  const cityCount = countCities(places ?? []);
  const shownCities = countCities(shown);

  const geocode = useMutation({ mutationFn: () => api.post("/api/places/geocode"), onSettled: () => qc.invalidateQueries({ queryKey: ["places"] }) });

  const more = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openContextMenu({ clientX: r.right - 180, clientY: r.bottom + 4, preventDefault: () => {} }, [
      { label: "Locate New Photos", disabled: !!running, onSelect: () => geocode.mutate() },
    ]);
  };

  return (
    <>
      <Toolbar title="Places" count={cityCount ? `${cityCount.toLocaleString()} ${cityCount === 1 ? "place" : "places"}` : null}>
        {(places ?? []).length > 0 && <ToolbarSearch value={query} onChange={setQuery} placeholder="Search places" hits={`${shownCities} of ${cityCount}`} />}
        <TbButton icon={<IconGlobe size={14} />} title="Map" onClick={() => nav("/map")} />
        <TbButton icon={<IconMore size={14} />} title="More" onClick={more} />
      </Toolbar>
      {isLoading ? null : searching && shown.length === 0 ? (
        <div className="empty"><p>Nowhere called “{query.trim()}” in your library.</p></div>
      ) : (places ?? []).length === 0 ? (
        <div className="empty">
          <h2>No places yet</h2>
          <p>Photos with a GPS position are named entirely offline. If some are indexed already, ask Smriti to locate them.</p>
          <div className="row">
            <button className="btn primary" disabled={!!running} onClick={() => geocode.mutate()}>Locate New Photos</button>
          </div>
        </div>
      ) : (
        <div className="page">
          {shown.map((c) => (
            <section key={c.country}>
              <h2 className="sec-h">
                <Link to={`/places/view?country=${encodeURIComponent(c.country)}`}>{c.country}</Link>
                <span className="n num">{c.count.toLocaleString()} photos</span>
              </h2>
              {c.states.map((st) => {
                const q = `country=${encodeURIComponent(c.country)}`;
                const withState = st.state ? `${q}&state=${encodeURIComponent(st.state)}` : q;
                return (
                  <div key={st.state ?? "—"}>
                    {st.state && (
                      <h3 className="sub-h">
                        <Link to={`/places/view?${withState}`}>{st.state}</Link>
                        <span className="num faint">{st.count.toLocaleString()}</span>
                      </h3>
                    )}
                    <div className="cards wide">
                      {st.cities.map((city) => (
                        <Link key={city.city} className="card" to={`/places/view?${withState}&city=${encodeURIComponent(city.city)}`}>
                          <img className="cover wide" src={thumbUrl(city.cover)} loading="lazy" decoding="async" alt="" />
                          <div className="meta">
                            <div className="name">{city.city}</div>
                            <div className="sub num">{city.count.toLocaleString()} photos</div>
                          </div>
                        </Link>
                      ))}
                    </div>
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      )}
    </>
  );
}
