import { NavLink, Link, Outlet, useLocation } from "react-router-dom";
import {
  IconAlbum,
  IconCopy,
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
          <span className="spacer" />
          <JobsIndicator />
        </aside>
        {/* key remounts pages on route change so the page-enter animation plays */}
        <main className="stage" id="main-scroll" key={location.pathname}>
          <Outlet />
        </main>
      </div>
    </>
  );
}
