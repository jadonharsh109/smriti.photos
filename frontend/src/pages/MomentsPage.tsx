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
import { IconClose, IconFilm, IconPlay } from "../components/Icons";
import Portal from "../components/Portal";
import { thumbUrl } from "../lib/images";
import { openContextMenu } from "../shell/ContextMenu";
import { Toolbar } from "../shell/Toolbar";

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

/** A plain <video> — the server answers byte ranges, so seeking just works. */
function Player({ moment, onClose }: { moment: Moment; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <Portal>
      <div className="scrim" onClick={onClose}>
        <div className="moment-player" onClick={(e) => e.stopPropagation()}>
          <header>
            <strong>{moment.title}</strong>
            {moment.subtitle && <span className="muted small">{moment.subtitle}</span>}
            <span className="grow" />
            <button className="iconbtn" onClick={onClose} style={{ color: "inherit" }}><IconClose size={15} /></button>
          </header>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video src={`/api/moments/${moment.id}/video`} controls autoPlay playsInline />
          <footer>
            <span className="muted small num">
              {moment.item_count} photos · {moment.duration_s ? mmss(moment.duration_s) : "—"}
              {moment.bytes ? ` · ${fmtBytes(moment.bytes)}` : ""}
            </span>
            <span className="grow" />
            <a className="btn small" href={`/api/moments/${moment.id}/video`} download>Save the Video</a>
          </footer>
        </div>
      </div>
    </Portal>
  );
}

interface Choosing {
  title: string;
  kind?: string;
  ref?: string;
  remakeId?: number;
  current?: string | null;
}

export default function MomentsPage() {
  const qc = useQueryClient();
  const [playing, setPlaying] = useState<Moment | null>(null);
  const [confirming, setConfirming] = useState<Moment | null>(null);
  const [choosing, setChoosing] = useState<Choosing | null>(null);
  const [track, setTrack] = useState<string>("");

  const { data: moments } = useQuery({
    queryKey: ["moments"],
    queryFn: listMoments,
    refetchInterval: (q) => ((q.state.data ?? []).some((m) => m.status === "rendering" || m.status === "pending") ? 2000 : false),
  });
  const { data: suggestions } = useQuery({ queryKey: ["moment-suggestions"], queryFn: momentSuggestions });
  const { data: music } = useQuery({ queryKey: ["moment-music"], queryFn: momentMusic });

  const done = () => {
    qc.invalidateQueries({ queryKey: ["moments"] });
    qc.invalidateQueries({ queryKey: ["moment-suggestions"] });
  };
  const make = useMutation({ mutationFn: ({ kind, ref, music }: { kind: string; ref: string; music: string | null }) => createMoment(kind, ref, music), onSettled: done });
  const again = useMutation({ mutationFn: ({ id, music }: { id: number; music: string | null }) => remakeMoment(id, music), onSettled: done });
  const remove = useMutation({ mutationFn: (id: number) => deleteMoment(id), onSettled: done });

  const made = moments ?? [];
  const toMake = (suggestions ?? []).filter((s) => !s.already);

  return (
    <>
      <Toolbar title="Moments" count={made.length ? `${made.length} ${made.length === 1 ? "moment" : "moments"}` : null} />
      {make.error ? <p className="note bad" style={{ padding: "8px 12px 0" }}>{String((make.error as Error).message)}</p> : null}
      {made.length === 0 && toMake.length === 0 ? (
        <div className="empty">
          <h2>Nothing to make a moment of yet</h2>
          <p>A moment is a short film cut from photos Smriti already knows belong together — a trip, a day out — set to music. None of your events have enough photos in them yet.</p>
        </div>
      ) : (
        <div className="page">
          {made.length > 0 && (
            <div className="cards wide">
              {made.map((m) => (
                <div
                  key={m.id}
                  className="card moment-card"
                  onContextMenu={(e) =>
                    openContextMenu(e, [
                      { label: "Play", disabled: !m.playable, onSelect: () => setPlaying(m) },
                      { label: "Make Again…", disabled: m.status === "rendering", onSelect: () => { setTrack(m.track ?? ""); setChoosing({ title: m.title, remakeId: m.id, current: m.track }); } },
                      "sep",
                      { label: "Delete", danger: true, onSelect: () => setConfirming(m) },
                    ])
                  }
                >
                  <button className="shot" disabled={!m.playable} onClick={() => m.playable && setPlaying(m)} title={m.playable ? `Play ${m.title}` : undefined}>
                    {m.cover_file_id ? <img src={thumbUrl(m.cover_file_id)} alt="" loading="lazy" /> : <span className="ph"><IconFilm size={26} /></span>}
                    {m.status === "ready" && m.playable && <span className="play"><IconPlay size={22} /></span>}
                    {(m.status === "rendering" || m.status === "pending") && <span className="working">Making it…</span>}
                    {m.duration_s && m.status === "ready" ? <span className="dur num">{mmss(m.duration_s)}</span> : null}
                  </button>
                  <div className="meta">
                    <div className="name">{m.title}</div>
                    <div className="sub">{m.status === "failed" ? m.error || "Couldn’t be made" : m.status === "ready" ? `${m.item_count} photos` : "Making it…"}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
          {toMake.length > 0 && (
            <>
              <h2 className="sec-h">Worth making one of</h2>
              <div className="cards wide">
                {toMake.map((s) => (
                  <div key={`${s.kind}-${s.ref}`} className="card moment-card">
                    <button className="shot" disabled={make.isPending} onClick={() => { setTrack(""); setChoosing({ title: s.title, kind: s.kind, ref: s.ref }); }} title={`Make a moment from ${s.title}`}>
                      {s.cover_file_id ? <img src={thumbUrl(s.cover_file_id)} alt="" loading="lazy" /> : <span className="ph"><IconFilm size={26} /></span>}
                      <span className="play"><IconPlay size={22} /></span>
                    </button>
                    <div className="meta">
                      <div className="name">{s.title}</div>
                      <div className="sub num">{s.count} photos</div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {choosing && (
        <Portal>
          <div className="scrim" onClick={() => setChoosing(null)}>
            <div className="sheet" onClick={(e) => e.stopPropagation()}>
              <header>{choosing.remakeId ? `Make “${choosing.title}” again` : `A moment of ${choosing.title}`}</header>
              <div className="sbody">
                <p>What should it sound like?</p>
                <div className="list" style={{ padding: 4 }}>
                  <button className={`track-row${track === "" ? " on" : ""}`} onClick={() => setTrack("")}>
                    <span className="nm">Pick one for me</span>
                  </button>
                  {(music?.tracks ?? []).map((t) => (
                    <button key={t.file} className={`track-row${track === t.file ? " on" : ""}`} onClick={() => setTrack(t.file)}>
                      <span className="nm">{t.title}</span>
                      <span className="ct num">{mmss(t.seconds)}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="sfoot">
                <button className="btn" onClick={() => setChoosing(null)}>Cancel</button>
                <button
                  className="btn primary"
                  disabled={make.isPending || again.isPending}
                  onClick={() => {
                    const m = track || null;
                    if (choosing.remakeId) again.mutate({ id: choosing.remakeId, music: m });
                    else make.mutate({ kind: choosing.kind!, ref: choosing.ref!, music: m });
                    setChoosing(null);
                  }}
                >
                  Make It
                </button>
              </div>
            </div>
          </div>
        </Portal>
      )}
      {playing && <Player moment={playing} onClose={() => setPlaying(null)} />}
      {confirming && (
        <ConfirmDialog
          title={`Delete “${confirming.title}”?`}
          body="The video goes; your photos are untouched, and you can make it again whenever."
          confirmLabel="Delete"
          danger
          onConfirm={() => remove.mutate(confirming.id)}
          onClose={() => setConfirming(null)}
        />
      )}
    </>
  );
}
