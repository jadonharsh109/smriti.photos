import { Link } from "react-router-dom";
import { IconChevronL } from "./Icons";

/** The way back out of a detail view.
 *
 *  Sits above the title rather than among the actions on the right, where the
 *  three pages that had one kept it next to "Delete album" — the wrong
 *  neighbourhood for the most-used control on the page. It names its
 *  destination instead of relying on browser history, which is both more
 *  honest about where it goes and the only way back inside the desktop app,
 *  where there is no browser chrome to fall back on. */
export default function BackLink({ to, label }: { to: string; label: string }) {
  return (
    <Link to={to} className="backlink">
      <IconChevronL size={14} />
      {label}
    </Link>
  );
}
