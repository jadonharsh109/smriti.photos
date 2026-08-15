import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api/client";
import { ConfirmDialog, TextDialog } from "./Dialogs";
import Portal from "./Portal";

interface Album {
  id: number;
  name: string;
  count: number;
}

interface Props {
  selected: Set<number>;
  onClear: () => void;
  onSelectAll?: () => void;
  extraActions?: React.ReactNode;
}

export default function SelectionBar({ selected, onClear, onSelectAll, extraActions }: Props) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [naming, setNaming] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const qc = useQueryClient();
  const { data: albums } = useQuery({
    queryKey: ["albums"],
    queryFn: () => api.get<Album[]>("/api/albums"),
    enabled: pickerOpen,
  });

  if (selected.size === 0) return null;

  const addTo = async (albumId: number) => {
    await api.post(`/api/albums/${albumId}/items`, { file_ids: [...selected] });
    qc.invalidateQueries({ queryKey: ["albums"] });
    qc.invalidateQueries({ queryKey: ["album"] });
    setPickerOpen(false);
    onClear();
  };

  const createAndAdd = async (name: string) => {
    const r = await api.post<{ id: number }>("/api/albums", { name });
    setNaming(false);
    await addTo(r.id);
  };

  const moveToTrash = async () => {
    await api.post("/api/files/delete", { file_ids: [...selected] });
    qc.invalidateQueries();
    onClear();
  };

  return (
    <>
      <Portal>
      <div className="selbar">
        <strong>{selected.size} selected</strong>
        {onSelectAll && <button onClick={onSelectAll}>Select all</button>}
        <button onClick={() => setPickerOpen((o) => !o)}>Add to album</button>
        {pickerOpen && (
          <div className="album-picks">
            {(albums ?? []).map((a) => (
              <button key={a.id} onClick={() => addTo(a.id)}>
                {a.name}
              </button>
            ))}
            <button className="primary" onClick={() => setNaming(true)}>
              + New
            </button>
          </div>
        )}
        {extraActions}
        <button className="danger" onClick={() => setConfirmingDelete(true)}>
          Delete
        </button>
        <button className="ghost" onClick={onClear}>
          Clear
        </button>
      </div>
      </Portal>
      {confirmingDelete && (
        <ConfirmDialog
          title={`Move ${selected.size} ${selected.size === 1 ? "item" : "items"} to Trash?`}
          body="Originals go to the macOS Trash (recoverable there) and disappear from the library. Items on offline drives are skipped."
          confirmLabel="Move to Trash"
          danger
          onConfirm={moveToTrash}
          onClose={() => setConfirmingDelete(false)}
        />
      )}
      {naming && (
        <TextDialog
          title="New album"
          placeholder="Album name"
          submitLabel="Create & add"
          onSubmit={createAndAdd}
          onClose={() => setNaming(false)}
        />
      )}
    </>
  );
}
