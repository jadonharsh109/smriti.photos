import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, fetchAllItems, type Person } from "../api/client";
import CoverPicker from "../components/CoverPicker";
import DayGrid from "../components/DayGrid";
import { TextDialog } from "../components/Dialogs";
import { IconMore, IconPencil } from "../components/Icons";
import Portal from "../components/Portal";
import { faceUrl } from "../lib/images";
import { actions } from "../shell/actions";
import { openContextMenu } from "../shell/ContextMenu";
import { GridControls, StandardSelection } from "../shell/GridToolbar";
import { Segmented, TbButton, Toolbar } from "../shell/Toolbar";

export default function PersonPage() {
  const { id } = useParams();
  const personId = Number(id);
  const qc = useQueryClient();
  const nav = useNavigate();
  const [renaming, setRenaming] = useState(false);
  const [merging, setMerging] = useState(false);
  const [pickingCover, setPickingCover] = useState(false);
  const [solo, setSolo] = useState<"all" | "solo">("all");
  const filters = { person_id: personId, solo: solo === "solo" || undefined };

  const { data: person } = useQuery({ queryKey: ["person", personId], queryFn: () => api.get<Person>(`/api/people/${personId}`) });

  const rename = useMutation({
    mutationFn: (name: string) => api.patch(`/api/people/${personId}`, { name }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["person", personId] });
      qc.invalidateQueries({ queryKey: ["people"] });
      setRenaming(false);
    },
  });
  const setHidden = useMutation({
    mutationFn: (hidden: boolean) => api.patch(`/api/people/${personId}`, { is_hidden: hidden }),
    onSuccess: (_d, hidden) => {
      qc.invalidateQueries({ queryKey: ["people"] });
      qc.invalidateQueries({ queryKey: ["person", personId] });
      qc.invalidateQueries({ queryKey: ["stats"] });
      if (hidden) nav("/people");
    },
  });
  const merge = useMutation({
    mutationFn: (toId: number) => api.post("/api/people/merge", { from_id: personId, to_id: toId }),
    onSuccess: (_d, toId) => {
      qc.invalidateQueries();
      nav(`/people/${toId}`);
    },
  });

  const addAll = async () => {
    const items = await fetchAllItems(filters);
    actions.addToAlbum(items.map((i) => i.id));
  };

  const more = (e: React.MouseEvent) => {
    if (!person) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openContextMenu({ clientX: r.right - 200, clientY: r.bottom + 4, preventDefault: () => {} }, [
      { label: person.name ? "Rename…" : "Name This Person…", onSelect: () => setRenaming(true) },
      { label: "Choose Photo…", disabled: !person.cover_face_id, onSelect: () => setPickingCover(true) },
      { label: "Merge Into…", onSelect: () => setMerging(true) },
      { label: "Add All to Album…", onSelect: addAll },
      "sep",
      person.is_hidden
        ? { label: "Unhide This Person", onSelect: () => setHidden.mutate(false) }
        : { label: "Hide This Person", danger: true, onSelect: () => setHidden.mutate(true) },
    ]);
  };

  const title = person ? (
    <span className="row" style={{ gap: 8 }}>
      {person.cover_face_id && (
        <button title="Choose a different photo" onClick={() => setPickingCover(true)} style={{ display: "inline-flex" }}>
          <img src={faceUrl(person.cover_face_id)} alt="" style={{ width: 22, height: 22, borderRadius: "50%", objectFit: "cover", background: "var(--tile-bg)" }} />
        </button>
      )}
      <button
        className="row"
        style={{ gap: 5, fontWeight: 600, fontSize: 13, color: person.name ? "var(--ink)" : "var(--muted)", fontStyle: person.name ? undefined : "italic" }}
        title={person.name ? "Rename this person" : "Give this person a name"}
        onClick={() => setRenaming(true)}
      >
        {person.name ?? "Unnamed person"}
        <span style={{ color: "var(--faint)", display: "inline-flex" }}><IconPencil size={12} /></span>
      </button>
    </span>
  ) : "";

  return (
    <>
      <Toolbar back="/people" title={title} count={person ? `${person.photo_count.toLocaleString()} ${person.photo_count === 1 ? "photo" : "photos"}${person.is_hidden ? " · hidden" : ""}` : null}>
        <StandardSelection />
        <Segmented value={solo} options={[{ value: "all", label: "All" }, { value: "solo", label: "Solo" }]} onChange={setSolo} />
        <TbButton icon={<IconMore size={14} />} title="More" onClick={more} />
        <GridControls />
      </Toolbar>
      <DayGrid filters={filters} emptyText={solo === "solo" ? "No photos of this person alone" : "No photos of this person"} />
      {renaming && person && (
        <TextDialog title={person.name ? "Rename" : "Name this person"} initial={person.name ?? ""} placeholder="Name" submitLabel="Save" onSubmit={(n) => rename.mutate(n)} onClose={() => setRenaming(false)} />
      )}
      {pickingCover && person && <CoverPicker person={person} onClose={() => setPickingCover(false)} />}
      {merging && person && <MergeSheet from={person} onPick={(toId) => merge.mutate(toId)} onClose={() => setMerging(false)} />}
    </>
  );
}

/** Which person this one is really the same as. */
function MergeSheet({ from, onPick, onClose }: { from: Person; onPick: (toId: number) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const { data: people } = useQuery({ queryKey: ["people", false], queryFn: () => api.get<Person[]>("/api/people") });
  const needle = q.trim().toLowerCase();
  const list = (people ?? []).filter((p) => p.id !== from.id && (!needle || (p.name ?? "").toLowerCase().includes(needle)));
  return (
    <Portal>
      <div className="scrim" onClick={onClose}>
        <div className="sheet" role="dialog" onClick={(e) => e.stopPropagation()}>
          <header>Merge {from.name ?? "this person"} into…</header>
          <div className="sbody">
            <p>Their photos join the person you pick, and this entry goes away. Choose the one whose name should survive.</p>
            <input className="input" autoFocus placeholder="Search people" value={q} onChange={(e) => setQ(e.target.value)} />
            <div className="album-list">
              {list.map((p) => (
                <button key={p.id} className="album-row" onClick={() => onPick(p.id)}>
                  {p.cover_face_id ? <img src={faceUrl(p.cover_face_id)} alt="" style={{ borderRadius: "50%" }} /> : <span className="ph" />}
                  <span className="nm">{p.name ?? `Person ${p.id}`}</span>
                  <span className="ct num">{p.photo_count.toLocaleString()}</span>
                </button>
              ))}
              {list.length === 0 && <p style={{ padding: 8 }}>No one else to merge into.</p>}
            </div>
          </div>
          <div className="sfoot">
            <button className="btn" onClick={onClose}>Cancel</button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
