import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, type Person } from "../api/client";
import AddAllToAlbum from "../components/AddAllToAlbum";
import { IconPencil } from "../components/Icons";
import TimelineGrid from "../components/TimelineGrid";

export default function PersonPage() {
  const { id } = useParams();
  const personId = Number(id);
  const qc = useQueryClient();
  const nav = useNavigate();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");
  const [merging, setMerging] = useState(false);
  const [soloOnly, setSoloOnly] = useState(false);
  const filters = { person_id: personId, solo: soloOnly || undefined };

  const { data: person } = useQuery({
    queryKey: ["person", personId],
    queryFn: () => api.get<Person>(`/api/people/${personId}`),
  });
  const { data: allPeople } = useQuery({
    queryKey: ["people"],
    queryFn: () => api.get<Person[]>("/api/people"),
    enabled: merging,
  });

  const rename = useMutation({
    mutationFn: (newName: string) => api.patch(`/api/people/${personId}`, { name: newName }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["person", personId] });
      qc.invalidateQueries({ queryKey: ["people"] });
      setRenaming(false);
    },
  });
  // Hiding without invalidating left the person visibly still there on the
  // page we navigate to — react-query served the cached list. That is what
  // made this look broken.
  const setHidden = useMutation({
    mutationFn: (hidden: boolean) => api.patch(`/api/people/${personId}`, { is_hidden: hidden }),
    onSuccess: (_d, hidden) => {
      qc.invalidateQueries({ queryKey: ["people"] });
      qc.invalidateQueries({ queryKey: ["person", personId] });
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

  if (!person) return <div className="page empty">Loading…</div>;
  return (
    <div className="page">
      <header className="page-head">
        <div className="row" style={{ gap: 16 }}>
          {person.cover_face_id && (
            <img
              src={`/api/faces/${person.cover_face_id}/thumb`}
              style={{
                width: 72,
                height: 72,
                borderRadius: "50%",
                objectFit: "cover",
                border: "2px solid rgba(255,255,255,0.2)",
                boxShadow: "0 8px 24px rgba(2,4,10,0.5), 0 0 20px rgba(110,123,255,0.25)",
              }}
              alt=""
            />
          )}
          {renaming ? (
            <div className="row">
              <input
                type="text"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && rename.mutate(name)}
                placeholder="Name"
              />
              <button className="primary" onClick={() => rename.mutate(name)}>
                Save
              </button>
              <button className="ghost" onClick={() => setRenaming(false)}>Cancel</button>
            </div>
          ) : (
            <div>
              {/* the name IS the rename control — clicking it is the obvious
                  gesture, and the pencil makes that discoverable */}
              <button
                className={`name-edit${person.name ? "" : " unnamed"}`}
                title={person.name ? "Rename this person" : "Give this person a name"}
                onClick={() => {
                  setName(person.name ?? "");
                  setRenaming(true);
                }}
              >
                <h1>{person.name ?? "Unnamed person"}</h1>
                <span className="pencil">
                  <IconPencil size={17} />
                </span>
              </button>
              {person.photo_count != null && <p className="sub">{person.photo_count} photos</p>}
            </div>
          )}
        </div>
        {!renaming && (
          <div className="actions">
            <div className="seg" title="Show every photo, or only ones where this person appears alone">
              <button className={soloOnly ? "" : "on"} onClick={() => setSoloOnly(false)}>
                All photos
              </button>
              <button className={soloOnly ? "on" : ""} onClick={() => setSoloOnly(true)}>
                Solo
              </button>
            </div>
            <AddAllToAlbum filters={filters} />
            <button onClick={() => setMerging((m) => !m)}>Merge into…</button>
            {person.is_hidden ? (
              <button
                className="primary"
                title="Show this person in People again"
                onClick={() => setHidden.mutate(false)}
              >
                Unhide this person
              </button>
            ) : (
              <button
                className="danger"
                title="Remove this person from the People page. No photos are deleted, and you can unhide them later."
                onClick={() => setHidden.mutate(true)}
              >
                Hide this person
              </button>
            )}
          </div>
        )}
      </header>
      {merging && (
        <div className="row" style={{ marginBottom: 16 }}>
          <span className="muted small">Merge into:</span>
          {(allPeople ?? [])
            .filter((p) => p.id !== personId)
            .map((p) => (
              <button key={p.id} onClick={() => merge.mutate(p.id)}>
                {p.name ?? `Person ${p.id}`}
              </button>
            ))}
        </div>
      )}
      <TimelineGrid
        filters={filters}
        emptyText={soloOnly ? "No solo photos of this person" : "No photos of this person"}
      />
    </div>
  );
}
