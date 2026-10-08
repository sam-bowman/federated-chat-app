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
    // The `cors` package with a fixed-string origin always echoes that
    // configured value, never the request's actual Origin - so the
    // assertion here isn't "no header", it's "still the one configured
    // origin, not a wildcard and not whatever the caller sent." A real
    // browser on evil.example would see this value, see it doesn't match
    // its own origin, and refuse to read the response - that's the
    // enforcement; this test just confirms the fix didn't touch it.
    const res = await api.post("/api/v1/auth/login").set("Origin", "http://evil.example").send({});

    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
  });
});
