import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { IconAlbum, IconClose } from "./Icons";
import Portal from "./Portal";

export interface Album {
  id: number;
  name: string;
  count: number;
  cover: number | null;
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

/** Choosing an album, for however many albums someone has.
 *
 *  This used to be a row of buttons inside the selection bar — fine with three
 *  albums, unusable with thirty, and the bar is the wrong place for a list that
 *  grows without limit. A dialog can scroll, can be searched, and can show each
 *  album's cover and size, which is what actually tells two albums apart. */
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
    const all = albums ?? [];
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

  const total = albums?.length ?? 0;
  return (
    <Portal>
      <div className="modal-back" onClick={() => !busy && onClose()}>
        <div className="modal" style={{ width: 460 }} onClick={(e) => e.stopPropagation()}>
          <header>
            {title}
            <span className="spacer" />
            <button className="icon-btn" style={{ width: 30, height: 30 }} disabled={busy} onClick={onClose}>
              <IconClose size={15} />
            </button>
          </header>

          <div className="modal-body" style={{ paddingBottom: 4 }}>
            {busy ? (
              <div className="row" style={{ gap: 10, padding: "18px 0" }}>
                <div className="spin" />
                <span className="muted">Adding to the album…</span>
              </div>
            ) : (
              <>
                {/* A search box earns its place once the list outgrows a glance. */}
                {total > 6 && (
                  <input
                    type="text"
                    autoFocus
                    placeholder={`Search ${total} albums`}
                    style={{ width: "100%", marginBottom: 8 }}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                )}

                {isLoading ? (
                  <p className="muted small" style={{ padding: "10px 0" }}>Loading albums…</p>
                ) : total === 0 ? (
                  <p className="muted small" style={{ padding: "6px 0 10px" }}>
                    No albums yet — name one below and it will be created with these photos in it.
                  </p>
                ) : shown.length === 0 ? (
                  <p className="muted small" style={{ padding: "10px 0" }}>
                    No album matches “{query}”.
                  </p>
                ) : (
                  <div className="album-list">
                    {shown.map((a) => (
                      <button key={a.id} className="album-row" onClick={() => run(() => onPick(a.id))}>
                        {a.cover ? (
                          <img src={`/api/thumb/${a.cover}`} alt="" loading="lazy" />
                        ) : (
                          <span className="ph">
                            <IconAlbum size={17} />
                          </span>
                        )}
                        <span className="nm">{a.name}</span>
                        <span className="ct">{a.count.toLocaleString()}</span>
                      </button>
                    ))}
                  </div>
                )}

              </>
            )}
          </div>

          {/* Pinned, not scrolled with the list: with a long list the create row
              would sit below the fold, and "make a new album" is exactly what
              someone does when they cannot find the one they wanted. */}
          {!busy && (
            <div className="album-new">
              <div className="album-or">{total === 0 ? "New album" : "or start a new one"}</div>
              <div className="row">
                <input
                  type="text"
                  autoFocus={total === 0}
                  placeholder="Album name"
                  style={{ flex: 1, minWidth: 0 }}
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && create()}
                />
                <button className="primary" disabled={!newName.trim()} onClick={create}>
                  Create &amp; add
                </button>
              </div>
              {error && (
                <p className="small" style={{ color: "var(--danger)", marginTop: 8 }}>{error}</p>
              )}
            </div>
          )}

          <footer>
            <button disabled={busy} onClick={onClose}>Cancel</button>
          </footer>
        </div>
      </div>
    </Portal>
  );
}
