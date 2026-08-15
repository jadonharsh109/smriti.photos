import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, cardDelay } from "../api/client";
import { IconLock } from "../components/Icons";
import { ArtEvents } from "../components/Illustrations";

interface Event {
  id: number;
  title: string | null;
  count: number;
  cover_file_id: number | null;
  start_ts: number;
  end_ts: number;
}

export default function EventsPage() {
  const qc = useQueryClient();
  const { data: events } = useQuery({
    queryKey: ["events"],
    queryFn: () => api.get<Event[]>("/api/events"),
  });
  const rebuild = useMutation({
    mutationFn: () => api.post("/api/events/rebuild"),
    onSettled: () => qc.invalidateQueries({ queryKey: ["events"] }),
  });

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Events</h1>
          <p className="sub">Trips and moments, split automatically on gaps in your timeline.</p>
        </div>
        <div className="actions">
          <button className="primary" onClick={() => rebuild.mutate()} disabled={rebuild.isPending}>
            Rebuild events
          </button>
        </div>
      </header>
      {(events ?? []).length === 0 && (
        <div className="empty">
          <ArtEvents className="art" />
          <p>No events yet — index some photos and press "Rebuild events".</p>
        </div>
      )}
      <div className="card-grid">
        {(events ?? []).map((e, i) => (
          <Link key={e.id} to={`/events/${e.id}`} className="card" style={cardDelay(i)}>
            {e.cover_file_id ? (
              <img className="cover wide" src={`/api/thumb/${e.cover_file_id}`} loading="lazy" alt="" />
            ) : (
              <div className="cover wide" />
            )}
            <div className="meta">
              <div className="name">{e.title ?? "Event"}</div>
              <div className="sub">{e.count} items</div>
            </div>
          </Link>
        ))}
        <Link to="/locked" className="card" style={cardDelay(events?.length ?? 0)}>
          <div className="cover wide locked-card-cover">
            <IconLock size={42} />
          </div>
          <div className="meta">
            <div className="name">Locked Folder</div>
            <div className="sub">Private &amp; encrypted — unlock to view</div>
          </div>
        </Link>
      </div>
    </div>
  );
}
