import { useQueryClient } from "@tanstack/react-query";
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { api } from "../api/client";

/** Locked Folder session state. The vault session token lives only in this
 * provider's memory (never localStorage), thumbnails/previews are fetched
 * with the session header into Object URLs that are revoked on relock, and
 * the folder relocks automatically when the tab hides, the page unloads, or
 * the auto-lock timeout passes without activity. */

export interface LockedStatus {
  configured: boolean;
  damaged: boolean;
  unlocked: boolean;
  webauthn_enrolled: boolean;
  lockout_seconds: number;
  auto_lock_seconds: number;
}

export interface LockedItem {
  vault_id: string;
  state: string;
  filename: string;
  media_type: "photo" | "video";
  size_bytes: number;
  taken_at: string | null;
  width: number | null;
  height: number | null;
  duration_s: number | null;
  locked_at: number;
  warning?: string | null;
}

interface LockedApi {
  token: string | null;
  touchIdAvailable: boolean;
  setupPin: (pin: string) => Promise<void>;
  unlockPin: (pin: string) => Promise<void>;
  unlockTouchId: () => Promise<void>;
  enrollTouchId: () => Promise<void>;
  removeTouchId: () => Promise<void>;
  lock: () => void;
  authedFetch: (url: string, init?: RequestInit) => Promise<Response>;
  authedJson: <T>(method: string, url: string, body?: unknown) => Promise<T>;
  loadImage: (url: string) => Promise<string>;
  mintStreamToken: (vaultId: string) => Promise<string>;
}

const Ctx = createContext<LockedApi | null>(null);

const b64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const b64d = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n));

export function LockedProvider({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  const [token, setToken] = useState<string | null>(null);
  const tokenRef = useRef<string | null>(null);
  const urlsRef = useRef<Map<string, string>>(new Map());
  const inflightRef = useRef<Map<string, Promise<string>>>(new Map());
  const idleTimer = useRef<number | null>(null);
  const autoLockSecs = useRef(300);
  tokenRef.current = token;

  const dropLocal = useCallback(() => {
    setToken(null);
    tokenRef.current = null;
    for (const url of urlsRef.current.values()) URL.revokeObjectURL(url);
    urlsRef.current.clear();
    inflightRef.current.clear();
    qc.removeQueries({ queryKey: ["locked", "items"] });
    qc.invalidateQueries({ queryKey: ["locked", "status"] });
  }, [qc]);

  const lock = useCallback(() => {
    const t = tokenRef.current;
    dropLocal();
    if (t) api.post("/api/locked/lock", { token: t }).catch(() => {});
  }, [dropLocal]);

  const adopt = useCallback(async (t: string) => {
    setToken(t);
    tokenRef.current = t;
    try {
      const s = await api.get<LockedStatus>("/api/locked/status");
      autoLockSecs.current = s.auto_lock_seconds || 300;
    } catch {
      /* keep default */
    }
    qc.invalidateQueries({ queryKey: ["locked"] });
  }, [qc]);

  const authedFetch = useCallback(async (url: string, init?: RequestInit) => {
    const t = tokenRef.current;
    if (!t) throw new Error("locked");
    const r = await fetch(url, {
      ...init,
      headers: { ...(init?.headers as Record<string, string>), "X-Vault-Session": t },
    });
    if (r.status === 401) {
      dropLocal();
      throw new Error("Locked Folder was locked — unlock it again.");
    }
    return r;
  }, [dropLocal]);

  const authedJson = useCallback(async <T,>(method: string, url: string, body?: unknown): Promise<T> => {
    const r = await authedFetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) {
      let detail = r.statusText;
      try {
        detail = (await r.json()).detail ?? detail;
      } catch { /* not json */ }
      throw new Error(detail);
    }
    return r.json();
  }, [authedFetch]);

  const loadImage = useCallback(async (url: string) => {
    const cached = urlsRef.current.get(url);
    if (cached) return cached;
    const pending = inflightRef.current.get(url);
    if (pending) return pending;
    const p = (async () => {
      const r = await authedFetch(url);
      if (!r.ok) throw new Error("no image");
      const obj = URL.createObjectURL(await r.blob());
      urlsRef.current.set(url, obj);
      inflightRef.current.delete(url);
      return obj;
    })();
    inflightRef.current.set(url, p);
    return p;
  }, [authedFetch]);

  const mintStreamToken = useCallback(async (vaultId: string) => {
    const r = await authedJson<{ token: string }>("POST", "/api/locked/stream-token", { vault_id: vaultId });
    return r.token;
  }, [authedJson]);

  const setupPin = useCallback(async (pin: string) => {
    const r = await api.post<{ token: string }>("/api/locked/setup", { pin });
    await adopt(r.token);
  }, [adopt]);

  const unlockPin = useCallback(async (pin: string) => {
    const r = await api.post<{ token: string }>("/api/locked/unlock", { pin });
    await adopt(r.token);
  }, [adopt]);

  // WebAuthn PRF: the authenticator's PRF output (only produced after
  // Touch ID / passcode verification) unwraps the vault key server-side.
  const touchIdAvailable =
    typeof window !== "undefined" && !!window.PublicKeyCredential && location.hostname === "localhost";

  const enrollTouchId = useCallback(async () => {
    if (!touchIdAvailable) throw new Error("Biometric unlock needs http://localhost");
    const prfSalt = rand(32);
    const cred = (await navigator.credentials.create({
      publicKey: {
        challenge: rand(32),
        rp: { name: "Smriti", id: location.hostname },
        user: { id: rand(16), name: "smriti-locked", displayName: "Smriti Locked Folder" },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
        authenticatorSelection: {
          authenticatorAttachment: "platform",
          userVerification: "required",
          residentKey: "preferred",
        },
        extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
    if (!cred) throw new Error("enrollment was cancelled");
    const ext = cred.getClientExtensionResults() as { prf?: { enabled?: boolean } };
    if (!ext.prf?.enabled) throw new Error("This browser doesn't support biometric unlock (PRF)");
    // create() doesn't reliably evaluate PRF — do an immediate get() for the output
    const assertion = (await navigator.credentials.get({
      publicKey: {
        challenge: rand(32),
        allowCredentials: [{ type: "public-key", id: cred.rawId }],
        userVerification: "required",
        extensions: { prf: { eval: { first: prfSalt } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
    const out = (assertion?.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } })
      ?.prf?.results?.first;
    if (!out) throw new Error("This browser doesn't support biometric unlock (PRF)");
    await authedJson("POST", "/api/locked/webauthn/enroll", {
      credential_id: b64(cred.rawId),
      prf_salt: b64(prfSalt.buffer as ArrayBuffer),
      prf_output: b64(out),
    });
    qc.invalidateQueries({ queryKey: ["locked", "status"] });
  }, [touchIdAvailable, authedJson, qc]);

  const unlockTouchId = useCallback(async () => {
    const req = await api.get<{ challenge: string; credentials: { id: string; prf_salt: string }[] }>(
      "/api/locked/webauthn/request"
    );
    const cred = req.credentials[0];
    if (!cred) throw new Error("no biometric credential enrolled");
    const assertion = (await navigator.credentials.get({
      publicKey: {
        challenge: rand(32),
        allowCredentials: [{ type: "public-key", id: b64d(cred.id).buffer as ArrayBuffer }],
        userVerification: "required",
        extensions: { prf: { eval: { first: b64d(cred.prf_salt) } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
    const out = (assertion?.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } })
      ?.prf?.results?.first;
    if (!out) throw new Error("biometric unlock failed");
    const r = await api.post<{ token: string }>("/api/locked/webauthn/unlock", {
      credential_id: cred.id,
      prf_output: b64(out),
    });
    await adopt(r.token);
  }, [adopt]);

  const removeTouchId = useCallback(async () => {
    await authedJson("POST", "/api/locked/webauthn/remove", {});
    qc.invalidateQueries({ queryKey: ["locked", "status"] });
  }, [authedJson, qc]);

  // auto-relock: tab hidden, page unload, or idle past the auto-lock timeout
  useEffect(() => {
    if (!token) return;
    const onVisibility = () => {
      if (document.hidden) lock();
    };
    const onPageHide = () => {
      const t = tokenRef.current;
      if (t) {
        navigator.sendBeacon(
          "/api/locked/lock",
          new Blob([JSON.stringify({ token: t })], { type: "application/json" })
        );
      }
    };
    const resetIdle = () => {
      if (idleTimer.current) window.clearTimeout(idleTimer.current);
      idleTimer.current = window.setTimeout(lock, autoLockSecs.current * 1000);
    };
    resetIdle();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pointermove", resetIdle);
    window.addEventListener("pointerdown", resetIdle);
    window.addEventListener("keydown", resetIdle);
    return () => {
      if (idleTimer.current) window.clearTimeout(idleTimer.current);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pointermove", resetIdle);
      window.removeEventListener("pointerdown", resetIdle);
      window.removeEventListener("keydown", resetIdle);
    };
  }, [token, lock]);

  const value: LockedApi = {
    token, touchIdAvailable, setupPin, unlockPin, unlockTouchId, enrollTouchId,
    removeTouchId, lock, authedFetch, authedJson, loadImage, mintStreamToken,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLocked(): LockedApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useLocked outside LockedProvider");
  return v;
}
