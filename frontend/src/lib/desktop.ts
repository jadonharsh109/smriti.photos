/** The few things the desktop shell can do that a browser tab cannot.
 *
 * The SPA is served by the local Python server, which Tauri treats as a *remote*
 * origin, so IPC is inert there unless a capability grants it. Everything below
 * is listed in `desktop/src-tauri/capabilities/spa.json` and nothing else is —
 * see that file for why each one is open.
 *
 * Commands are invoked by name rather than through `@tauri-apps/api`, so the
 * frontend gains no npm dependency on the shell it may not be running inside.
 */

type Unlisten = () => void;

interface TauriGlobal {
  core?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
  event?: {
    listen?: (name: string, handler: (e: { payload: unknown }) => void) => Promise<Unlisten>;
  };
}

const tauri = (): TauriGlobal | null =>
  (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__ ?? null;

/** True inside the desktop app. Set by an init script on <html>, so it is
 *  available before React mounts and is false in any browser. */
export const isDesktop = () =>
  typeof document !== "undefined" && document.documentElement.hasAttribute("data-smriti-desktop");

async function invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  const fn = tauri()?.core?.invoke;
  if (!fn) throw new Error("not running in the desktop app");
  return fn(cmd, args);
}

/** Subscribe to an event the shell emits. Returns a synchronous unsubscribe,
 *  safe to call before the listener has finished registering. */
export function onShellEvent<T>(name: string, handler: (payload: T) => void): Unlisten {
  const listen = tauri()?.event?.listen;
  if (!listen) return () => {};
  let stop: Unlisten | null = null;
  let dropped = false;
  listen(name, (e) => handler(e.payload as T))
    .then((off) => {
      if (dropped) off();
      else stop = off;
    })
    .catch(() => {});
  return () => {
    dropped = true;
    stop?.();
  };
}

/** Open a link in the user's real browser.
 *
 * In the desktop app a plain <a> would navigate the app itself away from the
 * library, so it goes through the shell. In a browser it is just a new tab. */
export async function openExternal(url: string): Promise<void> {
  if (!isDesktop()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  try {
    await invoke("plugin:opener|open_url", { url });
  } catch {
    window.open(url, "_blank", "noopener,noreferrer"); // better than nothing
  }
}

/** Hand the coordinates to a real map — deliberately, and only when asked.
 *
 * Smriti fetches no map tiles, so street-level detail is something only another
 * app can offer. On a Mac that is Apple Maps, which needs no network of its own
 * for the handoff; everywhere else it is OpenStreetMap in the user's own
 * browser. Either way it takes a click, and the request then comes from an app
 * the user opened rather than from a photo library sitting in the background. */
export async function openInMaps(lat: number, lon: number, label?: string): Promise<void> {
  const mac = typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);
  const url =
    isDesktop() && mac
      ? `maps://?ll=${lat},${lon}&q=${encodeURIComponent(label?.trim() || "Photo")}`
      : `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=15/${lat}/${lon}`;
  await openExternal(url);
}

/* ------------------------------------------------------------------ updates */

/** A newer build, as the shell describes it. */
export interface UpdateInfo {
  /** The version on offer. */
  version: string;
  /** The version running right now. */
  current: string;
  /** Release notes, one `- item` per line, as the release workflow wrote them. */
  notes: string;
}

/** The three ways a check can land. */
export type CheckResult =
  | ({ status: "available" } & UpdateInfo)
  | { status: "current"; current: string }
  | { status: "offline"; error: string };

export interface UpdateProgress {
  phase: "downloading" | "installing" | "restarting";
  downloaded: number;
  /** 0 when the server sent no content-length. */
  total: number;
  /** 0..100, and 0 for as long as `total` is unknown. */
  pct: number;
}

/** Ask the shell to check now, and say what it found. Desktop only. */
export const checkForUpdates = () => invoke("check_updates_now") as Promise<CheckResult>;

/** What the automatic check turned up, if anything. It runs ~10s after launch —
 *  usually before this page exists — so its event is long gone by now. */
export const pendingUpdate = () => invoke("pending_update") as Promise<UpdateInfo | null>;

/** Accept the pending update. Progress arrives as `update://` events; on
 *  success the app restarts, so this resolving means only that it started. */
export const installUpdate = () => invoke("install_update") as Promise<void>;

export const REPO_URL = "https://github.com/jadonharsh109/smriti.photos";
