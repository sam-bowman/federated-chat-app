// A suspended account (the operator's `users suspend`, #128) cannot sign in or refresh a session. The answer for a WRONG password
// stays the same as for any account, so suspension is only ever told to someone who proved they know the password.
import { generate } from "otplib";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { authHeader, registerUser } from "../helpers/factory.js";

beforeEach(resetDb);
afterAll(disconnectDb);

const PASSWORD = "Correct-Horse-Battery-Staple-1";
const suspend = (username: string) => prisma.user.updateMany({ where: { username, isRemote: false }, data: { suspendedAt: new Date() } });
const login = (username: string, password = PASSWORD) => api.post("/api/v1/auth/login").send({ username, password });

describe("a suspended account", () => {
  it("cannot sign in, and is told so once the password is right", async () => {
    await registerUser("alice", { password: PASSWORD });
    await suspend("alice");
    const res = await login("alice");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("account_suspended");
    expect(res.body.accessToken).toBeUndefined();
  });

  it("is not told apart from any other account by someone who does not know the password", async () => {
    await registerUser("alice", { password: PASSWORD });
    await suspend("alice");
    const wrong = await login("alice", "Not-The-Password-1!");
    const missing = await login("nobody");
    expect(wrong.status).toBe(401);
    expect(wrong.body).toEqual(missing.body);
  });

  it("cannot refresh a session it already had", async () => {
    const { refreshToken } = await registerUser("alice", { password: PASSWORD });
    await suspend("alice");
    const res = await api.post("/api/v1/auth/refresh").send({ refreshToken });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("account_suspended");
    // And the token was not spent on the way: it is simply refused until the account is back.
    await prisma.user.updateMany({ where: { username: "alice" }, data: { suspendedAt: null } });
    expect((await api.post("/api/v1/auth/refresh").send({ refreshToken })).status).toBe(200);
  });

  it("cannot finish a two-factor sign-in either", async () => {
    const { accessToken } = await registerUser("alice", { password: PASSWORD });
    const { secret } = (await api.post("/api/v1/auth/2fa/setup").set(authHeader(accessToken)).send({ password: PASSWORD })).body;
    await api.post("/api/v1/auth/2fa/verify").set(authHeader(accessToken)).send({ code: await generate({ secret }) });
    const challenge = (await login("alice")).body.challengeToken as string;
    expect(challenge).toBeTruthy();

    await suspend("alice");
    const res = await api.post("/api/v1/auth/2fa/login").send({ challengeToken: challenge, code: await generate({ secret }) });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("account_suspended");
  });

  it("can sign in again once it is unsuspended", async () => {
    await registerUser("alice", { password: PASSWORD });
    await suspend("alice");
    expect((await login("alice")).status).toBe(403);
    await prisma.user.updateMany({ where: { username: "alice" }, data: { suspendedAt: null } });
    expect((await login("alice")).status).toBe(200);
  });

  it("does not stop anyone else", async () => {
    await registerUser("alice", { password: PASSWORD });
    await registerUser("bob", { password: PASSWORD });
    await suspend("alice");
    expect((await login("bob")).status).toBe(200);
  });
});
