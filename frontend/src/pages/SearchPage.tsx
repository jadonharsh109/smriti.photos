import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  buildSearchIndex,
  downloadSearchModel,
  searchLibrary,
  searchStatus,
  similarTo,
  type SearchChip,
  type SearchItem,
} from "../api/client";
import { ArtPhotos } from "../components/Illustrations";
import JustifiedGrid from "../components/JustifiedGrid";
import Lightbox from "../components/Lightbox";
import { IconSearch } from "../components/Icons";
import { PhotoGridSkeleton } from "../components/Skeletons";

/** A few things worth trying, so an empty box isn't a blank stare. Deliberately
 *  ordinary nouns: the point to get across is that you describe the picture,
 *  not that you recall a filename. */
const SUGGESTIONS = ["sunset", "a group of friends", "food", "mountains", "a document", "at the beach"];

export default function SearchPage() {
  const [params, setParams] = useSearchParams();
  const urlQ = params.get("q") ?? "";
  // "More like this", handed over from the viewer: the same ranking with a
  // photo as the query instead of a sentence.
  const similarId = Number(params.get("similar")) || null;
  const [text, setText] = useState(urlQ);
  const [query, setQuery] = useState(urlQ);
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1000);
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);
  const qc = useQueryClient();

  const { data: status } = useQuery({
    queryKey: ["search-status"],
    queryFn: searchStatus,
    // while a scan is running the numbers move; this is the cheapest honest way
    // to keep "12,003 of 40,000 searchable" from going stale on screen
    refetchInterval: (q) => (q.state.data && q.state.data.pending > 0 ? 2000 : false),
  });

  // Debounced: CLIP encodes the query in a few milliseconds, but firing on
  // every keystroke still reorders the grid under someone mid-word.
  useEffect(() => {
    const t = setTimeout(() => {
      const next = text.trim();
      setQuery(next);
      // An empty box must not clear the URL when `similar` is what is being
      // shown — in that mode the photo *is* the query, and wiping it here
      // dropped the view on arrival. Typing anything is the deliberate way
      // out, and writing `q` drops `similar` on its own.
      if (!next && similarId) return;
      setParams(next ? { q: next } : {}, { replace: true });
    }, 250);
    return () => clearTimeout(t);
  }, [text, similarId, setParams]);

  const { data, isFetching } = useQuery({
    queryKey: ["search", query],
    queryFn: () => searchLibrary(query),
    enabled: !similarId && query.length > 0 && !!status?.ready,
    placeholderData: (prev) => prev, // keep the old grid while the new one lands
  });
  const { data: like, isFetching: findingLike } = useQuery({
    queryKey: ["search-similar", similarId],
    queryFn: () => similarTo(similarId!),
    enabled: !!similarId && !!status?.ready,
  });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [status?.ready]);

  const getModel = useMutation({
    mutationFn: downloadSearchModel,
    onSettled: () => qc.invalidateQueries({ queryKey: ["search-status"] }),
  });
  const index = useMutation({
    mutationFn: buildSearchIndex,
    onSettled: () => qc.invalidateQueries({ queryKey: ["search-status"] }),
  });

  const items: SearchItem[] = useMemo(
    () => (similarId ? like?.items ?? [] : data?.items ?? []),
    [similarId, like, data]
  );
  const busy = similarId ? findingLike : isFetching;
  const chips: SearchChip[] = similarId ? [] : data?.chips ?? [];
  const scored = items.some((it) => it.score != null);

  // ---- the two states before searching is possible at all -------------------
  if (status && !status.model_ready) {
    return (
      <div className="page">
        <header className="page-head">
          <div>
            <h1>Search</h1>
            <p className="sub">Find a photo by what is in it</p>
          </div>
        </header>
        <div className="empty">
          <ArtPhotos className="art" />
          <p>
            Searching by what a photo shows needs a model — about {status.model_mb} MB, downloaded
            once. It then runs on this machine, like everything else here: what you search for
            never leaves it.
          </p>
          <button className="primary" onClick={() => getModel.mutate()} disabled={getModel.isPending}>
            Download the search model (≈{status.model_mb} MB)
          </button>
          {getModel.error && (
            <p className="sub" style={{ color: "var(--danger)" }}>
              {String((getModel.error as Error).message)}
            </p>
          )}
        </div>
      </div>
    );
  }

  if (status && status.model_ready && status.indexed === 0) {
    return (
      <div className="page">
        <header className="page-head">
          <div>
            <h1>Search</h1>
            <p className="sub">Find a photo by what is in it</p>
          </div>
        </header>
        <div className="empty">
          <ArtPhotos className="art" />
          <p>
            The model is ready. Smriti now needs to look at your {status.total.toLocaleString()}{" "}
            photos once and remember what is in each — after that, searching is instant.
          </p>
          <button className="primary" onClick={() => index.mutate()} disabled={index.isPending}>
            Make my photos searchable
          </button>
          {index.error && (
            <p className="sub" style={{ color: "var(--danger)" }}>
              {String((index.error as Error).message)}
            </p>
          )}
        </div>
      </div>
    );
  }

  // ---- the search itself ----------------------------------------------------
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Search</h1>
          <p className="sub">
            {status
              ? `${status.indexed.toLocaleString()} photos searchable` +
                (status.pending > 0 ? ` · ${status.pending.toLocaleString()} still being read` : "")
              : " "}
          </p>
        </div>
        {status && status.pending > 0 && (
          <div className="actions">
            <button onClick={() => index.mutate()} disabled={index.isPending}>
              Index the rest
            </button>
          </div>
        )}
      </header>

      {similarId ? (
        <div className="row" style={{ marginBottom: 18 }}>
          <span className="muted">Photos that look like this one</span>
          <button className="ghost small" onClick={() => setParams({}, { replace: true })}>
            Search instead
          </button>
        </div>
      ) : null}
      <div className="search-hero" style={similarId ? { display: "none" } : undefined}>
        <span className="ico">
          <IconSearch size={20} />
        </span>
        <input
          type="text"
          autoFocus
          value={text}
          placeholder="Describe the photo — “sunset over the sea”, “my dog on a sofa”"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setText("")}
        />
        {text && (
          <button className="ghost small" onClick={() => setText("")}>
            Clear
          </button>
        )}
      </div>

      {chips.length > 0 && (
        <div className="q-chips">
          <span className="muted small">Understood</span>
          {chips.map((c, i) => (
            <span key={`${c.kind}-${c.label}-${i}`} className={`q-chip ${c.kind}`}>
              {c.label}
            </span>
          ))}
        </div>
      )}
      {!query && !similarId ? (
        <div className="empty">
          <p>
            Type what the photo shows, not what the file is called. Nothing was tagged for this —
            Smriti looked at the pictures.
          </p>
          <div className="row" style={{ justifyContent: "center", marginTop: 4 }}>
            {SUGGESTIONS.map((s) => (
              <button key={s} className="small" onClick={() => setText(s)}>
                {s}
              </button>
            ))}
          </div>
        </div>
      ) : busy && items.length === 0 ? (
        <PhotoGridSkeleton />
      ) : items.length === 0 ? (
        <div className="empty">
          {similarId ? (
            <p>Nothing else in the library looks much like that one.</p>
          ) : (
            <p>
              Nothing here looks like “{query}”. Try describing it more plainly — a scene rather
              than a name, since Smriti only knows what the pictures show.
            </p>
          )}
        </div>
      ) : (
        <>
          <p className="muted small" style={{ margin: "0 0 12px" }}>
            {items.length} {items.length === 1 ? "photo" : "photos"}
            {scored ? ", closest first" : ", newest first"}
          </p>
          <div ref={containerRef}>
            <JustifiedGrid items={items} width={width} onOpen={(i) => setLightboxIdx(i)} />
          </div>
        </>
      )}

      {lightboxIdx !== null && items[lightboxIdx] && (
        <Lightbox
          item={items[lightboxIdx]}
          onClose={() => setLightboxIdx(null)}
          onPrev={lightboxIdx > 0 ? () => setLightboxIdx(lightboxIdx - 1) : undefined}
          onNext={lightboxIdx < items.length - 1 ? () => setLightboxIdx(lightboxIdx + 1) : undefined}
        />
      )}
    </div>
  );
}
