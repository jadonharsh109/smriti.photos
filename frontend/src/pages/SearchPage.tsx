import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  buildSearchIndex,
  downloadSearchModel,
  searchLibrary,
  searchStatus,
  setFavourite,
  similarTo,
  type SearchChip,
  type SearchItem,
} from "../api/client";
import FlatGrid from "../components/FlatGrid";
import { GridControls, StandardSelection } from "../shell/GridToolbar";
import { TbButton, Toolbar, ToolbarSearch } from "../shell/Toolbar";

/** A few things worth trying, so an empty box isn't a blank stare. */
const SUGGESTIONS = ["sunset", "a group of friends", "food", "mountains", "a document", "at the beach"];

export default function SearchPage() {
  const [params, setParams] = useSearchParams();
  const urlQ = params.get("q") ?? "";
  // "Find similar", handed over from the viewer: the same ranking with a
  // photo as the query instead of a sentence.
  const similarId = Number(params.get("similar")) || null;
  const [text, setText] = useState(urlQ);
  const [query, setQuery] = useState(urlQ);
  const qc = useQueryClient();

  const { data: status } = useQuery({
    queryKey: ["search-status"],
    queryFn: searchStatus,
    refetchInterval: (q) => (q.state.data && q.state.data.pending > 0 ? 2000 : false),
  });

  useEffect(() => {
    const t = setTimeout(() => {
      const next = text.trim();
      setQuery(next);
      if (!next && similarId) return;
      setParams(next ? { q: next } : {}, { replace: true });
    }, 250);
    return () => clearTimeout(t);
  }, [text, similarId, setParams]);

  const { data, isFetching } = useQuery({
    queryKey: ["search", query],
    queryFn: () => searchLibrary(query),
    enabled: !similarId && query.length > 0 && !!status?.ready,
    placeholderData: (prev) => prev,
  });
  const { data: like, isFetching: findingLike } = useQuery({
    queryKey: ["search-similar", similarId],
    queryFn: () => similarTo(similarId!),
    enabled: !!similarId && !!status?.ready,
  });

  const getModel = useMutation({ mutationFn: downloadSearchModel, onSettled: () => qc.invalidateQueries({ queryKey: ["search-status"] }) });
  const index = useMutation({ mutationFn: buildSearchIndex, onSettled: () => qc.invalidateQueries({ queryKey: ["search-status"] }) });

  const items: SearchItem[] = useMemo(() => (similarId ? like?.items ?? [] : data?.items ?? []), [similarId, like, data]);
  const busy = similarId ? findingLike : isFetching;
  const chips: SearchChip[] = similarId ? [] : data?.chips ?? [];
  const scored = items.some((it) => it.score != null);

  const toggleFav = (id: number, on: boolean) =>
    setFavourite(id, on, (fav) => {
      const patch = <T extends { items: SearchItem[] }>(prev: T | undefined) =>
        prev && { ...prev, items: prev.items.map((it) => (it.id === id ? { ...it, fav } : it)) };
      if (similarId) qc.setQueryData<{ items: SearchItem[] }>(["search-similar", similarId], patch);
      else qc.setQueryData<{ query: string; items: SearchItem[]; chips: SearchChip[]; indexed: number }>(["search", query], patch);
    })
      .then(() => qc.invalidateQueries({ queryKey: ["albums"] }))
      .catch(() => {});

  const sub = status
    ? `${status.indexed.toLocaleString()} searchable` + (status.pending > 0 ? ` · ${status.pending.toLocaleString()} still being read` : "")
    : null;

  const toolbar = (
    <Toolbar title="Search" count={items.length ? `${items.length.toLocaleString()} ${scored ? "closest first" : "newest first"}` : sub}>
      <StandardSelection />
      {status?.ready && !similarId && (
        <ToolbarSearch value={text} onChange={setText} placeholder="Describe the photo — “sunset over the sea”" autoFocus />
      )}
      {status && status.pending > 0 && status.model_ready && (
        <TbButton onClick={() => index.mutate()} disabled={index.isPending}>Index the Rest</TbButton>
      )}
      <GridControls />
    </Toolbar>
  );

  if (status && !status.model_ready)
    return (
      <>
        {toolbar}
        <div className="empty">
          <h2>Search by what a photo shows</h2>
          <p>
            Needs a model — about {status.model_mb} MB, downloaded once. It then runs on this machine, like everything else here: what you search for never leaves it.
          </p>
          <div className="row">
            <button className="btn primary" onClick={() => getModel.mutate()} disabled={getModel.isPending}>Download the Search Model</button>
          </div>
          {getModel.error ? <p className="note bad" style={{ marginTop: 8 }}>{String((getModel.error as Error).message)}</p> : null}
        </div>
      </>
    );

  if (status && status.model_ready && status.indexed === 0)
    return (
      <>
        {toolbar}
        <div className="empty">
          <h2>The model is ready</h2>
          <p>Smriti now needs to look at your {status.total.toLocaleString()} photos once and remember what is in each — after that, searching is instant.</p>
          <div className="row">
            <button className="btn primary" onClick={() => index.mutate()} disabled={index.isPending}>Make My Photos Searchable</button>
          </div>
          {index.error ? <p className="note bad" style={{ marginTop: 8 }}>{String((index.error as Error).message)}</p> : null}
        </div>
      </>
    );

  return (
    <>
      {toolbar}
      {similarId ? (
        <div className="row" style={{ padding: "10px 12px 0" }}>
          <span className="muted small">Photos that look like the one you picked</span>
          <button className="btn small" onClick={() => setParams({}, { replace: true })}>Search Instead</button>
        </div>
      ) : chips.length > 0 ? (
        <div className="row chips" style={{ padding: "10px 12px 0" }}>
          <span className="muted small">Understood</span>
          {chips.map((c, i) => (
            <span key={`${c.kind}-${c.label}-${i}`} className={`chip ${c.kind}`}>{c.label}</span>
          ))}
        </div>
      ) : null}
      {!query && !similarId ? (
        <div className="empty">
          <p>Type what the photo shows, not what the file is called. Nothing was tagged for this — Smriti looked at the pictures.</p>
          <div className="row wrap">
            {SUGGESTIONS.map((s) => (
              <button key={s} className="btn small" onClick={() => setText(s)}>{s}</button>
            ))}
          </div>
        </div>
      ) : busy && items.length === 0 ? (
        <div className="page" style={{ display: "grid", gap: 12, paddingTop: 16 }}>
          <div className="skel" style={{ height: 150 }} />
          <div className="skel" style={{ height: 150 }} />
        </div>
      ) : (
        <FlatGrid
          items={items}
          onToggleFav={toggleFav}
          positionLabel={similarId ? "similar" : `“${query}”`}
          emptyText={similarId ? "Nothing else in the library looks much like that one." : `Nothing here looks like “${query}”. Try describing the scene more plainly.`}
        />
      )}
    </>
  );
}
