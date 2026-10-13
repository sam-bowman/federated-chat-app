import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "../../src/config.js";
import { prisma } from "../../src/db.js";
import { newProtocolId } from "../../src/lib/ids.js";
import { describeRepair, repairLocalHomeserverDomains } from "../../src/lib/localDomainRepair.js";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { authHeader, registerUser } from "../helpers/factory.js";

beforeEach(resetDb);
afterAll(disconnectDb);

const PASSWORD = "Correct-Horse-Battery-Staple-1";
const login = (username: string) => api.post("/api/v1/auth/login").send({ username, password: PASSWORD });

// Regression tests for a real upgrade bug: two migrations backfilled every existing local row's
// homeserverDomain with the literal 'localhost' (a migration cannot see SERVER_DOMAIN), so a
// server on a real domain was left with local accounts that findLocalUserByUsername() - which
// filters on the real domain - could not find. The test database's domain is "test.local".
describe("repairLocalHomeserverDomains", () => {
  it("lets an account tagged 'localhost' log in again, with the right identity", async () => {
    const { user } = await registerUser("pioneer");
    await prisma.user.updateMany({ where: { username: "pioneer" }, data: { homeserverDomain: "localhost" } });

    // The bug: the account exists, the password is right, and login says no.
    expect((await login("pioneer")).status).toBe(401);

    const result = await repairLocalHomeserverDomains(prisma, config.domain);
    expect(result.users).toBe(1);
    expect(result.conflicts).toEqual([]);

    const after = await login("pioneer");
    expect(after.status).toBe(200);
    expect(after.body.user.identity).toBe("@pioneer:test.local");
    expect(user.username).toBe("pioneer");
  });

  it("repairs local communities too, and leaves a remote community alone", async () => {
    const { accessToken } = await registerUser("founder");
    const created = await api
      .post("/api/v1/communities")
      .set(authHeader(accessToken))
      .send({ name: "Old Community" });
    expect(created.status).toBe(201);
    await prisma.community.updateMany({ data: { homeserverDomain: "localhost" } });
    const remote = await prisma.community.create({
      data: {
        protocolId: newProtocolId(),
        name: "Elsewhere",
        ownerId: (await prisma.user.findFirstOrThrow({ where: { username: "founder" } })).id,
        homeserverDomain: "localhost",
        isRemote: true,
      },
    });

    const result = await repairLocalHomeserverDomains(prisma, config.domain);
    expect(result.communities).toBe(1);

    const local = await prisma.community.findFirstOrThrow({ where: { name: "Old Community" } });
    expect(local.homeserverDomain).toBe("test.local");
    expect((await prisma.community.findUniqueOrThrow({ where: { id: remote.id } })).homeserverDomain).toBe("localhost");
  });

  it("never touches a remote user, even one whose recorded domain is 'localhost'", async () => {
    await registerUser("stub");
    await prisma.user.updateMany({ where: { username: "stub" }, data: { isRemote: true, homeserverDomain: "localhost" } });

    const result = await repairLocalHomeserverDomains(prisma, config.domain);
    expect(result.users).toBe(0);
    const row = await prisma.user.findFirstOrThrow({ where: { username: "stub" } });
    expect(row.homeserverDomain).toBe("localhost");
  });

  it("skips - and reports - a username that is already taken on the real domain, instead of aborting", async () => {
    // Someone locked out by the bug registers the same name again under the real domain.
    await registerUser("twin");
    await prisma.user.create({
      data: {
        protocolId: newProtocolId(),
        username: "twin",
        displayName: "the original",
        homeserverDomain: "localhost",
        isRemote: false,
      },
    });
    await registerUser("plain");
    await prisma.user.updateMany({ where: { username: "plain" }, data: { homeserverDomain: "localhost" } });

    const result = await repairLocalHomeserverDomains(prisma, config.domain);

    // The ordinary account is repaired; the colliding one is left alone and named.
    expect(result.users).toBe(1);
    expect(result.conflicts).toEqual(["twin"]);
    expect((await login("plain")).status).toBe(200);
    const warning = describeRepair(result, config.domain).find((line) => line.startsWith("WARNING"));
    expect(warning).toContain("twin");
    expect(warning).toContain("already exists on test.local");
  });

  it("is idempotent", async () => {
    await registerUser("once");
    await prisma.user.updateMany({ where: { username: "once" }, data: { homeserverDomain: "localhost" } });
    expect((await repairLocalHomeserverDomains(prisma, config.domain)).users).toBe(1);
    const again = await repairLocalHomeserverDomains(prisma, config.domain);
    expect(again).toEqual({ users: 0, communities: 0, conflicts: [] });
    expect(describeRepair(again, config.domain)).toEqual([]);
  });

  it("does nothing on a server that really is called localhost", async () => {
    await registerUser("local_dev");
    await prisma.user.updateMany({ where: { username: "local_dev" }, data: { homeserverDomain: "localhost" } });
    const result = await repairLocalHomeserverDomains(prisma, "localhost");
    expect(result).toEqual({ users: 0, communities: 0, conflicts: [] });
    expect((await prisma.user.findFirstOrThrow({ where: { username: "local_dev" } })).homeserverDomain).toBe("localhost");
  });
});
