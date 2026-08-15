import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api, cardDelay, type Person } from "../api/client";
import { ArtPeople } from "../components/Illustrations";

function PersonCard({ person, index }: { person: Person; index: number }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");

  const rename = useMutation({
    mutationFn: (newName: string) => api.patch(`/api/people/${person.id}`, { name: newName }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["people"] }),
  });

  const commit = () => {
    setEditing(false);
    if (name.trim() !== (person.name ?? "")) rename.mutate(name);
  };

  return (
    <Link
      to={`/people/${person.id}`}
      className="card"
      style={cardDelay(index)}
      onClick={(e) => editing && e.preventDefault()}
      draggable={false}
    >
      <div className="face-wrap">
        {person.cover_face_id ? (
          <img className="face-cover" src={`/api/faces/${person.cover_face_id}/thumb`} alt="" />
        ) : (
          <div className="face-cover" />
        )}
      </div>
      <div className="meta" style={{ textAlign: "center" }}>
        {editing ? (
          <input
            type="text"
            className="name-input"
            autoFocus
            value={name}
            placeholder="Name"
            onChange={(e) => setName(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") setEditing(false);
            }}
          />
        ) : (
          <div
            className="name editable"
            title="Click to rename"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setName(person.name ?? "");
              setEditing(true);
            }}
          >
            {person.name ?? "Add a name"}
          </div>
        )}
        <div className="sub">{person.photo_count} photos</div>
      </div>
    </Link>
  );
}

export default function PeoplePage() {
  const qc = useQueryClient();
  const { data: people } = useQuery({
    queryKey: ["people"],
    queryFn: () => api.get<Person[]>("/api/people"),
  });
  const { data: stats } = useQuery({
    queryKey: ["stats"],
    queryFn: () =>
      api.get<{ faces: number; face_pending: number; face_model_ready: boolean }>("/api/stats"),
  });

  const scan = useMutation({
    mutationFn: () => api.post("/api/faces/scan"),
    onSettled: () => qc.invalidateQueries({ queryKey: ["stats"] }),
  });
  const cluster = useMutation({
    mutationFn: () => api.post("/api/faces/recluster"),
    onSettled: () => qc.invalidateQueries(),
  });

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>People</h1>
          <p className="sub">
            {stats?.faces ?? 0} faces found
            {stats && stats.face_pending > 0 ? ` · ${stats.face_pending} photos not scanned yet` : ""}
          </p>
        </div>
        <div className="actions">
          {stats?.face_model_ready === false ? (
            <span className="chip">
              Face models missing — run <code>uv run python scripts/fetch_models.py</code>
            </span>
          ) : (
            <>
              <button onClick={() => scan.mutate()} disabled={scan.isPending}>
                Scan for faces
              </button>
              <button className="primary" onClick={() => cluster.mutate()} disabled={cluster.isPending}>
                Group into people
              </button>
            </>
          )}
        </div>
      </header>
      {scan.error && <p className="sub" style={{ color: "var(--danger)" }}>{String(scan.error)}</p>}
      {(people ?? []).length === 0 ? (
        <div className="empty">
          <ArtPeople className="art" />
          <p>No people yet — scan for faces, then group them. Everything runs on this machine.</p>
        </div>
      ) : (
        <div className="card-grid">
          {people!.map((p, i) => (
            <PersonCard key={p.id} person={p} index={i} />
          ))}
        </div>
      )}
    </div>
  );
}
