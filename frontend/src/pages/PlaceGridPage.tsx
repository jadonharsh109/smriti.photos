import { Link, useSearchParams } from "react-router-dom";
import AddAllToAlbum from "../components/AddAllToAlbum";
import TimelineGrid from "../components/TimelineGrid";

export default function PlaceGridPage() {
  const [params] = useSearchParams();
  const country = params.get("country") ?? undefined;
  const city = params.get("city") ?? undefined;
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{city ?? country ?? "Place"}</h1>
          {city && <p className="sub">{country}</p>}
        </div>
        <div className="actions">
          <AddAllToAlbum filters={{ country, city }} />
          <Link to="/places">
            <button className="ghost">← All places</button>
          </Link>
        </div>
      </header>
      <TimelineGrid filters={{ country, city }} emptyText="No photos for this place" />
    </div>
  );
}
