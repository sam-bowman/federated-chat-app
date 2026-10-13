// Configures the server as if it sat behind ONE reverse proxy (an ingress
// controller) with deliberately tiny auth limits, before anything imports
// config.ts - the same pattern rateLimit.test.ts uses.
process.env.TRUST_PROXY = "1";
process.env.AUTH_RATE_LIMIT_MAX = "2";

const { api } = await import("../helpers/app.js");
const { disconnectDb } = await import("../helpers/db.js");

import { afterAll, describe, expect, it } from "vitest";

afterAll(async () => {
  await disconnectDb();
  delete process.env.TRUST_PROXY;
  delete process.env.AUTH_RATE_LIMIT_MAX;
});

const login = (forwardedFor: string) =>
  api.post("/api/v1/auth/login").set("X-Forwarded-For", forwardedFor).send({ username: "nobody", password: "x" });

// Reproduces what happened behind Traefik on Kubernetes: every request reaches the
// server from the proxy's own address, so without TRUST_PROXY the whole user base
// shared one auth-rate-limit bucket and ten logins by anyone locked out everyone.
// (The default - nothing trusted - is covered by rateLimit.test.ts.)
describe("TRUST_PROXY=1 (one reverse proxy in front)", () => {
  it("gives each real client its own rate-limit bucket, from the proxy's X-Forwarded-For", async () => {
    // Client A uses up its two attempts and is limited...
    expect((await login("203.0.113.10")).status).toBe(401);
    expect((await login("203.0.113.10")).status).toBe(401);
    expect((await login("203.0.113.10")).status).toBe(429);

    // ...while client B, arriving through the same proxy, is untouched.
    expect((await login("203.0.113.20")).status).toBe(401);
  });

  it("only believes the address the nearest proxy appended, not one the client made up", async () => {
    // The client prepends a forged address; the trusted proxy appends the real one
    // (198.51.100.7). With one hop, only the rightmost entry counts, so rotating the
    // forged part must not hand out fresh rate-limit buckets.
    expect((await login("1.1.1.1, 198.51.100.7")).status).toBe(401);
    expect((await login("2.2.2.2, 198.51.100.7")).status).toBe(401);
    expect((await login("3.3.3.3, 198.51.100.7")).status).toBe(429);
  });
});
