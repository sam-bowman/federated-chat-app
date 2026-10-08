// Checked in this order: a runtime config injected into the page at
// container *startup* (env-config.js - see client/docker-entrypoint.sh),
// then the value Vite baked in at *build* time (VITE_API_URL). Either one
// present means "fixed-server mode" - this deployment only ever talks to
// one server, exactly as before the home-server picker existed. Neither
// present means "picker mode" - there's no default server, and the app
// resolves one at login time instead (see discovery.ts, AuthContext.tsx).
declare global {
  interface Window {
    __RUNTIME_CONFIG__?: { API_URL?: string };
  }
}

export interface HomeServer {
  /** Scheme+host+port only - e.g. "http://localhost:4000". Never a path. */
  origin: string;
  domain: string;
  serverName: string;
  registrationEnabled: boolean;
}

const HOME_SERVER_KEY = "chat.homeServer";
// Promoted from a private constant in WsContext.tsx so the "clear session
// state when switching servers" logic here and the sync-catchup code there
// agree on one literal instead of duplicating the string.
export const SYNC_CURSOR_KEY = "chat.syncCursor";

function readFixedOrigin(): string | null {
  return window.__RUNTIME_CONFIG__?.API_URL || import.meta.env.VITE_API_URL || null;
}

export function isFixedServerMode(): boolean {
  return readFixedOrigin() !== null;
}

let currentServer: HomeServer | null = null;
let initialized = false;

function ensureInitialized() {
  if (initialized) return;
  initialized = true;

  const fixedOrigin = readFixedOrigin();
  if (fixedOrigin) {
    // domain/serverName aren't known yet - AuthContext does a best-effort
    // background .well-known fetch against this origin and calls
    // setHomeServer() to fill them in for display. That's allowed even in
    // fixed mode as long as the origin itself doesn't change (see below).
    currentServer = { origin: fixedOrigin, domain: "", serverName: "", registrationEnabled: true };
    return;
  }

  const stored = localStorage.getItem(HOME_SERVER_KEY);
  if (stored) {
    try {
      currentServer = JSON.parse(stored);
    } catch {
      currentServer = null;
    }
  }
}

/** The server this client is currently pointed at, or null if none is resolved yet (picker mode, fresh client). */
export function getHomeServer(): HomeServer | null {
  ensureInitialized();
  return currentServer;
}

/**
 * In picker mode, this is how the entry step / "switch server" action
 * points the client at a resolved server. In fixed mode, changing the
 * *origin* is refused (the deployment's configured server can't be
 * switched away from) - but the same-origin case is allowed through, so
 * AuthContext's background discovery can still fill in domain/serverName
 * for display without that being a special case.
 */
export function setHomeServer(server: HomeServer) {
  ensureInitialized();
  if (isFixedServerMode()) {
    if (server.origin !== currentServer?.origin) {
      console.warn("setHomeServer: ignoring attempt to change the server origin in fixed-server mode");
      return;
    }
    currentServer = server;
    return;
  }
  currentServer = server;
  localStorage.setItem(HOME_SERVER_KEY, JSON.stringify(server));
  refreshPromise = null;
}

/** No-op in fixed mode - there's nothing to clear back to. */
export function clearHomeServer() {
  ensureInitialized();
  if (isFixedServerMode()) return;
  currentServer = null;
  localStorage.removeItem(HOME_SERVER_KEY);
  localStorage.removeItem(SYNC_CURSOR_KEY);
  refreshPromise = null;
}

export function resetHomeServerStateForTests() {
  currentServer = null;
  initialized = false;
}

function requireOrigin(): string {
  const server = getHomeServer();
  if (!server) throw new Error("requireOrigin: called with no home server resolved yet");
  return server.origin;
}

const ACCESS_TOKEN_KEY = "chat.accessToken";
const REFRESH_TOKEN_KEY = "chat.refreshToken";

export function getAccessToken(): string | null {
  return localStorage.getItem(ACCESS_TOKEN_KEY);
}

export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_TOKEN_KEY);
}

export function setTokens(accessToken: string, refreshToken: string) {
  localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
  localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
}

export function clearTokens() {
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
}

export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, body: unknown) {
    super(typeof body === "object" && body && "error" in body ? String((body as any).error) : `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

let refreshPromise: Promise<boolean> | null = null;

export async function refreshAccessToken(): Promise<boolean> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;

  if (!refreshPromise) {
    refreshPromise = fetch(`${requireOrigin()}/api/v1/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    })
      .then(async (res) => {
        if (!res.ok) return false;
        const data = await res.json();
        setTokens(data.accessToken, data.refreshToken);
        return true;
      })
      .catch(() => false)
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  isForm?: boolean;
  skipAuth?: boolean;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, isForm, skipAuth } = options;

  const doFetch = async (): Promise<Response> => {
    const headers: Record<string, string> = {};
    if (!isForm && body !== undefined) headers["Content-Type"] = "application/json";
    if (!skipAuth) {
      const token = getAccessToken();
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    return fetch(`${requireOrigin()}${path}`, {
      method,
      headers,
      body: isForm ? (body as FormData) : body !== undefined ? JSON.stringify(body) : undefined,
    });
  };

  let res = await doFetch();

  if (res.status === 401 && !skipAuth && path !== "/api/v1/auth/refresh") {
    const refreshed = await refreshAccessToken();
    if (refreshed) res = await doFetch();
  }

  if (!res.ok) {
    let parsedBody: unknown = null;
    try {
      parsedBody = await res.json();
    } catch {
      // no JSON body
    }
    throw new ApiError(res.status, parsedBody);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

function decodeJwtExpiryMs(token: string): number | null {
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

// The WebSocket has no equivalent of apiRequest's "retry once after a 401
// refresh" - a connection rejected for an expired token just closes, and the
// reconnect loop would otherwise keep retrying with that same stale token
// forever (nothing else ever refreshes it if no REST call happens to need
// one). Call this before every (re)connect attempt so a token that's expired
// or about to expire gets refreshed first.
export async function ensureFreshAccessToken(): Promise<string | null> {
  const token = getAccessToken();
  if (!token) return null;
  const expiresAt = decodeJwtExpiryMs(token);
  const REFRESH_BUFFER_MS = 10_000;
  if (expiresAt !== null && expiresAt - Date.now() > REFRESH_BUFFER_MS) return token;
  await refreshAccessToken();
  return getAccessToken();
}

export function wsUrl(): string {
  const token = getAccessToken();
  const base = requireOrigin().replace(/^http/, "ws");
  return `${base}/ws?token=${encodeURIComponent(token ?? "")}`;
}

const ABSOLUTE_HTTP_URL = /^https?:\/\//i;

// path is server-controlled data (an attachment/avatar/emoticon URL) that
// gets rendered directly into an <img src>/<a href> - explicitly requiring
// an http(s) scheme before trusting it as already-absolute means a
// malicious scheme (javascript:, data:, etc.) can never reach the DOM
// unmodified; it just becomes an inert path segment on this origin instead.
export function mediaUrl(path: string): string {
  if (ABSOLUTE_HTTP_URL.test(path)) return path;
  const relativePath = path.startsWith("/") ? path : `/${path}`;
  return `${requireOrigin()}${relativePath}`;
}
