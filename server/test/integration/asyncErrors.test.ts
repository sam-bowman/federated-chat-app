import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../../src/db.js";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { authHeader, registerUser } from "../helpers/factory.js";

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());
afterAll(disconnectDb);

// Regression tests for a real reliability bug: Express 4 does not catch a
// rejected promise from an async route handler, so any unexpected error
// (a database hiccup, a column the running code doesn't expect) became an
// unhandled rejection that terminated the whole Node process - one bad request
// took the server down for every connected user. Found while rolling a database
// back under an older image; see docs/deployment/upgrading-and-backups.md.
describe("errors thrown inside async route handlers", () => {
  it("become a JSON 500 and leave the server serving", async () => {
    const { accessToken } = await registerUser("victim");
    const spy = vi.spyOn(prisma.user, "findUnique").mockRejectedValueOnce(new Error("simulated database failure"));
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const failed = await api.get("/api/v1/users/me").set(authHeader(accessToken));
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ error: "internal_error" });
    expect(spy).toHaveBeenCalled();
    // Logged with the request line so an operator can find it, but the error
    // text itself never reaches the client.
    expect(quiet).toHaveBeenCalledWith("[http] %s %s failed:", "GET", "/api/v1/users/me", expect.any(Error));
    expect(JSON.stringify(failed.body)).not.toContain("simulated");

    // Same process, next request works.
    const ok = await api.get("/api/v1/users/me").set(authHeader(accessToken));
    expect(ok.status).toBe(200);
  });
});

describe("the final error handler", () => {
  it("answers a malformed JSON body with a 400 in the API's own error shape", async () => {
    const res = await api.post("/api/v1/auth/login").set("content-type", "application/json").send("{ not json");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid_request" });
  });

  it("answers an oversized body with a 413", async () => {
    const res = await api
      .post("/api/v1/auth/login")
      .set("content-type", "application/json")
      .send(JSON.stringify({ username: "x", password: "y".repeat(1024 * 1024 + 10) }));
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: "payload_too_large" });
  });
});
