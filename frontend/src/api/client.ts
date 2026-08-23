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
  photo_count: number;
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

export function filterQS(f: Filters, extra: Record<string, string | number> = {}): string {
  const p = new URLSearchParams();
  if (f.person_id != null) p.set("person_id", String(f.person_id));
  if (f.country != null) p.set("country", f.country);
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
 * don't keep late cards invisible (the animation uses `backwards` fill). */
export function cardDelay(i: number): { animationDelay: string } {
  return { animationDelay: `${Math.min(i * 45, 450)}ms` };
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
