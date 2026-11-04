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
  getRefreshToken,
  setHomeServer,
  startSignedInSession,
  type HomeServer,
} from "./client";
import { listSessions } from "../lib/accountSessions";

function fakeJwt(expiresInSeconds: number): string {
  const payload = { exp: Math.floor(Date.now() / 1000) + expiresInSeconds };
  const base64url = (obj: unknown) => btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${base64url({ alg: "none" })}.${base64url(payload)}.signature`;
}

/** Signs someone in on whatever server the client is pointed at, as the sign-in calls do: their tokens are kept and this tab uses them. */
const signedIn = (accessToken: string, refreshToken: string) => startSignedInSession({ username: "alice" }, accessToken, refreshToken);

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
  sessionStorage.clear();
  import.meta.env.VITE_API_URL = DEFAULT_VITE_API_URL;
  resetHomeServerStateForTests();
});

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
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

  // The origin is typed text on its way into every request and image URL; a stored one that is not
  // http(s) must not be used (it would otherwise be the base of <img src> for avatars and emoticons).
  it.each(["javascript:alert(1)", "data:text/html,x", "ftp://files.example", "//no-scheme.example", ""])(
    "refuses a stored origin that is not http(s): %j",
    (origin) => {
      localStorage.setItem("chat.homeServer", JSON.stringify({ ...sampleServer, origin }));
      resetHomeServerStateForTests();

      expect(() => mediaUrl("/uploads/a.png")).toThrow("not an http(s) URL");
    }
  );

  it("uses a stored https origin", () => {
    setHomeServer({ ...sampleServer, origin: "https://chat.example" });

    expect(mediaUrl("/uploads/a.png")).toBe("https://chat.example/uploads/a.png");
  });

  it("clears the stored server on clearHomeServer, and signs nobody out", () => {
    setHomeServer(sampleServer);
    signedIn("access", "refresh");

    clearHomeServer();

    expect(getHomeServer()).toBeNull();
    expect(localStorage.getItem("chat.homeServer")).toBeNull();
    // The accounts signed in on this device are their own list: "switch server" is about where to sign in next.
    expect(listSessions()).toHaveLength(1);
  });
});

describe("ensureFreshAccessToken", () => {
  it("returns null when there is no stored access token", async () => {
    const result = await ensureFreshAccessToken();
    expect(result).toBeNull();
  });

  it("returns the existing token without calling refresh when it isn't close to expiring", async () => {
    const token = fakeJwt(300);
    signedIn(token, "refresh-token");
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
    signedIn(fakeJwt(-5), "refresh-token");
    const fetchMock = vi.fn(async (_url?: string) =>
      jsonResponse({ accessToken: fakeJwt(900), refreshToken: "new-refresh-token" })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await ensureFreshAccessToken();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("/api/v1/auth/refresh");
    expect(result).not.toBeNull();
    expect(getRefreshToken()).toBe("new-refresh-token");
  });

  it("deduplicates concurrent refresh calls into a single network request", async () => {
    signedIn(fakeJwt(-5), "refresh-token");
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
  it("sends the extra headers it is given, and they can never replace who the request is from or what it carries", async () => {
    signedIn(fakeJwt(900), "refresh-token");
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await apiRequest("/api/v1/admin/x", {
      method: "POST",
      body: { a: 1 },
      headers: { "X-Admin-Sudo": "sudo-token", Authorization: "Bearer attacker", "Content-Type": "text/plain" },
    });

    const sent = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(sent["X-Admin-Sudo"]).toBe("sudo-token");
    expect(sent.Authorization).toMatch(/^Bearer ey/); // the person's own token, not the one passed in
    expect(sent["Content-Type"]).toBe("application/json");
  });

  it("retries once after a 401 if the refresh succeeds", async () => {
    signedIn(fakeJwt(900), "refresh-token");
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

// Several accounts on one device (#49): the tokens a request carries are those of the account THIS TAB uses, and only for the server that issued them.
describe("accounts on this device", () => {
  const serverA: HomeServer = { origin: "http://localhost:4000", domain: "alice.test", serverName: "A", registrationEnabled: true };
  const serverB: HomeServer = { origin: "http://localhost:4001", domain: "bob.test", serverName: "B", registrationEnabled: true };

  beforeEach(() => {
    import.meta.env.VITE_API_URL = "";
    resetHomeServerStateForTests();
  });

  it("sends the token of the account in use, and the other accounts' tokens to no one", async () => {
    setHomeServer(serverA);
    startSignedInSession({ username: "alice" }, "alice-access", "alice-refresh");
    startSignedInSession({ username: "carol" }, "carol-access", "carol-refresh");
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    await apiRequest("/api/v1/users/me");

    expect((fetchMock.mock.calls[0][1].headers as Record<string, string>).Authorization).toBe("Bearer carol-access");
  });

  it("never sends a token to a server other than the one that issued it, so adding an account on another server leaks nothing", async () => {
    setHomeServer(serverA);
    startSignedInSession({ username: "alice" }, "alice-access", "alice-refresh");
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    setHomeServer(serverB); // the sign-in step of adding an account: the tab points elsewhere, alice is still signed in
    await apiRequest("/api/v1/users/me");
    await ensureFreshAccessToken();

    expect((fetchMock.mock.calls[0][1].headers as Record<string, string>).Authorization).toBeUndefined();
    expect(getRefreshToken()).toBeNull();
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes("/auth/refresh"))).toBe(true);
    expect(listSessions()).toHaveLength(1); // not signed out
  });

  it("refreshing keeps the new tokens for the account that was refreshed", async () => {
    setHomeServer(serverA);
    startSignedInSession({ username: "alice" }, fakeJwt(-5), "alice-refresh");
    startSignedInSession({ username: "carol" }, "carol-access", "carol-refresh");
    sessionStorage.setItem("chat.activeAccount", `${serverA.origin}|alice`);
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ accessToken: fakeJwt(900), refreshToken: "alice-refresh-2" })));

    await ensureFreshAccessToken();

    const kept = Object.fromEntries(listSessions().map((s) => [s.username, s.refreshToken]));
    expect(kept).toEqual({ alice: "alice-refresh-2", carol: "carol-refresh" });
  });

  it("clearTokens signs out the account in use and no other", () => {
    setHomeServer(serverA);
    startSignedInSession({ username: "alice" }, "a", "r");
    startSignedInSession({ username: "carol" }, "c", "r2");

    clearTokens();

    expect(listSessions().map((s) => s.username)).toEqual(["alice"]);
  });

  it("a tab that is signed in uses its account's server, not the one remembered for the next sign-in", () => {
    setHomeServer(serverA);
    startSignedInSession({ username: "alice" }, "a", "r");
    setHomeServer(serverB); // another tab moved the remembered server
    resetHomeServerStateForTests(); // this tab is reloaded

    expect(getHomeServer()).toMatchObject({ origin: serverA.origin, domain: "alice.test" });
  });

  it("carries tokens from before accounts were kept over, so an update does not sign anyone out", () => {
    localStorage.setItem("chat.homeServer", JSON.stringify(serverA));
    localStorage.setItem("chat.accessToken", "old-access");
    localStorage.setItem("chat.refreshToken", "old-refresh");
    resetHomeServerStateForTests();

    expect(getHomeServer()?.origin).toBe(serverA.origin);
    expect(getRefreshToken()).toBe("old-refresh");
    expect(localStorage.getItem("chat.accessToken")).toBeNull();
  });
});
