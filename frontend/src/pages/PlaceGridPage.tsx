import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api, fetchAllItems, filterQS, type Bucket } from "../api/client";
import DayGrid from "../components/DayGrid";
import { IconAlbum } from "../components/Icons";
import { actions } from "../shell/actions";
import { GridControls, StandardSelection } from "../shell/GridToolbar";
import { TbButton, Toolbar } from "../shell/Toolbar";

export default function PlaceGridPage() {
  const [params] = useSearchParams();
  const country = params.get("country") ?? undefined;
  const state = params.get("state") ?? undefined;
  const city = params.get("city") ?? undefined;
  const filters = { country, state, city };
  // the toolbar shows the narrowest place; whatever is broader follows as the count line
  const heading = city ?? state ?? country;
  const under = [state, country].filter((p) => p && p !== heading).join(", ");
  const { data: buckets } = useQuery({
    queryKey: ["buckets", JSON.stringify(filters)],
    queryFn: () => api.get<Bucket[]>(`/api/timeline/buckets${filterQS(filters)}`),
  });
  const total = buckets?.reduce((s, b) => s + b.count, 0);
  const count = [under, total != null ? `${total.toLocaleString()} ${total === 1 ? "photo" : "photos"}` : null].filter(Boolean).join(" · ");

  return (
    <>
      <Toolbar back="/places" title={heading ?? "Place"} count={count || null}>
        <StandardSelection />
        <TbButton icon={<IconAlbum size={14} />} title="Add all to an album" onClick={async () => actions.addToAlbum((await fetchAllItems(filters)).map((i) => i.id))}>
          Add All to Album
        </TbButton>
        <GridControls />
      </Toolbar>
      <DayGrid filters={filters} emptyText="No photos for this place" />
    </>
  );
}
