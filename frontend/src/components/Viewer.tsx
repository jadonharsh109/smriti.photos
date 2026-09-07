import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { api, canRevealFiles, fmtDay, searchStatus, type Item } from "../api/client";
import { mediaUrl, previewUrl, thumbUrl } from "../lib/images";
import { actions } from "../shell/actions";
import { openContextMenu, type MenuItem } from "../shell/ContextMenu";
import type { FileDetail } from "../shell/Inspector";
import { inspector, setInspectorOpen, setInspectorSubject } from "../shell/store";
import { useShell } from "../shell/Toolbar";
import { IconChevronL, IconChevronR, IconHeart, IconInfo, IconMore } from "./Icons";

interface Props {
  item: Item;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  /** "42 of 221 · Sat, 19 Jun 2025" in the bar; `label` replaces the day. */
  position?: { index: number; total: number; day?: string; label?: string };
  /** Omit to leave the heart off — Locked has no use for it. */
  onToggleFav?: (id: number, on: boolean) => void;
  /** appended to media/detail URLs (the Locked section's token) */
  qs?: string;
  /** Replaces "Move to Trash" where the original is already gone (Cleanup's Missing list). */
  deleteAction?: { label: string; run: () => void };
}

const ZOOM = 2.5;

/** The viewer fills the content column — the sidebar and the Info panel stay
 *  where they are, which is how a desktop app looks at one photo. */
export default function Viewer({ item, onClose, onPrev, onNext, position, onToggleFav, qs = "", deleteAction }: Props) {
  const { contentEl } = useShell();
  const qc = useQueryClient();
  const nav = useNavigate();
  const infoOpen = inspector.use((s) => s.open);
  const [fav, setFav] = useState(!!item.fav);
  useEffect(() => setFav(!!item.fav), [item.id, item.fav]);
  const [playingLive, setPlayingLive] = useState(false);

  const { data: detail } = useQuery({
    queryKey: ["file", item.id, qs],
    queryFn: () => api.get<FileDetail>(`/api/files/${item.id}${qs}`),
  });
  const offline = detail?.volume != null && !detail.volume.is_online;
  const gone = detail?.status === "missing";
  const noOriginal = offline || gone;
  const [mediaError, setMediaError] = useState<null | "unreadable" | "format">(null);
  useEffect(() => setMediaError(null), [item.id, noOriginal]);

  // the Info panel describes what is on screen
  useEffect(() => {
    setInspectorSubject(item.id, qs);
    return () => setInspectorSubject(null);
  }, [item.id, qs]);

  const { data: search } = useQuery({ queryKey: ["search-status"], queryFn: searchStatus, staleTime: 60_000 });
  const canFindSimilar = !!search?.ready && !qs;

  const diagnoseMediaError = async () => {
    setMediaError("unreadable");
    try {
      const r = await fetch(mediaUrl(item.id, qs), { headers: { Range: "bytes=0-1" } });
      if (r.ok) setMediaError("format");
    } catch {
      /* the network said no — "unreadable" is the honest answer */
    }
  };

  // ---- double-click zoom & pan ----
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const baseRef = useRef<{ w: number; h: number } | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; px: number; py: number } | null>(null);
  const zoomRef = useRef(1);
  zoomRef.current = zoom;
  const resetZoom = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setPanning(false);
    dragRef.current = null;
  };
  useEffect(() => {
    resetZoom();
    setPlayingLive(false);
  }, [item.id]);
  const clampPan = (x: number, y: number, s: number) => {
    const base = baseRef.current;
    const stage = imgRef.current?.parentElement;
    if (!base || !stage) return { x: 0, y: 0 };
    const maxX = Math.max(0, (base.w * s - stage.clientWidth) / 2);
    const maxY = Math.max(0, (base.h * s - stage.clientHeight) / 2);
    return { x: Math.min(maxX, Math.max(-maxX, x)), y: Math.min(maxY, Math.max(-maxY, y)) };
  };
  const onDblClick = (e: React.MouseEvent) => {
    const img = imgRef.current;
    if (!img) return;
    if (zoom > 1) {
      resetZoom();
      return;
    }
    const rect = img.getBoundingClientRect();
    baseRef.current = { w: rect.width, h: rect.height };
    const dx = e.clientX - (rect.left + rect.width / 2);
    const dy = e.clientY - (rect.top + rect.height / 2);
    setZoom(ZOOM);
    setPan(clampPan(-dx * ZOOM, -dy * ZOOM, ZOOM));
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
      if (document.querySelector(".scrim, .cmenu")) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, [contenteditable]")) return;
      if (e.key === "Escape" || e.key === " ") {
        e.preventDefault();
        if (zoomRef.current > 1 && e.key === "Escape") resetZoom();
        else onClose();
      } else if (e.key === "ArrowLeft") onPrev?.();
      else if (e.key === "ArrowRight") onNext?.();
      else if (e.key === "i" && !e.metaKey && !e.ctrlKey) setInspectorOpen(!inspector.get().open);
      else if (e.key === "." && onToggleFav) toggleFav();
      else if ((e.key === "Backspace" || e.key === "Delete") && !deleteAction) actions.trash([item.id]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, onPrev, onNext, item.id, fav]);

  const toggleFav = () => {
    if (!onToggleFav) return;
    const next = !fav;
    setFav(next);
    onToggleFav(item.id, next);
    qc.invalidateQueries({ queryKey: ["file", item.id] });
  };

  const download = () => {
    const a = document.createElement("a");
    a.href = `/api/media/${item.id}/${encodeURIComponent(detail?.filename ?? `smriti-${item.id}`)}${qs ? `${qs}&dl=1` : "?dl=1"}`;
    a.download = detail?.filename ?? "";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const more = (e: React.MouseEvent) => {
    const items: MenuItem[] = [];
    if (canRevealFiles()) items.push({ label: "Show in Finder", disabled: noOriginal, onSelect: () => actions.reveal(item.id, qs) });
    if (canFindSimilar) items.push({ label: "Find Similar Photos", onSelect: () => { onClose(); nav(`/search?similar=${item.id}`); } });
    if (!qs) items.push({ label: "Add to Album…", onSelect: () => actions.addToAlbum([item.id]) });
    if (!qs) items.push({ label: "Hide in Locked", onSelect: () => actions.hideInLocked([item.id]) });
    items.push({ label: "Download Original", disabled: noOriginal, onSelect: download });
    items.push("sep");
    if (deleteAction) items.push({ label: deleteAction.label, danger: true, onSelect: deleteAction.run });
    else items.push({ label: "Move to Trash", shortcut: "⌫", danger: true, onSelect: () => actions.trash([item.id]) });
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openContextMenu({ clientX: r.right - 200, clientY: r.bottom + 4, preventDefault: () => {} }, items);
  };

  const m = detail?.metadata;
  const showingVideo = item.media_type === "video" && !noOriginal && !mediaError;
  const still = (
    <img
      key={item.id}
      ref={imgRef}
      className={`vmedia${zoom > 1 ? " zoomed" : " zoomable"}${panning ? " panning" : ""}`}
      src={previewUrl(item.id, qs)}
      alt=""
      draggable={false}
      style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transition: panning ? "none" : "transform 200ms ease" }}
      onDoubleClick={onDblClick}
      onPointerDown={onPanStart}
      onPointerMove={onPanMove}
      onPointerUp={onPanEnd}
      onPointerCancel={onPanEnd}
    />
  );

  if (!contentEl) return null;
  return createPortal(
    <div className="viewer" role="dialog" aria-label={detail?.filename ?? "Photo"}>
      <div className="vbar">
        <button title="Back (esc)" onClick={onClose}><IconChevronL size={15} /></button>
        <span className="name">{detail?.filename ?? ""}</span>
        {position && (
          <span className="sub num">
            {position.index.toLocaleString()} of {position.total.toLocaleString()}
            {position.day ? ` · ${fmtDay(position.day)}` : position.label ? ` · ${position.label}` : ""}
          </span>
        )}
        <span className="grow" />
        {detail?.motion_file_id && !noOriginal && (
          <button className={playingLive ? "on" : ""} title="Play the moment (Live Photo)" onClick={() => setPlayingLive((p) => !p)}>LIVE</button>
        )}
        {onToggleFav && (
          <button className={`fav${fav ? " on" : ""}`} title={fav ? "Remove from Favourites (.)" : "Add to Favourites (.)"} aria-pressed={fav} onClick={toggleFav}>
            <IconHeart size={15} filled={fav} />
          </button>
        )}
        <button className={infoOpen ? "on" : ""} title="Info (i)" onClick={() => setInspectorOpen(!infoOpen)}><IconInfo size={15} /></button>
        <button title="More" onClick={more}><IconMore size={15} /></button>
      </div>
      <div className="vstage" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        {onPrev && <button className="varrow l" title="Previous (←)" onClick={onPrev}><IconChevronL size={16} /></button>}
        {item.media_type === "video" && mediaError && !noOriginal ? (
          <div className="vunavail">
            <img src={thumbUrl(item.id, qs)} alt="" />
            <strong>{mediaError === "format" ? "This video can’t be played here" : "Video unavailable"}</strong>
            {mediaError === "format"
              ? `The file is intact; ${m?.video_codec ? `its ${m.video_codec.toUpperCase()} encoding` : "its encoding"} has no decoder in this app. Download it and open it in a player like VLC.`
              : "The original couldn’t be read — it may have been moved or renamed outside Smriti."}
          </div>
        ) : noOriginal ? (
          still
        ) : item.media_type === "video" ? (
          <video key={item.id} className="vmedia" src={mediaUrl(item.id, qs)} poster={thumbUrl(item.id, qs)} controls autoPlay onError={diagnoseMediaError} />
        ) : playingLive && detail?.motion_file_id ? (
          <video key={`live-${item.id}`} className="vmedia" src={mediaUrl(detail.motion_file_id, qs)} poster={previewUrl(item.id, qs)} autoPlay muted playsInline onEnded={() => setPlayingLive(false)} onError={() => setPlayingLive(false)} />
        ) : (
          still
        )}
        {onNext && <button className="varrow r" title="Next (→)" onClick={onNext}><IconChevronR size={16} /></button>}
        {noOriginal && (
          <div className="vchip">
            {offline ? `Original on “${detail?.volume?.label}” (not connected)` : "Original deleted outside Smriti"} — showing the cached {item.media_type === "video" ? "frame" : "preview"}
          </div>
        )}
        {!showingVideo && !noOriginal && (
          <div className="vfoot">← → to move · double-click to zoom · esc to close</div>
        )}
      </div>
    </div>,
    contentEl
  );
}
