import fs from "node:fs";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { config } from "../../src/config.js";
import { prisma } from "../../src/db.js";
import { newProtocolId } from "../../src/lib/ids.js";
import { applyCommunitySnapshot, buildCommunitySnapshot } from "../../src/modules/federation/communitySnapshot.js";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { authHeader, registerUser } from "../helpers/factory.js";

beforeEach(resetDb);
afterAll(disconnectDb);

type Registered = Awaited<ReturnType<typeof registerUser>>;
type CommunityJson = {
  id: string;
  name: string;
  iconUrl: string | null;
  iconText: string | null;
  iconColor: string | null;
};

async function createCommunity(owner: Registered, name = "Book Club") {
  const res = await api.post("/api/v1/communities").set(authHeader(owner.accessToken)).send({ name });
  expect(res.status).toBe(201);
  return res.body.community as CommunityJson;
}

const patch = (who: Registered, community: { id: string }, body: unknown) =>
  api.patch(`/api/v1/communities/${community.id}`).set(authHeader(who.accessToken)).send(body as object);

const join = (who: Registered, community: { id: string }) =>
  api.post(`/api/v1/communities/${community.id}/members`).set(authHeader(who.accessToken));

const row = (community: { id: string }) => prisma.community.findUniqueOrThrow({ where: { protocolId: community.id } });

describe("a new community", () => {
  it("has the default tile: no picture, no letters, no colour", async () => {
    const alice = await registerUser("alice");

    const community = await createCommunity(alice);

    expect(community.iconUrl).toBeNull();
    expect(community.iconText).toBeNull();
    expect(community.iconColor).toBeNull();
  });
});

describe("setting the letters and colour", () => {
  it("stores and returns them, and lists them with the community", async () => {
    const alice = await registerUser("alice");
    const community = await createCommunity(alice);

    const res = await patch(alice, community, { iconText: "BC", iconColor: "#E8B84B" });

    expect(res.status).toBe(200);
    expect(res.body.community.iconText).toBe("BC");
    expect(res.body.community.iconColor).toBe("#e8b84b"); // normalised to lower case
    const list = await api.get("/api/v1/communities").set(authHeader(alice.accessToken));
    expect(list.body.communities[0].iconText).toBe("BC");
    expect(list.body.communities[0].iconColor).toBe("#e8b84b");
  });

  it("goes back to the default with null, leaving the name alone", async () => {
    const alice = await registerUser("alice");
    const community = await createCommunity(alice);
    await patch(alice, community, { iconText: "BC", iconColor: "#e8b84b" });

    const res = await patch(alice, community, { iconText: null, iconColor: null });

    expect(res.body.community.iconText).toBeNull();
    expect(res.body.community.iconColor).toBeNull();
    expect(res.body.community.name).toBe("Book Club");
  });

  it("changes one without touching the other", async () => {
    const alice = await registerUser("alice");
    const community = await createCommunity(alice);
    await patch(alice, community, { iconText: "BC", iconColor: "#e8b84b" });

    const res = await patch(alice, community, { iconColor: "#3bc47e" });

    expect(res.body.community.iconText).toBe("BC");
    expect(res.body.community.iconColor).toBe("#3bc47e");
  });

  it("accepts an emoji, and a few characters in any script", async () => {
    const alice = await registerUser("alice");
    const community = await createCommunity(alice);

    expect((await patch(alice, community, { iconText: "🎲" })).body.community.iconText).toBe("🎲");
    expect((await patch(alice, community, { iconText: "日本語" })).body.community.iconText).toBe("日本語");
  });

  it.each([
    ["empty letters", { iconText: "" }],
    ["only spaces", { iconText: "   " }],
    ["four characters", { iconText: "ABCD" }],
    ["a newline in the letters", { iconText: "A\nB" }],
    ["a control character", { iconText: "A\u0000" }],
    ["letters that are not text", { iconText: 5 }],
    ["a three-digit colour", { iconColor: "#fff" }],
    ["a colour without the hash", { iconColor: "ff8800" }],
    ["a colour name", { iconColor: "red" }],
    ["css smuggled into the colour", { iconColor: "#ff8800;background:url(x)" }],
    ["a javascript: picture", { iconUrl: "javascript:alert(1)" }],
    ["a data: picture", { iconUrl: "data:image/png;base64,AAAA" }],
    ["a protocol-relative picture", { iconUrl: "//evil.example/a.png" }],
    ["a path outside uploads", { iconUrl: "/etc/passwd" }],
    ["an empty picture", { iconUrl: "" }],
  ])("refuses %s and changes nothing", async (_name, body) => {
    const alice = await registerUser("alice");
    const community = await createCommunity(alice);
    await patch(alice, community, { iconText: "BC", iconColor: "#e8b84b" });

    const res = await patch(alice, community, body);

    expect(res.status).toBe(400);
    const stored = await row(community);
    expect([stored.iconText, stored.iconColor, stored.iconUrl]).toEqual(["BC", "#e8b84b", null]);
  });

  it("is for someone who manages the community, not any member", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const community = await createCommunity(alice);
    await join(bob, community);

    const res = await patch(bob, community, { iconText: "XX" });

    expect(res.status).toBe(403);
    expect((await row(community)).iconText).toBeNull();
  });

  it("is allowed to a member with the Manage community permission", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const community = await createCommunity(alice);
    await join(bob, community);
    const role = await api
      .post(`/api/v1/communities/${community.id}/roles`)
      .set(authHeader(alice.accessToken))
      .send({ name: "Admin", permissions: (1n << 0n).toString() }); // MANAGE_COMMUNITY
    await api
      .post(`/api/v1/communities/${community.id}/members/${bob.user.id}/roles/${role.body.role.id}`)
      .set(authHeader(alice.accessToken));

    const res = await patch(bob, community, { iconText: "OK" });

    expect(res.status).toBe(200);
    expect(res.body.community.iconText).toBe("OK");
  });
});

describe("telling the members", () => {
  it("tells every local member's client to refetch, so the rail updates without a reload", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const outsider = await registerUser("outsider");
    const community = await createCommunity(alice);
    await join(bob, community);
    // Joining tells the members too (#220): only what the change itself sends is under test here.
    await prisma.syncEvent.deleteMany({ where: { type: "community:updated" } });

    await patch(alice, community, { iconText: "BC", iconColor: "#e8b84b" });

    const events = await prisma.syncEvent.findMany({ where: { type: "community:updated" } });
    const recipients = events.map((e) => e.recipientId).sort();
    const dbId = async (u: Registered) => (await prisma.user.findUniqueOrThrow({ where: { protocolId: u.user.id } })).id;
    expect(recipients).toEqual([await dbId(alice), await dbId(bob)].sort());
    expect(recipients).not.toContain(await dbId(outsider));
  });

  it("pings each other server with a member, so their copy is refetched", async () => {
    const alice = await registerUser("alice");
    const community = await createCommunity(alice);
    const remote = await prisma.user.create({
      data: { protocolId: newProtocolId(), username: "remy", displayName: "Remy", homeserverDomain: "far.invalid", isRemote: true },
    });
    await prisma.communityMember.create({ data: { communityId: (await row(community)).id, userId: remote.id } });

    await patch(alice, community, { iconText: "BC" });

    const pings = await prisma.federationOutboxEvent.findMany({ where: { path: `/communities/${community.id}/updated` } });
    expect(pings.map((p) => p.domain)).toEqual(["far.invalid"]);
  });
});

describe("the old picture file", () => {
  const written: string[] = [];
  const filePath = (name: string) => path.join(path.resolve(config.uploadsDir), name);

  function makeUpload(label: string) {
    const name = `icon-test-${label}-${newProtocolId()}.png`;
    fs.mkdirSync(path.resolve(config.uploadsDir), { recursive: true });
    fs.writeFileSync(filePath(name), "x");
    written.push(name);
    return { name, url: `/uploads/${name}` };
  }

  afterEach(() => {
    for (const name of written.splice(0)) fs.rmSync(filePath(name), { force: true });
  });

  it("is deleted when the picture is replaced", async () => {
    const alice = await registerUser("alice");
    const community = await createCommunity(alice);
    const first = makeUpload("first");
    const second = makeUpload("second");
    await patch(alice, community, { iconUrl: first.url });

    const res = await patch(alice, community, { iconUrl: second.url });

    expect(res.body.community.iconUrl).toBe(second.url);
    expect(fs.existsSync(filePath(first.name))).toBe(false);
    expect(fs.existsSync(filePath(second.name))).toBe(true);
  });

  it("is deleted when the picture is removed", async () => {
    const alice = await registerUser("alice");
    const community = await createCommunity(alice);
    const icon = makeUpload("icon");
    await patch(alice, community, { iconUrl: icon.url });

    const res = await patch(alice, community, { iconUrl: null });

    expect(res.body.community.iconUrl).toBeNull();
    expect(fs.existsSync(filePath(icon.name))).toBe(false);
  });

  it("is kept when something else uses the same file", async () => {
    const alice = await registerUser("alice");
    const community = await createCommunity(alice);
    const shared = makeUpload("shared");
    const other = makeUpload("other");
    await prisma.user.update({ where: { protocolId: alice.user.id }, data: { avatarUrl: shared.url } }); // alice's avatar
    await patch(alice, community, { iconUrl: shared.url });

    await patch(alice, community, { iconUrl: other.url });

    expect(fs.existsSync(filePath(shared.name))).toBe(true);
  });

  it("is not touched when the letters change and the picture does not", async () => {
    const alice = await registerUser("alice");
    const community = await createCommunity(alice);
    const icon = makeUpload("icon");
    await patch(alice, community, { iconUrl: icon.url });

    await patch(alice, community, { iconText: "BC" });
    await patch(alice, community, { iconUrl: icon.url }); // set to the same file again

    expect(fs.existsSync(filePath(icon.name))).toBe(true);
    expect((await row(community)).iconUrl).toBe(icon.url);
  });

  it("never fails the change over a file it cannot delete (already gone, or another server's)", async () => {
    const alice = await registerUser("alice");
    const community = await createCommunity(alice);
    await prisma.community.update({ where: { id: (await row(community)).id }, data: { iconUrl: "/uploads/already-gone.png" } });

    const gone = await patch(alice, community, { iconUrl: null });
    expect(gone.status).toBe(200);

    await prisma.community.update({ where: { id: (await row(community)).id }, data: { iconUrl: "https://elsewhere.example/icon.png" } });
    const elsewhere = await patch(alice, community, { iconText: "BC", iconUrl: null });
    expect(elsewhere.status).toBe(200);
  });
});

describe("the snapshot a member's server caches", () => {
  it("carries the letters and colour, and an absolute URL for an uploaded picture", async () => {
    const alice = await registerUser("alice");
    const community = await createCommunity(alice);
    await patch(alice, community, { iconText: "BC", iconColor: "#e8b84b", iconUrl: "/uploads/icon.png" });

    const snapshot = await buildCommunitySnapshot((await row(community)).id);

    // A relative path would resolve against the member's own server: the wrong one.
    expect(snapshot.iconUrl).toBe(`${config.baseUrl}/uploads/icon.png`);
    expect(snapshot.iconText).toBe("BC");
    expect(snapshot.iconColor).toBe("#e8b84b");
  });

  it("leaves an already-absolute picture alone, and a community with none has none", async () => {
    const alice = await registerUser("alice");
    const community = await createCommunity(alice);
    expect((await buildCommunitySnapshot((await row(community)).id)).iconUrl).toBeNull();

    await patch(alice, community, { iconUrl: "https://cdn.example/icon.png" });

    expect((await buildCommunitySnapshot((await row(community)).id)).iconUrl).toBe("https://cdn.example/icon.png");
  });
});

describe("applying a snapshot from another server", () => {
  // Applying a snapshot looks up the owner on their server first (discovery), so the peer has to answer.
  let peer: Server;
  beforeEach(async () => {
    peer = createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/.well-known/communication-platform") {
        res.end(JSON.stringify({ federation: { enabled: true, publicKey: "far-key", apiBase: "/federation/v1" } }));
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
    await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", resolve));
    config.federationPeerOverrides["far.invalid"] = `http://127.0.0.1:${(peer.address() as { port: number }).port}`;
  });
  afterEach(async () => {
    delete config.federationPeerOverrides["far.invalid"];
    await new Promise<void>((resolve) => peer.close(() => resolve()));
  });

  const owner = { protocolId: "OWNERPROTOID01", username: "owner", domain: "far.invalid", displayName: "Owner", avatarUrl: null };
  const channels = [{ protocolId: "GENERALPROTOID01", name: "general", topic: null, position: 0, type: "TEXT" as const }];
  const snapshot = (extra: object) => ({
    protocolId: "REMOTECOMMUNITYID01",
    name: "Far Club",
    description: null,
    iconUrl: null,
    owner,
    channels,
    ...extra,
  });

  it("keeps a valid tile", async () => {
    await applyCommunitySnapshot(
      snapshot({ iconUrl: "https://far.invalid/uploads/a.png", iconText: "FC", iconColor: "#3bc47e" }),
      "far.invalid"
    );

    const stored = await prisma.community.findUniqueOrThrow({ where: { protocolId: "REMOTECOMMUNITYID01" } });
    expect([stored.iconUrl, stored.iconText, stored.iconColor]).toEqual(["https://far.invalid/uploads/a.png", "FC", "#3bc47e"]);
  });

  // The fields are user data from another server, shown to our members.
  it("drops anything invalid rather than storing it", async () => {
    await applyCommunitySnapshot(
      snapshot({ iconUrl: "/uploads/a.png", iconText: "TOO LONG", iconColor: "red;background:url(x)" }),
      "far.invalid"
    );

    const stored = await prisma.community.findUniqueOrThrow({ where: { protocolId: "REMOTECOMMUNITYID01" } });
    expect([stored.iconUrl, stored.iconText, stored.iconColor]).toEqual([null, null, null]);
  });

  it("drops a javascript: picture and control characters in the letters", async () => {
    await applyCommunitySnapshot(snapshot({ iconUrl: "javascript:alert(1)", iconText: "A\u0000B" }), "far.invalid");

    const stored = await prisma.community.findUniqueOrThrow({ where: { protocolId: "REMOTECOMMUNITYID01" } });
    expect([stored.iconUrl, stored.iconText]).toEqual([null, null]);
  });

  it("takes a snapshot from a server that predates the letters and colour as the default", async () => {
    await applyCommunitySnapshot(snapshot({}), "far.invalid"); // neither field present

    const stored = await prisma.community.findUniqueOrThrow({ where: { protocolId: "REMOTECOMMUNITYID01" } });
    expect([stored.iconText, stored.iconColor]).toEqual([null, null]);
  });

  it("follows a change on the home server, including going back to the default", async () => {
    await applyCommunitySnapshot(snapshot({ iconText: "FC", iconColor: "#3bc47e" }), "far.invalid");

    await applyCommunitySnapshot(snapshot({ iconText: null, iconColor: null }), "far.invalid");

    const stored = await prisma.community.findUniqueOrThrow({ where: { protocolId: "REMOTECOMMUNITYID01" } });
    expect([stored.iconText, stored.iconColor]).toEqual([null, null]);
  });
});

describe("joining a community on another server", () => {
  let homeServer: Server;
  const HOME_DOMAIN = "icon-home.invalid";

  beforeEach(async () => {
    homeServer = createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/.well-known/communication-platform") {
        res.end(JSON.stringify({ federation: { enabled: true, publicKey: "home-key", apiBase: "/federation/v1" } }));
        return;
      }
      if (req.url?.endsWith("/members") && req.method === "POST") {
        res.statusCode = 201;
        res.end(
          JSON.stringify({
            community: {
              protocolId: "ICONCOMMUNITY0001",
              name: "Icon Club",
              description: null,
              iconUrl: `https://${HOME_DOMAIN}/uploads/icon.png`,
              iconText: "IC",
              iconColor: "#a66cf0",
              owner: { protocolId: "ICONOWNERPROTO01", username: "owner", domain: HOME_DOMAIN, displayName: "Owner", avatarUrl: null },
              channels: [{ protocolId: "ICONGENERAL00001", name: "general", topic: null, position: 0, type: "TEXT" }],
            },
          })
        );
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not_found" }));
    });
    await new Promise<void>((resolve) => homeServer.listen(0, "127.0.0.1", resolve));
    config.federationPeerOverrides[HOME_DOMAIN] = `http://127.0.0.1:${(homeServer.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    delete config.federationPeerOverrides[HOME_DOMAIN];
    await new Promise<void>((resolve) => homeServer.close(() => resolve()));
  });

  it("shows the member the home server's tile", async () => {
    const bob = await registerUser("bob");

    const res = await api.post(`/api/v1/communities/ICONCOMMUNITY0001:${HOME_DOMAIN}/members`).set(authHeader(bob.accessToken));

    expect(res.status).toBe(201);
    expect(res.body.community.iconText).toBe("IC");
    expect(res.body.community.iconColor).toBe("#a66cf0");
    expect(res.body.community.iconUrl).toBe(`https://${HOME_DOMAIN}/uploads/icon.png`);
  });
});
