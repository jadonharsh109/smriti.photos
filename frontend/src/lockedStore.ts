/** In-memory unlock token for the Locked section, plus thin API helpers.
 *
 * Never persisted: closing the tab re-locks. The server re-locks too, on two
 * clocks — 15 minutes idle, and an hour whatever you do — and reports the
 * shorter of them as `expires_in` so the page can lock on the second rather
 * than whenever its next poll happens to land. */

let token: string | null = null;

export const getLockedToken = () => token;
export const setLockedToken = (t: string | null) => {
  token = t;
};

/** Query-string form, for <img>/<video> URLs that can't send headers. */
export const lockedQS = () => (token ? `?lt=${encodeURIComponent(token)}` : "");

export interface LockedStatus {
  configured: boolean;
  unlocked: boolean;
  count?: number;
  codes_remaining?: number;
  /** Seconds until the session locks itself. Present only while unlocked. */
  expires_in?: number;
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "X-Locked-Token": token } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!r.ok) {
    let detail = r.statusText;
    try {
      const body = await r.json();
      if (body.detail) detail = body.detail;
    } catch {
      /* not json */
    }
    if (r.status === 401) token = null; // expired or wrong — drop stale token
    const err = new Error(detail) as Error & { status?: number };
    err.status = r.status;
    throw err;
  }
  return r.json();
}

export const lockedApi = {
  status: () => req<LockedStatus>("/api/locked/status"),
  setup: (password: string) =>
    req<{ token: string; backup_codes: string[] }>("/api/locked/setup", {
      method: "POST",
      body: JSON.stringify({ password }),
    }),
  unlock: (password: string) =>
    req<{ token: string }>("/api/locked/unlock", { method: "POST", body: JSON.stringify({ password }) }),
  unlockBackup: (code: string) =>
    req<{ token: string; codes_remaining: number }>("/api/locked/unlock-backup", {
      method: "POST",
      body: JSON.stringify({ code }),
    }),
  changePassword: (new_password: string) =>
    req<{ backup_codes: string[] }>("/api/locked/change-password", {
      method: "POST",
      body: JSON.stringify({ new_password }),
    }),
  lock: () => req<{ ok: boolean }>("/api/locked/lock", { method: "POST" }),
  items: () => req<import("./api/client").Item[]>("/api/locked/items"),
  addItems: (file_ids: number[]) =>
    req<{ ok: boolean; count: number }>("/api/locked/items", {
      method: "POST",
      body: JSON.stringify({ file_ids }),
    }),
  removeItems: (file_ids: number[]) =>
    req<{ ok: boolean }>("/api/locked/items/remove", {
      method: "POST",
      body: JSON.stringify({ file_ids }),
    }),
};
