import { useSearchParams } from "react-router-dom";
import AddAllToAlbum from "../components/AddAllToAlbum";
import BackLink from "../components/BackLink";
import TimelineGrid from "../components/TimelineGrid";

export default function PlaceGridPage() {
  const [params] = useSearchParams();
  const country = params.get("country") ?? undefined;
  const city = params.get("city") ?? undefined;
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <BackLink to="/places" label="Places" />
          <h1>{city ?? country ?? "Place"}</h1>
          {city && <p className="sub">{country}</p>}
        </div>
        <div className="actions">
          <AddAllToAlbum filters={{ country, city }} />
        </div>
      </header>
      <TimelineGrid filters={{ country, city }} emptyText="No photos for this place" />
    </div>
  );
}
