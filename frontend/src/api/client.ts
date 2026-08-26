import { isDesktop } from "../lib/desktop";

export interface Bucket {
  day: string;
  count: number;
  /** Summed width/height of the day's media. Lets the grid predict a day's
   *  height before it has fetched a single item — see TimelineGrid. */
  ar?: number;
}

export interface Item {
  id: number;
  media_type: "photo" | "video";
  width: number | null;
  height: number | null;
  duration_s: number | null;
  day: string;
  /** 1 when this still has a motion clip attached (a Live Photo). */
  live?: number;
  /** 1 when this is in the Favourites album. Carried on the item rather than
   *  fetched per grid, so the heart is drawn right the first time. */
  fav?: number;
}

export interface Filters {
  person_id?: number;
  country?: string;
  /** Narrows a country to one of its states. Independent of `city`, so the
   *  Places page's state heading opens on its own. */
  state?: string;
  city?: string;
  album_id?: number;
  event_id?: number;
  /** with person_id: only photos where that person is the sole person */
  solo?: boolean;
  media_type?: "photo" | "video";
  /** "any" = every screenshot/scan; or a specific kind. Omitted from the
   *  timeline, where documents are hidden by default. */
  kind?: "any" | "screenshot" | "document";
  /** only Live Photos — stills that carry a motion clip */
  live?: boolean;
}

export interface Person {
  id: number;
  name: string | null;
  is_hidden: number;
  cover_face_id: number | null;
  /** "manual" once someone has chosen the cover themselves; null while Smriti picks. */
  cover_src: string | null;
  photo_count: number;
}

/** One detected face belonging to a person — a candidate cover. */
export interface PersonFace {
  id: number;
  file_id: number;
  det_score: number;
  assign_src: string | null;
}

export interface Job {
  id: number;
  kind: string;
  status: string;
  total: number;
  done: number;
  errors: number;
  message: string | null;
  root_id: number | null;
  started_at?: number;
  finished_at?: number | null;
}

export interface Volume {
  id: number;
  label: string;
  mount_path: string;
  is_online: boolean;
  internal: boolean;
  free_bytes: number | null;
  total_bytes: number | null;
}

export interface Root {
  id: number;
  rel_path: string;
  volume_id: number;
  label: string;
  is_online: number;
  abs_path: string;
  file_count: number;
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) {
    let detail = r.statusText;
    try {
      const body = await r.json();
      if (body.detail) detail = body.detail;
    } catch {
      /* not json */
    }
    throw new Error(detail);
  }
  return r.json();
}

export const api = {
  get: <T>(url: string) => req<T>(url),
  post: <T>(url: string, body?: unknown) =>
    req<T>(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  patch: <T>(url: string, body: unknown) =>
    req<T>(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  del: <T>(url: string) => req<T>(url, { method: "DELETE" }),
};

/** Can "Show in Finder" mean anything from here?
 *
 * The window opens on whatever machine is serving the library, so the button is
 * only honest when that is also the machine in front of you. The desktop app is
 * always that; a browser is when it is talking to a loopback address. Anyone
 * who has deliberately bound the server to their LAN and opened it from a
 * different room simply doesn't see the button, rather than clicking it and
 * having a Finder window open somewhere they can't see. */
export const canRevealFiles = () =>
  isDesktop() ||
  (typeof location !== "undefined" &&
    ["localhost", "127.0.0.1", "::1", "[::1]"].includes(location.hostname));

/** Ask the server to select this original in Finder / File Explorer. */
export const revealFile = (id: number, qs = "") =>
  api.post<{ ok: boolean; path: string }>(`/api/files/${id}/reveal${qs}`);

/** A search hit: an ordinary grid item, plus how well it answered the query
 *  when a model was involved in deciding. A hit found purely by name, place or
 *  date has no score — it did not rank, it matched. */
export interface SearchItem extends Item {
  score?: number;
}

/** One part of the query Smriti recognised exactly, rather than guessed at. */
export interface SearchChip {
  kind: "person" | "place" | "date" | "album" | "filter";
  label: string;
}

export interface SearchStatus {
  model_ready: boolean;
  model_mb: number;
  indexed: number;
  pending: number;
  total: number;
  ready: boolean;
}

/** What the search box can honestly offer before anyone types. */
export const searchStatus = () => api.get<SearchStatus>("/api/search/status");

/** Rank the library against a sentence. Runs entirely on the serving machine —
 *  the query is never sent anywhere. */
export const searchLibrary = (q: string, limit = 200) =>
  api.get<{ query: string; items: SearchItem[]; chips: SearchChip[]; indexed: number }>(
    `/api/search?q=${encodeURIComponent(q)}&limit=${limit}`
  );

export const downloadSearchModel = () => api.post<{ job_id?: number }>("/api/search/models/download");
export const buildSearchIndex = () => api.post<{ job_id?: number }>("/api/search/index");

/** More photos like this one — the same ranking, with an image as the query. */
export const similarTo = (fileId: number) =>
  api.post<{ items: SearchItem[] }>("/api/search/similar", { file_id: fileId });

/** Every face Smriti has of this person, best first — the covers to choose from. */
export const personFaces = (personId: number, limit = 200) =>
  api.get<PersonFace[]>(`/api/people/${personId}/faces?limit=${limit}`);

/** Choose the face that stands for a person. `null` hands the choice back to Smriti. */
export const setPersonCover = (personId: number, faceId: number | null) =>
  api.post<{ ok: boolean; cover_face_id: number | null; cover_src: string | null }>(
    `/api/people/${personId}/cover`,
    { face_id: faceId }
  );

export function filterQS(f: Filters, extra: Record<string, string | number> = {}): string {
  const p = new URLSearchParams();
  if (f.person_id != null) p.set("person_id", String(f.person_id));
  if (f.country != null) p.set("country", f.country);
  if (f.state != null) p.set("state", f.state);
  if (f.city != null) p.set("city", f.city);
  if (f.album_id != null) p.set("album_id", String(f.album_id));
  if (f.event_id != null) p.set("event_id", String(f.event_id));
  if (f.solo) p.set("solo", "1");
  if (f.media_type) p.set("media_type", f.media_type);
  if (f.kind) p.set("kind", f.kind);
  if (f.live) p.set("live", "1");
  for (const [k, v] of Object.entries(extra)) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

export function fmtBytes(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n;
  let u = -1;
  do {
    v /= 1024;
    u++;
  } while (v >= 1024 && u < units.length - 1);
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[u]}`;
}

export function fmtDuration(s: number | null): string {
  if (s == null) return "";
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/** Every item matching a filter, paging past the server's 2000-row cap.
 *
 * `day` narrows it to one day section. That is not a convenience: the grid used
 * to fetch a day with a bare request and take whatever came back, which is the
 * endpoint's default of 1000 rows. A day holding more than that — a camera
 * dump, a wedding, a bulk import — rendered short with no error, and the
 * photos past the first 1000 were indexed, thumbnailed and unreachable. Worse,
 * "select this day" then covered only the ones that had arrived, so add-to-album
 * and Move to Trash quietly acted on part of a day that looked whole.
 */
export async function fetchAllItems(f: Filters, day?: string): Promise<Item[]> {
  const LIMIT = 2000;
  const out: Item[] = [];
  for (let offset = 0; ; offset += LIMIT) {
    const extra: Record<string, string | number> = { limit: LIMIT, offset };
    if (day != null) extra.day = day;
    const page = await api.get<Item[]>(`/api/timeline/items${filterQS(f, extra)}`);
    out.push(...page);
    if (page.length < LIMIT) break;
  }
  return out;
}

/** Staggered entry delay for the nth card in a grid, capped so long grids
 * don't keep late cards invisible (the animation uses `backwards` fill).
 *
 * Halved inside the desktop app, alongside the shorter `rise` there: a grid
 * that is still staggering itself in half a second after the data landed reads
 * as the app being slow, which is the opposite of what the stagger is for.
 *
 * Past the first screenful the card doesn't animate at all. Not a visual
 * decision — nothing down there is on screen to see it — but a cost one: each
 * animating card is a compositing layer for the half-second it runs, and
 * People on a large library has 253 of them starting at once. Chrome shrugs
 * that off, which is why this only ever looked broken inside the desktop app.
 */
const snappy = isDesktop();
const STAGGER_STEP = snappy ? 22 : 45;
const STAGGER_CAP = snappy ? 220 : 450;

export function cardDelay(i: number): { animationDelay: string } | { animation: string } {
  if (i >= 40) return { animation: "none" };
  return { animationDelay: `${Math.min(i * STAGGER_STEP, STAGGER_CAP)}ms` };
}

export function fmtDay(day: string): string {
  const d = new Date(day + "T12:00:00");
  const now = new Date();
  const opts: Intl.DateTimeFormatOptions =
    d.getFullYear() === now.getFullYear()
      ? { weekday: "short", month: "short", day: "numeric" }
      : { weekday: "short", month: "short", day: "numeric", year: "numeric" };
  return d.toLocaleDateString(undefined, opts);
}

/** Heart or unheart, optimistically.
 *
 * `patch` re-writes whatever list the photo is currently being shown in, so the
 * heart fills under the cursor instead of after a round-trip, and is put back
 * if the server disagrees. Every grid does the same thing with a different
 * cache key, which is the only part it has to supply.
 */
export async function setFavourite(
  id: number,
  on: boolean,
  patch: (fav: 0 | 1) => void
): Promise<void> {
  patch(on ? 1 : 0);
  try {
    await api.post("/api/favourites", { file_ids: [id], on });
  } catch (e) {
    patch(on ? 0 : 1);
    throw e;
  }
}
