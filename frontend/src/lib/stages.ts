/** Every word the app says about background work, in one place.
 *
 * This used to live in two files that disagreed — the sidebar said "Indexing"
 * while the setup page said "Index" for the same job — and neither knew about
 * `classify`, so sorting Documents surfaced the raw kind. Wording a user sees
 * in two places at once has to come from one place.
 */

/** Short label: the activity log and the sidebar progress card. */
const LABEL: Record<string, string> = {
  scan: "Finding photos",
  geocode: "Finding places",
  events: "Building trips",
  neardup: "Finding duplicates",
  faces: "Finding faces",
  recluster: "Grouping people",
  models: "Downloading models",
  classify: "Sorting documents",
  remove: "Removing a folder",
  blur: "Checking sharpness",
  takeout: "Importing from Google",
};

/** Full sentence: what the library page says while that stage is running.
 *  Written to be understood by someone who has never opened a terminal — no
 *  "index", no "geocode", no "cluster". */
const SENTENCE: Record<string, string> = {
  scan: "Looking through your folders",
  geocode: "Working out where photos were taken",
  events: "Grouping photos into trips",
  neardup: "Looking for duplicates",
  faces: "Finding faces",
  recluster: "Grouping people",
  models: "Downloading the face models",
  classify: "Sorting out screenshots and scans",
  remove: "Removing a folder from your library",
  blur: "Checking your photos for blur",
  takeout: "Unpacking your Google Takeout",
};

/** Stages slow enough that silence reads as a hang. Faces on a 40k-photo
 *  library runs for hours; saying so is kinder than a stalled-looking bar. */
const NOTE: Record<string, string> = {
  faces: "This one takes a while on a big library — you can keep browsing.",
  models: "About 280 MB, downloaded once.",
  takeout: "Your .zip files are only read, never changed. The repaired photos land in a folder — adding it to your library is up to you.",
};

/** What the counter is counting, so "9,847" reads as something. */
const UNIT: Record<string, string> = {
  scan: "photos found so far",
  faces: "photos checked",
  geocode: "photos placed",
  neardup: "photos compared",
  classify: "photos sorted",
  remove: "photos removed",
  blur: "photos checked",
  takeout: "photos and videos copied",
};

export const stageLabel = (kind: string) => LABEL[kind] ?? kind;
export const stageSentence = (kind: string) => SENTENCE[kind] ?? stageLabel(kind);
export const stageNote = (kind: string) => NOTE[kind] ?? null;
export const stageUnit = (kind: string) => UNIT[kind] ?? "done";

/** Turn a raw error into something a person can act on.
 *
 * Job failures arrive as Python exception strings (`_guard` in
 * backend/app/jobs/runner.py formats them as "TypeError: ..."), and API errors
 * arrive as FastAPI `detail` strings. Neither belongs in front of someone who
 * just wanted to add a folder — but both stay verbatim in the activity log,
 * where they are the whole point. */
export function friendlyError(raw: unknown, kind?: string): string {
  const msg = String(raw ?? "").replace(/^Error:\s*/, "");
  const has = (s: string) => msg.toLowerCase().includes(s);

  if (has("not a directory")) return "That folder no longer exists. Pick another one.";
  if (has("offline") || has("not mounted") || has("no such volume"))
    return "That drive isn't connected. Plug it in and try again.";
  if (has("permission") || has("denied") || has("eacces"))
    return "Smriti isn't allowed to read that folder. Check its permissions in System Settings.";
  if (has("no space") || has("enospc")) return "The disk is full. Free up some space and try again.";
  if (has("already")) return "That's already running. Give it a moment to finish.";
  if (has("brokenprocesspool")) return "Processing stopped unexpectedly. Try again — open Advanced for details.";
  if (has("network") || has("urlerror") || has("timed out"))
    return "Couldn't reach the download. Check your connection and try again.";

  const what = kind ? stageSentence(kind).toLowerCase() : "working on your library";
  return `Something went wrong while ${what}. Open Advanced for the details.`;
}
