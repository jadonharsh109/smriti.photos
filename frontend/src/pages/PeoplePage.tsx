import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api, cardDelay, type Person } from "../api/client";
import { ArtPeople } from "../components/Illustrations";

export default function PeoplePage() {
  const [showHidden, setShowHidden] = useState(false);
  const qc = useQueryClient();
  const { data: people } = useQuery({
    queryKey: ["people", showHidden],
    queryFn: () => api.get<Person[]>(`/api/people${showHidden ? "?include_hidden=true" : ""}`),
  });
  const { data: stats } = useQuery({
    queryKey: ["stats"],
    queryFn: () =>
      api.get<{ faces: number; people_visible: number; face_pending: number; face_model_ready: boolean }>(
        "/api/stats"
      ),
  });

  const scan = useMutation({
    mutationFn: () => api.post("/api/faces/scan"),
    onSettled: () => qc.invalidateQueries({ queryKey: ["stats"] }),
  });
  const cluster = useMutation({
    mutationFn: () => api.post("/api/faces/recluster"),
    onSettled: () => qc.invalidateQueries(),
  });
  const unhide = useMutation({
    mutationFn: (pid: number) => api.patch(`/api/people/${pid}`, { is_hidden: false }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["people"] }),
  });
  const getModels = useMutation({
    mutationFn: () => api.post("/api/models/download"),
    onSettled: () => qc.invalidateQueries({ queryKey: ["stats"] }),
  });

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>People</h1>
          {/* People, not faces. A face count is an internal detail — it can read
              in the thousands while this page is empty, because a face only
              becomes a person once several of them match. */}
          <p className="sub">
            {(stats?.people_visible ?? 0) > 0
              ? `${stats!.people_visible.toLocaleString()} ${stats!.people_visible === 1 ? "person" : "people"}`
              : "No one grouped yet"}
            {stats && stats.face_pending > 0
              ? ` · ${stats.face_pending.toLocaleString()} photos still to check`
              : ""}
          </p>
        </div>
        <div className="actions">
          {/* Hidden people are still in the library. Without a way back this
              action was one-way and unreachable, which is most of why it read
              as broken. */}
          <button
            className={showHidden ? "on" : ""}
            title="Show people you've hidden, so you can bring one back"
            onClick={() => setShowHidden((v) => !v)}
          >
            {showHidden ? "Hide hidden" : "Show hidden"}
          </button>
          {stats?.face_model_ready === false ? (
            <button className="primary" onClick={() => getModels.mutate()} disabled={getModels.isPending}>
              Download face models (≈280 MB)
            </button>
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
          {/* "Scan for faces, then group them" is the wrong thing to say to
              someone who has already done both — which is the common case when
              a small library finds a few faces that never cluster. Say what is
              actually true of their library instead. */}
          {stats?.face_model_ready === false ? (
            <p>
              People needs the face-recognition models first — about 280 MB, downloaded once.
              Everything then runs on this machine.
            </p>
          ) : (stats?.faces ?? 0) === 0 ? (
            <p>
              {(stats?.face_pending ?? 0) > 0
                ? "Your photos haven't been checked for faces yet — press Scan for faces."
                : "No one found in your photos yet."}
            </p>
          ) : (
            <p>
              Smriti has found people in your photos, but not yet enough of the same person to
              group anyone. It waits until someone appears in several photos before calling
              them a person — add more photos, or press Group into people to try again.
              {(stats?.face_pending ?? 0) > 0
                ? ` ${stats!.face_pending.toLocaleString()} photos still to check.`
                : ""}
            </p>
          )}
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
                <div className="sub">
                  {p.photo_count} photos{p.is_hidden ? " · hidden" : ""}
                </div>
                {p.is_hidden ? (
                  <button
                    className="small"
                    style={{ marginTop: 8 }}
                    onClick={(e) => {
                      e.preventDefault();   // the whole card is a Link
                      e.stopPropagation();
                      unhide.mutate(p.id);
                    }}
                  >
                    Unhide
                  </button>
                ) : null}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
