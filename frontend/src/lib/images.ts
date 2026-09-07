/** Where images come from.
 *
 * In a browser every thumbnail, preview, face crop and original is one HTTP
 * request to the Python server — about two milliseconds each, and never more
 * than six at a time, which is the connection limit a browser keeps per host.
 * Inside the desktop app the shell serves the same files straight from disk
 * over its own URL scheme, with no connection limit and no Python in the
 * path (desktop/src-tauri/src/assets.rs). The shell announces that scheme on
 * `<html data-smriti-images>`; the attribute is absent in a plain browser, so
 * these helpers fall back to the `/api/` routes there.
 *
 * The one exception is deliberate: the Locked section. The shell refuses
 * anything belonging to a locked file, so a request that carries the unlock
 * token (`?lt=…`, the only query string these URLs ever take) stays on the
 * Python route that knows how to check it. */

const base = (): string | null =>
  typeof document === "undefined" ? null : document.documentElement.getAttribute("data-smriti-images");

/** The grid thumbnail (512 px WebP). */
export const thumbUrl = (id: number, qs = ""): string => {
  const b = base();
  return b && !qs ? `${b}/thumb/${id}` : `/api/thumb/${id}${qs}`;
};

/** The 1600 px viewer preview; for a video, its poster frame. */
export const previewUrl = (id: number, qs = ""): string => {
  const b = base();
  return b && !qs ? `${b}/preview/${id}` : `/api/preview/${id}${qs}`;
};

/** The crop the People page draws for one face. */
export const faceUrl = (faceId: number, qs = ""): string => {
  const b = base();
  return b && !qs ? `${b}/face/${faceId}` : `/api/faces/${faceId}/thumb${qs}`;
};

/** The original, for the viewer's <video> and the Live Photo clip. Not for
 *  downloads: those keep the Python route, whose path ends in the filename so
 *  the saved file gets its name. */
export const mediaUrl = (id: number, qs = ""): string => {
  const b = base();
  return b && !qs ? `${b}/media/${id}` : `/api/media/${id}${qs}`;
};
