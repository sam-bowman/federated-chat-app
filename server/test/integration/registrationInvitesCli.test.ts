// The operator's command for making the codes an invite-only server asks for: create, list and revoke, run against the
// real database, with what it prints and the exit code it returns.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { runRegistrationInvitesCli, type Output, type ServerSettings } from "../../src/cli/registrationInvites.js";
import { generateInviteCode } from "../../src/lib/registrationInvites.js";
import { disconnectDb, resetDb } from "../helpers/db.js";

beforeEach(resetDb);
afterAll(disconnectDb);

const INVITE_ONLY: ServerSettings = { registrationEnabled: true, registrationInviteOnly: true };
const DAY = 86_400_000;

async function run(argv: string[], settings: ServerSettings = INVITE_ONLY) {
  const lines: string[] = [];
  const errors: string[] = [];
  const out: Output = { log: (l) => lines.push(l), error: (l) => errors.push(l) };
  const code = await runRegistrationInvitesCli(argv, prisma, out, settings);
  return { code, text: lines.join("\n"), errorText: errors.join("\n") };
}

const CODE = /\b[0-9A-HJKMNP-TV-Z]{10}\b/g;

describe("create", () => {
  it("makes one single-use code that lasts a week, and prints it", async () => {
    const result = await run(["create"]);
    expect(result.code).toBe(0);
    const [invite] = await prisma.registrationInvite.findMany();
    expect(invite.maxUses).toBe(1);
    expect(invite.uses).toBe(0);
    expect(invite.note).toBeNull();
    const days = (invite.expiresAt!.getTime() - Date.now()) / DAY;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThan(7.01);
    expect(result.text).toContain(invite.code);
    expect(result.text).toContain("one use");
    expect(result.text).toContain("register screen");
  });

  it("takes the number of uses, the lifetime and a note", async () => {
    const result = await run(["create", "--uses", "5", "--days", "30", "--note", "Alex from work"]);
    expect(result.code).toBe(0);
    const [invite] = await prisma.registrationInvite.findMany();
    expect(invite.maxUses).toBe(5);
    expect(invite.note).toBe("Alex from work");
    expect((invite.expiresAt!.getTime() - Date.now()) / DAY).toBeGreaterThan(29.99);
    expect(result.text).toContain("5 uses");
    expect(result.text).toContain("Alex from work");
  });

  it("can make a code that never ends and has no limit", async () => {
    await run(["create", "--uses", "unlimited", "--days", "never"]);
    const [invite] = await prisma.registrationInvite.findMany();
    expect(invite.maxUses).toBeNull();
    expect(invite.expiresAt).toBeNull();
  });

  it("makes several different codes at once", async () => {
    const result = await run(["create", "--count", "5"]);
    expect(result.code).toBe(0);
    const stored = (await prisma.registrationInvite.findMany()).map((i) => i.code);
    expect(new Set(stored).size).toBe(5);
    expect([...result.text.matchAll(CODE)].map((m) => m[0]).sort()).toEqual([...stored].sort());
  });

  it("refuses bad options and makes nothing", async () => {
    for (const args of [["--uses", "0"], ["--days", "soon"], ["--count", "51"], ["--day", "1"], ["--note"]]) {
      const result = await run(["create", ...args]);
      expect(result.code, args.join(" ")).toBe(2);
      expect(result.errorText.length).toBeGreaterThan(0);
    }
    expect(await prisma.registrationInvite.count()).toBe(0);
  });

  it("warns that a code is not asked for yet when the server is not invite-only, or registration is off", async () => {
    const open = await run(["create"], { registrationEnabled: true, registrationInviteOnly: false });
    expect(open.code).toBe(0);
    expect(open.text).toContain("not invite-only");
    const closed = await run(["create"], { registrationEnabled: false, registrationInviteOnly: true });
    expect(closed.text).toContain("registration is OFF");
    const fine = await run(["create"]);
    expect(fine.text).not.toContain("Note:");
  });
});

describe("list", () => {
  it("says so when there is nothing to list", async () => {
    const result = await run(["list"]);
    expect(result.code).toBe(0);
    expect(result.text).toContain("no registration invites");
  });

  it("shows the codes that can still be used, with their use, expiry, note and who joined with them", async () => {
    const active = await prisma.registrationInvite.create({ data: { code: generateInviteCode(), maxUses: 3, uses: 1, note: "the group", expiresAt: new Date(Date.now() + DAY) } });
    const alice = await prisma.user.create({
      data: { protocolId: "01HZZZZZZZZZZZZZZZZZZZZZZA", username: "alice", passwordHash: "x", displayName: "alice", homeserverDomain: "localhost", registrationInviteId: active.id },
    });
    expect(alice.registrationInviteId).toBe(active.id);

    const result = await run(["list"]);
    expect(result.code).toBe(0);
    expect(result.text).toContain(active.code);
    expect(result.text).toContain("active");
    expect(result.text).toContain("1/3 used");
    expect(result.text).toContain("the group");
    expect(result.text).toContain("joined: alice");
  });

  it("leaves out the codes that are over unless asked, and then says what is wrong with each", async () => {
    const make = (data: object) => prisma.registrationInvite.create({ data: { code: generateInviteCode(), maxUses: 1, ...data } });
    const live = await make({});
    const revoked = await make({ revokedAt: new Date() });
    const expired = await make({ expiresAt: new Date(Date.now() - DAY) });
    const usedUp = await make({ uses: 1 });

    const shown = await run(["list"]);
    expect(shown.text).toContain(live.code);
    for (const gone of [revoked, expired, usedUp]) expect(shown.text).not.toContain(gone.code);

    const all = await run(["list", "--all"]);
    for (const invite of [live, revoked, expired, usedUp]) expect(all.text).toContain(invite.code);
    expect(all.text).toMatch(new RegExp(`${revoked.code}  revoked`));
    expect(all.text).toMatch(new RegExp(`${expired.code}  expired`));
    expect(all.text).toMatch(new RegExp(`${usedUp.code}  used_up`));
  });

  it("says an unlimited code has no limit", async () => {
    const invite = await prisma.registrationInvite.create({ data: { code: generateInviteCode(), maxUses: null, uses: 4 } });
    const result = await run(["list"]);
    expect(result.text).toContain(`${invite.code}`);
    expect(result.text).toContain("4 used, never expires");
  });

  it("refuses an option it does not know", async () => {
    expect((await run(["list", "--everything"])).code).toBe(2);
  });
});

describe("revoke", () => {
  it("stops a code from being used and says what happens to the accounts it made", async () => {
    const invite = await prisma.registrationInvite.create({ data: { code: generateInviteCode(), maxUses: 1 } });
    const result = await run(["revoke", invite.code]);
    expect(result.code).toBe(0);
    expect(result.text).toContain("keep theirs");
    expect((await prisma.registrationInvite.findUniqueOrThrow({ where: { id: invite.id } })).revokedAt).not.toBeNull();
  });

  it("finds the code whatever the case", async () => {
    const invite = await prisma.registrationInvite.create({ data: { code: generateInviteCode(), maxUses: 1 } });
    expect((await run(["revoke", invite.code.toLowerCase()])).code).toBe(0);
    expect((await prisma.registrationInvite.findUniqueOrThrow({ where: { id: invite.id } })).revokedAt).not.toBeNull();
  });

  it("says so, without changing anything, when it was already revoked", async () => {
    const revokedAt = new Date(Date.now() - DAY);
    const invite = await prisma.registrationInvite.create({ data: { code: generateInviteCode(), maxUses: 1, revokedAt } });
    const result = await run(["revoke", invite.code]);
    expect(result.code).toBe(0);
    expect(result.text).toContain("already revoked");
    expect((await prisma.registrationInvite.findUniqueOrThrow({ where: { id: invite.id } })).revokedAt?.getTime()).toBe(revokedAt.getTime());
  });

  it("fails for a code that does not exist, and when not given exactly one", async () => {
    const missing = await run(["revoke", "NOSUCHCODE"]);
    expect(missing.code).toBe(1);
    expect(missing.errorText).toContain("NOSUCHCODE");
    expect((await run(["revoke"])).code).toBe(2);
    expect((await run(["revoke", "A", "B"])).code).toBe(2);
  });
});

describe("the command itself", () => {
  it("explains itself, and fails when it is run with nothing or something it does not know", async () => {
    const none = await run([]);
    expect(none.code).toBe(2);
    expect(none.text).toContain("create");
    const help = await run(["help"]);
    expect(help.code).toBe(0);
    expect(help.text).toContain("revoke <code>");
    const unknown = await run(["delete"]);
    expect(unknown.code).toBe(2);
    expect(unknown.errorText).toContain('Unknown command "delete"');
  });
});
