import { useQuery } from "@tanstack/react-query";
import { NavLink } from "react-router-dom";
import { api } from "../api/client";
import {
  IconAlbum,
  IconChevronR,
  IconCopy,
  IconDoc,
  IconFilm,
  IconGear,
  IconGlobe,
  IconHeart,
  IconLive,
  IconLock,
  IconPeople,
  IconPhotos,
  IconPin,
  IconSearch,
  IconSparkle,
  IconVideo,
} from "../components/Icons";
import Logo from "../components/Logo";
import { openPrefs, setAlbumsOpen, side } from "./store";

interface Stats {
  photos: number;
  videos: number;
  live: number;
  people_visible: number;
}
interface Album {
  id: number;
  name: string;
  count: number;
  system?: string | null;
}

const n = (x: number | undefined) => (x == null ? "" : x.toLocaleString());

function Row({
  to,
  icon,
  label,
  count,
  end,
  sub,
}: {
  to: string;
  icon?: React.ReactNode;
  label: string;
  count?: string;
  end?: boolean;
  sub?: boolean;
}) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => `srow${isActive ? " on" : ""}${sub ? " sub" : ""}`}>
      {icon}
      <span className="trunc">{label}</span>
      {count ? <span className="ct num">{count}</span> : null}
    </NavLink>
  );
}

export default function Sidebar() {
  const { data: stats } = useQuery({ queryKey: ["stats"], queryFn: () => api.get<Stats>("/api/stats") });
  const { data: albums } = useQuery({ queryKey: ["albums"], queryFn: () => api.get<Album[]>("/api/albums") });
  const { data: years } = useQuery({
    queryKey: ["events", "years"],
    queryFn: () => api.get<{ year: number; events: number }[]>("/api/events/years"),
  });
  const { data: kinds } = useQuery({
    queryKey: ["kinds"],
    queryFn: () => api.get<{ total: number }>("/api/kinds/summary"),
  });
  const { data: places } = useQuery({
    queryKey: ["places"],
    queryFn: () => api.get<{ states: { cities: unknown[] }[] }[]>("/api/places/summary"),
  });
  const { data: moments } = useQuery({ queryKey: ["moments"], queryFn: () => api.get<unknown[]>("/api/moments") });
  const { data: health } = useQuery({
    queryKey: ["health"],
    queryFn: () => api.get<{ version: string }>("/api/health"),
    staleTime: Infinity,
  });
  const albumsOpen = side.use((s) => s.albumsOpen);

  const fav = albums?.find((a) => a.system === "favourites");
  const userAlbums = (albums ?? []).filter((a) => !a.system);
  const eventCount = (years ?? []).reduce((s, y) => s + y.events, 0);
  const cityCount = (places ?? []).reduce((s, c) => s + c.states.reduce((m, st) => m + st.cities.length, 0), 0);

  return (
    <aside className="side" data-tauri-drag-region>
      <div className="brand" data-tauri-drag-region>
        <Logo size={16} />
        Smriti <span className="dev">स्मृति</span>
      </div>
      <nav className="nav">
        <div className="sec">Library</div>
        <Row to="/" end icon={<IconPhotos />} label="Photos" count={n(stats?.photos)} />
        <Row to="/videos" icon={<IconVideo />} label="Videos" count={n(stats?.videos)} />
        {(stats?.live ?? 0) > 0 && <Row to="/live" icon={<IconLive />} label="Live Photos" count={n(stats?.live)} />}
        <Row to="/favourites" icon={<IconHeart />} label="Favourites" count={fav ? n(fav.count) : ""} />
        <Row to="/search" icon={<IconSearch />} label="Search" />

        <div className="sec">Collections</div>
        <div className="row" style={{ gap: 0 }}>
          <button
            className="srow"
            style={{ width: 22, paddingLeft: 6, paddingRight: 0 }}
            aria-label={albumsOpen ? "Collapse albums" : "Expand albums"}
            onClick={() => setAlbumsOpen(!albumsOpen)}
          >
            <IconChevronR className={`chev${albumsOpen ? " open" : ""}`} size={12} />
          </button>
          <NavLink to="/albums" end className={({ isActive }) => `srow${isActive ? " on" : ""}`} style={{ paddingLeft: 4 }}>
            <IconAlbum />
            <span className="trunc">Albums</span>
            <span className="ct num">{userAlbums.length || ""}</span>
          </NavLink>
        </div>
        {albumsOpen && userAlbums.map((a) => <Row key={a.id} to={`/albums/${a.id}`} label={a.name} count={n(a.count)} sub />)}
        <Row to="/people" icon={<IconPeople />} label="People" count={n(stats?.people_visible)} />
        <Row to="/places" icon={<IconPin />} label="Places" count={cityCount ? n(cityCount) : ""} />
        <Row to="/map" icon={<IconGlobe />} label="Map" />
        <Row to="/events" icon={<IconSparkle />} label="Events" count={eventCount ? n(eventCount) : ""} />
        <Row to="/moments" icon={<IconFilm />} label="Moments" count={moments?.length ? n(moments.length) : ""} />

        <div className="sec">Utilities</div>
        <Row to="/documents" icon={<IconDoc />} label="Documents" count={kinds?.total ? n(kinds.total) : ""} />
        <Row to="/locked" icon={<IconLock />} label="Locked" />
        <Row to="/cleanup" icon={<IconCopy />} label="Cleanup" />

      </nav>
      <div className="side-foot">
        <button className="iconbtn" title="Preferences (⌘,)" onClick={() => openPrefs()}>
          <IconGear size={15} />
        </button>
        <span className="ver num">{health?.version ? `v${health.version}` : ""}</span>
      </div>
    </aside>
  );
}
