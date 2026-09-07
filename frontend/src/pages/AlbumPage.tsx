import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, setFavourite, type Item } from "../api/client";
import { ConfirmDialog, TextDialog } from "../components/Dialogs";
import FlatGrid from "../components/FlatGrid";
import { IconMore } from "../components/Icons";
import { openContextMenu } from "../shell/ContextMenu";
import { GridControls, StandardSelection } from "../shell/GridToolbar";
import { selection } from "../shell/store";
import { TbButton, Toolbar } from "../shell/Toolbar";

interface AlbumDetail {
  id: number;
  name: string;
  system?: string | null;
  items: (Item & { position: number })[];
}

export default function AlbumPage() {
  const { id } = useParams();
  const albumId = Number(id);
  const qc = useQueryClient();
  const nav = useNavigate();
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const { data: album } = useQuery({ queryKey: ["album", albumId], queryFn: () => api.get<AlbumDetail>(`/api/albums/${albumId}`) });

  const toggleFav = (fid: number, on: boolean) =>
    setFavourite(fid, on, (fav) =>
      qc.setQueryData<AlbumDetail>(["album", albumId], (prev) => prev && { ...prev, items: prev.items.map((it) => (it.id === fid ? { ...it, fav } : it)) })
    )
      // unhearting inside Favourites takes the photo out of the album being shown
      .then(() => qc.invalidateQueries({ queryKey: ["album", albumId] }))
      .then(() => qc.invalidateQueries({ queryKey: ["albums"] }))
      .catch(() => {});

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
      selection.set({ ids: new Set(), anchor: null, last: null });
      qc.invalidateQueries({ queryKey: ["album", albumId] });
      qc.invalidateQueries({ queryKey: ["albums"] });
    },
  });
  const delAlbum = useMutation({
    mutationFn: () => api.del(`/api/albums/${albumId}`),
    onSuccess: () => {
      qc.removeQueries({ queryKey: ["album", albumId] });
      qc.invalidateQueries({ queryKey: ["albums"] });
      nav("/albums");
    },
  });

  const isSystem = !!album?.system;
  const more = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openContextMenu({ clientX: r.right - 180, clientY: r.bottom + 4, preventDefault: () => {} }, [
      { label: "Rename…", onSelect: () => setRenaming(true) },
      "sep",
      { label: "Delete Album", danger: true, onSelect: () => setDeleting(true) },
    ]);
  };

  return (
    <>
      <Toolbar back="/albums" title={album?.name ?? ""} count={album ? `${album.items.length.toLocaleString()} ${album.items.length === 1 ? "item" : "items"}` : null}>
        <StandardSelection fav={!isSystem}>
          <TbButton onClick={() => removeItems.mutate([...selection.get().ids])}>{isSystem ? "Unfavourite" : "Remove from Album"}</TbButton>
        </StandardSelection>
        {!isSystem && <TbButton icon={<IconMore size={14} />} title="More" onClick={more} />}
        <GridControls />
      </Toolbar>
      {album && (
        <FlatGrid
          items={album.items}
          onToggleFav={toggleFav}
          positionLabel={album.name}
          emptyText={isSystem ? "Nothing favourited yet — the heart on any photo puts it here" : "This album is empty. Select photos anywhere and choose Add to Album."}
          menuExtras={(ids) => [{ label: isSystem ? "Unfavourite" : "Remove from Album", onSelect: () => removeItems.mutate(ids) }]}
        />
      )}
      {renaming && album && <TextDialog title="Rename Album" initial={album.name} submitLabel="Rename" onSubmit={(name) => rename.mutate(name)} onClose={() => setRenaming(false)} />}
      {deleting && (
        <ConfirmDialog
          title="Delete this album?"
          body="The album is removed. Every photo in it stays in your library and on disk."
          confirmLabel="Delete Album"
          danger
          onConfirm={() => delAlbum.mutate()}
          onClose={() => setDeleting(false)}
        />
      )}
    </>
  );
}
