import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, fetchAllItems, type Filters } from "../api/client";
import Portal from "./Portal";

interface Album {
  id: number;
  name: string;
  count: number;
}

/** Header action for filtered views (person / place / event): adds every
 * photo matching the filter to an existing or new album in one go. */
export default function AddAllToAlbum({ filters }: { filters: Filters }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [justAdded, setJustAdded] = useState(false);

  const { data: albums } = useQuery({
    queryKey: ["albums"],
    queryFn: () => api.get<Album[]>("/api/albums"),
    enabled: open,
  });

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy]);

  const addAllTo = async (albumId: number) => {
    setBusy(true);
    try {
      const items = await fetchAllItems(filters);
      await api.post(`/api/albums/${albumId}/items`, { file_ids: items.map((i) => i.id) });
      qc.invalidateQueries({ queryKey: ["albums"] });
      qc.invalidateQueries({ queryKey: ["album"] });
      setOpen(false);
      setJustAdded(true);
      setTimeout(() => setJustAdded(false), 2500);
    } finally {
      setBusy(false);
    }
  };

  const createAndAdd = async () => {
    const name = newName.trim();
    if (!name) return;
    const r = await api.post<{ id: number }>("/api/albums", { name });
    setNewName("");
    await addAllTo(r.id);
  };

  return (
    <>
      <button onClick={() => setOpen(true)}>{justAdded ? "✓ Added to album" : "Add all to album…"}</button>
      {open && (
        <Portal>
        <div className="modal-back" onClick={() => !busy && setOpen(false)}>
          <div className="modal" style={{ width: 440 }} onClick={(e) => e.stopPropagation()}>
            <header>Add every photo in this view</header>
            <div className="modal-body" style={{ padding: "10px 24px 18px" }}>
              {busy ? (
                <div className="row" style={{ gap: 10, padding: "12px 0" }}>
                  <div className="spin" />
                  <span className="muted">Adding photos…</span>
                </div>
              ) : (
                <>
                  {(albums ?? []).length > 0 && (
                    <>
                      <p className="muted small" style={{ marginBottom: 8 }}>Pick an album:</p>
                      <div className="row" style={{ marginBottom: 16 }}>
                        {albums!.map((a) => (
                          <button key={a.id} onClick={() => addAllTo(a.id)}>
                            {a.name} <span className="faint">({a.count})</span>
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                  <p className="muted small" style={{ marginBottom: 8 }}>
                    {(albums ?? []).length > 0 ? "…or start a new one:" : "Name a new album:"}
                  </p>
                  <div className="row">
                    <input
                      type="text"
                      autoFocus={(albums ?? []).length === 0}
                      placeholder="New album name"
                      style={{ flex: 1 }}
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && createAndAdd()}
                    />
                    <button className="primary" disabled={!newName.trim()} onClick={createAndAdd}>
                      Create &amp; add
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
        </Portal>
      )}
    </>
  );
}
