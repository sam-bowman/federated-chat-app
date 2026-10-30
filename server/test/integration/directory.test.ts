// The directory (#109, phase 5): the PUBLIC communities a server lists and the people who chose to be listed, for its own people
// to browse and, through their own servers, other servers' people. Off until the operator turns DIRECTORY_ENABLED on.
//
// config.directoryEnabled (and the other settings) are read at the moment of each decision, so these tests flip them per test and
// put them back.
import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { config } from "../../src/config.js";
import { prisma } from "../../src/db.js";
import { newProtocolId } from "../../src/lib/ids.js";
import { createDomainPolicy } from "../../src/lib/federationPolicy.js";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { registerTestPeer, signedGet } from "../helpers/federation.js";
import { authHeader, registerUser } from "../helpers/factory.js";

beforeEach(resetDb);
afterAll(disconnectDb);
afterEach(() => {
  config.directoryEnabled = false;
  config.federationEnabled = true;
  config.federationPolicy = createDomainPolicy([], []);
  config.userDiscoverability = "default-on";
});

type Registered = Awaited<ReturnType<typeof registerUser>>;
type Visibility = "UNLISTED" | "INVITE_ONLY" | "LOCAL_ONLY" | "PUBLIC";
const FAR = "far.invalid";

const publish = () => {
  config.directoryEnabled = true;
};
const row = (username: string) => prisma.user.findFirstOrThrow({ where: { username, isRemote: false } });

/** A community hosted here, with an id that sorts by `n` (a real one sorts by when it was made). */
async function community(owner: Registered, n: number, over: { name?: string; description?: string | null; visibility?: Visibility; iconUrl?: string | null } = {}) {
  const ownerRow = await row(owner.user.username);
  return prisma.community.create({
    data: {
      protocolId: String(n).padStart(26, "0"),
      name: over.name ?? `Club ${n}`,
      description: over.description ?? null,
      iconUrl: over.iconUrl ?? null,
      ownerId: ownerRow.id,
      homeserverDomain: config.domain,
      visibility: over.visibility ?? "PUBLIC",
      members: { create: [{ userId: ownerRow.id }] },
    },
  });
}

const listCommunities = (who: Registered, query = "") => api.get(`/api/v1/directory/communities${query}`).set(authHeader(who.accessToken));
const listPeople = (who: Registered, query = "") => api.get(`/api/v1/directory/people${query}`).set(authHeader(who.accessToken));
const patchMe = (who: Registered, body: object) => api.patch("/api/v1/users/me").set(authHeader(who.accessToken)).send(body);

describe("whether a server publishes a directory", () => {
  it("does not, until the operator turns it on: nothing is listed and nobody is told there is anything", async () => {
    const alice = await registerUser("alice");
    await community(alice, 1);
    const far = await registerTestPeer(FAR);

    const local = await listCommunities(alice);
    const people = await listPeople(alice);
    const federated = await signedGet(far, "/federation/v1/directory/communities");
    const federatedPeople = await signedGet(far, "/federation/v1/directory/people");

    expect([local.status, local.body]).toEqual([404, { error: "directory_disabled" }]);
    expect([people.status, people.body]).toEqual([404, { error: "directory_disabled" }]);
    expect([federated.status, federated.body]).toEqual([404, { error: "directory_disabled" }]);
    expect([federatedPeople.status, federatedPeople.body]).toEqual([404, { error: "directory_disabled" }]);
  });

  it("says whether it does in its discovery document, which stays public", async () => {
    expect((await api.get("/.well-known/communication-platform")).body.features.directory).toBe(false);

    publish();

    expect((await api.get("/.well-known/communication-platform")).body.features.directory).toBe(true);
  });

  it("is only for people who are signed in, and, from another server, only for a signed request", async () => {
    publish();

    expect((await api.get("/api/v1/directory/communities")).status).toBe(401);
    expect((await api.get("/federation/v1/directory/communities")).status).toBe(401);
  });
});

describe("the communities it lists", () => {
  it("are the PUBLIC ones hosted here, and no others", async () => {
    publish();
    const alice = await registerUser("alice");
    await community(alice, 1, { name: "Public", visibility: "PUBLIC" });
    await community(alice, 2, { name: "Unlisted", visibility: "UNLISTED" });
    await community(alice, 3, { name: "Invite", visibility: "INVITE_ONLY" });
    await community(alice, 4, { name: "Local", visibility: "LOCAL_ONLY" });
    const owner = await prisma.user.create({ data: { protocolId: newProtocolId(), username: "olga", displayName: "Olga", homeserverDomain: FAR, isRemote: true } });
    await prisma.community.create({
      data: { protocolId: String(5).padStart(26, "0"), name: "Cached", ownerId: owner.id, homeserverDomain: FAR, isRemote: true, visibility: "PUBLIC" },
    });

    const res = await listCommunities(alice);

    expect(res.status).toBe(200);
    expect(res.body.items.map((c: { name: string }) => c.name)).toEqual(["Public"]); // not the ones another server hosts
  });

  it("say what they are, with the picture as a full address and how many are in", async () => {
    publish();
    const alice = await registerUser("alice");
    const created = await community(alice, 1, { description: "We read.", iconUrl: "/uploads/club.png" });
    const bob = await registerUser("bob");
    await prisma.communityMember.create({ data: { communityId: created.id, userId: (await row("bob")).id } });
    expect(bob).toBeTruthy();

    const res = await listCommunities(alice);

    expect(res.body.items[0]).toEqual({
      id: created.protocolId,
      domain: config.domain,
      name: "Club 1",
      description: "We read.",
      iconUrl: `${config.baseUrl}/uploads/club.png`,
      iconText: null,
      iconColor: null,
      memberCount: 2,
    });
    expect(res.body.nextCursor).toBeNull();
  });

  it("can be joined by the code they are listed with, from this server or another, like any unlisted one", async () => {
    publish();
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const created = await community(alice, 1);

    const joined = await api.post(`/api/v1/communities/${created.protocolId}/members`).set(authHeader(bob.accessToken)).send({});

    expect(joined.status).toBe(201);
  });

  it("are chosen by a manager of the community, who can make one PUBLIC and take it back", async () => {
    publish();
    const alice = await registerUser("alice");
    const made = await api.post("/api/v1/communities").set(authHeader(alice.accessToken)).send({ name: "Book Club" });
    const id = made.body.community.id as string;
    expect((await listCommunities(alice)).body.items).toEqual([]);

    const patched = await api.patch(`/api/v1/communities/${id}`).set(authHeader(alice.accessToken)).send({ visibility: "PUBLIC" });
    expect([patched.status, patched.body.community.visibility, patched.body.community.openJoin]).toEqual([200, "PUBLIC", true]);
    expect((await listCommunities(alice)).body.items.map((c: { id: string }) => c.id)).toEqual([id]);

    await api.patch(`/api/v1/communities/${id}`).set(authHeader(alice.accessToken)).send({ visibility: "LOCAL_ONLY" });
    expect((await listCommunities(alice)).body.items).toEqual([]);
  });

  it("are found by part of the name or description, whatever its case, and the search is taken literally", async () => {
    publish();
    const alice = await registerUser("alice");
    await community(alice, 1, { name: "Book Club", description: "Novels" });
    await community(alice, 2, { name: "Chess", description: "Openings and BOOKS" });
    await community(alice, 3, { name: "100% Rust", description: null });
    await community(alice, 4, { name: "a_b", description: null });

    expect((await listCommunities(alice, "?q=book")).body.items.map((c: { name: string }) => c.name)).toEqual(["Chess", "Book Club"]);
    expect((await listCommunities(alice, "?q=NOVEL")).body.items.map((c: { name: string }) => c.name)).toEqual(["Book Club"]);
    expect((await listCommunities(alice, "?q=%25")).body.items.map((c: { name: string }) => c.name)).toEqual(["100% Rust"]); // % is not a wildcard
    expect((await listCommunities(alice, "?q=_")).body.items.map((c: { name: string }) => c.name)).toEqual(["a_b"]); // nor is _
    expect((await listCommunities(alice, "?q=nothing")).body.items).toEqual([]);
  });

  it("come a page at a time, newest first, without repeating or missing any, even if one goes while the page is open", async () => {
    publish();
    const alice = await registerUser("alice");
    for (let n = 1; n <= 25; n++) await community(alice, n);

    const first = await listCommunities(alice);
    expect(first.body.items).toHaveLength(20);
    expect(first.body.items[0].name).toBe("Club 25");
    expect(first.body.nextCursor).toBe(first.body.items[19].id);
    await prisma.community.delete({ where: { protocolId: first.body.items[19].id } }); // gone between the pages
    const second = await listCommunities(alice, `?cursor=${first.body.nextCursor}`);

    expect(second.body.items.map((c: { name: string }) => c.name)).toEqual(["Club 5", "Club 4", "Club 3", "Club 2", "Club 1"]);
    expect(second.body.nextCursor).toBeNull();
  });

  it("are asked for with a search and a cursor that are plain, and a request that is not is refused", async () => {
    publish();
    const alice = await registerUser("alice");

    for (const bad of ["?q=a%0Ab", "?cursor=has%20space", `?q=${"x".repeat(65)}`, "?q=a&q=b", "?cursor=a&cursor=b"]) {
      expect([(await listCommunities(alice, bad)).status, bad]).toEqual([400, bad]);
    }
  });
});

describe("the people it lists", () => {
  it("are those who chose to be, and can still be found: someone who hid is not, whatever they chose before", async () => {
    publish();
    const alice = await registerUser("alice");
    const listed = await registerUser("lena");
    const quiet = await registerUser("quentin");
    const hidden = await registerUser("hidy");
    await patchMe(listed, { listedInDirectory: true });
    await patchMe(hidden, { listedInDirectory: true });
    await patchMe(hidden, { discoverable: false });
    expect(quiet).toBeTruthy();

    const res = await listPeople(alice);

    expect(res.body.items.map((p: { username: string }) => p.username)).toEqual(["lena"]);
  });

  it("say who they are, and not the person looking", async () => {
    publish();
    const lena = await registerUser("lena", { displayName: "Lena L" });
    await patchMe(lena, { listedInDirectory: true, bio: "Hello", avatarUrl: "/uploads/lena.png" });

    expect((await listPeople(lena)).body.items).toEqual([]); // her own entry is of no use to her
    const alice = await registerUser("alice");
    const res = await listPeople(alice);

    expect(res.body.items).toEqual([
      { id: lena.user.id, username: "lena", domain: config.domain, displayName: "Lena L", avatarUrl: `${config.baseUrl}/uploads/lena.png`, bio: "Hello" },
    ]);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|email|totp|presence/i);
  });

  it("are nobody when the server has switched findability off for everyone, whatever they chose", async () => {
    publish();
    const lena = await registerUser("lena");
    await patchMe(lena, { listedInDirectory: true });
    const alice = await registerUser("alice");
    config.userDiscoverability = "forced-off";

    expect((await listPeople(alice)).body.items).toEqual([]);
  });

  it("are not people on other servers whom this server happens to know", async () => {
    publish();
    const alice = await registerUser("alice");
    await prisma.user.create({
      data: { protocolId: newProtocolId(), username: "rex", displayName: "Rex", homeserverDomain: FAR, isRemote: true, listedInDirectory: true },
    });

    expect((await listPeople(alice)).body.items).toEqual([]);
  });

  it("are found by part of a username or name, and come a page at a time", async () => {
    publish();
    const alice = await registerUser("alice");
    for (let n = 1; n <= 22; n++) {
      const who = await registerUser(`person${String(n).padStart(2, "0")}`, { displayName: n === 7 ? "Seven Of Nine" : `Person ${n}` });
      await patchMe(who, { listedInDirectory: true });
    }

    const first = await listPeople(alice);
    const second = await listPeople(alice, `?cursor=${first.body.nextCursor}`);

    expect(first.body.items).toHaveLength(20);
    expect(second.body.items).toHaveLength(2);
    expect(new Set([...first.body.items, ...second.body.items].map((p: { id: string }) => p.id)).size).toBe(22);
    expect((await listPeople(alice, "?q=seven")).body.items.map((p: { username: string }) => p.username)).toEqual(["person07"]);
    expect((await listPeople(alice, "?q=PERSON22")).body.items.map((p: { username: string }) => p.username)).toEqual(["person22"]);
  });
});

describe("the choice to be listed", () => {
  it("is saved, off for everyone to begin with, and shown only to the person it is about", async () => {
    const lena = await registerUser("lena");
    const other = await registerUser("other");
    expect(lena.user).toMatchObject({ listedInDirectory: false });

    const patched = await patchMe(lena, { listedInDirectory: true });
    const me = await api.get("/api/v1/users/me").set(authHeader(lena.accessToken));
    const view = await api.get(`/api/v1/users/${lena.user.id}/profile`).set(authHeader(other.accessToken));

    expect(patched.body.user).toMatchObject({ listedInDirectory: true, directoryEnabled: false });
    expect(me.body.user).toMatchObject({ listedInDirectory: true });
    expect(JSON.stringify(view.body)).not.toContain("listedInDirectory");
  });

  it("says whether the server publishes a directory at all, so being listed can be explained", async () => {
    const lena = await registerUser("lena");
    publish();

    expect((await api.get("/api/v1/users/me").set(authHeader(lena.accessToken))).body.user.directoryEnabled).toBe(true);
  });

  it("is true or false and nothing else, and is not changed where the server has taken findability away", async () => {
    const lena = await registerUser("lena");
    for (const value of ["yes", 1, null]) expect([(await patchMe(lena, { listedInDirectory: value })).status, value]).toEqual([400, value]);

    config.userDiscoverability = "forced-off";
    const res = await patchMe(lena, { listedInDirectory: true });

    expect([res.status, res.body.error]).toEqual([409, "discoverability_locked"]);
  });

  it("is not who another server finds by handle: listing and being found are separate, and hiding wins", async () => {
    publish();
    const lena = await registerUser("lena");
    await patchMe(lena, { listedInDirectory: true, discoverable: false });
    const far = await registerTestPeer(FAR);

    const lookup = await signedGet(far, "/federation/v1/users/lena");
    const listing = await signedGet(far, "/federation/v1/directory/people");

    expect(lookup.status).toBe(404);
    expect(listing.body.items).toEqual([]);
  });
});

describe("another server asking for this one's directory", () => {
  it("is answered when it publishes one, with the same pages", async () => {
    publish();
    const alice = await registerUser("alice");
    await community(alice, 1, { name: "Book Club" });
    const lena = await registerUser("lena");
    await patchMe(lena, { listedInDirectory: true });
    const far = await registerTestPeer(FAR);

    const communities = await signedGet(far, "/federation/v1/directory/communities?q=book");
    const people = await signedGet(far, "/federation/v1/directory/people");

    expect(communities.body.items.map((c: { name: string }) => c.name)).toEqual(["Book Club"]);
    expect(people.body.items.map((p: { username: string }) => p.username)).toEqual(["lena"]);
  });

  it("is refused a request that is not plain", async () => {
    publish();
    const far = await registerTestPeer(FAR);

    expect((await signedGet(far, "/federation/v1/directory/communities?cursor=a%20b")).status).toBe(400);
  });

  it("is refused, like everything else, by a private server and for a server this one does not talk to", async () => {
    publish();
    const far = await registerTestPeer(FAR);
    config.federationPolicy = createDomainPolicy([], [FAR]);
    const blocked = await signedGet(far, "/federation/v1/directory/communities");
    config.federationPolicy = createDomainPolicy([], []);
    config.federationEnabled = false;
    const privateServer = await signedGet(far, "/federation/v1/directory/communities");

    expect([blocked.status, blocked.body.error]).toEqual([403, "federation_domain_blocked"]);
    expect([privateServer.status, privateServer.body.error]).toEqual([403, "federation_disabled"]);
  });

  it("does not stop this server's own people browsing it when it is private: that is not talking to another server", async () => {
    publish();
    const alice = await registerUser("alice");
    await community(alice, 1);
    config.federationEnabled = false;

    expect((await listCommunities(alice)).body.items).toHaveLength(1);
  });
});

describe("browsing another server's directory, through this one", () => {
  let host: Server;
  let asked: string[];
  /** What the fake server answers a directory request: a body, a status, or nothing at all (it hangs up). */
  let answer: { status: number; body: unknown } | null;

  beforeEach(async () => {
    asked = [];
    answer = { status: 200, body: { items: [], nextCursor: null } };
    host = createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/.well-known/communication-platform") {
        res.end(JSON.stringify({ federation: { enabled: true, publicKey: `${FAR}-key`, apiBase: "/federation/v1" } }));
        return;
      }
      asked.push(req.url ?? "");
      if (answer === null) return void req.socket.destroy();
      res.statusCode = answer.status;
      res.end(JSON.stringify(answer.body));
    });
    await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
    config.federationPeerOverrides[FAR] = `http://127.0.0.1:${(host.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    delete config.federationPeerOverrides[FAR];
    await new Promise<void>((resolve) => host.close(() => resolve()));
  });

  it("asks that server, with the search and the page, and passes the answer on, saying where each thing lives", async () => {
    const alice = await registerUser("alice");
    answer = {
      status: 200,
      body: { items: [{ id: "01M4ZY34DY638B7J24A3RMYRMC", name: "Far Club", description: "Hi", iconUrl: null, memberCount: 3 }], nextCursor: "01ABC" },
    };

    const res = await listCommunities(alice, `?domain=${FAR}&q=far%20club&cursor=01ZZZ`);

    expect(asked).toEqual(["/federation/v1/directory/communities?q=far%20club&cursor=01ZZZ"]);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      items: [{ id: "01M4ZY34DY638B7J24A3RMYRMC", domain: FAR, name: "Far Club", description: "Hi", iconUrl: null, iconText: null, iconColor: null, memberCount: 3 }],
      nextCursor: "01ABC",
    });
  });

  it("browses people the same way", async () => {
    const alice = await registerUser("alice");
    answer = { status: 200, body: { items: [{ id: "01M4ZY34DY638B7J24A3RMYRMC", username: "rex", displayName: "Rex", avatarUrl: null, bio: null }], nextCursor: null } };

    const res = await listPeople(alice, `?domain=${FAR}`);

    expect(asked).toEqual(["/federation/v1/directory/people"]);
    expect(res.body.items).toEqual([{ id: "01M4ZY34DY638B7J24A3RMYRMC", username: "rex", domain: FAR, displayName: "Rex", avatarUrl: null, bio: null }]);
  });

  it("checks everything that comes back, because it is a stranger's: what is wrong is dropped, and nothing is trusted about where it lives", async () => {
    const alice = await registerUser("alice");
    answer = {
      status: 200,
      body: {
        items: [
          { id: "ok1", name: "Fine", description: null, iconUrl: "javascript:alert(1)", memberCount: -1, domain: "evil.example" },
          { id: "has space", name: "Bad id" },
          { id: "ok2", name: "<img src=x onerror=alert(1)>" },
          { id: "ok3", name: "bell\u0007" },
        ],
        nextCursor: "not a cursor",
      },
    };

    const res = await listCommunities(alice, `?domain=${FAR}`);

    expect(res.body.items.map((c: { id: string; domain: string; iconUrl: string | null }) => [c.id, c.domain, c.iconUrl])).toEqual([
      ["ok1", FAR, null],
      ["ok2", FAR, null], // markup is just text here: the client shows it as text
    ]);
    expect(res.body.nextCursor).toBeNull();
  });

  it("says so when that server publishes no directory, which is not the same as not being able to reach it", async () => {
    const alice = await registerUser("alice");
    answer = { status: 404, body: { error: "directory_disabled" } };

    const none = await listCommunities(alice, `?domain=${FAR}`);
    answer = null;
    const down = await listCommunities(alice, `?domain=${FAR}`);

    expect([none.status, none.body]).toEqual([404, { error: "directory_disabled" }]);
    expect([down.status, down.body.error]).toEqual([502, "federation_unreachable"]);
  });

  it("is refused by a private server, plainly, and does not go anywhere", async () => {
    const alice = await registerUser("alice");
    config.federationEnabled = false;

    const res = await listCommunities(alice, `?domain=${FAR}`);

    expect([res.status, res.body.error]).toEqual([403, "federation_disabled"]);
    expect(asked).toEqual([]);
  });

  it("is refused for a server this one does not talk to, and does not go there", async () => {
    const alice = await registerUser("alice");
    config.federationPolicy = createDomainPolicy([], [FAR]);

    const res = await listPeople(alice, `?domain=${FAR}`);

    expect([res.status, res.body.error]).toEqual([403, "federation_domain_blocked"]);
    expect(asked).toEqual([]);
  });

  it("is this server's own directory when the domain named is this server's, whatever its case", async () => {
    publish();
    const alice = await registerUser("alice");
    await community(alice, 1);

    const res = await listCommunities(alice, `?domain=${config.domain.toUpperCase()}`);

    expect(res.body.items).toHaveLength(1);
    expect(asked).toEqual([]);
  });

  it("is refused a domain that is not one, and a domain that carries something else", async () => {
    const alice = await registerUser("alice");

    for (const bad of ["a b", "https://far.invalid", "far.invalid/x", "x@y", "far.invalid%0d%0a", "..", "far.invalid:99999x"]) {
      expect([(await listCommunities(alice, `?domain=${encodeURIComponent(bad)}`)).status, bad]).toEqual([400, bad]);
    }
    expect((await listCommunities(alice, "?domain=a&domain=b")).status).toBe(400);
    expect(asked).toEqual([]);
  });

  it("gives this server's own answer for a search it would refuse, rather than asking the other one", async () => {
    const alice = await registerUser("alice");

    expect((await listCommunities(alice, `?domain=${FAR}&q=${"x".repeat(65)}`)).status).toBe(400);
    expect(asked).toEqual([]);
  });
});
