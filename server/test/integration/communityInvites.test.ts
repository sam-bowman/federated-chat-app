import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { config } from "../../src/config.js";
import { prisma } from "../../src/db.js";
import { newProtocolId } from "../../src/lib/ids.js";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { authHeader, registerUser } from "../helpers/factory.js";
import { registerTestPeer, signedPost } from "../helpers/federation.js";

beforeEach(resetDb);
afterAll(disconnectDb);

type Registered = Awaited<ReturnType<typeof registerUser>>;

async function createCommunity(owner: Registered, name = "Book Club") {
  const res = await api.post("/api/v1/communities").set(authHeader(owner.accessToken)).send({ name });
  expect(res.status).toBe(201);
  return res.body.community as { id: string; homeserverDomain: string; name: string };
}

async function createDm(from: Registered, username: string) {
  const res = await api
    .post("/api/v1/conversations")
    .set(authHeader(from.accessToken))
    .send({ type: "DM", memberUsernames: [username] });
  expect([200, 201]).toContain(res.status);
  return res.body.conversation.id as string;
}

const sendInvite = (from: Registered, conversationId: string, invite: unknown, extra: object = {}) =>
  api
    .post(`/api/v1/conversations/${conversationId}/messages`)
    .set(authHeader(from.accessToken))
    .send({ invite, ...extra });

describe("a community says where it lives", () => {
  it("includes its server, which with its id is the code to join it from anywhere", async () => {
    const alice = await registerUser("alice");
    const community = await createCommunity(alice);

    expect(community.homeserverDomain).toBe(config.domain);
  });
});

describe("inviting a friend to a community in a DM", () => {
  it("sends a message carrying a card the server built from its own records", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const community = await createCommunity(alice);
    const dm = await createDm(alice, "bob");

    const res = await sendInvite(alice, dm, { communityId: community.id });

    expect(res.status).toBe(201);
    expect(res.body.message.invite).toEqual({ communityId: community.id, domain: config.domain, name: "Book Club" });
    // The text says the same, so anything that shows only text (a conversation list, an older client) still has the code.
    expect(res.body.message.content).toBe(`Invited you to join Book Club (join code: ${community.id}:${config.domain})`);

    const fetched = await api.get(`/api/v1/conversations/${dm}/messages`).set(authHeader(bob.accessToken));
    expect(fetched.body.messages[0].invite).toEqual(res.body.message.invite);
    expect(fetched.body.messages[0].sender.username).toBe("alice");
  });

  it("reaches the other member as a realtime event with the card in it", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const community = await createCommunity(alice);
    const dm = await createDm(alice, "bob");

    await sendInvite(alice, dm, { communityId: community.id });

    const sync = await api.get("/api/v1/sync").set(authHeader(bob.accessToken));
    const created = sync.body.events.find((e: { type: string }) => e.type === "message:created");
    expect(created.payload.message.invite.name).toBe("Book Club");
  });

  // The card is a statement by this server about this community: nothing in the request can change it.
  it("ignores a name or server in the request, taking them from the community itself", async () => {
    const alice = await registerUser("alice");
    await registerUser("bob");
    const community = await createCommunity(alice);
    const dm = await createDm(alice, "bob");

    const res = await sendInvite(alice, dm, { communityId: community.id, name: "Free iPhones", domain: "evil.example" });

    expect(res.status).toBe(201);
    expect(res.body.message.invite).toEqual({ communityId: community.id, domain: config.domain, name: "Book Club" });
  });

  it("accepts the community as a full reference, and still uses the server in its own record", async () => {
    const alice = await registerUser("alice");
    await registerUser("bob");
    const community = await createCommunity(alice);
    const dm = await createDm(alice, "bob");

    const res = await sendInvite(alice, dm, { communityId: `${community.id}:evil.example` });

    expect(res.status).toBe(201);
    expect(res.body.message.invite.domain).toBe(config.domain);
  });

  it("works from a member who did not create the community", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    await registerUser("carol");
    const community = await createCommunity(alice);
    await api.post(`/api/v1/communities/${community.id}/members`).set(authHeader(bob.accessToken));
    const dm = await createDm(bob, "carol");

    const res = await sendInvite(bob, dm, { communityId: community.id });

    expect(res.status).toBe(201);
  });

  it("uses the community's name as it is now, not as it was when it was created", async () => {
    const alice = await registerUser("alice");
    await registerUser("bob");
    const community = await createCommunity(alice, "Old Name");
    await api.patch(`/api/v1/communities/${community.id}`).set(authHeader(alice.accessToken)).send({ name: "New Name" });
    const dm = await createDm(alice, "bob");

    const res = await sendInvite(alice, dm, { communityId: community.id });

    expect(res.body.message.invite.name).toBe("New Name");
  });

  it("leaves an ordinary message without a card", async () => {
    const alice = await registerUser("alice");
    await registerUser("bob");
    const dm = await createDm(alice, "bob");

    const res = await api.post(`/api/v1/conversations/${dm}/messages`).set(authHeader(alice.accessToken)).send({ content: "hi" });

    expect(res.status).toBe(201);
    expect(res.body.message.invite).toBeNull();
  });
});

describe("who may invite, and what is refused", () => {
  it("refuses someone who is not a member of the community, and sends nothing", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    await registerUser("carol");
    const community = await createCommunity(alice);
    const dm = await createDm(bob, "carol");

    const res = await sendInvite(bob, dm, { communityId: community.id });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("not_a_member");
    expect(await prisma.message.count()).toBe(0);
  });

  it("refuses a community that does not exist", async () => {
    const alice = await registerUser("alice");
    await registerUser("bob");
    const dm = await createDm(alice, "bob");

    const res = await sendInvite(alice, dm, { communityId: "NOSUCHCOMMUNITY0000000000" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("community_not_found");
  });

  it("refuses an invite that also has attachments, and a message with neither text nor an invite", async () => {
    const alice = await registerUser("alice");
    await registerUser("bob");
    const community = await createCommunity(alice);
    const dm = await createDm(alice, "bob");

    const withFile = await sendInvite(alice, dm, { communityId: community.id }, {
      attachments: [{ url: "/uploads/a.png", filename: "a.png", contentType: "image/png", size: 10 }],
    });
    const empty = await api.post(`/api/v1/conversations/${dm}/messages`).set(authHeader(alice.accessToken)).send({});

    expect(withFile.status).toBe(400);
    expect(empty.status).toBe(400);
  });

  it("refuses a user who is not in the conversation", async () => {
    const alice = await registerUser("alice");
    await registerUser("bob");
    const mallory = await registerUser("mallory");
    const community = await createCommunity(mallory);
    const dm = await createDm(alice, "bob");

    const res = await sendInvite(mallory, dm, { communityId: community.id });

    expect(res.status).toBe(404);
  });

  it("does not let the sender edit the text under the card", async () => {
    const alice = await registerUser("alice");
    await registerUser("bob");
    const community = await createCommunity(alice);
    const dm = await createDm(alice, "bob");
    const sent = await sendInvite(alice, dm, { communityId: community.id });

    const edited = await api
      .patch(`/api/v1/messages/${sent.body.message.id}`)
      .set(authHeader(alice.accessToken))
      .send({ content: "something else" });

    expect(edited.status).toBe(400);
    expect(edited.body.error).toBe("cannot_edit_invite");
  });

  it("shows no card once the message is deleted", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const community = await createCommunity(alice);
    const dm = await createDm(alice, "bob");
    const sent = await sendInvite(alice, dm, { communityId: community.id });

    await api.delete(`/api/v1/messages/${sent.body.message.id}`).set(authHeader(alice.accessToken));

    const fetched = await api.get(`/api/v1/conversations/${dm}/messages`).set(authHeader(bob.accessToken));
    expect(fetched.body.messages[0].invite).toBeNull();
    expect(fetched.body.messages[0].content).toBeNull();
  });

  it("shows a malformed stored card as the plain message it also is", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const dm = await createDm(alice, "bob");
    const sender = await prisma.user.findUniqueOrThrow({ where: { protocolId: alice.user.id } });
    const conversation = await prisma.conversation.findUniqueOrThrow({ where: { protocolId: dm } });
    await prisma.message.create({
      data: {
        protocolId: newProtocolId(),
        conversationId: conversation.id,
        senderId: sender.id,
        content: "Invited you to join something",
        invite: { communityId: "has spaces", domain: "x", name: 42 },
      },
    });

    const fetched = await api.get(`/api/v1/conversations/${dm}/messages`).set(authHeader(bob.accessToken));

    expect(fetched.body.messages[0].invite).toBeNull();
    expect(fetched.body.messages[0].content).toBe("Invited you to join something");
  });
});

describe("joining from a card", () => {
  it("joins with the reference the card carries", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const community = await createCommunity(alice);
    const dm = await createDm(alice, "bob");
    const card = (await sendInvite(alice, dm, { communityId: community.id })).body.message.invite;

    const joined = await api
      .post(`/api/v1/communities/${card.communityId}:${card.domain}/members`)
      .set(authHeader(bob.accessToken));

    expect(joined.status).toBe(201);
    expect(joined.body.community.members.map((m: { username: string }) => m.username).sort()).toEqual(["alice", "bob"]);
  });

  // The card can go stale: the person was banned after the invite was sent, or the community was deleted.
  it("is refused for someone banned since, with a reason the card can show", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const community = await createCommunity(alice);
    const dm = await createDm(alice, "bob");
    const card = (await sendInvite(alice, dm, { communityId: community.id })).body.message.invite;
    await api.post(`/api/v1/communities/${community.id}/members`).set(authHeader(bob.accessToken));
    await api.post(`/api/v1/communities/${community.id}/bans`).set(authHeader(alice.accessToken)).send({ protocolId: bob.user.id });

    const joined = await api
      .post(`/api/v1/communities/${card.communityId}:${card.domain}/members`)
      .set(authHeader(bob.accessToken));

    expect(joined.status).toBe(403);
    expect(joined.body.error).toBe("banned");
  });

  it("is refused with not_found once the community is gone", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const community = await createCommunity(alice);
    const dm = await createDm(alice, "bob");
    const card = (await sendInvite(alice, dm, { communityId: community.id })).body.message.invite;
    const deleted = await api
      .delete(`/api/v1/communities/${community.id}`)
      .set(authHeader(alice.accessToken))
      .send({ password: "Correct-Horse-Battery-Staple-1" });
    expect(deleted.status).toBe(204);

    const joined = await api
      .post(`/api/v1/communities/${card.communityId}:${card.domain}/members`)
      .set(authHeader(bob.accessToken));

    expect(joined.status).toBe(404);
  });

  it("is harmless for someone who is already a member", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const community = await createCommunity(alice);
    await api.post(`/api/v1/communities/${community.id}/members`).set(authHeader(bob.accessToken));

    const again = await api
      .post(`/api/v1/communities/${community.id}:${config.domain}/members`)
      .set(authHeader(bob.accessToken));

    expect(again.status).toBe(201);
    expect(again.body.community.members).toHaveLength(2);
  });
});

describe("inviting to a community hosted on another server", () => {
  it("builds the card from the cached copy, with that server's domain", async () => {
    const alice = await registerUser("alice");
    await registerUser("bob");
    const aliceRow = await prisma.user.findUniqueOrThrow({ where: { protocolId: alice.user.id } });
    const remote = await prisma.community.create({
      data: {
        protocolId: "REMOTECOMMUNITYID01",
        name: "Far Away Club",
        ownerId: aliceRow.id,
        homeserverDomain: "far.invalid",
        isRemote: true,
      },
    });
    await prisma.communityMember.create({ data: { communityId: remote.id, userId: aliceRow.id } });
    const dm = await createDm(alice, "bob");

    const res = await sendInvite(alice, dm, { communityId: remote.protocolId });

    expect(res.status).toBe(201);
    expect(res.body.message.invite).toEqual({
      communityId: "REMOTECOMMUNITYID01",
      domain: "far.invalid",
      name: "Far Away Club",
    });
  });
});

describe("invitations across federation", () => {
  const servers: Server[] = [];
  const domain = "invite-peer.invalid";

  beforeEach(async () => {
    const server = createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/.well-known/communication-platform") {
        res.end(JSON.stringify({ federation: { enabled: true, publicKey: `${domain}-key`, apiBase: "/federation/v1" } }));
        return;
      }
      if (req.url === "/federation/v1/users/dave") {
        res.end(JSON.stringify({ user: { id: "dave-protocol-id", username: "dave", displayName: "Dave", avatarUrl: null } }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    config.federationPeerOverrides[domain] = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    servers.push(server);
  });

  afterEach(async () => {
    delete config.federationPeerOverrides[domain];
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  });

  it("sends the card to a friend's server along with the message", async () => {
    const alice = await registerUser("alice");
    const community = await createCommunity(alice);
    const dm = await createDm(alice, `dave:${domain}`);

    const res = await sendInvite(alice, dm, { communityId: community.id });

    expect(res.status).toBe(201);
    const row = await prisma.federationOutboxEvent.findFirstOrThrow({ where: { path: "/messages" } });
    const payload = row.body as { invite?: unknown; content: string };
    expect(payload.invite).toEqual({ communityId: community.id, domain: config.domain, name: "Book Club" });
    expect(payload.content).toContain("join code");
  });

  describe("receiving one", () => {
    async function setUpFederatedDm() {
      const bob = await registerUser("bob");
      const peer = await registerTestPeer("alice.test");
      const alicesProtocolId = newProtocolId();
      const conversationId = newProtocolId();
      const convo = await signedPost(peer, "/federation/v1/conversations", {
        conversationId,
        type: "DM",
        members: [
          { protocolId: alicesProtocolId, username: "alice", domain: "alice.test", displayName: "Alice" },
          { protocolId: bob.user.id, username: "bob", domain: config.domain, displayName: "Bob" },
        ],
      });
      expect(convo.status).toBe(201);
      return { bob, peer, alicesProtocolId, conversationId };
    }

    const incoming = (ctx: Awaited<ReturnType<typeof setUpFederatedDm>>, extra: object) =>
      signedPost(ctx.peer, "/federation/v1/messages", {
        conversationId: ctx.conversationId,
        messageId: newProtocolId(),
        fromProtocolId: ctx.alicesProtocolId,
        fromUsername: "alice",
        fromDomain: "alice.test",
        content: "Invited you to join Far Club (join code: FARCLUB123:alice.test)",
        ...extra,
      });

    const messagesFor = async (ctx: Awaited<ReturnType<typeof setUpFederatedDm>>) =>
      (await api.get(`/api/v1/conversations/${ctx.conversationId}/messages`).set(authHeader(ctx.bob.accessToken))).body
        .messages as { invite: unknown; content: string }[];

    it("stores the card and shows it to the recipient", async () => {
      const ctx = await setUpFederatedDm();

      const res = await incoming(ctx, { invite: { communityId: "FARCLUB123", domain: "alice.test", name: "Far Club" } });

      expect(res.status).toBe(201);
      const [message] = await messagesFor(ctx);
      expect(message.invite).toEqual({ communityId: "FARCLUB123", domain: "alice.test", name: "Far Club" });
    });

    it("drops fields it does not know", async () => {
      const ctx = await setUpFederatedDm();

      await incoming(ctx, { invite: { communityId: "FARCLUB123", domain: "alice.test", name: "Far Club", html: "<b>x</b>" } });

      expect((await messagesFor(ctx))[0].invite).toEqual({ communityId: "FARCLUB123", domain: "alice.test", name: "Far Club" });
      // and what is stored is only the known fields, not whatever the peer sent
      expect((await prisma.message.findFirstOrThrow({ where: { invite: { not: undefined } } })).invite).toEqual({
        communityId: "FARCLUB123",
        domain: "alice.test",
        name: "Far Club",
      });
    });

    // A peer on a newer version might send a card this one cannot read: the message must still arrive.
    it.each([
      ["a card with a bad id", { communityId: "not valid!", domain: "alice.test", name: "x" }],
      ["a card with a name that is too long", { communityId: "FARCLUB123", domain: "alice.test", name: "x".repeat(500) }],
      ["something that is not an object", "join my server"],
    ])("delivers the message as plain text for %s", async (_name, invite) => {
      const ctx = await setUpFederatedDm();

      const res = await incoming(ctx, { invite });

      expect(res.status).toBe(201);
      const [message] = await messagesFor(ctx);
      expect(message.invite).toBeNull();
      expect(message.content).toContain("join code");
      // nothing unvalidated is stored either
      expect((await prisma.message.findFirstOrThrow({ where: { conversation: { protocolId: ctx.conversationId } } })).invite).toBeNull();
    });

    it("keeps an ordinary message from a peer free of a card", async () => {
      const ctx = await setUpFederatedDm();

      await incoming(ctx, { content: "hello" });

      expect((await messagesFor(ctx))[0].invite).toBeNull();
    });
  });
});
