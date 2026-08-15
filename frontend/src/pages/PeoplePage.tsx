import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, cardDelay, type Person } from "../api/client";
import { ArtPeople } from "../components/Illustrations";

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
            <Link key={p.id} to={`/people/${p.id}`} className="card" style={cardDelay(i)}>
              <div className="face-wrap">
                {p.cover_face_id ? (
                  <img className="face-cover" src={`/api/faces/${p.cover_face_id}/thumb`} alt="" />
                ) : (
                  <div className="face-cover" />
                )}
              </div>
              <div className="meta" style={{ textAlign: "center" }}>
                <div className="name">{p.name ?? "Add a name"}</div>
                <div className="sub">{p.photo_count} photos</div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
