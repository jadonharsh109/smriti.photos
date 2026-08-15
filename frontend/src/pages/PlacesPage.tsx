import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, cardDelay } from "../api/client";
import { ArtPlaces } from "../components/Illustrations";

interface CityEntry {
  city: string;
  count: number;
  cover: number;
}
interface CountryEntry {
  country: string;
  count: number;
  cover?: number;
  cities: CityEntry[];
}

export default function PlacesPage() {
  const qc = useQueryClient();
  const { data: places } = useQuery({
    queryKey: ["places"],
    queryFn: () => api.get<CountryEntry[]>("/api/places/summary"),
  });
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
          <Link to="/map">
            <button>Globe view</button>
          </Link>
          <button className="primary" onClick={() => geocode.mutate()} disabled={geocode.isPending}>
            Locate new photos
          </button>
        </div>
      </header>
      {(places ?? []).length === 0 ? (
        <div className="empty">
          <ArtPlaces className="art" />
          <p>No places yet. Index photos with GPS, then press "Locate new photos".</p>
        </div>
      ) : (
        places!.map((c) => (
          <div key={c.country} style={{ marginBottom: 30 }}>
            <div className="row" style={{ marginBottom: 12 }}>
              <h2 style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-0.3px" }}>
                <Link to={`/places/view?country=${encodeURIComponent(c.country)}`} style={{ color: "var(--fg)" }}>
                  {c.country}
                </Link>
              </h2>
              <span className="chip">{c.count} photos</span>
            </div>
            <div className="card-grid">
              {c.cities.map((city, i) => (
                <Link
                  key={city.city}
                  className="card"
                  style={cardDelay(i)}
                  to={`/places/view?country=${encodeURIComponent(c.country)}&city=${encodeURIComponent(city.city)}`}
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
        ))
      )}
    </div>
  );
}
