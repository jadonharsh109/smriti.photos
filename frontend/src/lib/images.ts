/** Where an image comes from.
 *
 *  In the desktop app the shell serves cached thumbnails, previews, face crops
 *  and originals straight from disk over its own URL scheme, and announces
 *  which form it uses (`smriti://localhost` on macOS and Linux,
 *  `http://smriti.localhost` on Windows) in `data-smriti-images` on <html>.
 *  Anything carrying a Locked-section token stays on the Python routes, which
 *  are the only place the token can be checked; so does every browser. */
const base = (): string | null =>
  typeof document === "undefined" ? null : document.documentElement.getAttribute("data-smriti-images");

const pick = (shell: string, api: string, qs: string) => {
  const b = !qs ? base() : null;
  return b ? `${b}${shell}` : `${api}${qs}`;
};

export const thumbUrl = (id: number, qs = "") => pick(`/thumb/${id}`, `/api/thumb/${id}`, qs);
export const previewUrl = (id: number, qs = "") => pick(`/preview/${id}`, `/api/preview/${id}`, qs);
export const faceUrl = (faceId: number, qs = "") => pick(`/face/${faceId}`, `/api/faces/${faceId}/thumb`, qs);
export const mediaUrl = (id: number, qs = "") => pick(`/media/${id}`, `/api/media/${id}`, qs);
