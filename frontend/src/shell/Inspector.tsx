import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api, canRevealFiles, fmtBytes, revealFile, setFavourite } from "../api/client";
import AlbumPicker from "../components/AlbumPicker";
import { ConfirmDialog } from "../components/Dialogs";
import { IconAlbum, IconClose, IconFolderOpen, IconHeart, IconTrash } from "../components/Icons";
import PlaceInset from "../components/PlaceInset";
import { openInMaps } from "../lib/desktop";
import { previewUrl, thumbUrl } from "../lib/images";
import { inspector, selection, selectionActions, setInspectorOpen } from "./store";

export interface FileDetail {
  id: number;
  filename: string;
  rel_path: string;
  size_bytes: number;
  media_type: string;
  status: string;
  fav: number;
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
  motion_file_id: number | null;
}

const fmtDate = (s: string) => {
  const d = new Date(s.replace(" ", "T"));
  if (isNaN(d.getTime())) return { date: s, time: "" };
  return {
    date: d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" }),
    time: d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }),
  };
};

/** The Info panel: what the viewer is showing, else what is selected. */
export default function Inspector() {
  const open = inspector.use((s) => s.open);
  const subject = inspector.use((s) => s.subject);
  const qs = inspector.use((s) => s.qs);
  const last = selection.use((s) => s.last);
  const count = selection.use((s) => s.ids.size);
  const id = subject ?? (count > 0 ? last : null);
  if (!open) return null;
  return (
    <aside className="inspector">
      <div className="ihead">
        Info
        <button className="x" title="Hide info (⌘I)" onClick={() => setInspectorOpen(false)}>
          <IconClose size={13} />
        </button>
      </div>
      {subject == null && count > 1 ? <Selection count={count} /> : id != null ? <Detail id={id} qs={qs} /> : (
        <div className="iempty">Select a photo to see its details.</div>
      )}
    </aside>
  );
}

function Selection({ count }: { count: number }) {
  const qc = useQueryClient();
  const [picking, setPicking] = useState(false);
  const [trashing, setTrashing] = useState(false);
  const ids = () => [...selection.get().ids];
  const favAll = async (on: boolean) => {
    await api.post("/api/favourites", { file_ids: ids(), on });
    qc.invalidateQueries();
  };
  return (
    <>
      <div className="isec">
        <h4>Selection</h4>
        <div className="num">{count.toLocaleString()} items</div>
      </div>
      <div className="isec">
        <h4>Actions</h4>
        <div className="actions">
          <button onClick={() => favAll(true)}><IconHeart size={16} />Favourite</button>
          <button onClick={() => setPicking(true)}><IconAlbum size={16} />Album</button>
          <button onClick={() => favAll(false)}><IconHeart size={16} />Unfav.</button>
          <button onClick={() => setTrashing(true)}><IconTrash size={16} />Trash</button>
        </div>
      </div>
      {picking && (
        <AlbumPicker
          title={`Add ${count} items to an album`}
          onPick={async (albumId) => {
            await api.post(`/api/albums/${albumId}/items`, { file_ids: ids() });
            qc.invalidateQueries({ queryKey: ["albums"] });
            qc.invalidateQueries({ queryKey: ["album"] });
          }}
          onCreate={async (name) => {
            const r = await api.post<{ id: number }>("/api/albums", { name });
            await api.post(`/api/albums/${r.id}/items`, { file_ids: ids() });
            qc.invalidateQueries({ queryKey: ["albums"] });
          }}
          onClose={() => setPicking(false)}
        />
      )}
      {trashing && (
        <ConfirmDialog
          title={`Move ${count} items to Trash?`}
          body="Originals go to the system Trash, where they can be recovered, and leave the library. Items on drives that are not connected are skipped."
          confirmLabel="Move to Trash"
          danger
          onConfirm={async () => {
            await api.post("/api/files/delete", { file_ids: ids() });
            selectionActions.clear();
            qc.invalidateQueries();
          }}
          onClose={() => setTrashing(false)}
        />
      )}
    </>
  );
}

function Detail({ id, qs }: { id: number; qs: string }) {
  const qc = useQueryClient();
  const { data: d } = useQuery({ queryKey: ["file", id, qs], queryFn: () => api.get<FileDetail>(`/api/files/${id}${qs}`) });
  const { data: health } = useQuery({
    queryKey: ["health"],
    queryFn: () => api.get<{ file_manager?: string }>("/api/health"),
    staleTime: Infinity,
  });
  const [picking, setPicking] = useState(false);
  const [trashing, setTrashing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!d) return <div className="iempty">Loading…</div>;
  const m = d.metadata;
  const offline = d.volume != null && !d.volume.is_online;
  const gone = d.status === "missing";
  const taken = m?.taken_at ? fmtDate(m.taken_at) : null;
  const folder = d.rel_path.split("/").slice(0, -1).join(" / ");
  const exposure = [
    m?.f_number ? `f/${m.f_number}` : null,
    m?.exposure ? `${m.exposure} s` : null,
    m?.iso ? `ISO ${m.iso}` : null,
    m?.focal_length ? `${m.focal_length} mm` : null,
  ].filter(Boolean);
  const toggleFav = () =>
    setFavourite(d.id, !d.fav, (fav) => qc.setQueryData<FileDetail>(["file", id, qs], (prev) => prev && { ...prev, fav }))
      .then(() => qc.invalidateQueries({ queryKey: ["items"] }))
      .then(() => qc.invalidateQueries({ queryKey: ["albums"] }))
      .catch(() => {});

  return (
    <>
      <div className="ipreview">
        <img src={d.media_type === "video" ? thumbUrl(d.id, qs) : previewUrl(d.id, qs)} alt="" />
      </div>
      <div className="isec">
        <h4>File</h4>
        <dl className="kv">
          <dt>Name</dt><dd>{d.filename}</dd>
          <dt>Size</dt><dd className="num">{fmtBytes(d.size_bytes)}{m?.width ? ` · ${m.width} × ${m.height}` : ""}{m?.duration_s ? ` · ${Math.round(m.duration_s)} s` : ""}</dd>
          {folder && <><dt>Location</dt><dd>{folder}</dd></>}
          {d.volume && (
            <><dt>Drive</dt><dd>{d.volume.label}{offline ? <span style={{ color: "var(--warn)" }}> · not connected</span> : ""}{gone ? <span style={{ color: "var(--bad)" }}> · file missing</span> : ""}</dd></>
          )}
        </dl>
      </div>
      {taken && (
        <div className="isec">
          <h4>Taken</h4>
          <dl className="kv"><dt>Date</dt><dd>{taken.date}</dd><dt>Time</dt><dd className="num">{taken.time}</dd></dl>
        </div>
      )}
      {(m?.camera_make || m?.camera_model || exposure.length > 0) && (
        <div className="isec">
          <h4>Camera</h4>
          <dl className="kv">
            {(m?.camera_make || m?.camera_model) && <><dt>Device</dt><dd>{[m?.camera_make, m?.camera_model].filter(Boolean).join(" ")}</dd></>}
            {exposure.length > 0 && <><dt>Exposure</dt><dd className="num">{exposure.join(" · ")}</dd></>}
            {m?.video_codec && <><dt>Codec</dt><dd>{m.video_codec.toUpperCase()}</dd></>}
          </dl>
        </div>
      )}
      {(d.place || (m?.gps_lat != null && m?.gps_lon != null)) && (
        <div className="isec">
          <h4>Place</h4>
          {d.place && <div>{[d.place.city, d.place.state, d.place.country].filter(Boolean).join(", ")}</div>}
          {m?.gps_lat != null && m?.gps_lon != null && (
            <>
              <PlaceInset lat={m.gps_lat} lon={m.gps_lon} />
              <div className="place-coords num">
                {m.gps_lat.toFixed(4)}, {m.gps_lon.toFixed(4)}
                <button onClick={() => openInMaps(m.gps_lat!, m.gps_lon!, [d.place?.city, d.place?.country].filter(Boolean).join(", "))}>
                  Open in Maps ↗
                </button>
              </div>
            </>
          )}
        </div>
      )}
      {d.persons.length > 0 && (
        <div className="isec">
          <h4>People</h4>
          <div className="chips">
            {d.persons.map((p) => (
              <Link key={p.id} to={`/people/${p.id}`} className={`chip${p.name ? "" : " quiet"}`}>
                {p.name ?? "Unnamed"}
              </Link>
            ))}
          </div>
        </div>
      )}
      <div className="isec">
        <h4>Actions</h4>
        <div className="actions">
          <button className={d.fav ? "on" : ""} onClick={toggleFav} disabled={!!qs}><IconHeart size={16} filled={!!d.fav} />Favourite</button>
          <button
            disabled={!canRevealFiles() || offline || gone}
            title={offline ? `Connect ${d.volume?.label} to show it` : gone ? "The file is gone from disk" : undefined}
            onClick={() => revealFile(d.id, qs).catch((e) => setErr(e instanceof Error ? e.message : String(e)))}
          >
            <IconFolderOpen size={16} />{health?.file_manager ?? "Finder"}
          </button>
          <button onClick={() => setPicking(true)} disabled={!!qs}><IconAlbum size={16} />Album</button>
          <button onClick={() => setTrashing(true)}><IconTrash size={16} />Trash</button>
        </div>
        {err && <p className="note bad" style={{ marginTop: 8 }}>{err}</p>}
      </div>
      {picking && (
        <AlbumPicker
          title="Add to an album"
          onPick={async (albumId) => {
            await api.post(`/api/albums/${albumId}/items`, { file_ids: [d.id] });
            qc.invalidateQueries({ queryKey: ["albums"] });
            qc.invalidateQueries({ queryKey: ["album"] });
          }}
          onCreate={async (name) => {
            const r = await api.post<{ id: number }>("/api/albums", { name });
            await api.post(`/api/albums/${r.id}/items`, { file_ids: [d.id] });
            qc.invalidateQueries({ queryKey: ["albums"] });
          }}
          onClose={() => setPicking(false)}
        />
      )}
      {trashing && (
        <ConfirmDialog
          title={`Move this ${d.media_type} to Trash?`}
          body="The original goes to the system Trash, where it can be recovered, and leaves the library."
          confirmLabel="Move to Trash"
          danger
          onConfirm={async () => {
            await api.post("/api/files/delete", { file_ids: [d.id] });
            selectionActions.clear();
            qc.invalidateQueries();
          }}
          onClose={() => setTrashing(false)}
        />
      )}
    </>
  );
}
