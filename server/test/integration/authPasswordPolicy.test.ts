// Deliberately separate from PASSWORD_BREACH_CHECK_ENABLED (which the rest
// of the suite leaves "false" - see test/setupEnv.ts - so registerUser()
// calls throughout the suite never make a real outbound HTTP call) so this
// file can exercise that path on its own, with a mocked fetch standing in
// for the real Have I Been Pwned API.
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.PASSWORD_BREACH_CHECK_ENABLED = "true";

const { api } = await import("../helpers/app.js");
const { disconnectDb, resetDb } = await import("../helpers/db.js");

beforeEach(resetDb);
afterEach(() => {
  vi.unstubAllGlobals();
});
afterAll(async () => {
  await disconnectDb();
  delete process.env.PASSWORD_BREACH_CHECK_ENABLED;
});

function sha1(input: string): string {
  return createHash("sha1").update(input).digest("hex").toUpperCase();
}

describe("POST /api/v1/auth/register (breach check enabled)", () => {
  it("rejects a password whose hash suffix appears in the breach range response", async () => {
    const password = "Correct-Horse-Battery-Staple-1";
    const suffix = sha1(password).slice(5);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, text: async () => `${suffix}:999999` })
    );

    const res = await api.post("/api/v1/auth/register").send({ username: "alice", password });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("password_breached");

    const user = await (await import("../../src/db.js")).prisma.user.findFirst({ where: { username: "alice" } });
    expect(user).toBeNull();
  });

  it("still registers successfully when the password's suffix isn't in the breach range", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:1",
      })
    );

    const res = await api
      .post("/api/v1/auth/register")
      .send({ username: "alice", password: "Correct-Horse-Battery-Staple-1" });
    expect(res.status).toBe(201);
  });

  it("still registers successfully (fails open) when the breach-check API itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const res = await api
      .post("/api/v1/auth/register")
      .send({ username: "alice", password: "Correct-Horse-Battery-Staple-1" });
    expect(res.status).toBe(201);
  });
});
