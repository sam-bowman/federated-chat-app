// Password hashing cost is configurable (BCRYPT_ROUNDS) so the suite can run fast, but it must never
// change what a real deployment gets: these pin what the setting does end to end.
import bcrypt from "bcryptjs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "../../src/config.js";
import { prisma } from "../../src/db.js";
import { hashPassword } from "../../src/lib/auth.js";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { registerUser } from "../helpers/factory.js";

beforeEach(resetDb);
afterAll(disconnectDb);

describe("password hashing cost", () => {
  it("runs the suite at bcrypt's minimum cost, from test/setupEnv.ts", () => {
    expect(config.bcryptRounds).toBe(4);
  });

  it("hashes new passwords at the configured cost", async () => {
    expect(bcrypt.getRounds(await hashPassword("Correct-Horse-Battery-Staple-1"))).toBe(config.bcryptRounds);
  });

  it("stores a registered user's password at that cost, and it still verifies", async () => {
    await registerUser("alice");
    const row = await prisma.user.findFirstOrThrow({ where: { username: "alice" } });
    expect(bcrypt.getRounds(row.passwordHash!)).toBe(config.bcryptRounds);

    const login = await api.post("/api/v1/auth/login").send({ username: "alice", password: "Correct-Horse-Battery-Staple-1" });
    expect(login.status).toBe(200);
  });

  // The cost lives inside the hash, so changing BCRYPT_ROUNDS never locks anyone out: accounts made at
  // the production cost of 12 must keep working on a server (or test run) set lower, and vice versa.
  it("still accepts a password hashed at a different cost", async () => {
    await registerUser("bob");
    const stronger = await bcrypt.hash("Another-Strong-Pass-9!", 12);
    await prisma.user.updateMany({ where: { username: "bob" }, data: { passwordHash: stronger } });

    const login = await api.post("/api/v1/auth/login").send({ username: "bob", password: "Another-Strong-Pass-9!" });

    expect(login.status).toBe(200);
  });
});
