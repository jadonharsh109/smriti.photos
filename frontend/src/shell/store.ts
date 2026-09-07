/** The shell's shared state: small external stores read with
 *  useSyncExternalStore, so a change made anywhere — a keyboard shortcut, the
 *  status bar, a grid — re-renders exactly the components that read it.
 *
 *  Selectors must return something referentially stable when nothing changed
 *  (a primitive, or a value already held in the state), or React will loop. */
import { useSyncExternalStore } from "react";
import type { Job } from "../api/client";
import { isDesktop, setUiZoom } from "../lib/desktop";
import { PALETTES, type PaletteId } from "./palettes";

export function createStore<T extends object>(initial: T) {
  let state = initial;
  const subs = new Set<() => void>();
  const subscribe = (fn: () => void) => {
    subs.add(fn);
    return () => {
      subs.delete(fn);
    };
  };
  const set = (patch: Partial<T> | ((s: T) => Partial<T>)) => {
    const p = typeof patch === "function" ? patch(state) : patch;
    state = { ...state, ...p };
    subs.forEach((fn) => fn());
  };
  function use<U>(sel: (s: T) => U): U {
    return useSyncExternalStore(subscribe, () => sel(state), () => sel(state));
  }
  return { get: () => state, set, use, subscribe };
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode, quota — a preference that does not stick is not an error */
  }
}

/* ---- theme ---------------------------------------------------------------- */
export type ThemeMode = "system" | "light" | "dark";
export const theme = createStore<{ mode: ThemeMode }>({ mode: read<ThemeMode>("smriti.theme", "system") });

export function applyTheme(mode: ThemeMode) {
  const el = document.documentElement;
  // a palette is light or dark by nature and says so for the window
  const pal = PALETTES.find((p) => p.id === currentPalette());
  const effective = pal && pal.scheme !== "auto" ? pal.scheme : mode;
  if (effective === "system") el.removeAttribute("data-theme");
  else el.setAttribute("data-theme", effective);
}
let paletteId: PaletteId = "smriti";
const currentPalette = () => paletteId;
export function setTheme(mode: ThemeMode) {
  theme.set({ mode });
  write("smriti.theme", mode);
  applyTheme(mode);
  savePrefs();
}
applyTheme(theme.get().mode);

/* ---- appearance: accent, style, size --------------------------------- */
export type Accent = "auto" | "saffron" | "rani" | "teal" | "blue" | "violet" | "graphite";
export type UiStyle = "minimal" | "vibrant";
/** "auto" is the palette's own accent — saffron for Smriti's, mauve for
 *  Catppuccin, frost for Nord — and the others override it. */
export const ACCENTS: { id: Accent; label: string; swatch: string }[] = [
  { id: "auto", label: "Theme's own", swatch: "" },
  { id: "saffron", label: "Saffron", swatch: "#d8781a" },
  { id: "rani", label: "Rani", swatch: "#d8397a" },
  { id: "teal", label: "Teal", swatch: "#1a9a8f" },
  { id: "blue", label: "Blue", swatch: "#3373e0" },
  { id: "violet", label: "Violet", swatch: "#8659d8" },
  { id: "graphite", label: "Graphite", swatch: "#6b6b74" },
];
export const UI_SCALES: { value: number; label: string }[] = [
  { value: 0.9, label: "Compact" },
  { value: 1, label: "Default" },
  { value: 1.1, label: "Large" },
  { value: 1.25, label: "Larger" },
];
export const ui = createStore<{ palette: PaletteId; accent: Accent; style: UiStyle; scale: number }>({
  palette: read<PaletteId>("smriti.palette", "smriti"),
  accent: read<Accent>("smriti.accent", "auto"),
  style: read<UiStyle>("smriti.style", "minimal"),
  scale: read<number>("smriti.scale", 1),
});
export function applyUi() {
  const u = ui.get();
  const el = document.documentElement;
  paletteId = PALETTES.some((p) => p.id === u.palette) ? u.palette : "smriti";
  if (paletteId === "smriti") el.removeAttribute("data-palette");
  else el.setAttribute("data-palette", paletteId);
  applyTheme(theme.get().mode);
  if (u.accent === "auto") el.removeAttribute("data-accent");
  else el.setAttribute("data-accent", u.accent);
  if (u.style === "minimal") el.removeAttribute("data-style");
  else el.setAttribute("data-style", u.style);
  // the shell scales the page the way browser zoom would; a plain browser has its own
  if (isDesktop()) setUiZoom(u.scale).catch((e) => console.warn("ui zoom:", e));
}
export function setPalette(palette: PaletteId) {
  ui.set({ palette });
  write("smriti.palette", palette);
  applyUi();
  savePrefs();
}
export function setAccent(accent: Accent) {
  ui.set({ accent });
  write("smriti.accent", accent);
  applyUi();
  savePrefs();
}
export function setUiStyle(style: UiStyle) {
  ui.set({ style });
  write("smriti.style", style);
  applyUi();
  savePrefs();
}
export function setUiScale(scale: number) {
  ui.set({ scale });
  write("smriti.scale", scale);
  applyUi();
  savePrefs();
}
applyUi();

/* ---- sidebar ------------------------------------------------------------- */
export const side = createStore<{ albumsOpen: boolean }>({ albumsOpen: read("smriti.side.albums", true) });
export function setAlbumsOpen(albumsOpen: boolean) {
  side.set({ albumsOpen });
  write("smriti.side.albums", albumsOpen);
  savePrefs();
}

/* ---- view: thumbnail size, select mode ----------------------------------- */
export const TILE_MIN = 96;
export const TILE_MAX = 280;
export const view = createStore<{ tileHeight: number; selecting: boolean }>({
  tileHeight: Math.min(TILE_MAX, Math.max(TILE_MIN, read("smriti.tile", 150))),
  selecting: false,
});
export function setTileHeight(h: number) {
  const v = Math.min(TILE_MAX, Math.max(TILE_MIN, Math.round(h)));
  view.set({ tileHeight: v });
  write("smriti.tile", v);
  savePrefs();
}
export const setSelecting = (selecting: boolean) => view.set({ selecting });

/* ---- selection ------------------------------------------------------------ */
/** One selection for the whole window: the grid that owns the screen writes
 *  it, the toolbar, status bar and inspector read it. `order` is the visible
 *  order the owning grid has loaded, for shift-click ranges and arrow keys. */
export const selection = createStore<{ ids: Set<number>; anchor: number | null; last: number | null; order: number[] }>({
  ids: new Set(),
  anchor: null,
  last: null,
  order: [],
});

export const selectionActions = {
  clear: () => selection.set({ ids: new Set(), anchor: null, last: null }),
  setOrder: (order: number[]) => selection.set({ order }),
  /** Plain click: this one, and only this one. */
  select: (id: number) => selection.set({ ids: new Set([id]), anchor: id, last: id }),
  /** Cmd/Ctrl-click, or a click in select mode. */
  toggle: (id: number) =>
    selection.set((s) => {
      const ids = new Set(s.ids);
      if (ids.has(id)) ids.delete(id);
      else ids.add(id);
      return { ids, anchor: ids.has(id) ? id : s.anchor, last: id };
    }),
  /** Shift-click: everything between the anchor and this, in visible order. */
  range: (id: number) =>
    selection.set((s) => {
      const anchor = s.anchor ?? id;
      const a = s.order.indexOf(anchor);
      const b = s.order.indexOf(id);
      if (a < 0 || b < 0) return { ids: new Set([...s.ids, id]), last: id, anchor: s.anchor ?? id };
      const [lo, hi] = a < b ? [a, b] : [b, a];
      const ids = new Set(s.ids);
      for (let i = lo; i <= hi; i++) ids.add(s.order[i]);
      return { ids, last: id, anchor };
    }),
  setMany: (list: number[], on: boolean) =>
    selection.set((s) => {
      const ids = new Set(s.ids);
      for (const id of list) on ? ids.add(id) : ids.delete(id);
      return { ids };
    }),
  replace: (list: number[]) => selection.set({ ids: new Set(list), anchor: list[0] ?? null, last: list[list.length - 1] ?? null }),
};

/* ---- inspector ------------------------------------------------------------ */
/** `subject` is what the Info panel describes: the item open in the viewer
 *  while one is, else the last selected item. `qs` carries the Locked
 *  section's token when the subject lives there. */
export const inspector = createStore<{ open: boolean; subject: number | null; qs: string }>({
  open: read("smriti.inspector", false),
  subject: null,
  qs: "",
});
export function setInspectorOpen(open: boolean) {
  inspector.set({ open });
  write("smriti.inspector", open);
  savePrefs();
}

/* ---- the window's look, remembered by the server ------------------------- */
/** localStorage is the fast path for the first paint, but it is per origin —
 *  and the desktop app serves the page from a fresh ephemeral port on every
 *  launch, so it forgot the thumbnail size each time. The server's settings
 *  are the copy that lasts; this loads them once and writes every change back. */
interface UiPrefs {
  theme?: ThemeMode;
  palette?: PaletteId;
  tile?: number;
  inspector?: boolean;
  accent?: Accent;
  style?: UiStyle;
  scale?: number;
  sideAlbums?: boolean;
}
let prefsLoaded = false;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
function collectPrefs(): UiPrefs {
  return {
    theme: theme.get().mode,
    palette: ui.get().palette,
    tile: view.get().tileHeight,
    inspector: inspector.get().open,
    accent: ui.get().accent,
    style: ui.get().style,
    scale: ui.get().scale,
    sideAlbums: side.get().albumsOpen,
  };
}
export function savePrefs() {
  if (!prefsLoaded) return; // never overwrite the server's copy with this origin's defaults
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ui: collectPrefs() }) }).catch(() => {});
  }, 400);
}
export async function loadPrefs() {
  if (prefsLoaded) return;
  try {
    const r = await fetch("/api/settings");
    const u: UiPrefs = (await r.json()).ui ?? {};
    if (u.theme === "system" || u.theme === "light" || u.theme === "dark") {
      theme.set({ mode: u.theme });
      write("smriti.theme", u.theme);
      applyTheme(u.theme);
    }
    if (typeof u.tile === "number") {
      const v = Math.min(TILE_MAX, Math.max(TILE_MIN, Math.round(u.tile)));
      view.set({ tileHeight: v });
      write("smriti.tile", v);
    }
    if (typeof u.inspector === "boolean") {
      inspector.set({ open: u.inspector });
      write("smriti.inspector", u.inspector);
    }
    if (typeof u.sideAlbums === "boolean") {
      side.set({ albumsOpen: u.sideAlbums });
      write("smriti.side.albums", u.sideAlbums);
    }
    const palette = PALETTES.find((p) => p.id === u.palette)?.id;
    const accent = ACCENTS.find((a) => a.id === u.accent)?.id;
    const style = u.style === "vibrant" || u.style === "minimal" ? u.style : undefined;
    const scale = UI_SCALES.find((x) => x.value === u.scale)?.value;
    if (palette || accent || style || scale) {
      ui.set({ ...(palette ? { palette } : {}), ...(accent ? { accent } : {}), ...(style ? { style } : {}), ...(scale ? { scale } : {}) });
      write("smriti.palette", ui.get().palette);
      write("smriti.accent", ui.get().accent);
      write("smriti.style", ui.get().style);
      write("smriti.scale", ui.get().scale);
    }
    applyUi();
    prefsLoaded = true;
    // a library that has never stored a look gets this window's as the start
    if (Object.keys(u).length === 0) savePrefs();
  } catch {
    prefsLoaded = true; // offline or old server: behave as before, per origin
  }
}
export const setInspectorSubject = (subject: number | null, qs = "") => inspector.set({ subject, qs });

/* ---- preferences sheet ---------------------------------------------------- */
export type PrefsTab = "library" | "indexing" | "appearance" | "advanced";
export const prefs = createStore<{ open: boolean; tab: PrefsTab }>({ open: false, tab: "library" });
export const openPrefs = (tab: PrefsTab = "library") => prefs.set({ open: true, tab });
export const closePrefs = () => prefs.set({ open: false });

/* ---- background work, from the server's event stream -------------------- */
export interface DriveToast {
  id: number;
  kind: "in" | "out";
  label: string;
}
export const jobs = createStore<{ byId: Record<number, Job>; toasts: DriveToast[]; log: string[] }>({
  byId: {},
  toasts: [],
  log: [],
});

let stream: EventSource | null = null;
let toastSeq = 0;

/** One EventSource for the whole window. The status bar and Preferences both
 *  read from here; they used to each open their own stream. `onJobDone` and
 *  `onVolumes` let the shell refresh queries without this module knowing
 *  about react-query. */
export function startJobStream(onJobSettled: () => void, onVolumes: () => void): void {
  if (stream) return;
  stream = new EventSource("/api/jobs/stream");
  stream.addEventListener("job", (e) => {
    const job: Job = JSON.parse((e as MessageEvent).data);
    jobs.set((s) => ({
      byId: { ...s.byId, [job.id]: job },
      log: [...s.log.slice(-299), fmtLogLine(job)],
    }));
    if (job.status !== "running") onJobSettled();
  });
  stream.addEventListener("volumes", (e) => {
    const d: { attached: { label: string }[]; removed: { label: string }[] } = JSON.parse((e as MessageEvent).data);
    const fresh: DriveToast[] = [
      ...d.attached.map((a) => ({ id: ++toastSeq, kind: "in" as const, label: a.label })),
      ...d.removed.map((r) => ({ id: ++toastSeq, kind: "out" as const, label: r.label })),
    ];
    if (fresh.length) {
      jobs.set((s) => ({ toasts: [...s.toasts, ...fresh] }));
      for (const t of fresh) {
        setTimeout(() => jobs.set((s) => ({ toasts: s.toasts.filter((x) => x.id !== t.id) })), 6000);
      }
    }
    onVolumes();
  });
}

export function fmtLogLine(j: Job, time = new Date().toLocaleTimeString()): string {
  return (
    `${time}  ${j.kind} · ${j.status}` +
    (j.total > 0 ? ` ${j.done}/${j.total}` : "") +
    (j.errors ? ` (${j.errors} errors)` : "") +
    (j.message ? ` — ${j.message}` : "")
  );
}

export const runningJob = (byId: Record<number, Job>): Job | undefined =>
  Object.values(byId)
    .filter((j) => j.status === "running")
    .sort((a, b) => b.id - a.id)[0];
