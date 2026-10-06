import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiRequest, clearTokens, ensureFreshAccessToken, setTokens } from "./client";

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

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
