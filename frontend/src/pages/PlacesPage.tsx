import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, cardDelay } from "../api/client";
import { ArtPlaces } from "../components/Illustrations";
import SearchBox from "../components/SearchBox";
import { CardGridSkeleton } from "../components/Skeletons";

interface CityEntry {
  city: string;
  count: number;
  cover: number;
}
interface StateEntry {
  /** null when the offline geocoder could not name one — those cities are
   *  shown straight under the country, with no sub-heading. */
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
  const { data: places, isLoading } = useQuery({
    queryKey: ["places"],
    queryFn: () => api.get<CountryEntry[]>("/api/places/summary"),
  });
  const [query, setQuery] = useState("");

  /** A query can match a country, a state or a city, and a match keeps
   *  everything under it: the country keeps all its states, a state keeps all
   *  its cities. A match further down keeps the headings above it, so a city
   *  is never shown adrift of where it is. */
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
        if (cities.length) {
          states.push({ ...st, cities, count: cities.reduce((n, ct) => n + ct.count, 0) });
        }
      }
      if (states.length) {
        out.push({ ...c, states, count: states.reduce((n, st) => n + st.count, 0) });
      }
    }
    return out;
  }, [places, query]);
  const searching = query.trim().length > 0;
  const countCities = (list: CountryEntry[]) =>
    list.reduce((n, c) => n + c.states.reduce((m, st) => m + st.cities.length, 0), 0);
  const cityCount = countCities(places ?? []);
  const shownCities = countCities(shown);

  const geocode = useMutation({
    mutationFn: () => api.post("/api/places/geocode"),
    onSettled: () => qc.invalidateQueries({ queryKey: ["places"] }),
  });

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Places</h1>
          <p className="sub">Grouped by GPS data — everything resolved offline.</p>
        </div>
        <div className="actions">
          {(places ?? []).length > 0 && (
            <SearchBox
              value={query}
              onChange={setQuery}
              placeholder="Search places"
              result={`${shownCities} of ${cityCount}`}
            />
          )}
          <Link to="/map">
            <button>Globe view</button>
          </Link>
          <button className="primary" onClick={() => geocode.mutate()} disabled={geocode.isPending}>
            Locate new photos
          </button>
        </div>
      </header>
      {isLoading ? (
        <CardGridSkeleton count={6} wide />
      ) : searching && shown.length === 0 ? (
        <div className="empty">
          <ArtPlaces className="art" />
          <p>Nowhere called “{query.trim()}” in your library.</p>
        </div>
      ) : (places ?? []).length === 0 ? (
        <div className="empty">
          <ArtPlaces className="art" />
          <p>No places yet. Index photos with GPS, then press "Locate new photos".</p>
        </div>
      ) : (
        shown.map((c) => (
          <div key={c.country} style={{ marginBottom: 30 }}>
            <div className="row" style={{ marginBottom: 12 }}>
              <h2 style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-0.3px" }}>
                <Link to={`/places/view?country=${encodeURIComponent(c.country)}`} style={{ color: "var(--fg)" }}>
                  {c.country}
                </Link>
              </h2>
              <span className="chip">{c.count} photos</span>
            </div>
            {c.states.map((st) => {
              const q = `country=${encodeURIComponent(c.country)}`;
              // Carried into the city link too, so two places of the same name
              // in one country stay two places.
              const withState = st.state ? `${q}&state=${encodeURIComponent(st.state)}` : q;
              return (
                <div key={st.state ?? "\u2014"} className="place-state">
                  {st.state && (
                    <div className="row place-state-head">
                      <h3>
                        <Link to={`/places/view?${withState}`}>{st.state}</Link>
                      </h3>
                      <span className="muted small">{st.count} photos</span>
                    </div>
                  )}
                  <div className="card-grid">
                    {st.cities.map((city, i) => (
                      <Link
                        key={city.city}
                        className="card"
                        style={cardDelay(i)}
                        to={`/places/view?${withState}&city=${encodeURIComponent(city.city)}`}
                      >
                        <img className="cover wide" src={`/api/thumb/${city.cover}`} loading="lazy" alt="" />
                        <div className="meta">
                          <div className="name">{city.city}</div>
                          <div className="sub">{city.count} photos</div>
                        </div>
                      </Link>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        ))
      )}
    </div>
  );
}
