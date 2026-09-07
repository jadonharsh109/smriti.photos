import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { IconMore } from "../components/Icons";
import { thumbUrl } from "../lib/images";
import { openContextMenu } from "../shell/ContextMenu";
import { jobs, runningJob } from "../shell/store";
import { TbButton, Toolbar } from "../shell/Toolbar";

interface Event {
  id: number;
  title: string | null;
  count: number;
  cover_file_id: number | null;
  start_ts: number;
  end_ts: number;
  is_user_titled: number;
}
interface Year {
  year: number;
  events: number;
}

const span = (e: Event) => {
  const a = new Date(e.start_ts * 1000);
  const b = new Date(e.end_ts * 1000);
  const f = (d: Date, y = false) => d.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(y ? { year: "numeric" } : {}) });
  if (a.toDateString() === b.toDateString()) return f(a);
  return `${f(a)} – ${f(b)}`;
};

/** Trips and days out, cut on the gaps in the timeline. One section per
 *  year, each fetched as it scrolls into view — a long library has thousands
 *  of events and nobody needs all of them at once. */
export default function EventsPage() {
  const qc = useQueryClient();
  const { data: years, isLoading } = useQuery({ queryKey: ["events", "years"], queryFn: () => api.get<Year[]>("/api/events/years") });
  const running = runningJob(jobs.use((s) => s.byId));
  const rebuild = useMutation({ mutationFn: () => api.post("/api/events/rebuild"), onSettled: () => qc.invalidateQueries({ queryKey: ["events"] }) });
  const total = (years ?? []).reduce((s, y) => s + y.events, 0);

  const more = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openContextMenu({ clientX: r.right - 180, clientY: r.bottom + 4, preventDefault: () => {} }, [
      { label: "Rebuild Events", disabled: !!running, onSelect: () => rebuild.mutate() },
    ]);
  };

  return (
    <>
      <Toolbar title="Events" count={total ? `${total.toLocaleString()} ${total === 1 ? "event" : "events"}` : null}>
        <TbButton icon={<IconMore size={14} />} title="More" onClick={more} />
      </Toolbar>
      {isLoading ? null : (years ?? []).length === 0 ? (
        <div className="empty">
          <h2>No events yet</h2>
          <p>Events are found on their own after a scan. If photos are indexed already, build them now.</p>
          <div className="row">
            <button className="btn primary" disabled={!!running} onClick={() => rebuild.mutate()}>Build Events</button>
          </div>
        </div>
      ) : (
        <div className="page">
          {years!.map((y, i) => (
            <YearSection key={y.year} year={y.year} n={y.events} eager={i < 2} />
          ))}
        </div>
      )}
    </>
  );
}

/** The first years load at once — the ones on screen must never wait on an
 *  observer; the rest as they scroll near. */
function YearSection({ year, n, eager }: { year: number; n: number; eager: boolean }) {
  const ref = useRef<HTMLElement>(null);
  const [near, setNear] = useState(eager);
  useEffect(() => {
    const el = ref.current;
    if (!el || eager) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          io.disconnect();
        }
      },
      { root: document.getElementById("main-scroll"), rootMargin: "600px 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [eager]);
  const { data: events } = useQuery({
    queryKey: ["events", "year", year],
    queryFn: () => api.get<Event[]>(`/api/events?year=${year}`),
    enabled: near,
    staleTime: 300_000,
  });
  // the estimate holds the page's scroll height steady until the real rows land
  const rows = Math.ceil(n / 4);
  return (
    <section ref={ref} style={{ minHeight: events ? undefined : rows * 208 + 44 }}>
      <h2 className="sec-h">
        {year}
        <span className="n num">{n.toLocaleString()} {n === 1 ? "event" : "events"}</span>
      </h2>
      {events && (
        <div className="cards wide">
          {events.map((e) => (
            <Link key={e.id} to={`/events/${e.id}`} className="card">
              {e.cover_file_id ? <img className="cover wide" src={thumbUrl(e.cover_file_id)} loading="lazy" decoding="async" alt="" /> : <div className="cover wide" />}
              <div className="meta">
                <div className="name">{e.title ?? "Event"}</div>
                <div className="sub num">
                  {/* an automatic title is already the date */}
                  {e.is_user_titled ? `${span(e)} · ` : ""}{e.count.toLocaleString()} {e.count === 1 ? "item" : "items"}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
