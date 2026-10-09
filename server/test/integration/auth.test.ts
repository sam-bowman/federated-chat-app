import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { registerUser } from "../helpers/factory.js";

beforeEach(resetDb);
afterAll(disconnectDb);

describe("POST /api/v1/auth/register", () => {
  it("registers a new user and returns tokens", async () => {
    const res = await api
      .post("/api/v1/auth/register")
      .send({ username: "alice", password: "Correct-Horse-Battery-Staple-1" });

    expect(res.status).toBe(201);
    expect(res.body.user.username).toBe("alice");
    expect(res.body.user.identity).toBe("@alice:test.local");
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.refreshToken).toEqual(expect.any(String));
    // The local database id must never leak into the response.
    expect(res.body.user.id).not.toBe(res.body.user.username);
  });

  // Regression test: a short password used to come back as a bare
  // "invalid_request" with no indication of what was wrong (see README/git
  // history - this was the first bug reported against the MVP).
  it("rejects a password under 8 characters with a field-level validation detail", async () => {
    const res = await api.post("/api/v1/auth/register").send({ username: "alice", password: "short" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect(res.body.details?.fieldErrors?.password).toBeTruthy();
  });

  it("rejects a duplicate username on the same server", async () => {
    await registerUser("alice");
    const res = await api
      .post("/api/v1/auth/register")
      .send({ username: "alice", password: "Correct-Horse-Battery-Staple-1" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("username_taken");
  });

  it("rejects an uppercase or symbol-containing username", async () => {
    const res = await api
      .post("/api/v1/auth/register")
      .send({ username: "Alice!", password: "Correct-Horse-Battery-Staple-1" });
    expect(res.status).toBe(400);
  });

  // Regression target: "password" (8 chars, meets only the old length-only
  // rule) used to be accepted outright.
  it.each([
    ["password", "all-lowercase, no uppercase/number/symbol"],
    ["PASSWORD1!", "no lowercase"],
    ["password1!", "no uppercase"],
    ["Password!!", "no number"],
    ["Password11", "no symbol"],
  ])("rejects %j (%s)", async (password) => {
    const res = await api.post("/api/v1/auth/register").send({ username: "alice", password });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect(res.body.details?.fieldErrors?.password).toBeTruthy();
  });

  it("accepts a password with uppercase, lowercase, a number, and a symbol", async () => {
    const res = await api
      .post("/api/v1/auth/register")
      .send({ username: "alice", password: "Correct-Horse-Battery-Staple-1" });
    expect(res.status).toBe(201);
  });
});

describe("POST /api/v1/auth/login", () => {
  it("logs in with correct credentials", async () => {
    await registerUser("alice", { password: "Correct-Horse-Battery-Staple-1" });
    const res = await api
      .post("/api/v1/auth/login")
      .send({ username: "alice", password: "Correct-Horse-Battery-Staple-1" });

    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe("alice");
  });

  it("rejects an incorrect password", async () => {
    await registerUser("alice", { password: "Correct-Horse-Battery-Staple-1" });
    const res = await api.post("/api/v1/auth/login").send({ username: "alice", password: "wrong password here" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_credentials");
  });

  it("rejects a nonexistent username", async () => {
    const res = await api
      .post("/api/v1/auth/login")
      .send({ username: "nobody", password: "Correct-Horse-Battery-Staple-1" });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/v1/users/me (auth middleware)", () => {
  it("rejects a request with no Authorization header", async () => {
    const res = await api.get("/api/v1/users/me");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("missing_token");
  });

  it("rejects a malformed/garbage token", async () => {
    const res = await api.get("/api/v1/users/me").set("Authorization", "Bearer not-a-real-token");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_token");
  });

  it("accepts a valid access token", async () => {
    const { accessToken } = await registerUser("alice");
    const res = await api.get("/api/v1/users/me").set("Authorization", `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe("alice");
  });
});
