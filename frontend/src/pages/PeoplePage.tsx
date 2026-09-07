import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Person } from "../api/client";
import { IconEyeOff, IconMore } from "../components/Icons";
import { faceUrl } from "../lib/images";
import { openContextMenu } from "../shell/ContextMenu";
import { jobs, openPrefs, runningJob } from "../shell/store";
import { TbButton, Toolbar, ToolbarSearch } from "../shell/Toolbar";

interface Stats {
  faces: number;
  people_visible: number;
  face_pending: number;
  face_model_ready: boolean;
}

export default function PeoplePage() {
  const [showHidden, setShowHidden] = useState(false);
  const [query, setQuery] = useState("");
  const qc = useQueryClient();
  const { data: people, isLoading } = useQuery({
    queryKey: ["people", showHidden],
    queryFn: () => api.get<Person[]>(`/api/people${showHidden ? "?include_hidden=true" : ""}`),
  });
  const { data: stats } = useQuery({ queryKey: ["stats"], queryFn: () => api.get<Stats>("/api/stats") });
  const running = runningJob(jobs.use((s) => s.byId));

  const run = useMutation({ mutationFn: (url: string) => api.post(url), onSettled: () => qc.invalidateQueries({ queryKey: ["stats"] }) });
  const setHidden = useMutation({
    mutationFn: ({ id, hidden }: { id: number; hidden: boolean }) => api.patch(`/api/people/${id}`, { is_hidden: hidden }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["people"] });
      qc.invalidateQueries({ queryKey: ["stats"] });
    },
  });

  /** Names only: an unnamed cluster has nothing to match on. */
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return people ?? [];
    return (people ?? []).filter((p) => (p.name ?? "").toLowerCase().includes(needle));
  }, [people, query]);
  const searching = query.trim().length > 0;
  const n = stats?.people_visible ?? 0;

  const more = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openContextMenu({ clientX: r.right - 200, clientY: r.bottom + 4, preventDefault: () => {} }, [
      { label: "Scan for Faces", disabled: !!running || stats?.face_model_ready === false, onSelect: () => run.mutate("/api/faces/scan") },
      { label: "Group into People", disabled: !!running || stats?.face_model_ready === false, onSelect: () => run.mutate("/api/faces/recluster") },
      "sep",
      { label: "Indexing Preferences…", onSelect: () => openPrefs("indexing") },
    ]);
  };

  return (
    <>
      <Toolbar
        title="People"
        count={!stats ? null : `${n.toLocaleString()} ${n === 1 ? "person" : "people"}` + (stats.face_pending > 0 ? ` · ${stats.face_pending.toLocaleString()} ${stats.face_pending === 1 ? "photo" : "photos"} to check` : "")}
      >
        {(people ?? []).length > 0 && <ToolbarSearch value={query} onChange={setQuery} placeholder="Search people" hits={`${shown.length} of ${people!.length}`} />}
        <TbButton on={showHidden} icon={<IconEyeOff size={14} />} title={showHidden ? "Hide hidden people" : "Show hidden people"} onClick={() => setShowHidden((v) => !v)} />
        <TbButton icon={<IconMore size={14} />} title="More" onClick={more} />
      </Toolbar>
      {isLoading ? null : searching && shown.length === 0 ? (
        <div className="empty">
          <p>No one named “{query.trim()}”. People you haven’t named yet can’t be found by search — clear the box to see everyone.</p>
        </div>
      ) : (people ?? []).length === 0 ? (
        <div className="empty">
          {stats?.face_model_ready === false ? (
            <>
              <h2>People needs its models first</h2>
              <p>About 280 MB, downloaded once. Everything then runs on this machine.</p>
              <div className="row">
                <button className="btn primary" disabled={running?.kind === "models"} onClick={() => run.mutate("/api/models/download")}>
                  {running?.kind === "models" ? "Downloading…" : "Download Face Models"}
                </button>
              </div>
            </>
          ) : (stats?.faces ?? 0) === 0 ? (
            <>
              <p>{(stats?.face_pending ?? 0) > 0 ? "Your photos haven’t been checked for faces yet." : "No one found in your photos yet."}</p>
              {(stats?.face_pending ?? 0) > 0 && (
                <div className="row">
                  <button className="btn primary" disabled={!!running} onClick={() => run.mutate("/api/faces/scan")}>Scan for Faces</button>
                </div>
              )}
            </>
          ) : (
            <>
              <p>
                Smriti has found people in your photos, but not yet enough of the same person to group anyone. It waits until someone appears in several photos.
                {(stats?.face_pending ?? 0) > 0 ? ` ${stats!.face_pending.toLocaleString()} photos still to check.` : ""}
              </p>
              <div className="row">
                <button className="btn" disabled={!!running} onClick={() => run.mutate("/api/faces/recluster")}>Group into People</button>
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="page">
          <div className="cards">
            {shown.map((p) => (
              <Link
                key={p.id}
                to={`/people/${p.id}`}
                className="card person"
                style={{ "--card-h": "190px" } as React.CSSProperties}
                onContextMenu={(e) =>
                  openContextMenu(e, [
                    p.is_hidden
                      ? { label: "Unhide", onSelect: () => setHidden.mutate({ id: p.id, hidden: false }) }
                      : { label: "Hide This Person", onSelect: () => setHidden.mutate({ id: p.id, hidden: true }) },
                  ])
                }
              >
                {p.cover_face_id ? <img className="face" src={faceUrl(p.cover_face_id)} loading="lazy" decoding="async" alt="" /> : <div className="face" />}
                <div className="meta">
                  <div className={`name${p.name ? "" : " placeholder"}`}>{p.name ?? "Add a name"}</div>
                  <div className="sub num">
                    {p.photo_count.toLocaleString()} {p.photo_count === 1 ? "photo" : "photos"}
                    {p.is_hidden ? " · hidden" : ""}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
