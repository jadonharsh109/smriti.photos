import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, canRevealFiles, fmtBytes, revealFile, type Item } from "../api/client";
import { ConfirmDialog } from "./Dialogs";
import {
  IconChevronL,
  IconChevronR,
  IconClose,
  IconDownload,
  IconFolderOpen,
  IconHeart,
  IconInfo,
  IconTrash,
} from "./Icons";
import PlaceInset from "./PlaceInset";
import Portal from "./Portal";
import { openInMaps } from "../lib/desktop";

interface Detail {
  id: number;
  filename: string;
  rel_path: string;
  size_bytes: number;
  media_type: string;
  /** 'missing' once a completed scan found the original gone from disk. The
   *  row and its thumbnail outlive the file, so it can still be looked at —
   *  but nothing that needs the original can be offered. */
  status: string;
  metadata: {
    taken_at: string | null;
    width: number | null;
    height: number | null;
    camera_make: string | null;
    camera_model: string | null;
    iso: number | null;
    f_number: number | null;
    exposure: string | null;
    focal_length: number | null;
    duration_s: number | null;
    video_codec: string | null;
    gps_lat: number | null;
    gps_lon: number | null;
  } | null;
  place: { city: string | null; state: string | null; country: string | null } | null;
  persons: { id: number; name: string | null }[];
  volume: { label: string; is_online: number } | null;
  /** the movie half, when this still is a Live Photo */
  motion_file_id: number | null;
}

interface Props {
  item: Item;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  /** Omit to leave the heart off — Locked has no use for it. */
  onToggleFav?: (id: number, on: boolean) => void;
  /** appended to media/detail URLs (e.g. the locked-section token) */
  qs?: string;
  /** Replaces "Move to Trash".
   *
   *  Cleanup's Missing list is the one place where the original is already
   *  gone: there is nothing left to send to the Trash, only a row to forget.
   *  Offering the usual Trash button there would promise something it cannot
   *  do, so that list hands its own action down instead. */
  deleteAction?: {
    icon?: React.ReactNode;
    tooltip: string;
    title: string;
    body: React.ReactNode;
    confirmLabel: string;
    run: () => Promise<void>;
  };
}

const ZOOM = 2.5;

export default function Lightbox({ item, onClose, onPrev, onNext, qs = "", onToggleFav, deleteAction }: Props) {
  const [showInfo, setShowInfo] = useState(false);
  // Held here as well as in the grid: the grid hands the viewer a snapshot of
  // the item, so without this the heart would not fill until the viewer was
  // closed and reopened. Re-seeded per photo, since stepping keeps the viewer
  // mounted and only swaps which item it is showing.
  const [fav, setFav] = useState(!!item.fav);
  useEffect(() => setFav(!!item.fav), [item.id, item.fav]);
  const [playingLive, setPlayingLive] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const qc = useQueryClient();
  // always loaded (cheap, cached): also tells us whether the drive is online
  const { data: detail } = useQuery({
    queryKey: ["file", item.id],
    queryFn: () => api.get<Detail>(`/api/files/${item.id}${qs}`),
  });
  const offline = detail?.volume != null && !detail.volume.is_online;
  const driveLabel = detail?.volume?.label ?? "its drive";
  /** The original is gone, not merely out of reach. Cleanup's Missing list
   *  opens the viewer on exactly these, and everything that needs the file
   *  itself — playing it, downloading it, showing it in Finder — has to stand
   *  down rather than fail on the click. */
  const originalGone = detail?.status === "missing";
  /** Neither of the two is the file being readable right now. */
  const noOriginal = offline || originalGone;
  /** Why the player gave up — which is not something a media element will
   *  tell you. `MediaError.code` is the same MEDIA_ERR_SRC_NOT_SUPPORTED for a
   *  file that isn't there and for one the browser simply cannot decode, and
   *  those two need opposite things from the reader: go find your file, versus
   *  there is nothing wrong with your file. So ask the server which it is. */
  const [mediaError, setMediaError] = useState<null | "unreadable" | "format">(null);
  // `noOriginal` and not just `offline`: the detail fetch lands a beat after
  // the first render, so a video can error on a 404 before we know the file is
  // merely missing. Clearing on either verdict lets the cached still take over.
  useEffect(() => setMediaError(null), [item.id, noOriginal]);

  const diagnoseMediaError = async () => {
    // Assume the worse of the two until proven otherwise: a file that cannot
    // be fetched at all is the one worth going to look for.
    setMediaError("unreadable");
    try {
      const r = await fetch(`/api/media/${item.id}${qs}`, { headers: { Range: "bytes=0-1" } });
      // The bytes are right there and the player still refused them, so it is
      // the encoding this browser lacks, not the file.
      if (r.ok) setMediaError("format");
    } catch {
      /* the network said no — "unreadable" is the honest answer */
    }
  };

  // "Show in Finder" has no UI of its own when it works — a window opens
  // somewhere else. So the only thing to show is the case where it didn't.
  const [revealError, setRevealError] = useState<string | null>(null);
  useEffect(() => setRevealError(null), [item.id]);
  const { data: health } = useQuery({
    queryKey: ["health"],
    queryFn: () => api.get<{ file_manager?: string }>("/api/health"),
    staleTime: Infinity,
  });
  const fileManager = health?.file_manager ?? "your file manager";
  const showReveal = canRevealFiles();

  const doReveal = async () => {
    setRevealError(null);
    try {
      await revealFile(item.id, qs);
    } catch (e) {
      setRevealError(e instanceof Error ? e.message : String(e));
    }
  };

  // ---- double-click zoom & pan (photos only) ----
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  // Once the entrance animation is done (or a zoom begins), detach it — an
  // attached animation would override the inline zoom transform.
  const [entranceDone, setEntranceDone] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const baseRef = useRef<{ w: number; h: number } | null>(null); // unscaled render size
  const dragRef = useRef<{ startX: number; startY: number; px: number; py: number } | null>(null);
  const zoomRef = useRef(1);
  zoomRef.current = zoom;

  const resetZoom = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setPanning(false);
    dragRef.current = null;
  };

  // fresh item, fresh view
  useEffect(() => {
    resetZoom();
    setEntranceDone(false);
    setPlayingLive(false);
  }, [item.id]);

  const clampPan = (x: number, y: number, s: number) => {
    const base = baseRef.current;
    if (!base) return { x: 0, y: 0 };
    const vw = window.innerWidth - (showInfo ? 350 : 0);
    const vh = window.innerHeight;
    const maxX = Math.max(0, (base.w * s - vw) / 2);
    const maxY = Math.max(0, (base.h * s - vh) / 2);
    return { x: Math.min(maxX, Math.max(-maxX, x)), y: Math.min(maxY, Math.max(-maxY, y)) };
  };

  const onDblClick = (e: React.MouseEvent) => {
    const img = imgRef.current;
    if (!img) return;
    if (zoom > 1) {
      resetZoom();
      return;
    }
    const rect = img.getBoundingClientRect(); // zoom is 1 here, so this is the fit size
    baseRef.current = { w: rect.width, h: rect.height };
    const dx = e.clientX - (rect.left + rect.width / 2);
    const dy = e.clientY - (rect.top + rect.height / 2);
    setEntranceDone(true);
    setZoom(ZOOM);
    setPan(clampPan(-dx * ZOOM, -dy * ZOOM, ZOOM)); // bring the clicked spot to center
  };

  const onPanStart = (e: React.PointerEvent) => {
    if (zoom <= 1) return;
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startY: e.clientY, px: pan.x, py: pan.y };
    setPanning(true);
  };
  const onPanMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setPan(clampPan(d.px + (e.clientX - d.startX), d.py + (e.clientY - d.startY), zoom));
  };
  const onPanEnd = () => {
    dragRef.current = null;
    setPanning(false);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // while the delete dialog is up, it owns the keyboard (otherwise Esc
      // would close both, and arrows could swap the item being deleted)
      if (confirmingDelete) return;
      if (e.key === "Escape") {
        // first Esc un-zooms, second closes
        if (zoomRef.current > 1) resetZoom();
        else onClose();
      } else if (e.key === "ArrowLeft") onPrev?.();
      else if (e.key === "ArrowRight") onNext?.();
      else if (e.key === "i") setShowInfo((s) => !s);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onPrev, onNext, confirmingDelete]);

  // freeze the page behind the viewer so wheel/trackpad can't scroll it away
  useEffect(() => {
    const stage = document.getElementById("main-scroll");
    if (!stage) return;
    const prev = stage.style.overflowY;
    stage.style.overflowY = "hidden";
    return () => {
      stage.style.overflowY = prev;
    };
  }, []);

  const m = detail?.metadata;
  /** `is-video` drops the scrim's blur, because a playing video repaints
   *  constantly and flips the blurred backdrop back and forth (see styles.css).
   *  An unplugged drive puts a still on screen instead, so that reasoning — and
   *  the different-looking background that comes with it — does not apply. */
  const showingVideo = item.media_type === "video" && !noOriginal && !mediaError;

  /** The still. Shown for a photo, and for anything at all whose drive is
   *  unplugged — `/api/preview` hands back the cached frame for a video and
   *  degrades to the thumbnail for a photo whose full preview was never made,
   *  so one element covers both. A drive being out is one state, and it should
   *  not look like two different problems depending on what you clicked. */
  const still = (
    <img
      key={item.id}
      ref={imgRef}
      className="lb-media"
      src={`/api/preview/${item.id}${qs}`}
      alt=""
      draggable={false}
      style={{
        transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
        transition: panning ? "none" : "transform 0.35s var(--ease)",
        cursor: zoom > 1 ? (panning ? "grabbing" : "grab") : "zoom-in",
        animation: entranceDone ? "none" : undefined,
      }}
      title={zoom > 1 ? "Double-click to fit" : "Double-click to zoom"}
      onAnimationEnd={() => setEntranceDone(true)}
      onDoubleClick={onDblClick}
      onPointerDown={onPanStart}
      onPointerMove={onPanMove}
      onPointerUp={onPanEnd}
      onPointerCancel={onPanEnd}
    />
  );

  return (
    <Portal>
    <div
      className={`lightbox${showInfo ? " with-info" : ""}${showingVideo ? " is-video" : ""}`}
      onClick={onClose}
    >
      <div className="lb-stage" onClick={(e) => e.stopPropagation()}>
        {/* Only a genuinely unreadable file gets a screen of its own. An
            unplugged drive is not that: there is a cached image either way, so
            it is shown, and the chip below says why it is the cached one. */}
        {item.media_type === "video" && mediaError && !noOriginal ? (
          <div className="lb-unavailable">
            <img src={`/api/thumb/${item.id}${qs}`} alt="" className="lb-unavail-poster" />
            <div className="lb-unavail-body">
              <span className="lb-unavail-icon">{mediaError === "format" ? "🎞" : "🗄"}</span>
              <strong>
                {mediaError === "format" ? "This browser can’t play this video" : "Video unavailable"}
              </strong>
              {mediaError === "format" ? (
                <p>
                  The file is here and intact — {m?.video_codec ? <>its {m.video_codec.toUpperCase()} encoding</> : "its encoding"}{" "}
                  is something this browser has no decoder for. Downloading it and opening it in a
                  player like VLC will work.
                </p>
              ) : (
                <p>The original file couldn&rsquo;t be read — it may have been moved or renamed outside Smriti.</p>
              )}
            </div>
          </div>
        ) : noOriginal ? (
          still
        ) : item.media_type === "video" ? (
          <video
            key={item.id}
            className="lb-media"
            src={`/api/media/${item.id}${qs}`}
            poster={`/api/thumb/${item.id}${qs}`}
            controls
            autoPlay
            onError={diagnoseMediaError}
          />
        ) : playingLive && detail?.motion_file_id ? (
          // The whole point of a Live Photo is the movement; hand back the
          // still the moment it finishes so the frame you chose is what stays.
          <video
            key={`live-${item.id}`}
            className="lb-media"
            src={`/api/media/${detail.motion_file_id}${qs}`}
            poster={`/api/preview/${item.id}${qs}`}
            autoPlay
            muted
            playsInline
            onEnded={() => setPlayingLive(false)}
            onError={() => setPlayingLive(false)}
          />
        ) : (
          still
        )}
        {noOriginal && (
          <div className="lb-offline-chip">
            <span className="dot" />
            {offline ? (
              <>Original on “{driveLabel}” (offline)</>
            ) : (
              <>Original deleted outside Smriti</>
            )}{" "}
            — showing a cached {item.media_type === "video" ? "frame" : "preview"}
          </div>
        )}
        {revealError && (
          <div className="lb-offline-chip bad" onClick={(e) => e.stopPropagation()}>
            <span className="dot" />
            {revealError}
            <button className="ghost small" onClick={() => setRevealError(null)}>
              Dismiss
            </button>
          </div>
        )}
      </div>

      <div className="lb-top" onClick={(e) => e.stopPropagation()}>
        {detail?.motion_file_id && !noOriginal && (
          <button
            className={`icon-btn live-btn${playingLive ? " on" : ""}`}
            title="Play the moment (Live Photo)"
            onClick={() => setPlayingLive((p) => !p)}
          >
            LIVE
          </button>
        )}
        {onToggleFav && (
          <button
            className={`icon-btn fav-btn${fav ? " on" : ""}`}
            title={fav ? "Remove from Favourites" : "Add to Favourites"}
            aria-pressed={fav}
            onClick={() => {
              const next = !fav;
              setFav(next);
              onToggleFav(item.id, next);
            }}
          >
            <IconHeart filled={fav} />
          </button>
        )}
        <button
          className={`icon-btn${showInfo ? " on" : ""}`}
          title="Info (i)"
          onClick={() => setShowInfo((s) => !s)}
        >
          <IconInfo />
        </button>
        {showReveal && (
          <button
            className="icon-btn"
            title={
              originalGone
                ? "The original is gone from disk — there is nothing left to show"
                : offline
                ? `Original is on “${driveLabel}” — connect the drive to show it in ${fileManager}`
                : `Show in ${fileManager}`
            }
            disabled={noOriginal}
            onClick={doReveal}
          >
            <IconFolderOpen />
          </button>
        )}
        <button
          className="icon-btn"
          title={deleteAction ? deleteAction.tooltip : "Move to Trash"}
          onClick={() => setConfirmingDelete(true)}
        >
          {deleteAction?.icon ?? <IconTrash />}
        </button>
        {noOriginal ? (
          <button
            className="icon-btn"
            disabled
            title={
              originalGone
                ? "The original is gone from disk — nothing left to download"
                : `Original is on “${driveLabel}” — connect the drive to download`
            }
          >
            <IconDownload />
          </button>
        ) : (
          <a
            // the filename rides in the path: the desktop webview names the
            // saved file from the URL, not from Content-Disposition
            href={`/api/media/${item.id}/${encodeURIComponent(detail?.filename ?? `smriti-${item.id}`)}${
              qs ? `${qs}&dl=1` : "?dl=1"
            }`}
            download={detail?.filename}
          >
            <button className="icon-btn" title="Download original">
              <IconDownload />
            </button>
          </a>
        )}
        <button className="icon-btn" title="Close (Esc)" onClick={onClose}>
          <IconClose />
        </button>
      </div>

      {onPrev && (
        <button className="lb-btn prev" onClick={(e) => { e.stopPropagation(); onPrev(); }}>
          <IconChevronL size={24} />
        </button>
      )}
      {onNext && (
        <button className="lb-btn next" onClick={(e) => { e.stopPropagation(); onNext(); }}>
          <IconChevronR size={24} />
        </button>
      )}

      {showInfo && (
        <aside className="lb-info" onClick={(e) => e.stopPropagation()}>
          <div className="lb-info-head">
            <span>Info</span>
            <button className="icon-btn" title="Hide info" onClick={() => setShowInfo(false)}>
              <IconClose size={18} />
            </button>
          </div>
          {detail ? (
            <>
              <h3>File</h3>
              <div>{detail.filename}</div>
              <div className="muted small">{detail.rel_path}</div>
              <div className="muted small">
                {fmtBytes(detail.size_bytes)}
                {m?.width ? ` · ${m.width}×${m.height}` : ""}
                {detail.volume ? ` · ${detail.volume.label}${detail.volume.is_online ? "" : " (offline)"}` : ""}
              </div>
              {m?.taken_at && (
                <>
                  <h3>Taken</h3>
                  <div>{m.taken_at}</div>
                </>
              )}
              {(m?.camera_make || m?.camera_model) && (
                <>
                  <h3>Camera</h3>
                  <div>
                    {[m?.camera_make, m?.camera_model].filter(Boolean).join(" ")}
                    <div className="muted small">
                      {[
                        m?.f_number ? `f/${m.f_number}` : null,
                        m?.exposure ? `${m.exposure}s` : null,
                        m?.iso ? `ISO ${m.iso}` : null,
                        m?.focal_length ? `${m.focal_length}mm` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  </div>
                </>
              )}
              {/* Coordinates alone earn the heading: a photo can carry GPS the
                  offline geocoder could not name, and that is still a place. */}
              {(detail.place || (m?.gps_lat != null && m?.gps_lon != null)) && (
                <>
                  <h3>Place</h3>
                  {detail.place && (
                    <div>{[detail.place.city, detail.place.state, detail.place.country].filter(Boolean).join(", ")}</div>
                  )}
                  {m?.gps_lat != null && m?.gps_lon != null && (
                    <>
                      <PlaceInset lat={m.gps_lat} lon={m.gps_lon} />
                      <div className="place-coords">
                        <span className="muted small">
                          {m.gps_lat.toFixed(4)}, {m.gps_lon.toFixed(4)}
                        </span>
                        <button
                          className="ghost small"
                          title="Open these coordinates in your map app"
                          onClick={() =>
                            openInMaps(
                              m.gps_lat!,
                              m.gps_lon!,
                              [detail.place?.city, detail.place?.country].filter(Boolean).join(", ")
                            )
                          }
                        >
                          Open in Maps ↗
                        </button>
                      </div>
                    </>
                  )}
                </>
              )}
              {detail.persons.length > 0 && (
                <>
                  <h3>People</h3>
                  <div>{detail.persons.map((p) => p.name ?? "Unnamed").join(", ")}</div>
                </>
              )}
            </>
          ) : (
            <div className="muted small" style={{ marginTop: 12 }}>Loading…</div>
          )}
        </aside>
      )}
      {confirmingDelete && (
        // stopPropagation: dialog clicks must not bubble (in the React tree) to the lightbox's close-on-click
        <span onClick={(e) => e.stopPropagation()}>
        <ConfirmDialog
          title={deleteAction?.title ?? `Move this ${item.media_type} to Trash?`}
          body={
            deleteAction?.body ??
            "The original goes to the system Trash (recoverable there) and disappears from the library."
          }
          confirmLabel={deleteAction?.confirmLabel ?? "Move to Trash"}
          danger
          onConfirm={async () => {
            if (deleteAction) await deleteAction.run();
            else await api.post("/api/files/delete", { file_ids: [item.id] });
            qc.invalidateQueries();
            onClose();
          }}
          onClose={() => setConfirmingDelete(false)}
        />
        </span>
      )}
    </div>
    </Portal>
  );
}
