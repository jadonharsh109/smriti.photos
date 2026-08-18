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

interface TauriGlobal {
  core?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
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

/** Ask the shell to check for a new version. Desktop only — the shell shows its
 *  own dialogs for all three outcomes (update / up to date / offline). */
export async function checkForUpdates(): Promise<void> {
  await invoke("check_updates_now");
}

export const REPO_URL = "https://github.com/jadonharsh109/smriti.photos";
