import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";

beforeEach(resetDb);
afterAll(disconnectDb);

describe("GET /.well-known/communication-platform", () => {
  it("returns the server-discovery document", async () => {
    const res = await api.get("/.well-known/communication-platform");

    expect(res.status).toBe(200);
    expect(res.body.domain).toBe("test.local");
    expect(res.body.serverName).toBe("Test Server");
    expect(res.body.apiBase).toBe("/api/v1");
    expect(res.body.websocketPath).toBe("/ws");
    expect(res.body.registration.enabled).toBe(true);
    expect(res.body.federation.enabled).toBe(true);
    expect(res.body.federation.publicKey).toEqual(expect.any(String));
  });

  // Regression test: a browser-based home-server picker needs to fetch this
  // document from a domain the user just typed in, which by definition isn't
  // in CORS_ORIGIN's allowlist - so this route carries its own permissive
  // CORS (see wellknown.ts), mounted before the app-wide policy (app.ts).
  // This asserts that fix without over-reaching: every other route must
  // still enforce the single configured origin.
  it("allows any origin to read the response", async () => {
    const res = await api.get("/.well-known/communication-platform").set("Origin", "http://evil.example");

    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  it("does not loosen CORS on other routes", async () => {
    // The app-wide policy is a list of allowed origins (CORS_ORIGIN): a listed
    // origin is echoed back, any other gets no allow-origin header at all - so a
    // real browser on evil.example is refused the response. This confirms the
    // permissive well-known policy above did not leak onto other routes.
    const stranger = await api.post("/api/v1/auth/login").set("Origin", "http://evil.example").send({});
    expect(stranger.headers["access-control-allow-origin"]).toBeUndefined();

    const listed = await api.post("/api/v1/auth/login").set("Origin", "http://localhost:5173").send({});
    expect(listed.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
  });
});
