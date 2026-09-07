import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useParams } from "react-router-dom";
import { api, fetchAllItems, filterQS, type Bucket } from "../api/client";
import DayGrid from "../components/DayGrid";
import { TextDialog } from "../components/Dialogs";
import { IconMore, IconPencil } from "../components/Icons";
import { actions } from "../shell/actions";
import { openContextMenu } from "../shell/ContextMenu";
import { GridControls, StandardSelection } from "../shell/GridToolbar";
import { TbButton, Toolbar } from "../shell/Toolbar";

interface Event {
  id: number;
  title: string | null;
  count: number;
  start_ts: number;
  end_ts: number;
}

export default function EventPage() {
  const { id } = useParams();
  const eventId = Number(id);
  const qc = useQueryClient();
  const [renaming, setRenaming] = useState(false);
  const filters = { event_id: eventId };
  // the event's own row: cheap, and the one year's list is probably cached already
  const { data: buckets } = useQuery({
    queryKey: ["buckets", JSON.stringify(filters)],
    queryFn: () => api.get<Bucket[]>(`/api/timeline/buckets${filterQS(filters)}`),
  });
  const year = buckets?.[0] ? Number(buckets[0].day.slice(0, 4)) : null;
  const { data: events } = useQuery({
    queryKey: ["events", "year", year],
    queryFn: () => api.get<Event[]>(`/api/events?year=${year}`),
    enabled: year != null,
    staleTime: 300_000,
  });
  const event = events?.find((e) => e.id === eventId);
  const total = buckets?.reduce((s, b) => s + b.count, 0);

  const rename = useMutation({
    mutationFn: (title: string) => api.patch(`/api/events/${eventId}`, { title }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["events"] });
      setRenaming(false);
    },
  });

  const more = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openContextMenu({ clientX: r.right - 180, clientY: r.bottom + 4, preventDefault: () => {} }, [
      { label: "Rename…", onSelect: () => setRenaming(true) },
      { label: "Add All to Album…", onSelect: async () => actions.addToAlbum((await fetchAllItems(filters)).map((i) => i.id)) },
    ]);
  };

  const title = (
    <button className="row" style={{ gap: 5, fontWeight: 600, fontSize: 13, color: "var(--ink)" }} title="Rename this event" onClick={() => setRenaming(true)}>
      {event?.title ?? "Event"}
      <span style={{ color: "var(--faint)", display: "inline-flex" }}><IconPencil size={12} /></span>
    </button>
  );

  return (
    <>
      <Toolbar back="/events" title={title} count={total != null ? `${total.toLocaleString()} ${total === 1 ? "item" : "items"}` : null}>
        <StandardSelection />
        <TbButton icon={<IconMore size={14} />} title="More" onClick={more} />
        <GridControls />
      </Toolbar>
      <DayGrid filters={filters} emptyText="No items in this event" />
      {renaming && <TextDialog title="Rename Event" initial={event?.title ?? ""} submitLabel="Rename" onSubmit={(t) => rename.mutate(t)} onClose={() => setRenaming(false)} />}
    </>
  );
}
