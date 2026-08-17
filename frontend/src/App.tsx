import { useQuery } from "@tanstack/react-query";
import { NavLink, Link, Outlet, useLocation } from "react-router-dom";
import { api } from "./api/client";
import {
  IconAlbum,
  IconCopy,
  IconDoc,
  IconGlobe,
  IconLock,
  IconPeople,
  IconPhotos,
  IconPin,
  IconSliders,
  IconSparkle,
} from "./components/Icons";
import JobsIndicator from "./components/JobsIndicator";
import Logo from "./components/Logo";

const NAV: { sec: string; items: { to: string; label: string; Icon: typeof IconPhotos }[] }[] = [
  {
    sec: "Library",
    items: [
      { to: "/", label: "Photos", Icon: IconPhotos },
      { to: "/albums", label: "Albums", Icon: IconAlbum },
    ],
  },
  {
    sec: "Explore",
    items: [
      { to: "/people", label: "People", Icon: IconPeople },
      { to: "/places", label: "Places", Icon: IconPin },
      { to: "/map", label: "Map", Icon: IconGlobe },
      { to: "/events", label: "Events", Icon: IconSparkle },
      { to: "/documents", label: "Documents", Icon: IconDoc },
      { to: "/locked", label: "Locked", Icon: IconLock },
    ],
  },
  {
    sec: "Manage",
    items: [
      { to: "/dupes", label: "Duplicates", Icon: IconCopy },
      { to: "/settings", label: "Library setup", Icon: IconSliders },
    ],
  },
];

/** Version of the running server, pinned to the foot of the rail.
 *
 * Reported by the backend rather than compiled in, so after an in-app update
 * it shows what is actually serving. Rendered as a sibling *below*
 * JobsIndicator: when a job starts, its progress card appears above this line
 * and pushes nothing around, so the two never contend for the same space. */
function AppVersion() {
  const { data } = useQuery({
    queryKey: ["health"],
    queryFn: () => api.get<{ version: string }>("/api/health"),
    staleTime: Infinity,
  });
  if (!data?.version) return null;
  return (
    <div className="rail-version" title="Version of the running library server">
      v{data.version}
    </div>
  );
}

export default function App() {
  const location = useLocation();
  return (
    <>
      <div className="aurora">
        <i /><i /><i />
      </div>
      <div className="grain" />
      <div className="shell">
        <aside className="rail">
          <Link to="/welcome" className="rail-brand" title="About Smriti">
            <Logo size={27} />
            <span className="word">Smriti</span>
            <span className="dev brand-dev">स्मृति</span>
          </Link>
          {/* Only the links scroll. The jobs card and version stay pinned to
              the foot of the rail, so a short window can never hide progress. */}
          <div className="rail-nav">
            {NAV.map((g) => (
              <nav key={g.sec}>
                <div className="nav-sec">{g.sec}</div>
                {g.items.map((n) => (
                  <NavLink
                    key={n.to}
                    to={n.to}
                    end={n.to === "/"}
                    className={({ isActive }) => (isActive ? "nav active" : "nav")}
                  >
                    <span className="nav-icon">
                      <n.Icon size={19} />
                    </span>
                    {n.label}
                  </NavLink>
                ))}
              </nav>
            ))}
          </div>
          <JobsIndicator />
          <AppVersion />
        </aside>
        {/* key remounts pages on route change so the page-enter animation plays */}
        <main className="stage" id="main-scroll" key={location.pathname}>
          <Outlet />
        </main>
      </div>
    </>
  );
}
