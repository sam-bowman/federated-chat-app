// The operator's admin command (#128): list and manage this server's accounts and communities straight from the database.
// What matters most is what it must NOT do: show anything secret, touch an account that is not ours, or do something that cannot
// be undone without asking. The commands run for real against the test database, with a stand-in for the terminal.
import { generate } from "otplib";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "../../src/config.js";
import { prisma } from "../../src/db.js";
import { runAdminCli, type AdminIo } from "../../src/cli/admin.js";
import { newProtocolId } from "../../src/lib/ids.js";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { authHeader, registerUser } from "../helpers/factory.js";

beforeEach(resetDb);
afterAll(disconnectDb);

const PASSWORD = "Correct-Horse-Battery-Staple-1";

interface Terminal {
  interactive?: boolean;
  /** Answers to confirmations, in order. */
  confirms?: boolean[];
  /** What is typed at each hidden prompt, in order. */
  secrets?: string[];
}

async function admin(args: string[], terminal: Terminal = {}) {
  const lines: string[] = [];
  const errors: string[] = [];
  const confirms = [...(terminal.confirms ?? [])];
  const secrets = [...(terminal.secrets ?? [])];
  const asked: string[] = [];
  const io: AdminIo = {
    interactive: terminal.interactive ?? true,
    async confirm(question) {
      asked.push(question);
      return confirms.shift() ?? false;
    },
    async secret(prompt) {
      asked.push(prompt);
      return secrets.shift() ?? "";
    },
  };
  const code = await runAdminCli(args, { log: (l) => lines.push(l), error: (l) => errors.push(l) }, io);
  return { code, out: lines.join("\n"), err: errors.join("\n"), asked, everything: [...lines, ...errors, ...asked].join("\n") };
}

async function remoteStub(username = "remy", domain = "far.example") {
  return prisma.user.create({ data: { protocolId: newProtocolId(), username, displayName: "Remy", homeserverDomain: domain, isRemote: true } });
}
const rowOf = (username: string) => prisma.user.findFirstOrThrow({ where: { username, isRemote: false } });
const createCommunity = async (owner: { accessToken: string }, name = "Club") =>
  (await api.post("/api/v1/communities").set(authHeader(owner.accessToken)).send({ name })).body.community as { id: string };
const joinCommunity = (community: { id: string }, user: { accessToken: string }) =>
  api.post(`/api/v1/communities/${community.id}/members`).set(authHeader(user.accessToken));

describe("using the command", () => {
  it("shows what it can do with no arguments, and fails (nothing was asked of it)", async () => {
    const res = await admin([]);
    expect(res.code).toBe(2);
    expect(res.out).toContain("users list");
    expect(res.out).toContain("communities delete");
  });

  it("shows the same for help, as a success", async () => {
    expect((await admin(["help"])).code).toBe(0);
    expect((await admin(["--help"])).out).toContain("Metadata only");
  });

  it("says when a command or an option is not one, and changes nothing", async () => {
    expect((await admin(["frobnicate"])).code).toBe(2);
    expect((await admin(["users", "frobnicate"])).code).toBe(2);
    expect((await admin(["users"])).code).toBe(2);
    expect((await admin(["users", "list", "--sudo"])).err).toContain("Unknown option --sudo");
    expect((await admin(["users", "list", "--search"])).err).toContain("--search needs a value");
    expect((await admin(["users", "show"])).code).toBe(2);
    expect((await admin(["communities", "list", "extra"])).code).toBe(2);
  });
});

describe("users list and show", () => {
  it("lists the accounts on this server, with what an operator needs, and not the cached copies of other servers' people", async () => {
    await registerUser("alice", { displayName: "Alice A" });
    await registerUser("bob");
    await remoteStub("remy");
    const res = await admin(["users", "list"]);
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/USERNAME\s+NAME\s+CREATED\s+LAST SEEN\s+2FA/);
    expect(res.out).toContain("alice");
    expect(res.out).toContain("Alice A");
    expect(res.out).toContain("bob");
    expect(res.out).not.toContain("remy");
    expect(res.out).toContain("2 accounts.");
  });

  it("searches by username or name, and can show only the suspended", async () => {
    await registerUser("alice", { displayName: "Alice A" });
    await registerUser("bob", { displayName: "Robert" });
    expect((await admin(["users", "list", "--search", "ROB"])).out).toContain("bob");
    expect((await admin(["users", "list", "--search", "ROB"])).out).not.toContain("alice");
    expect((await admin(["users", "list", "--search", "nobody"])).out).toBe("No accounts match.");
    await admin(["users", "suspend", "bob", "--yes"]);
    const suspended = await admin(["users", "list", "--suspended"]);
    expect(suspended.out).toContain("bob");
    expect(suspended.out).toContain("SUSPENDED");
    expect(suspended.out).not.toContain("alice");
  });

  it("gives JSON for a script, with the same fields", async () => {
    await registerUser("alice");
    const list = JSON.parse((await admin(["users", "list", "--json"])).out);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ username: "alice", identity: `@alice:${config.domain}`, twoFactor: false, suspended: false, communitiesOwned: 0 });
  });

  it("shows one account: the communities it owns, whether it has 2FA or is suspended, and its sessions", async () => {
    const alice = await registerUser("alice");
    await createCommunity(alice, "Alice's Club");
    const res = await admin(["users", "show", "alice"]);
    expect(res.code).toBe(0);
    expect(res.out).toContain(`@alice:${config.domain}`);
    expect(res.out).toContain("two-factor:      off");
    expect(res.out).toContain("suspended:       no");
    expect(res.out).toContain("owns Alice's Club");
    expect(res.out).toContain("1 that can be refreshed");
    expect(JSON.parse((await admin(["users", "show", "alice", "--json"])).out).ownedCommunities).toHaveLength(1);
  });

  it("does not know an account that is not here, including a cached copy of someone from another server", async () => {
    await remoteStub("remy");
    for (const username of ["nobody", "remy"]) {
      const res = await admin(["users", "show", username]);
      expect(res.code).toBe(1);
      expect(res.err).toContain("There is no account");
    }
  });

  it("never prints a password hash, a 2FA secret, a recovery code or a token, whatever it is asked for", async () => {
    const alice = await registerUser("alice", { password: PASSWORD });
    const { secret } = (await api.post("/api/v1/auth/2fa/setup").set(authHeader(alice.accessToken)).send({ password: PASSWORD })).body;
    const verified = await api.post("/api/v1/auth/2fa/verify").set(authHeader(alice.accessToken)).send({ code: await generate({ secret }) });
    const recovery = verified.body.recoveryCodes as string[];
    await createCommunity(alice);
    const row = await rowOf("alice");
    const secrets = [row.passwordHash!, row.totpSecret!, alice.refreshToken, alice.accessToken, ...recovery];
    expect(secrets.every(Boolean)).toBe(true);

    const everything = (
      await Promise.all([
        admin(["users", "list"]),
        admin(["users", "list", "--json"]),
        admin(["users", "show", "alice"]),
        admin(["users", "show", "alice", "--json"]),
        admin(["communities", "list"]),
        admin(["communities", "list", "--json"]),
      ])
    )
      .map((r) => r.everything)
      .join("\n");
    for (const secretValue of secrets) expect(everything).not.toContain(secretValue);
    expect(everything).not.toMatch(/passwordHash|totpSecret|refreshToken|tokenHash|recovery/i);
    expect(everything).toContain("alice"); // and it did print something
  });
});

describe("users suspend and unsuspend", () => {
  it("stops sign-in and ends the sessions, and says how many", async () => {
    const alice = await registerUser("alice", { password: PASSWORD });
    const res = await admin(["users", "suspend", "alice", "--yes"]);
    expect(res.code).toBe(0);
    expect(res.out).toContain("Suspended alice. 1 session ended");
    expect((await api.post("/api/v1/auth/login").send({ username: "alice", password: PASSWORD })).status).toBe(403);
    // The session it had is gone, not just refused: it stays gone after the account is back.
    expect((await api.post("/api/v1/auth/refresh").send({ refreshToken: alice.refreshToken })).status).toBe(401);
    expect((await rowOf("alice")).suspendedAt).not.toBeNull();
    expect(await prisma.refreshToken.count({ where: { user: { username: "alice" }, revokedAt: null } })).toBe(0);
  });

  it("asks first, and does nothing if the answer is no", async () => {
    await registerUser("alice");
    const res = await admin(["users", "suspend", "alice"], { confirms: [false] });
    expect(res.code).toBe(1);
    expect(res.asked[0]).toContain("Suspend alice?");
    expect(res.out).toContain("Cancelled");
    expect((await rowOf("alice")).suspendedAt).toBeNull();
  });

  it("refuses to run without a terminal to ask on, unless it is told --yes", async () => {
    await registerUser("alice");
    const res = await admin(["users", "suspend", "alice"], { interactive: false });
    expect(res.code).toBe(2);
    expect(res.err).toContain("--yes");
    expect((await rowOf("alice")).suspendedAt).toBeNull();
    expect((await admin(["users", "suspend", "alice", "--yes"], { interactive: false })).code).toBe(0);
  });

  it("can be run again: the same result, no harm", async () => {
    await registerUser("alice");
    await admin(["users", "suspend", "alice", "--yes"]);
    const first = (await rowOf("alice")).suspendedAt;
    const again = await admin(["users", "suspend", "alice", "--yes"]);
    expect(again.code).toBe(0);
    expect(again.out).toContain("already suspended");
    expect((await rowOf("alice")).suspendedAt).toEqual(first);
  });

  it("is undone by unsuspend, which does not ask and can be run again", async () => {
    await registerUser("alice", { password: PASSWORD });
    await admin(["users", "suspend", "alice", "--yes"]);
    const res = await admin(["users", "unsuspend", "alice"], { interactive: false });
    expect(res.code).toBe(0);
    expect(res.out).toContain("Unsuspended alice");
    expect((await api.post("/api/v1/auth/login").send({ username: "alice", password: PASSWORD })).status).toBe(200);
    expect((await admin(["users", "unsuspend", "alice"])).out).toContain("was not suspended");
  });

  it("leaves everyone else alone, and will not touch an account that is not ours or does not exist", async () => {
    await registerUser("alice");
    await registerUser("bob", { password: PASSWORD });
    const remy = await remoteStub("remy");
    await admin(["users", "suspend", "alice", "--yes"]);
    expect((await api.post("/api/v1/auth/login").send({ username: "bob", password: PASSWORD })).status).toBe(200);
    for (const args of [["suspend", "remy", "--yes"], ["suspend", "nobody", "--yes"], ["unsuspend", "remy"], ["unsuspend", "nobody"]]) {
      expect((await admin(["users", ...args])).code, args.join(" ")).toBe(1);
    }
    expect((await prisma.user.findUniqueOrThrow({ where: { id: remy.id } })).suspendedAt).toBeNull();
  });
});

describe("users delete and cancel-deletion (#60)", () => {
  it("asks for the account to be deleted as the person could: sessions end, the clock starts, and nothing is erased yet", async () => {
    const alice = await registerUser("alice", { password: PASSWORD });
    const res = await admin(["users", "delete", "alice", "--yes"]);
    expect(res.code).toBe(0);
    expect(res.out).toContain("Asked for alice to be deleted");
    expect(res.out).toContain("unless they sign in first");
    const row = await rowOf("alice");
    expect(row.deletionRequestedAt).not.toBeNull();
    expect(row.deletedAt).toBeNull();
    expect((await api.post("/api/v1/auth/refresh").send({ refreshToken: alice.refreshToken })).status).toBe(401);
    // The person signing in is the way back, exactly as when they asked themselves.
    const back = await api.post("/api/v1/auth/login").send({ username: "alice", password: PASSWORD });
    expect(back.body.deletionCancelled).toBe(true);
  });

  it("erases at once with --now, saying what that means for backups", async () => {
    await registerUser("alice", { password: PASSWORD });
    const res = await admin(["users", "delete", "alice", "--now", "--yes"]);
    expect(res.code).toBe(0);
    expect(res.out).toContain("Erased alice");
    expect(res.out).toContain("Backups");
    expect(await prisma.user.count({ where: { username: "alice" } })).toBe(0);
    expect(await prisma.deletedUsername.count({ where: { username: "alice" } })).toBe(1);
    expect((await api.post("/api/v1/auth/login").send({ username: "alice", password: PASSWORD })).status).toBe(401);
    // It is not an account any more: not listed, not found.
    expect((await admin(["users", "list"])).out).toContain("No accounts match");
    expect((await admin(["users", "show", "alice"])).code).toBe(1);
  });

  it("asks first, saying what is lost, and does nothing if the answer is no, or without a terminal or --yes", async () => {
    await registerUser("alice");
    const no = await admin(["users", "delete", "alice", "--now"], { confirms: [false] });
    expect(no.code).toBe(1);
    expect(no.asked[0]).toContain("Erase alice NOW?");
    expect(no.asked[0]).toContain("no way back");
    expect(no.out).toContain("Cancelled");
    const soft = await admin(["users", "delete", "alice"], { confirms: [false] });
    expect(soft.asked[0]).toContain("erased in 14 days");
    expect((await rowOf("alice")).deletionRequestedAt).toBeNull();

    const piped = await admin(["users", "delete", "alice", "--now"], { interactive: false });
    expect(piped.code).toBe(2);
    expect(piped.err).toContain("--yes");
    expect((await rowOf("alice")).deletedAt).toBeNull();
  });

  it("refuses an account that owns a community, naming it, whether or not it is asked to erase at once", async () => {
    const alice = await registerUser("alice");
    const club = await createCommunity(alice, "Alice's Club");
    for (const args of [["users", "delete", "alice", "--yes"], ["users", "delete", "alice", "--now", "--yes"]]) {
      const res = await admin(args);
      expect(res.code, args.join(" ")).toBe(1);
      expect(res.err).toContain("Alice's Club");
      expect(res.err).toContain(club.id);
      expect(res.err).toContain("communities delete");
    }
    const row = await rowOf("alice");
    expect(row.deletionRequestedAt).toBeNull();
    expect(row.deletedAt).toBeNull();
    // Delete the community and there is nothing in the way.
    await admin(["communities", "delete", club.id, "--yes"]);
    expect((await admin(["users", "delete", "alice", "--yes"])).code).toBe(0);
  });

  it("can be run again, keeps the first date, and is taken back by cancel-deletion without asking", async () => {
    await registerUser("alice");
    await admin(["users", "delete", "alice", "--yes"]);
    const first = (await rowOf("alice")).deletionRequestedAt;
    const again = await admin(["users", "delete", "alice", "--yes"]);
    expect(again.out).toContain("had already asked");
    expect((await rowOf("alice")).deletionRequestedAt).toEqual(first);

    const back = await admin(["users", "cancel-deletion", "alice"], { interactive: false });
    expect(back.code).toBe(0);
    expect(back.out).toContain("Cancelled the deletion of alice");
    expect((await rowOf("alice")).deletionRequestedAt).toBeNull();
    expect((await admin(["users", "cancel-deletion", "alice"])).out).toContain("had not asked to be deleted");
  });

  it("shows a pending deletion in the list and in the details, and the date it will happen", async () => {
    await registerUser("alice");
    await registerUser("bob");
    await admin(["users", "delete", "alice", "--yes"]);
    const list = await admin(["users", "list"]);
    expect(list.out).toMatch(/alice.*DELETING/);
    expect(list.out).not.toMatch(/bob.*DELETING/);
    const shown = await admin(["users", "show", "alice"]);
    expect(shown.out).toContain("asked for");
    expect(shown.out).toContain("unless they sign in first");
    expect((await admin(["users", "show", "bob"])).out).toContain("not asked for");
    const json = JSON.parse((await admin(["users", "show", "alice", "--json"])).out);
    expect(new Date(json.deletionScheduledFor).getTime() - new Date(json.deletionRequestedAt).getTime()).toBe(config.accountDeletionGraceDays * 24 * 60 * 60 * 1000);
  });

  it("leaves everyone else alone, and will not touch an account that is not ours or does not exist", async () => {
    await registerUser("alice");
    await registerUser("bob", { password: PASSWORD });
    const remy = await remoteStub("remy");
    await admin(["users", "delete", "alice", "--now", "--yes"]);
    expect((await api.post("/api/v1/auth/login").send({ username: "bob", password: PASSWORD })).status).toBe(200);
    for (const args of [["delete", "remy", "--now", "--yes"], ["delete", "nobody", "--yes"], ["cancel-deletion", "remy"], ["cancel-deletion", "nobody"], ["delete", "alice", "--yes"]]) {
      expect((await admin(["users", ...args])).code, args.join(" ")).toBe(1);
    }
    expect((await prisma.user.findUniqueOrThrow({ where: { id: remy.id } })).deletedAt).toBeNull();
  });

  it("says in its help what it does", async () => {
    const help = (await admin(["help"])).out;
    expect(help).toContain("users delete <username> [--now] [--yes]");
    expect(help).toContain("users cancel-deletion <username>");
  });
});

describe("users reset-password", () => {
  it("sets the new password, ends every session, and never shows it", async () => {
    const alice = await registerUser("alice", { password: PASSWORD });
    const fresh = "Brand-New-Password-9!";
    const res = await admin(["users", "reset-password", "alice"], { secrets: [fresh, fresh] });
    expect(res.code).toBe(0);
    expect(res.out).toContain("Changed alice's password. 1 session ended");
    expect(res.everything).not.toContain(fresh);
    expect((await api.post("/api/v1/auth/login").send({ username: "alice", password: fresh })).status).toBe(200);
    expect((await api.post("/api/v1/auth/login").send({ username: "alice", password: PASSWORD })).status).toBe(401);
    expect((await api.post("/api/v1/auth/refresh").send({ refreshToken: alice.refreshToken })).status).toBe(401);
  });

  it("only takes the password at a terminal, never from the command line or a pipe", async () => {
    await registerUser("alice", { password: PASSWORD });
    const piped = await admin(["users", "reset-password", "alice"], { interactive: false, secrets: ["Brand-New-Password-9!", "Brand-New-Password-9!"] });
    expect(piped.code).toBe(2);
    expect(piped.err).toContain("never taken from the command line");
    const onCommandLine = await admin(["users", "reset-password", "alice", "Brand-New-Password-9!"], { secrets: ["Brand-New-Password-9!", "Brand-New-Password-9!"] });
    // The extra word is not a password: it is ignored, and the one at the prompt is used.
    expect(onCommandLine.everything).not.toContain("Brand-New-Password-9!");
  });

  it("holds the new password to the same rules as signing up, and checks it was typed twice", async () => {
    await registerUser("alice", { password: PASSWORD });
    const weak = await admin(["users", "reset-password", "alice"], { secrets: ["short", "short"] });
    expect(weak.code).toBe(2);
    expect(weak.err).toContain("at least 8");
    const different = await admin(["users", "reset-password", "alice"], { secrets: ["Brand-New-Password-9!", "Brand-New-Password-8!"] });
    expect(different.code).toBe(2);
    expect(different.err).toContain("not the same");
    expect((await api.post("/api/v1/auth/login").send({ username: "alice", password: PASSWORD })).status).toBe(200); // unchanged
  });

  it("does not ask for a password for an account that is not there or not ours", async () => {
    await remoteStub("remy");
    for (const username of ["nobody", "remy"]) {
      const res = await admin(["users", "reset-password", username], { secrets: ["Brand-New-Password-9!", "Brand-New-Password-9!"] });
      expect(res.code).toBe(1);
      expect(res.asked).toEqual([]);
    }
  });
});

describe("users disable-2fa", () => {
  async function withTwoFactor() {
    const alice = await registerUser("alice", { password: PASSWORD });
    const { secret } = (await api.post("/api/v1/auth/2fa/setup").set(authHeader(alice.accessToken)).send({ password: PASSWORD })).body;
    await api.post("/api/v1/auth/2fa/verify").set(authHeader(alice.accessToken)).send({ code: await generate({ secret }) });
    return alice;
  }

  it("turns it off for someone locked out, removes their recovery codes, and leaves their sessions alone", async () => {
    const alice = await withTwoFactor();
    expect((await api.post("/api/v1/auth/login").send({ username: "alice", password: PASSWORD })).body.totpRequired).toBe(true);
    const res = await admin(["users", "disable-2fa", "alice", "--yes"]);
    expect(res.code).toBe(0);
    expect(res.out).toContain("Turned off two-factor sign-in for alice");
    const row = await rowOf("alice");
    expect(row.totpEnabled).toBe(false);
    expect(row.totpSecret).toBeNull();
    expect(await prisma.totpRecoveryCode.count({ where: { userId: row.id } })).toBe(0);
    expect((await api.post("/api/v1/auth/login").send({ username: "alice", password: PASSWORD })).body.accessToken).toBeTruthy();
    expect((await api.post("/api/v1/auth/refresh").send({ refreshToken: alice.refreshToken })).status).toBe(200);
  });

  it("asks first, and does nothing without --yes or a terminal", async () => {
    await withTwoFactor();
    expect((await admin(["users", "disable-2fa", "alice"], { confirms: [false] })).code).toBe(1);
    expect((await admin(["users", "disable-2fa", "alice"], { interactive: false })).code).toBe(2);
    expect((await rowOf("alice")).totpEnabled).toBe(true);
  });

  it("says so, without asking, when it was not on", async () => {
    await registerUser("alice");
    const res = await admin(["users", "disable-2fa", "alice"], { interactive: false });
    expect(res.code).toBe(0);
    expect(res.out).toContain("does not have two-factor sign-in on");
  });
});

describe("communities list and show", () => {
  it("lists them, saying which are hosted here and which are copies of another server's, and who owns each", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const club = await createCommunity(alice, "Alice's Club");
    await joinCommunity(club, bob);
    const far = await remoteStub("remy", "far.example");
    await prisma.community.create({ data: { protocolId: newProtocolId(), name: "Far Club", ownerId: far.id, homeserverDomain: "far.example", isRemote: true } });

    const res = await admin(["communities", "list"]);
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/ID\s+NAME\s+HOSTED\s+OWNER\s+MEMBERS\s+CHANNELS/);
    const here = res.out.split("\n").find((l) => l.includes("Alice's Club"))!;
    expect(here).toContain(club.id);
    expect(here).toContain(`@alice:${config.domain}`);
    expect(here).toMatch(/\bhere\b/);
    expect(here).toMatch(/\s2\s+1\s/); // 2 members, 1 channel
    const cached = res.out.split("\n").find((l) => l.includes("Far Club"))!;
    expect(cached).toContain("cached from far.example");
    expect(JSON.parse((await admin(["communities", "list", "--json"])).out)).toHaveLength(2);
  });

  it("shows one: members here and elsewhere, its channels, who can join; and no messages or channel names", async () => {
    const alice = await registerUser("alice");
    const club = await createCommunity(alice, "Alice's Club");
    await api.post(`/api/v1/channels/${(await prisma.channel.findFirstOrThrow({ where: { community: { protocolId: club.id } } })).protocolId}/messages`).set(authHeader(alice.accessToken)).send({ content: "a private conversation" });
    const far = await remoteStub("remy", "far.example");
    const row = await prisma.community.findUniqueOrThrow({ where: { protocolId: club.id } });
    await prisma.communityMember.create({ data: { communityId: row.id, userId: far.id } });

    const res = await admin(["communities", "show", club.id]);
    expect(res.code).toBe(0);
    expect(res.out).toContain("members:      2 (1 here, 1 on other servers: far.example)");
    expect(res.out).toContain("channels:     1 (1 text, 0 voice)");
    expect(res.out).not.toContain("a private conversation");
    expect(res.out).not.toContain("general");
    expect((await admin(["communities", "show", "NOSUCH"])).code).toBe(1);
  });
});

describe("communities delete", () => {
  it("deletes it as its owner would: the members are told, other servers are told to drop their copy, and everything in it goes", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const club = await createCommunity(alice, "Alice's Club");
    await joinCommunity(club, bob);
    const channel = await prisma.channel.findFirstOrThrow({ where: { community: { protocolId: club.id } } });
    await api.post(`/api/v1/channels/${channel.protocolId}/messages`).set(authHeader(alice.accessToken)).send({ content: "hello" });
    const far = await remoteStub("remy", "far.example");
    await prisma.communityMember.create({ data: { communityId: channel.communityId, userId: far.id } });
    await prisma.syncEvent.deleteMany({ where: { type: "community:deleted" } });

    const res = await admin(["communities", "delete", club.id, "--yes"]);
    expect(res.code).toBe(0);
    expect(res.out).toContain('Deleted "Alice\'s Club"');

    expect(await prisma.community.count({ where: { protocolId: club.id } })).toBe(0);
    expect(await prisma.message.count()).toBe(0);
    const told = await prisma.syncEvent.findMany({ where: { type: "community:deleted" } });
    expect(told.map((e) => e.recipientId).sort()).toEqual([(await rowOf("alice")).id, (await rowOf("bob")).id].sort());
    const pings = await prisma.federationOutboxEvent.findMany({ where: { path: `/communities/${club.id}/updated` } });
    expect(pings.map((p) => p.domain)).toEqual(["far.example"]);
    // Their accounts are not touched.
    expect(await prisma.user.count({ where: { username: { in: ["alice", "bob"] } } })).toBe(2);
  });

  it("asks first, saying what goes, and does nothing if the answer is no, or without a terminal or --yes", async () => {
    const alice = await registerUser("alice");
    const club = await createCommunity(alice, "Alice's Club");
    const declined = await admin(["communities", "delete", club.id], { confirms: [false] });
    expect(declined.code).toBe(1);
    expect(declined.asked[0]).toContain('Delete "Alice\'s Club"?');
    expect(declined.asked[0]).toContain("1 channels");
    expect((await admin(["communities", "delete", club.id], { interactive: false })).code).toBe(2);
    expect(await prisma.community.count({ where: { protocolId: club.id } })).toBe(1);
    expect((await admin(["communities", "delete", club.id], { confirms: [true] })).code).toBe(0);
    expect(await prisma.community.count({ where: { protocolId: club.id } })).toBe(0);
  });

  it("will not delete a copy of another server's community, which is theirs, and says so", async () => {
    const far = await remoteStub("remy", "far.example");
    const cached = await prisma.community.create({ data: { protocolId: newProtocolId(), name: "Far Club", ownerId: far.id, homeserverDomain: "far.example", isRemote: true } });
    const res = await admin(["communities", "delete", cached.protocolId, "--yes"]);
    expect(res.code).toBe(1);
    expect(res.err).toContain("on far.example");
    expect(await prisma.community.count({ where: { id: cached.id } })).toBe(1);
  });

  it("says when there is no such community, and deleting twice is harmless", async () => {
    const alice = await registerUser("alice");
    const club = await createCommunity(alice);
    expect((await admin(["communities", "delete", "NOSUCH", "--yes"])).code).toBe(1);
    expect((await admin(["communities", "delete", club.id, "--yes"])).code).toBe(0);
    const again = await admin(["communities", "delete", club.id, "--yes"]);
    expect(again.code).toBe(1);
    expect(again.err).toContain("There is no community");
  });
});
