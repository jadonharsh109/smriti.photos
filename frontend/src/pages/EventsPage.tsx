import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, cardDelay } from "../api/client";
import { ArtEvents } from "../components/Illustrations";
import { CardGridSkeleton } from "../components/Skeletons";
import CardGrid from "../components/CardGrid";

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
  const { data: events, isLoading } = useQuery({
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
      {isLoading ? (
        <CardGridSkeleton count={8} wide />
      ) : (events ?? []).length === 0 ? (
        <div className="empty">
          <ArtEvents className="art" />
          <p>No events yet — index some photos and press "Rebuild events".</p>
        </div>
      ) : (
        <CardGrid>
          {events!.map((e, i) => (
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
        </CardGrid>
      )}
    </div>
  );
}
