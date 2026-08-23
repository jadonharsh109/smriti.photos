import { useSearchParams } from "react-router-dom";
import AddAllToAlbum from "../components/AddAllToAlbum";
import BackLink from "../components/BackLink";
import TimelineGrid from "../components/TimelineGrid";

export default function PlaceGridPage() {
  const [params] = useSearchParams();
  const country = params.get("country") ?? undefined;
  const state = params.get("state") ?? undefined;
  const city = params.get("city") ?? undefined;
  const filters = { country, state, city };
  // The heading is the narrowest thing we were given; the line under it is
  // whatever is broader than that, narrowest first. Dropping what already is
  // the heading is the whole job — a state page headed "Uttarakhand" should
  // say "India" beneath it, not "Uttarakhand" again.
  const heading = city ?? state ?? country;
  const under = [state, country].filter((part) => part && part !== heading).join(", ");
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <BackLink to="/places" label="Places" />
          <h1>{heading ?? "Place"}</h1>
          {under && <p className="sub">{under}</p>}
        </div>
        <div className="actions">
          <AddAllToAlbum filters={filters} />
        </div>
      </header>
      <TimelineGrid filters={filters} emptyText="No photos for this place" />
    </div>
  );
}
