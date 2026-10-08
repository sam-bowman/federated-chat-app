import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  apiRequest,
  clearHomeServer,
  clearTokens,
  ensureFreshAccessToken,
  getHomeServer,
  isFixedServerMode,
  mediaUrl,
  resetHomeServerStateForTests,
  setHomeServer,
  setTokens,
  type HomeServer,
} from "./client";

function fakeJwt(expiresInSeconds: number): string {
  const payload = { exp: Math.floor(Date.now() / 1000) + expiresInSeconds };
  const base64url = (obj: unknown) => btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${base64url({ alg: "none" })}.${base64url(payload)}.signature`;
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

// Every test in this file runs in fixed-server mode by default (matching
// how client.ts behaved before the picker existed) - explicitly set here,
// not read from client/.env, since that file is gitignored and local-dev
// only (CI's checkout has no .env at all, so relying on it would pass
// locally and fail in CI). The "picker mode" describe block below
// overrides this in its own nested beforeEach for the tests that need it.
const DEFAULT_VITE_API_URL = "http://localhost:4000";

beforeEach(() => {
  localStorage.clear();
  import.meta.env.VITE_API_URL = DEFAULT_VITE_API_URL;
  resetHomeServerStateForTests();
});

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetHomeServerStateForTests();
});

const sampleServer: HomeServer = {
  origin: "http://localhost:4001",
  domain: "bob.test",
  serverName: "Bob's Server",
  registrationEnabled: true,
};

describe("home server - fixed mode", () => {
  it("reports fixed-server mode (VITE_API_URL set)", () => {
    expect(isFixedServerMode()).toBe(true);
  });

  it("resolves an initial home server from the fixed origin, with no domain/serverName yet", () => {
    const server = getHomeServer();
    expect(server).not.toBeNull();
    expect(server!.origin).toBe("http://localhost:4000");
    expect(server!.domain).toBe("");
  });

  it("refuses to change the origin away from the fixed one", () => {
    const before = getHomeServer();
    setHomeServer(sampleServer); // different origin
    expect(getHomeServer()).toEqual(before);
  });

  it("allows updating display fields for the same (fixed) origin", () => {
    const fixedOrigin = getHomeServer()!.origin;
    setHomeServer({ origin: fixedOrigin, domain: "chat.example.com", serverName: "Example", registrationEnabled: false });
    expect(getHomeServer()).toEqual({
      origin: fixedOrigin,
      domain: "chat.example.com",
      serverName: "Example",
      registrationEnabled: false,
    });
  });

  it("ignores clearHomeServer entirely", () => {
    const before = getHomeServer();
    clearHomeServer();
    expect(getHomeServer()).toEqual(before);
  });
});

describe("home server - picker mode", () => {
  beforeEach(() => {
    // Overrides the file-wide default set above - simulates a deployment
    // with no fixed server configured (desktop app, mobile app, or the
    // client Docker image's multi-server mode). The outer beforeEach runs
    // first (sets DEFAULT_VITE_API_URL and resets state), then this one
    // overrides it and resets state again so the override actually takes.
    import.meta.env.VITE_API_URL = "";
    resetHomeServerStateForTests();
  });

  it("reports picker mode when no fixed origin is configured", () => {
    expect(isFixedServerMode()).toBe(false);
  });

  it("has no home server resolved on a fresh client", () => {
    expect(getHomeServer()).toBeNull();
  });

  it("persists a resolved server to localStorage and returns it on next read", () => {
    setHomeServer(sampleServer);
    expect(getHomeServer()).toEqual(sampleServer);
    expect(JSON.parse(localStorage.getItem("chat.homeServer")!)).toEqual(sampleServer);
  });

  it("restores a previously resolved server from localStorage after re-initializing", () => {
    setHomeServer(sampleServer);
    resetHomeServerStateForTests(); // simulates a fresh page load
    expect(getHomeServer()).toEqual(sampleServer);
  });

  it("clears the stored server and the sync cursor on clearHomeServer", () => {
    setHomeServer(sampleServer);
    localStorage.setItem("chat.syncCursor", "some-cursor");

    clearHomeServer();

    expect(getHomeServer()).toBeNull();
    expect(localStorage.getItem("chat.homeServer")).toBeNull();
    expect(localStorage.getItem("chat.syncCursor")).toBeNull();
  });
});

describe("ensureFreshAccessToken", () => {
  it("returns null when there is no stored access token", async () => {
    const result = await ensureFreshAccessToken();
    expect(result).toBeNull();
  });

  it("returns the existing token without calling refresh when it isn't close to expiring", async () => {
    const token = fakeJwt(300);
    setTokens(token, "refresh-token");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await ensureFreshAccessToken();

    expect(result).toBe(token);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Regression-relevant: a WebSocket reconnect that never refreshes an
  // expired token would leave a user permanently unable to reconnect (stuck
  // appearing offline forever) - this is the fix that WsContext.connect()
  // relies on before every (re)connect attempt.
  it("refreshes the token when it is expired or about to expire", async () => {
    setTokens(fakeJwt(-5), "refresh-token");
    const fetchMock = vi.fn(async (_url?: string) =>
      jsonResponse({ accessToken: fakeJwt(900), refreshToken: "new-refresh-token" })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await ensureFreshAccessToken();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("/api/v1/auth/refresh");
    expect(result).not.toBeNull();
    expect(localStorage.getItem("chat.refreshToken")).toBe("new-refresh-token");
  });

  it("deduplicates concurrent refresh calls into a single network request", async () => {
    setTokens(fakeJwt(-5), "refresh-token");
    let resolveCount = 0;
    const fetchMock = vi.fn(async () => {
      resolveCount += 1;
      return jsonResponse({ accessToken: fakeJwt(900), refreshToken: "new-refresh-token" });
    });
    vi.stubGlobal("fetch", fetchMock);

    await Promise.all([ensureFreshAccessToken(), ensureFreshAccessToken(), ensureFreshAccessToken()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(resolveCount).toBe(1);
  });
});

describe("apiRequest", () => {
  it("retries once after a 401 if the refresh succeeds", async () => {
    setTokens(fakeJwt(900), "refresh-token");
    let callCount = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("/auth/refresh")) {
        return jsonResponse({ accessToken: fakeJwt(900), refreshToken: "new-refresh-token" });
      }
      callCount += 1;
      if (callCount === 1) return new Response(JSON.stringify({ error: "invalid_token" }), { status: 401 });
      return jsonResponse({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await apiRequest<{ ok: boolean }>("/api/v1/users/me");

    expect(result).toEqual({ ok: true });
    expect(callCount).toBe(2);
  });

  it("throws ApiError with the response body when the request fails and isn't retried", async () => {
    clearTokens();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "not_found" }), { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiRequest("/api/v1/users/nobody")).rejects.toMatchObject({
      status: 404,
      body: { error: "not_found" },
    });
  });

  it("returns undefined for a 204 No Content response", async () => {
    clearTokens();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    const result = await apiRequest("/api/v1/friends/x");
    expect(result).toBeUndefined();
  });
});

describe("mediaUrl", () => {
  it("prefixes a relative path with the current origin", () => {
    expect(mediaUrl("/uploads/avatar.png")).toBe("http://localhost:4000/uploads/avatar.png");
  });

  it("adds a leading slash if the path is missing one", () => {
    expect(mediaUrl("uploads/avatar.png")).toBe("http://localhost:4000/uploads/avatar.png");
  });

  it("passes through an already-absolute http(s) URL unchanged (remote federated content)", () => {
    expect(mediaUrl("https://remote.example/uploads/avatar.png")).toBe("https://remote.example/uploads/avatar.png");
  });

  // Regression test: path is server-controlled data rendered directly into
  // an <img src>/<a href> (CodeQL flagged this pattern repo-wide as a
  // DOM-XSS sink). A naive `path.startsWith("http")` check would have let
  // a crafted scheme like "httpevil:" or "javascript:" through unmodified -
  // this asserts any non-http(s) scheme is neutralized into an inert path
  // segment on this origin instead of reaching the DOM as typed.
  it("treats a non-http(s) scheme as a relative path instead of trusting it as absolute", () => {
    expect(mediaUrl("javascript:alert(1)")).toBe("http://localhost:4000/javascript:alert(1)");
    expect(mediaUrl("data:text/html,<script>alert(1)</script>")).toBe(
      "http://localhost:4000/data:text/html,<script>alert(1)</script>"
    );
  });
});
