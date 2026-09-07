import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api, type Filters } from "../api/client";
import DayGrid from "../components/DayGrid";
import { IconSearch } from "../components/Icons";
import { GridControls, StandardSelection } from "../shell/GridToolbar";
import { openPrefs } from "../shell/store";
import { TbButton, Toolbar } from "../shell/Toolbar";

interface Stats {
  photos: number;
  videos: number;
  live: number;
}
interface Album {
  id: number;
  count: number;
  system?: string | null;
}

export type PhotosVariant = "all" | "videos" | "live" | "favourites";

const TITLE: Record<PhotosVariant, string> = { all: "Photos", videos: "Videos", live: "Live Photos", favourites: "Favourites" };
const EMPTY: Record<PhotosVariant, string> = {
  all: "Nothing here yet",
  videos: "No videos in your library yet",
  live: "No Live Photos found yet",
  favourites: "Nothing favourited yet — the heart on any photo puts it here",
};

/** The library, newest first — and its three standing views. */
export default function PhotosPage({ variant = "all" }: { variant?: PhotosVariant }) {
  const nav = useNavigate();
  const { data: stats } = useQuery({ queryKey: ["stats"], queryFn: () => api.get<Stats>("/api/stats") });
  const { data: albums } = useQuery({
    queryKey: ["albums"],
    queryFn: () => api.get<Album[]>("/api/albums"),
    enabled: variant === "favourites",
  });
  const fav = albums?.find((a) => a.system === "favourites");

  const filters: Filters =
    variant === "videos" ? { media_type: "video" } : variant === "live" ? { live: true } : variant === "favourites" ? { album_id: fav?.id ?? -1 } : {};
  const count =
    variant === "videos" ? stats?.videos : variant === "live" ? stats?.live : variant === "favourites" ? fav?.count : stats ? stats.photos + stats.videos : undefined;
  const empty = stats && stats.photos + stats.videos === 0;

  return (
    <>
      <Toolbar title={TITLE[variant]} count={count != null ? count.toLocaleString() : null}>
        <StandardSelection fav={variant !== "favourites"} />
        <TbButton icon={<IconSearch size={14} />} title="Search (⌘F)" onClick={() => nav("/search")} />
        <GridControls />
      </Toolbar>
      {empty ? (
        <div className="setup-hero">
          <h2>Your library is empty</h2>
          <p>Point Smriti at the folders that hold your photos. They are read where they are — nothing is moved or copied.</p>
          <button className="btn primary" onClick={() => openPrefs("library")}>Add a Folder…</button>
        </div>
      ) : variant === "favourites" && albums && !fav ? (
        <div className="empty"><p>{EMPTY.favourites}</p></div>
      ) : variant === "favourites" && !albums ? null : (
        <DayGrid filters={filters} emptyText={EMPTY[variant]} />
      )}
    </>
  );
}
