// This file configures the server for two browser origins - its web client and
// the desktop app - before anything imports config.ts, the same way
// rateLimit.test.ts overrides its limits. (The rest of the suite runs with the
// single default origin from test/setupEnv.ts.)
process.env.CORS_ORIGIN = "http://localhost:5173, http://tauri.localhost/";

const { api } = await import("../helpers/app.js");
const { disconnectDb } = await import("../helpers/db.js");

import { afterAll, describe, expect, it } from "vitest";

afterAll(async () => {
  await disconnectDb();
  process.env.CORS_ORIGIN = "http://localhost:5173"; // restore setupEnv's value for later files
});

const WEB = "http://localhost:5173";
const DESKTOP = "http://tauri.localhost";

// A server used to accept exactly one origin, so it could serve its web client
// or the desktop app but never both. These run real preflights and requests
// against the real app.
describe("CORS_ORIGIN with more than one origin", () => {
  it("answers each listed origin's real request with that origin", async () => {
    for (const origin of [WEB, DESKTOP]) {
      const res = await api.post("/api/v1/auth/login").set("Origin", origin).send({});
      expect(res.headers["access-control-allow-origin"]).toBe(origin);
      expect(res.headers["access-control-allow-credentials"]).toBe("true");
    }
  });

  it("answers each listed origin's preflight for an API route, naming that origin - not a wildcard", async () => {
    for (const origin of [WEB, DESKTOP]) {
      const res = await api
        .options("/api/v1/auth/login")
        .set("Origin", origin)
        .set("Access-Control-Request-Method", "POST")
        .set("Access-Control-Request-Headers", "content-type,authorization");
      expect(res.status).toBe(204);
      expect(res.headers["access-control-allow-origin"]).toBe(origin);
    }
  });

  it("gives an unlisted origin nothing, on the request and on the preflight", async () => {
    const real = await api.post("/api/v1/auth/login").set("Origin", "http://evil.example").send({});
    expect(real.headers["access-control-allow-origin"]).toBeUndefined();

    // Regression: the well-known router's wildcard CORS used to be mounted
    // without a path, so it answered EVERY preflight on the server with `*`
    // before this policy was consulted.
    const preflight = await api
      .options("/api/v1/auth/login")
      .set("Origin", "http://evil.example")
      .set("Access-Control-Request-Method", "POST");
    expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("keeps .well-known open to any origin, preflight included", async () => {
    const res = await api.get("/.well-known/communication-platform").set("Origin", "http://evil.example");
    expect(res.headers["access-control-allow-origin"]).toBe("*");

    const preflight = await api
      .options("/.well-known/communication-platform")
      .set("Origin", "http://evil.example")
      .set("Access-Control-Request-Method", "GET");
    expect(preflight.headers["access-control-allow-origin"]).toBe("*");
  });
});
