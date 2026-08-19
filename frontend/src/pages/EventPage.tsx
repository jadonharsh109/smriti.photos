import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api/client";
import AddAllToAlbum from "../components/AddAllToAlbum";
import BackLink from "../components/BackLink";
import { TextDialog } from "../components/Dialogs";
import TimelineGrid from "../components/TimelineGrid";

interface Event {
  id: number;
  title: string | null;
  count: number;
}

export default function EventPage() {
  const { id } = useParams();
  const eventId = Number(id);
  const qc = useQueryClient();
  const [renaming, setRenaming] = useState(false);
  const { data: events } = useQuery({
    queryKey: ["events"],
    queryFn: () => api.get<Event[]>("/api/events"),
  });
  const event = events?.find((e) => e.id === eventId);
  const rename = useMutation({
    mutationFn: (title: string) => api.patch(`/api/events/${eventId}`, { title }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["events"] });
      setRenaming(false);
    },
  });

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <BackLink to="/events" label="Events" />
          <h1>{event?.title ?? "Event"}</h1>
          {event && <p className="sub">{event.count} items</p>}
        </div>
        <div className="actions">
          <AddAllToAlbum filters={{ event_id: eventId }} />
          <button onClick={() => setRenaming(true)}>Rename</button>
        </div>
      </header>
      <TimelineGrid filters={{ event_id: eventId }} emptyText="No items in this event" />
      {renaming && (
        <TextDialog
          title="Rename event"
          initial={event?.title ?? ""}
          submitLabel="Rename"
          onSubmit={(t) => rename.mutate(t)}
          onClose={() => setRenaming(false)}
        />
      )}
    </div>
  );
}
