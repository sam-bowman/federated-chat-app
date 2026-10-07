// Checked in this order: a runtime config injected into the page at
// container *startup* (env-config.js - see client/docker-entrypoint.sh),
// then the value Vite baked in at *build* time (VITE_API_URL), then a
// localhost default for plain `npm run dev`. The runtime check is what lets
// one built Docker image be pointed at any server without rebuilding it -
// import.meta.env.VITE_API_URL alone is fixed forever once a static build
// exists, which isn't useful for an image meant to be reused across
// different self-hosted deployments.
declare global {
  interface Window {
    __RUNTIME_CONFIG__?: { API_URL?: string };
  }
}

const API_URL = window.__RUNTIME_CONFIG__?.API_URL || import.meta.env.VITE_API_URL || "http://localhost:4000";

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
    refreshPromise = fetch(`${API_URL}/api/v1/auth/refresh`, {
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
    return fetch(`${API_URL}${path}`, {
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
  const base = API_URL.replace(/^http/, "ws");
  return `${base}/ws?token=${encodeURIComponent(token ?? "")}`;
}

export function mediaUrl(path: string): string {
  if (path.startsWith("http")) return path;
  return `${API_URL}${path}`;
}
