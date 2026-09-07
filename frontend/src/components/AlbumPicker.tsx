import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { thumbUrl } from "../lib/images";
import { IconAlbum } from "./Icons";
import Portal from "./Portal";

export interface Album {
  id: number;
  name: string;
  count: number;
  cover: number | null;
  system?: string | null;
}

interface Props {
  /** What is being filed, e.g. "Add 12 photos to an album". */
  title: string;
  /** File into an existing album. Resolving closes the dialog. */
  onPick: (albumId: number) => Promise<void>;
  /** Create the album, then file into it. */
  onCreate: (name: string) => Promise<void>;
  onClose: () => void;
}

/** Choosing an album, for however many albums someone has: a searchable list
 *  with covers and sizes, and a way to make a new one without leaving. */
export default function AlbumPicker({ title, onPick, onCreate, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: albums, isLoading } = useQuery({
    queryKey: ["albums"],
    queryFn: () => api.get<Album[]>("/api/albums"),
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const all = (albums ?? []).filter((a) => !a.system);
    return needle ? all.filter((a) => a.name.toLowerCase().includes(needle)) : all;
  }, [albums, query]);

  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      onClose();
    } catch (e) {
      setError(String((e as Error).message));
      setBusy(false);
    }
  };

  const create = () => {
    const name = newName.trim();
    if (name) run(() => onCreate(name));
  };

  const total = shown.length;
  return (
    <Portal>
      <div className="scrim" onClick={() => !busy && onClose()}>
        <div className="sheet" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
          <header>{title}</header>
          <div className="sbody">
            {busy ? (
              <div className="row" style={{ padding: "12px 0" }}>
                <div className="spin" />
                <span className="muted">Adding to the album…</span>
              </div>
            ) : (
              <>
                {(albums ?? []).length > 6 && (
                  <input className="input" type="text" autoFocus placeholder="Search albums" value={query} onChange={(e) => setQuery(e.target.value)} />
                )}
                {isLoading ? (
                  <p>Loading albums…</p>
                ) : total === 0 ? (
                  <p>{query ? `No album matches “${query}”.` : "No albums yet — name one below and it will be created with these photos in it."}</p>
                ) : (
                  <div className="album-list">
                    {shown.map((a) => (
                      <button key={a.id} className="album-row" onClick={() => run(() => onPick(a.id))}>
                        {a.cover ? <img src={thumbUrl(a.cover)} alt="" loading="lazy" /> : <span className="ph"><IconAlbum size={15} /></span>}
                        <span className="nm">{a.name}</span>
                        <span className="ct num">{a.count.toLocaleString()}</span>
                      </button>
                    ))}
                  </div>
                )}
                <div className="row" style={{ marginTop: 10 }}>
                  <input
                    className="input"
                    type="text"
                    autoFocus={(albums ?? []).length <= 6}
                    placeholder="New album name"
                    style={{ marginBottom: 0 }}
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && create()}
                  />
                  <button className="btn" disabled={!newName.trim()} onClick={create}>Create &amp; Add</button>
                </div>
                {error && <p className="note bad" style={{ marginTop: 8 }}>{error}</p>}
              </>
            )}
          </div>
          <div className="sfoot">
            <button className="btn" disabled={busy} onClick={onClose}>Cancel</button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
