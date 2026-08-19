import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, type Item } from "../api/client";
import { ConfirmDialog, TextDialog } from "../components/Dialogs";
import JustifiedGrid from "../components/JustifiedGrid";
import { PhotoGridSkeleton } from "../components/Skeletons";
import Lightbox from "../components/Lightbox";

interface AlbumDetail {
  id: number;
  name: string;
  items: (Item & { position: number })[];
}

export default function AlbumPage() {
  const { id } = useParams();
  const albumId = Number(id);
  const qc = useQueryClient();
  const nav = useNavigate();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const resizeObs = useRef<ResizeObserver | null>(null);
  const [width, setWidth] = useState(1000);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const { data: album } = useQuery({
    queryKey: ["album", albumId],
    queryFn: () => api.get<AlbumDetail>(`/api/albums/${albumId}`),
  });

  /** Callback ref, not an effect: this component returns early while the album
   *  loads, so an effect with no deps would fire on a render where the
   *  container does not exist yet and never run again — leaving the grid laid
   *  out for whatever width it started with. Same trap as TimelineGrid. */
  const attachContainer = useCallback((el: HTMLDivElement | null) => {
    containerRef.current = el;
    resizeObs.current?.disconnect();
    resizeObs.current = null;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    resizeObs.current = ro;
    setWidth(el.clientWidth);
  }, []);

  useEffect(() => () => resizeObs.current?.disconnect(), []);

  const rename = useMutation({
    mutationFn: (name: string) => api.patch(`/api/albums/${albumId}`, { name }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["album", albumId] });
      qc.invalidateQueries({ queryKey: ["albums"] });
      setRenaming(false);
    },
  });
  const removeItems = useMutation({
    mutationFn: (ids: number[]) => api.post(`/api/albums/${albumId}/items/remove`, { file_ids: ids }),
    onSuccess: () => {
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ["album", albumId] });
    },
  });
  const delAlbum = useMutation({
    mutationFn: () => api.del(`/api/albums/${albumId}`),
    onSuccess: () => nav("/albums"),
  });

  if (!album)
    return (
      <div className="page">
        <header className="page-head">
          <div>
            <div className="skeleton line" style={{ width: 220, height: 22 }} />
            <div className="skeleton line short" style={{ width: 70 }} />
          </div>
        </header>
        <PhotoGridSkeleton />
      </div>
    );
  const items = album.items;
  return (
    <div className="page" ref={attachContainer}>
      <header className="page-head">
        <div>
          <h1>{album.name}</h1>
          <p className="sub">{items.length} items</p>
        </div>
        <div className="actions">
          <Link to="/albums">
            <button className="ghost">← Albums</button>
          </Link>
          <button onClick={() => setRenaming(true)}>Rename</button>
          {selected.size > 0 && (
            <button onClick={() => removeItems.mutate([...selected])}>Remove {selected.size} from album</button>
          )}
          <button className="danger" onClick={() => setDeleting(true)}>
            Delete album
          </button>
        </div>
      </header>
      <JustifiedGrid
        items={items}
        width={width - 40}
        onOpen={setLightboxIdx}
        selected={selected}
        onToggleSelect={(fid) =>
          setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(fid)) next.delete(fid);
            else next.add(fid);
            return next;
          })
        }
      />
      {lightboxIdx != null && items[lightboxIdx] && (
        <Lightbox
          item={items[lightboxIdx]}
          onClose={() => setLightboxIdx(null)}
          onPrev={lightboxIdx > 0 ? () => setLightboxIdx(lightboxIdx - 1) : undefined}
          onNext={lightboxIdx < items.length - 1 ? () => setLightboxIdx(lightboxIdx + 1) : undefined}
        />
      )}
      {renaming && (
        <TextDialog
          title="Rename album"
          initial={album.name}
          submitLabel="Rename"
          onSubmit={(name) => rename.mutate(name)}
          onClose={() => setRenaming(false)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete this album?"
          body="The album is removed but every file stays on disk."
          confirmLabel="Delete album"
          danger
          onConfirm={() => delAlbum.mutate()}
          onClose={() => setDeleting(false)}
        />
      )}
    </div>
  );
}
