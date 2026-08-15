import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, fmtBytes, type Item } from "../api/client";
import { ConfirmDialog } from "./Dialogs";
import { IconChevronL, IconChevronR, IconClose, IconDownload, IconInfo, IconTrash } from "./Icons";
import Portal from "./Portal";

interface Detail {
  id: number;
  filename: string;
  rel_path: string;
  size_bytes: number;
  media_type: string;
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
    gps_lat: number | null;
    gps_lon: number | null;
  } | null;
  place: { city: string | null; state: string | null; country: string | null } | null;
  persons: { id: number; name: string | null }[];
  volume: { label: string; is_online: number } | null;
}

interface Props {
  item: Item;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  /** appended to media/detail URLs (e.g. the locked-section token) */
  qs?: string;
}

const ZOOM = 2.5;

export default function Lightbox({ item, onClose, onPrev, onNext, qs = "" }: Props) {
  const [showInfo, setShowInfo] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const qc = useQueryClient();
  // always loaded (cheap, cached): also tells us whether the drive is online
  const { data: detail } = useQuery({
    queryKey: ["file", item.id],
    queryFn: () => api.get<Detail>(`/api/files/${item.id}${qs}`),
  });
  const offline = detail?.volume != null && !detail.volume.is_online;
  const driveLabel = detail?.volume?.label ?? "its drive";
  const [mediaError, setMediaError] = useState(false);
  useEffect(() => setMediaError(false), [item.id, offline]);

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
  return (
    <Portal>
    <div className={`lightbox${showInfo ? " with-info" : ""}`} onClick={onClose}>
      <div className="lb-stage" onClick={(e) => e.stopPropagation()}>
        {item.media_type === "video" && (offline || mediaError) ? (
          <div className="lb-unavailable">
            <img src={`/api/thumb/${item.id}${qs}`} alt="" className="lb-unavail-poster" />
            <div className="lb-unavail-body">
              <span className="lb-unavail-icon">🗄</span>
              <strong>{offline ? "Drive not connected" : "Video unavailable"}</strong>
              <p>
                {offline
                  ? `This video lives on “${driveLabel}”, which isn't connected. Plug it in and it will play right here.`
                  : "The original file couldn't be read — it may have been moved or renamed outside Smriti."}
              </p>
            </div>
          </div>
        ) : item.media_type === "video" ? (
          <video
            key={item.id}
            className="lb-media"
            src={`/api/media/${item.id}${qs}`}
            poster={`/api/thumb/${item.id}${qs}`}
            controls
            autoPlay
            onError={() => setMediaError(true)}
          />
        ) : (
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
        )}
        {item.media_type === "photo" && offline && (
          <div className="lb-offline-chip">
            <span className="dot" />
            Original on “{driveLabel}” (offline) — showing cached preview
          </div>
        )}
      </div>

      <div className="lb-top" onClick={(e) => e.stopPropagation()}>
        <button
          className={`icon-btn${showInfo ? " on" : ""}`}
          title="Info (i)"
          onClick={() => setShowInfo((s) => !s)}
        >
          <IconInfo />
        </button>
        <button className="icon-btn" title="Move to Trash" onClick={() => setConfirmingDelete(true)}>
          <IconTrash />
        </button>
        {offline ? (
          <button className="icon-btn" disabled title={`Original is on “${driveLabel}” — connect the drive to download`}>
            <IconDownload />
          </button>
        ) : (
          <a href={`/api/media/${item.id}${qs}`} download>
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
              {detail.place && (
                <>
                  <h3>Place</h3>
                  <div>{[detail.place.city, detail.place.state, detail.place.country].filter(Boolean).join(", ")}</div>
                  {m?.gps_lat != null && (
                    <div className="muted small">
                      {m.gps_lat.toFixed(4)}, {m.gps_lon?.toFixed(4)}
                    </div>
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
          title={`Move this ${item.media_type} to Trash?`}
          body="The original goes to the system Trash (recoverable there) and disappears from the library."
          confirmLabel="Move to Trash"
          danger
          onConfirm={async () => {
            await api.post("/api/files/delete", { file_ids: [item.id] });
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
