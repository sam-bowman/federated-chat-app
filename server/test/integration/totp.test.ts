import { generate } from "otplib";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { api } from "../helpers/app.js";
import { authHeader, registerUser } from "../helpers/factory.js";
import { disconnectDb, resetDb } from "../helpers/db.js";

const PASSWORD = "Correct-Horse-Battery-Staple-1";

beforeEach(resetDb);
afterAll(disconnectDb);

async function setUpTotp() {
  const { accessToken } = await registerUser("alice", { password: PASSWORD });
  const setupRes = await api.post("/api/v1/auth/2fa/setup").set(authHeader(accessToken)).send({ password: PASSWORD });
  expect(setupRes.status).toBe(200);
  const { secret } = setupRes.body;

  const code = await generate({ secret });
  const verifyRes = await api.post("/api/v1/auth/2fa/verify").set(authHeader(accessToken)).send({ code });
  expect(verifyRes.status).toBe(200);

  return { accessToken, secret, recoveryCodes: verifyRes.body.recoveryCodes as string[] };
}

describe("POST /api/v1/auth/2fa/setup", () => {
  it("returns a secret and otpauth URL given the correct password", async () => {
    const { accessToken } = await registerUser("alice", { password: PASSWORD });
    const res = await api.post("/api/v1/auth/2fa/setup").set(authHeader(accessToken)).send({ password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.secret).toEqual(expect.any(String));
    expect(res.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
  });

  it("rejects the wrong password", async () => {
    const { accessToken } = await registerUser("alice", { password: PASSWORD });
    const res = await api.post("/api/v1/auth/2fa/setup").set(authHeader(accessToken)).send({ password: "nope" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_credentials");
  });

  it("requires authentication", async () => {
    const res = await api.post("/api/v1/auth/2fa/setup").send({ password: PASSWORD });
    expect(res.status).toBe(401);
  });

  it("rejects starting setup again once already enabled", async () => {
    const { accessToken } = await setUpTotp();
    const res = await api.post("/api/v1/auth/2fa/setup").set(authHeader(accessToken)).send({ password: PASSWORD });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("totp_already_enabled");
  });
});

describe("POST /api/v1/auth/2fa/verify", () => {
  it("enables 2FA and returns recovery codes for a correct code", async () => {
    const { accessToken } = await registerUser("alice", { password: PASSWORD });
    const setupRes = await api
      .post("/api/v1/auth/2fa/setup")
      .set(authHeader(accessToken))
      .send({ password: PASSWORD });
    const code = await generate({ secret: setupRes.body.secret });

    const res = await api.post("/api/v1/auth/2fa/verify").set(authHeader(accessToken)).send({ code });
    expect(res.status).toBe(200);
    expect(res.body.recoveryCodes).toHaveLength(10);

    const me = await api.get("/api/v1/users/me").set(authHeader(accessToken));
    expect(me.body.user.totpEnabled).toBe(true);
  });

  it("rejects a wrong code and leaves 2FA disabled", async () => {
    const { accessToken } = await registerUser("alice", { password: PASSWORD });
    await api.post("/api/v1/auth/2fa/setup").set(authHeader(accessToken)).send({ password: PASSWORD });

    const res = await api.post("/api/v1/auth/2fa/verify").set(authHeader(accessToken)).send({ code: "000000" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_code");

    const me = await api.get("/api/v1/users/me").set(authHeader(accessToken));
    expect(me.body.user.totpEnabled).toBe(false);
  });
});

describe("GET /api/v1/users/:username and /search (privacy)", () => {
  it("never exposes totpEnabled for anyone but the account's own owner", async () => {
    const { accessToken } = await setUpTotp();
    const { accessToken: bobToken } = await registerUser("bob");

    const viaUsername = await api.get("/api/v1/users/alice").set(authHeader(bobToken));
    expect(viaUsername.body.user.totpEnabled).toBeUndefined();

    const viaSearch = await api.get("/api/v1/users/search?q=alice").set(authHeader(bobToken));
    expect(viaSearch.body.users[0].totpEnabled).toBeUndefined();
  });
});

describe("POST /api/v1/auth/login (2FA enabled)", () => {
  it("returns a challenge token instead of real tokens", async () => {
    await setUpTotp();
    const res = await api.post("/api/v1/auth/login").send({ username: "alice", password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.totpRequired).toBe(true);
    expect(res.body.challengeToken).toEqual(expect.any(String));
    expect(res.body.accessToken).toBeUndefined();
  });

  // Regression: the challenge token is a real, correctly-signed JWT, but it
  // must never be usable as a stand-in for a real access token - see
  // signTotpChallengeToken()'s comment in lib/auth.ts.
  it("rejects the challenge token everywhere requireAuth is used", async () => {
    await setUpTotp();
    const loginRes = await api.post("/api/v1/auth/login").send({ username: "alice", password: PASSWORD });

    const res = await api.get("/api/v1/users/me").set("Authorization", `Bearer ${loginRes.body.challengeToken}`);
    expect(res.status).toBe(401);
  });
});

describe("POST /api/v1/auth/2fa/login", () => {
  it("issues real tokens for a correct code", async () => {
    const { secret } = await setUpTotp();
    const loginRes = await api.post("/api/v1/auth/login").send({ username: "alice", password: PASSWORD });
    const code = await generate({ secret });

    const res = await api
      .post("/api/v1/auth/2fa/login")
      .send({ challengeToken: loginRes.body.challengeToken, code });

    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe("alice");
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.refreshToken).toEqual(expect.any(String));
  });

  it("rejects a wrong code", async () => {
    await setUpTotp();
    const loginRes = await api.post("/api/v1/auth/login").send({ username: "alice", password: PASSWORD });

    const res = await api
      .post("/api/v1/auth/2fa/login")
      .send({ challengeToken: loginRes.body.challengeToken, code: "000000" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_code");
  });

  it("rejects a garbage or expired challenge token", async () => {
    const res = await api.post("/api/v1/auth/2fa/login").send({ challengeToken: "not-a-real-token", code: "000000" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_challenge_token");
  });

  // Regression target for the replay protection built into totp.ts/otplib's
  // afterTimeStep - the exact same code must not work twice.
  it("rejects replaying the same code a second time", async () => {
    const { secret } = await setUpTotp();
    const code = await generate({ secret });

    const first = await api.post("/api/v1/auth/login").send({ username: "alice", password: PASSWORD });
    const ok = await api.post("/api/v1/auth/2fa/login").send({ challengeToken: first.body.challengeToken, code });
    expect(ok.status).toBe(200);

    const second = await api.post("/api/v1/auth/login").send({ username: "alice", password: PASSWORD });
    const replay = await api
      .post("/api/v1/auth/2fa/login")
      .send({ challengeToken: second.body.challengeToken, code });
    expect(replay.status).toBe(401);
    expect(replay.body.error).toBe("invalid_code");
  });

  it("accepts a valid recovery code and consumes it", async () => {
    const { recoveryCodes } = await setUpTotp();
    const loginRes = await api.post("/api/v1/auth/login").send({ username: "alice", password: PASSWORD });

    const res = await api
      .post("/api/v1/auth/2fa/login")
      .send({ challengeToken: loginRes.body.challengeToken, recoveryCode: recoveryCodes[0] });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toEqual(expect.any(String));

    // The same recovery code can't be used again.
    const secondLogin = await api.post("/api/v1/auth/login").send({ username: "alice", password: PASSWORD });
    const replay = await api
      .post("/api/v1/auth/2fa/login")
      .send({ challengeToken: secondLogin.body.challengeToken, recoveryCode: recoveryCodes[0] });
    expect(replay.status).toBe(401);
  });

  it("rejects a request with neither code nor recoveryCode", async () => {
    await setUpTotp();
    const loginRes = await api.post("/api/v1/auth/login").send({ username: "alice", password: PASSWORD });
    const res = await api.post("/api/v1/auth/2fa/login").send({ challengeToken: loginRes.body.challengeToken });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/v1/auth/2fa/disable", () => {
  it("disables 2FA given the correct password, restoring password-only login", async () => {
    const { accessToken } = await setUpTotp();

    const res = await api.post("/api/v1/auth/2fa/disable").set(authHeader(accessToken)).send({ password: PASSWORD });
    expect(res.status).toBe(204);

    const loginRes = await api.post("/api/v1/auth/login").send({ username: "alice", password: PASSWORD });
    expect(loginRes.body.totpRequired).toBeUndefined();
    expect(loginRes.body.accessToken).toEqual(expect.any(String));

    const me = await api.get("/api/v1/users/me").set(authHeader(accessToken));
    expect(me.body.user.totpEnabled).toBe(false);
  });

  it("rejects the wrong password and leaves 2FA enabled", async () => {
    const { accessToken } = await setUpTotp();
    const res = await api.post("/api/v1/auth/2fa/disable").set(authHeader(accessToken)).send({ password: "nope" });
    expect(res.status).toBe(401);

    const me = await api.get("/api/v1/users/me").set(authHeader(accessToken));
    expect(me.body.user.totpEnabled).toBe(true);
  });

  it("deletes recovery codes, so a previously-valid one no longer works after re-enabling", async () => {
    const { accessToken, recoveryCodes } = await setUpTotp();
    await api.post("/api/v1/auth/2fa/disable").set(authHeader(accessToken)).send({ password: PASSWORD });

    const setupRes = await api
      .post("/api/v1/auth/2fa/setup")
      .set(authHeader(accessToken))
      .send({ password: PASSWORD });
    const code = await generate({ secret: setupRes.body.secret });
    await api.post("/api/v1/auth/2fa/verify").set(authHeader(accessToken)).send({ code });

    const loginRes = await api.post("/api/v1/auth/login").send({ username: "alice", password: PASSWORD });
    const res = await api
      .post("/api/v1/auth/2fa/login")
      .send({ challengeToken: loginRes.body.challengeToken, recoveryCode: recoveryCodes[0] });
    expect(res.status).toBe(401);
  });
});
