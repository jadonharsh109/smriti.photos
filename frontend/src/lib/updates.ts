/** One place that knows whether an update is waiting — shared, because two
 *  parts of the app speak for it: the notice pinned to the rail and the
 *  "Check for updates" row in Settings. Both drive the same sheet, so neither
 *  can contradict the other or open a second copy of it.
 *
 *  A module store rather than context: the shell can tell us about an update
 *  before React has mounted anything, and this way nothing has to be mounted
 *  for the answer to be remembered. */

import { useSyncExternalStore } from "react";

import {
  checkForUpdates,
  installUpdate,
  isDesktop,
  onShellEvent,
  pendingUpdate,
  type UpdateInfo,
  type UpdateProgress,
} from "./desktop";

export interface UpdateState {
  /** The newer build we know about, from either check. */
  available: UpdateInfo | null;
  /** The sheet is showing. The rail notice stays whether it is or not. */
  sheetOpen: boolean;
  /** A check is in flight. Only ever an asked-for one. */
  checking: boolean;
  /** How the last *asked-for* check landed, so the button can answer for
   *  itself. Null once it has been read and moved on from. */
  answer: "current" | "offline" | null;
  /** Non-null from the moment an update is accepted until it fails. */
  progress: UpdateProgress | null;
  error: string | null;
}

let state: UpdateState = {
  available: null,
  sheetOpen: false,
  checking: false,
  answer: null,
  progress: null,
  error: null,
};

const listeners = new Set<() => void>();

function set(patch: Partial<UpdateState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Stable identity between changes — useSyncExternalStore requires it. */
export const snapshot = (): UpdateState => state;

let wired = false;

/** Connect to the shell. Idempotent, and a no-op in a plain browser, where
 *  updates are whatever the package manager says they are. */
export function startUpdates(): void {
  if (wired || !isDesktop()) return;
  wired = true;

  // Ask as well as listen: the automatic check runs about ten seconds after
  // launch, when the loaded document is usually still the splash, so by the
  // time this page exists the event it emitted has already been and gone.
  pendingUpdate()
    .then((found) => found && set({ available: found }))
    .catch(() => {});

  onShellEvent<UpdateInfo>("update://available", (found) => set({ available: found }));
  onShellEvent<UpdateProgress>("update://progress", (progress) => set({ progress, error: null }));
  onShellEvent<string>("update://failed", (error) => set({ progress: null, error }));
}

/** Check now. Opens the sheet if there is something to show. */
export async function check(): Promise<void> {
  if (state.checking || state.progress) return;
  set({ checking: true, answer: null, error: null });
  try {
    const result = await checkForUpdates();
    if (result.status === "available") {
      const { version, current, notes } = result;
      set({ checking: false, available: { version, current, notes }, sheetOpen: true });
    } else {
      // "current" clears anything a previous check left pending — it may have
      // been installed some other way since.
      set({
        checking: false,
        available: result.status === "current" ? null : state.available,
        answer: result.status,
      });
    }
  } catch {
    set({ checking: false, answer: "offline" });
  }
}

/** Accept. From here the shell reports through events until it restarts. */
export function install(): void {
  if (state.progress) return;
  set({
    error: null,
    sheetOpen: true,
    progress: { phase: "downloading", downloaded: 0, total: 0, pct: 0 },
  });
  installUpdate().catch((e) => set({ progress: null, error: String(e) }));
}

export const openSheet = () => set({ sheetOpen: true, answer: null });

/** "Later". The rail notice stays, so the offer is never lost — only quiet. */
export const closeSheet = () => set({ sheetOpen: false, answer: null });

export const clearAnswer = () => set({ answer: null });

/** Read the store from a component. */
export const useUpdates = (): UpdateState => useSyncExternalStore(subscribe, snapshot);
