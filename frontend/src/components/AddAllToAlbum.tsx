import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, fetchAllItems, type Filters } from "../api/client";
import AlbumPicker from "./AlbumPicker";

/** Header action for filtered views (person / place / event): files every photo
 *  matching the filter into an album, existing or new. The picking itself is
 *  the shared AlbumPicker — the same dialog the selection bar opens. */
export default function AddAllToAlbum({ filters }: { filters: Filters }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [justAdded, setJustAdded] = useState(false);

  const addAllTo = async (albumId: number) => {
    const items = await fetchAllItems(filters);
    await api.post(`/api/albums/${albumId}/items`, { file_ids: items.map((i) => i.id) });
    qc.invalidateQueries({ queryKey: ["albums"] });
    qc.invalidateQueries({ queryKey: ["album"] });
    setJustAdded(true);
    setTimeout(() => setJustAdded(false), 2500);
  };

  const createAndAdd = async (name: string) => {
    const r = await api.post<{ id: number }>("/api/albums", { name });
    await addAllTo(r.id);
  };

  return (
    <>
      <button onClick={() => setOpen(true)}>{justAdded ? "\u2713 Added to album" : "Add all to album\u2026"}</button>
      {open && (
        <AlbumPicker
          title="Add every photo in this view to an album"
          onPick={addAllTo}
          onCreate={createAndAdd}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
