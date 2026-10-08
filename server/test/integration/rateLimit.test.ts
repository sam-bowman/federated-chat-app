// Deliberately separate from test/setupEnv.ts's generous defaults (which
// exist so ordinary test traffic across the rest of the suite - e.g. a
// single file registering a dozen users - never trips rate limiting
// incidentally). This file hard-overrides those defaults back down to
// small numbers so it can actually exercise the 429 behavior, the same
// way presenceFanout.test.ts hard-overrides REDIS_URL for its own file only.
process.env.RATE_LIMIT_MAX = "5";
process.env.AUTH_RATE_LIMIT_MAX = "2";

const { api } = await import("../helpers/app.js");
const { disconnectDb, resetDb } = await import("../helpers/db.js");

import { afterAll, beforeEach, describe, expect, it } from "vitest";

beforeEach(resetDb);
afterAll(async () => {
  await disconnectDb();
  // Integration test files share one worker process (fileParallelism:
  // false, singleFork: true) and process.env is genuinely global even
  // though each file gets its own isolated module graph - without this,
  // these small limits would leak into whichever file runs next.
  delete process.env.RATE_LIMIT_MAX;
  delete process.env.AUTH_RATE_LIMIT_MAX;
});

describe("rate limiting (in-memory store, no REDIS_URL)", () => {
  it("enforces the stricter auth limit before the general limit, and the general limit for everything else", async () => {
    // AUTH_RATE_LIMIT_MAX=2: authLimiter stacks on top of the app-level
    // generalLimiter for /api/v1/auth/* (see app.ts) - it's an additional,
    // tighter check on the same requests, not an independent budget.
    for (let i = 0; i < 2; i++) {
      const res = await api.post("/api/v1/auth/login").send({ username: "nobody", password: "wrong" });
      expect(res.status).toBe(401); // wrong credentials, not yet rate-limited
    }
    const blockedByAuth = await api.post("/api/v1/auth/login").send({ username: "nobody", password: "wrong" });
    expect(blockedByAuth.status).toBe(429);

    // All 3 login attempts above also counted against the general limiter
    // (RATE_LIMIT_MAX=5), since it sits in front of every /api/v1 route,
    // auth included. 2 requests remain before a non-auth route trips it.
    for (let i = 0; i < 2; i++) {
      const res = await api.get("/api/v1/communities");
      expect(res.status).not.toBe(429);
    }
    const blockedByGeneral = await api.get("/api/v1/communities");
    expect(blockedByGeneral.status).toBe(429);
  });
});
