import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api, cardDelay } from "../api/client";
import { TextDialog } from "../components/Dialogs";
import { ArtAlbums } from "../components/Illustrations";
import { CardGridSkeleton } from "../components/Skeletons";

interface Album {
  id: number;
  name: string;
  count: number;
  cover: number | null;
}

export default function AlbumsPage() {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const { data: albums, isLoading } = useQuery({
    queryKey: ["albums"],
    queryFn: () => api.get<Album[]>("/api/albums"),
  });
  const create = useMutation({
    mutationFn: (name: string) => api.post<{ id: number }>("/api/albums", { name }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["albums"] });
      setCreating(false);
    },
  });

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Albums</h1>
          <p className="sub">Albums are virtual — your files never move.</p>
        </div>
        <div className="actions">
          <button className="primary" onClick={() => setCreating(true)}>
            + New album
          </button>
        </div>
      </header>
      {isLoading ? (
        <CardGridSkeleton count={8} />
      ) : (albums ?? []).length === 0 ? (
        <div className="empty">
          <ArtAlbums className="art" />
          <p>No albums yet. Select photos in the timeline and choose "Add to album".</p>
        </div>
      ) : (
        <div className="card-grid">
          {albums!.map((a, i) => (
            <Link key={a.id} to={`/albums/${a.id}`} className="card" style={cardDelay(i)}>
              {a.cover ? <img className="cover" src={`/api/thumb/${a.cover}`} loading="lazy" alt="" /> : <div className="cover" />}
              <div className="meta">
                <div className="name">{a.name}</div>
                <div className="sub">{a.count} items</div>
              </div>
            </Link>
          ))}
        </div>
      )}
      {creating && (
        <TextDialog
          title="New album"
          placeholder="Album name"
          submitLabel="Create"
          onSubmit={(name) => create.mutate(name)}
          onClose={() => setCreating(false)}
        />
      )}
    </div>
  );
}
