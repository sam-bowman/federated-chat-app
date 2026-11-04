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

import {
  adoptLegacySession,
  getActiveId,
  getActiveSession,
  getSyncCursor,
  listSessions,
  removeSession,
  sameOrigin,
  setSyncCursor,
  startSession,
  updateTokens,
  type AccountSession,
} from "../lib/accountSessions";

export interface HomeServer {
  /** Scheme+host+port only - e.g. "http://localhost:4000". Never a path. */
  origin: string;
  domain: string;
  serverName: string;
  registrationEnabled: boolean;
  /** Registration needs an invite code. Absent from a record saved before the server could say so, and from an older server. */
  registrationInviteOnly?: boolean;
}

const HOME_SERVER_KEY = "chat.homeServer";
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
    if (!getActiveSession()) adoptLegacySession(currentServer);
    return;
  }

  // A tab that is signed in to an account uses that account's server: the one remembered for the next sign-in is shared by every tab, and
  // another tab may have moved it to somewhere else since.
  const active = getActiveSession();
  if (active) {
    currentServer = {
      origin: active.origin,
      domain: active.domain,
      serverName: active.serverName,
      registrationEnabled: active.registrationEnabled,
      ...(active.registrationInviteOnly !== undefined ? { registrationInviteOnly: active.registrationInviteOnly } : {}),
    };
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
  adoptLegacySession(currentServer);
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
  refreshPromise = null;
}

export function resetHomeServerStateForTests() {
  currentServer = null;
  initialized = false;
}

function requireOrigin(): string {
  const server = getHomeServer();
  if (!server) throw new Error("requireOrigin: called with no home server resolved yet");
  // The origin starts as text typed into the server box (or comes back out of localStorage), and
  // from here it becomes the start of every request URL and every <img src>. Discovery builds it as
  // http(s), but that is checked where it is made, not where it is used, so a value that got into
  // storage another way (an old version, a hand edit) would be trusted. Check at the point of use.
  const origin = server.origin;
  if (!(origin.startsWith("https://") || origin.startsWith("http://"))) {
    throw new Error("requireOrigin: the home server origin is not an http(s) URL");
  }
  return origin;
}

// The tokens are those of the account THIS TAB is signed in to (lib/accountSessions.ts), and they are only ever handed out for the server
// they were issued by: a tab pointed at another server (the sign-in step of "add an account") sends nobody's token there.
function activeSessionHere(): AccountSession | null {
  const session = getActiveSession();
  const server = getHomeServer();
  return session && server && sameOrigin(session.origin, server.origin) ? session : null;
}

export function getAccessToken(): string | null {
  return activeSessionHere()?.accessToken ?? null;
}

export function getRefreshToken(): string | null {
  return activeSessionHere()?.refreshToken ?? null;
}

/** A refreshed pair of tokens for the account this tab is signed in to. */
export function setTokens(accessToken: string, refreshToken: string) {
  const session = activeSessionHere();
  if (session) updateTokens(session.id, accessToken, refreshToken);
}

/** Someone has just signed in or registered on the server this tab is pointed at: keep their tokens and use them from now on. */
export function startSignedInSession(user: { username: string; identity?: string }, accessToken: string, refreshToken: string) {
  const server = getHomeServer();
  if (!server) throw new Error("startSignedInSession: called with no home server resolved yet");
  startSession({
    origin: server.origin,
    domain: server.domain,
    serverName: server.serverName,
    registrationEnabled: server.registrationEnabled,
    registrationInviteOnly: server.registrationInviteOnly,
    username: user.username,
    identity: user.identity,
    accessToken,
    refreshToken,
  });
}

/** Signs the account this tab is using out of this device (tokens and sync position). Other accounts are not touched. */
export function clearTokens() {
  const id = getActiveId();
  if (id) removeSession(id);
}

/** The accounts signed in on this device that this client can use: in a fixed-server deployment, only those on its one server. */
export function listAccountSessions(): AccountSession[] {
  const fixed = readFixedOrigin();
  return listSessions().filter((session) => !fixed || sameOrigin(session.origin, fixed));
}

/** Where this tab's account got to in the server's event stream. */
export function getActiveSyncCursor(): string | undefined {
  const id = getActiveId();
  return id ? getSyncCursor(id) : undefined;
}

export function setActiveSyncCursor(cursor: string) {
  const id = getActiveId();
  if (id) setSyncCursor(id, cursor);
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
  /** Extra request headers (the admin page's sudo token goes in one). They never replace Authorization or Content-Type. */
  headers?: Record<string, string>;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, isForm, skipAuth, headers: extraHeaders } = options;

  const doFetch = async (): Promise<Response> => {
    const headers: Record<string, string> = { ...extraHeaders };
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

/**
 * POSTs JSON and hands back the response as a file (a download), with the name the server suggested. Signs in again once if the access
 * token had expired, like apiRequest. For something the server streams as an attachment, which is not JSON to parse.
 */
export async function apiDownload(path: string, body: unknown): Promise<{ blob: Blob; filename: string | null }> {
  const doFetch = () => {
    const token = getAccessToken();
    return fetch(`${requireOrigin()}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
  };
  let res = await doFetch();
  if (res.status === 401 && (await refreshAccessToken())) res = await doFetch();
  if (!res.ok) {
    let parsedBody: unknown = null;
    try {
      parsedBody = await res.json();
    } catch {
      // no JSON body
    }
    throw new ApiError(res.status, parsedBody);
  }
  const named = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "");
  return { blob: await res.blob(), filename: named?.[1] ?? null };
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
