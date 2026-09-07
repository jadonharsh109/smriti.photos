import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { ConfirmDialog, TextDialog } from "../components/Dialogs";
import { IconPlus } from "../components/Icons";
import { thumbUrl } from "../lib/images";
import { openContextMenu } from "../shell/ContextMenu";
import { TbButton, Toolbar } from "../shell/Toolbar";

interface Album {
  id: number;
  name: string;
  count: number;
  cover: number | null;
  system?: string | null;
}

export default function AlbumsPage() {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<Album | null>(null);
  const [deleting, setDeleting] = useState<Album | null>(null);
  const { data: albums, isLoading } = useQuery({ queryKey: ["albums"], queryFn: () => api.get<Album[]>("/api/albums") });
  const refresh = () => qc.invalidateQueries({ queryKey: ["albums"] });
  const create = useMutation({
    mutationFn: (name: string) => api.post<{ id: number }>("/api/albums", { name }),
    onSuccess: () => {
      refresh();
      setCreating(false);
    },
  });
  const rename = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) => api.patch(`/api/albums/${id}`, { name }),
    onSuccess: (_r, v) => {
      refresh();
      qc.invalidateQueries({ queryKey: ["album", v.id] });
      setRenaming(null);
    },
  });
  const del = useMutation({
    mutationFn: (id: number) => api.del(`/api/albums/${id}`),
    onSuccess: (_r, id) => {
      qc.removeQueries({ queryKey: ["album", id] });
      refresh();
    },
  });

  const user = (albums ?? []).filter((a) => !a.system);
  return (
    <>
      <Toolbar title="Albums" count={user.length ? user.length.toLocaleString() : null}>
        <TbButton icon={<IconPlus size={14} />} title="New Album…" onClick={() => setCreating(true)}>New Album</TbButton>
      </Toolbar>
      {isLoading ? null : user.length === 0 ? (
        <div className="empty">
          <h2>No albums yet</h2>
          <p>Select photos anywhere and choose Add to Album. Albums are virtual — your files never move.</p>
          <div className="row">
            <button className="btn" onClick={() => setCreating(true)}>New Album…</button>
          </div>
        </div>
      ) : (
        <div className="page">
          <div className="cards">
            {user.map((a) => (
              <Link
                key={a.id}
                to={`/albums/${a.id}`}
                className="card"
                onContextMenu={(e) =>
                  openContextMenu(e, [
                    { label: "Rename…", onSelect: () => setRenaming(a) },
                    "sep",
                    { label: "Delete Album", danger: true, onSelect: () => setDeleting(a) },
                  ])
                }
              >
                {a.cover ? <img className="cover" src={thumbUrl(a.cover)} loading="lazy" decoding="async" alt="" /> : <div className="cover" />}
                <div className="meta">
                  <div className="name">{a.name}</div>
                  <div className="sub num">{a.count.toLocaleString()} {a.count === 1 ? "item" : "items"}</div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}
      {creating && <TextDialog title="New Album" placeholder="Album name" submitLabel="Create" onSubmit={(name) => create.mutate(name)} onClose={() => setCreating(false)} />}
      {renaming && (
        <TextDialog title="Rename Album" initial={renaming.name} submitLabel="Rename" onSubmit={(name) => rename.mutate({ id: renaming.id, name })} onClose={() => setRenaming(null)} />
      )}
      {deleting && (
        <ConfirmDialog
          title={`Delete “${deleting.name}”?`}
          body="The album is removed. Every photo in it stays in your library and on disk."
          confirmLabel="Delete Album"
          danger
          onConfirm={() => del.mutate(deleting.id)}
          onClose={() => setDeleting(null)}
        />
      )}
    </>
  );
}
