import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { useLocked } from "../locked/LockedContext";
import { ConfirmDialog, PasswordDialog, TextDialog } from "./Dialogs";
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
  const [lockedStep, setLockedStep] = useState<"pin" | "confirm" | null>(null);
  const [lockedMsg, setLockedMsg] = useState<string | null>(null);
  const lockedApi = useLocked();
  const navigate = useNavigate();
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

  const startMoveToLocked = async () => {
    setLockedMsg(null);
    try {
      const s = await api.get<{ configured: boolean }>("/api/locked/status");
      if (!s.configured) {
        navigate("/locked"); // first-time setup lives on the Locked page
        return;
      }
      setLockedStep(lockedApi.token ? "confirm" : "pin");
    } catch (e) {
      setLockedMsg(String((e as Error).message ?? e));
    }
  };

  const moveToLocked = async () => {
    try {
      const r = await lockedApi.authedJson<{ locked: number; skipped_offline: number; errors: unknown[] }>(
        "POST", "/api/locked/move-in", { file_ids: [...selected] });
      let msg = `${r.locked} moved to Locked Folder`;
      if (r.skipped_offline) msg += ` · ${r.skipped_offline} skipped (drive offline)`;
      if (r.errors.length) msg += ` · ${r.errors.length} failed`;
      setLockedMsg(msg);
      qc.invalidateQueries();
      onClear();
    } catch (e) {
      setLockedMsg(String((e as Error).message ?? e));
    }
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
        <button onClick={startMoveToLocked}>Move to Locked</button>
        <button className="danger" onClick={() => setConfirmingDelete(true)}>
          Delete
        </button>
        <button className="ghost" onClick={onClear}>
          Clear
        </button>
        {lockedMsg && <span className="muted small">{lockedMsg}</span>}
      </div>
      </Portal>
      {lockedStep === "pin" && (
        <PasswordDialog
          title="Unlock Locked Folder"
          body="Moving photos into the Locked Folder needs it unlocked first."
          onSubmit={async (pin) => {
            setLockedStep(null);
            try {
              await lockedApi.unlockPin(pin);
              setLockedStep("confirm");
            } catch (e) {
              setLockedMsg(String((e as Error).message ?? e));
            }
          }}
          onClose={() => setLockedStep(null)}
        />
      )}
      {lockedStep === "confirm" && (
        <ConfirmDialog
          title={`Move ${selected.size} ${selected.size === 1 ? "item" : "items"} to Locked Folder?`}
          body="Originals are encrypted and moved out of your photo folders immediately — not to the Trash — and removed from albums, events and people. Items on offline drives are skipped."
          confirmLabel="Move to Locked"
          onConfirm={moveToLocked}
          onClose={() => setLockedStep(null)}
        />
      )}
      {confirmingDelete && (
        <ConfirmDialog
          title={`Move ${selected.size} ${selected.size === 1 ? "item" : "items"} to Trash?`}
          body="Originals go to the system Trash (recoverable there) and disappear from the library. Items on offline drives are skipped."
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
