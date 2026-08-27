import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  createMoment,
  deleteMoment,
  fmtBytes,
  listMoments,
  momentMusic,
  momentSuggestions,
  remakeMoment,
  type Moment,
} from "../api/client";
import { ConfirmDialog } from "../components/Dialogs";
import { IconClose, IconFilm, IconPlay, IconTrash } from "../components/Icons";
import { ArtEvents } from "../components/Illustrations";
import Portal from "../components/Portal";

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

/** The player. A plain <video> — the server answers byte ranges, so seeking
 *  works without anything clever on this side. */
function Player({ moment, onClose }: { moment: Moment; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <Portal>
      <div className="modal-back" onClick={onClose}>
        <div className="moment-player" onClick={(e) => e.stopPropagation()}>
          <header>
            <div>
              <strong>{moment.title}</strong>
              {moment.subtitle && <span className="muted small"> · {moment.subtitle}</span>}
            </div>
            <button className="icon-btn" style={{ width: 30, height: 30 }} onClick={onClose}>
              <IconClose size={15} />
            </button>
          </header>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video src={`/api/moments/${moment.id}/video`} controls autoPlay playsInline />
          <footer>
            <span className="muted small">
              {moment.item_count} photos · {moment.duration_s ? mmss(moment.duration_s) : "—"}
              {moment.bytes ? ` · ${fmtBytes(moment.bytes)}` : ""}
            </span>
            <a className="ghost small" href={`/api/moments/${moment.id}/video`} download>
              Save the video
            </a>
          </footer>
        </div>
      </div>
    </Portal>
  );
}

export default function MomentsPage() {
  const qc = useQueryClient();
  const [playing, setPlaying] = useState<Moment | null>(null);
  const [confirming, setConfirming] = useState<Moment | null>(null);
  const [track, setTrack] = useState<string>("");

  const { data: moments } = useQuery({
    queryKey: ["moments"],
    queryFn: listMoments,
    // one is being made; the row changes under us when it finishes
    refetchInterval: (q) =>
      (q.state.data ?? []).some((m) => m.status === "rendering" || m.status === "pending") ? 2000 : false,
  });
  const { data: suggestions } = useQuery({ queryKey: ["moment-suggestions"], queryFn: momentSuggestions });
  const { data: music } = useQuery({ queryKey: ["moment-music"], queryFn: momentMusic });

  const make = useMutation({
    mutationFn: ({ kind, ref }: { kind: string; ref: string }) =>
      createMoment(kind, ref, track || null),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["moments"] });
      qc.invalidateQueries({ queryKey: ["moment-suggestions"] });
    },
  });
  const again = useMutation({
    mutationFn: (id: number) => remakeMoment(id, track || null),
    onSettled: () => qc.invalidateQueries({ queryKey: ["moments"] }),
  });
  const remove = useMutation({
    mutationFn: (id: number) => deleteMoment(id),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["moments"] });
      qc.invalidateQueries({ queryKey: ["moment-suggestions"] });
    },
  });

  const made = moments ?? [];
  const toMake = (suggestions ?? []).filter((s) => !s.already);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Moments</h1>
          <p className="sub">
            {made.length > 0
              ? `${made.length} ${made.length === 1 ? "moment" : "moments"}`
              : "Your photos, in order, set to music"}
          </p>
        </div>
        {(music?.tracks.length ?? 0) > 0 && (
          <div className="actions">
            <label className="muted small" htmlFor="mtrack">Music</label>
            <select id="mtrack" value={track} onChange={(e) => setTrack(e.target.value)}>
              <option value="">Pick one for me</option>
              {music!.tracks.map((t) => (
                <option key={t.file} value={t.file}>{t.title}</option>
              ))}
            </select>
          </div>
        )}
      </header>

      {make.error && (
        <p className="sub" style={{ color: "var(--danger)" }}>{String((make.error as Error).message)}</p>
      )}

      {made.length === 0 && toMake.length === 0 ? (
        <div className="empty">
          <ArtEvents className="art" />
          <p>
            A moment is made from photos Smriti already knows belong together — a trip, a day out.
            None of your events have enough photos in them yet.
          </p>
        </div>
      ) : null}

      {made.length > 0 && (
        <div className="moment-grid">
          {made.map((m) => (
            <div key={m.id} className={`moment-card${m.status === "failed" ? " failed" : ""}`}>
              <button
                className="shot"
                disabled={!m.playable}
                onClick={() => m.playable && setPlaying(m)}
                title={m.playable ? `Play ${m.title}` : undefined}
              >
                {m.cover_file_id ? (
                  <img src={`/api/thumb/${m.cover_file_id}`} alt="" loading="lazy" />
                ) : (
                  <span className="ph"><IconFilm size={26} /></span>
                )}
                {m.status === "ready" && m.playable && (
                  <span className="play"><IconPlay size={22} /></span>
                )}
                {(m.status === "rendering" || m.status === "pending") && (
                  <span className="working"><span className="spin" /></span>
                )}
                {m.duration_s && m.status === "ready" && (
                  <span className="dur">{mmss(m.duration_s)}</span>
                )}
              </button>
              <div className="meta">
                <div className="name">{m.title}</div>
                <div className="sub">
                  {m.status === "failed"
                    ? m.error || "Couldn’t be made"
                    : m.status === "ready"
                    ? `${m.item_count} photos`
                    : "Making it…"}
                </div>
                <div className="row" style={{ gap: 6, marginTop: 8 }}>
                  <button
                    className="small"
                    disabled={again.isPending || m.status === "rendering"}
                    title="Make it again — a different pick of photos, or the music you chose above"
                    onClick={() => again.mutate(m.id)}
                  >
                    Make again
                  </button>
                  <button className="small" title="Delete" onClick={() => setConfirming(m)}>
                    <IconTrash size={14} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {toMake.length > 0 && (
        <>
          <h2 className="sec-head">Worth making one of</h2>
          <div className="moment-grid">
            {toMake.map((s) => (
              <div key={`${s.kind}-${s.ref}`} className="moment-card suggestion">
                <button
                  className="shot"
                  disabled={make.isPending}
                  onClick={() => make.mutate({ kind: s.kind, ref: s.ref })}
                  title={`Make a moment from ${s.title}`}
                >
                  {s.cover_file_id ? (
                    <img src={`/api/thumb/${s.cover_file_id}`} alt="" loading="lazy" />
                  ) : (
                    <span className="ph"><IconFilm size={26} /></span>
                  )}
                  <span className="play"><IconPlay size={22} /></span>
                </button>
                <div className="meta">
                  <div className="name">{s.title}</div>
                  <div className="sub">{s.count} photos</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {playing && <Player moment={playing} onClose={() => setPlaying(null)} />}
      {confirming && (
        <ConfirmDialog
          title={`Delete “${confirming.title}”?`}
          body="The video goes; your photos are untouched, and you can make it again whenever."
          confirmLabel="Delete"
          danger
          onConfirm={() => {
            remove.mutate(confirming.id);
            setConfirming(null);
          }}
          onClose={() => setConfirming(null)}
        />
      )}
    </div>
  );
}
