import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { newProtocolId } from "../../src/lib/ids.js";
import { signRequest } from "../../src/lib/federation/signing.js";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { registerTestPeer, signedPost } from "../helpers/federation.js";
import { registerUser } from "../helpers/factory.js";

beforeEach(resetDb);
afterAll(disconnectDb);

describe("federation request signature verification", () => {
  it("rejects a request with no signature headers at all", async () => {
    const res = await api.post("/federation/v1/users/alice").send();
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("missing_federation_signature");
  });

  it("rejects a request whose body was tampered with after signing", async () => {
    await registerUser("bob");
    const peer = await registerTestPeer("alice.test");
    const bodyString = JSON.stringify({ hello: "world" });
    const { timestamp, signature } = signRequest(peer.privateKey, "POST", "/federation/v1/friend-requests", bodyString);

    const res = await api
      .post("/federation/v1/friend-requests")
      .set("Content-Type", "application/json")
      .set("X-Federation-Origin", peer.domain)
      .set("X-Federation-Timestamp", timestamp)
      .set("X-Federation-Signature", signature)
      .send(JSON.stringify({ hello: "tampered" }));

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_federation_signature");
  });

  it("rejects a signature with an expired timestamp", async () => {
    const peer = await registerTestPeer("alice.test");
    const bodyString = JSON.stringify({});
    const realSign = signRequest(peer.privateKey, "POST", "/federation/v1/friend-requests", bodyString);
    const staleTimestamp = (Date.now() - 10 * 60 * 1000).toString();

    const res = await api
      .post("/federation/v1/friend-requests")
      .set("Content-Type", "application/json")
      .set("X-Federation-Origin", peer.domain)
      .set("X-Federation-Timestamp", staleTimestamp)
      .set("X-Federation-Signature", realSign.signature)
      .send(bodyString);

    expect(res.status).toBe(401);
  });

  it("rejects a request claiming to be from a domain whose key doesn't match the signature", async () => {
    const peer = await registerTestPeer("alice.test");
    await registerTestPeer("mallory.test");
    const res = await signedPost(peer, "/federation/v1/friend-requests", {}).set(
      "X-Federation-Origin",
      "mallory.test"
    );
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_federation_signature");
  });

  it("rejects a replay of an exact, still-valid, previously-accepted signed request", async () => {
    await registerUser("bob");
    const peer = await registerTestPeer("alice.test");
    // A real bodyless GET signs against an empty string, not "{}" - see
    // client.ts's federationFetch: `method === "GET" ? "" : JSON.stringify(...)`.
    const { timestamp, signature } = signRequest(peer.privateKey, "GET", "/federation/v1/users/bob", "");

    const send = () =>
      api
        .get("/federation/v1/users/bob")
        .set("X-Federation-Origin", peer.domain)
        .set("X-Federation-Timestamp", timestamp)
        .set("X-Federation-Signature", signature);

    const first = await send();
    expect(first.status).toBe(200);

    // Exact same headers and body as the first request, captured-and-
    // resent rather than a fresh retry (a real retry re-signs with a new
    // timestamp - see client.ts's federationFetch, which calls
    // signRequest() fresh on every attempt).
    const replay = await send();
    expect(replay.status).toBe(401);
    expect(replay.body.error).toBe("replayed_federation_request");
  });

  it("does not treat two independently-signed requests (a genuine retry) as a replay of each other", async () => {
    await registerUser("bob");
    const peer = await registerTestPeer("alice.test");

    const first = await signedPost(peer, "/federation/v1/friend-requests", {
      requestId: newProtocolId(),
      fromProtocolId: newProtocolId(),
      fromUsername: "alice",
      fromDisplayName: "Alice",
      toUsername: "bob",
    });
    expect(first.status).toBe(201);

    // A different request (fresh signRequest() call => different
    // timestamp => different signature) must not be rejected just because
    // *something* was already seen from this peer.
    const second = await signedPost(peer, "/federation/v1/friend-requests", {
      requestId: newProtocolId(),
      fromProtocolId: newProtocolId(),
      fromUsername: "alice",
      fromDisplayName: "Alice",
      toUsername: "bob",
    });
    expect(second.status).toBe(201);
  });
});

describe("GET /federation/v1/users/:username", () => {
  it("returns the public profile of a local user to a signed peer request", async () => {
    await registerUser("bob", { displayName: "Bobby" });
    const peer = await registerTestPeer("alice.test");

    const { timestamp, signature } = signRequest(peer.privateKey, "GET", "/federation/v1/users/bob", "");
    const res = await api
      .get("/federation/v1/users/bob")
      .set("X-Federation-Origin", peer.domain)
      .set("X-Federation-Timestamp", timestamp)
      .set("X-Federation-Signature", signature);

    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe("bob");
    expect(res.body.user.displayName).toBe("Bobby");
  });

  it("404s for a username that doesn't exist locally", async () => {
    const peer = await registerTestPeer("alice.test");
    const { timestamp, signature } = signRequest(peer.privateKey, "GET", "/federation/v1/users/nobody", "");
    const res = await api
      .get("/federation/v1/users/nobody")
      .set("X-Federation-Origin", peer.domain)
      .set("X-Federation-Timestamp", timestamp)
      .set("X-Federation-Signature", signature);
    expect(res.status).toBe(404);
  });
});

// Regression test for a real bug: ensureRemoteUser used to generate a FRESH
// protocolId for every incoming remote stub instead of using the real one
// the peer sent, so the two servers disagreed on who "alice" was - matching
// by protocolId (which the client does for every live WebSocket event)
// silently failed. The fix threads the real protocolId through every
// federation call site; this asserts the inbox honors it exactly.
describe("POST /federation/v1/friend-requests (regression: remote stub protocolId)", () => {
  it("creates a remote stub carrying the exact protocolId the peer sent, not a freshly generated one", async () => {
    const bob = await registerUser("bob");
    const peer = await registerTestPeer("alice.test");
    const realRemoteProtocolId = newProtocolId();

    const res = await signedPost(peer, "/federation/v1/friend-requests", {
      requestId: newProtocolId(),
      fromProtocolId: realRemoteProtocolId,
      fromUsername: "alice",
      fromDisplayName: "Alice",
      toUsername: "bob",
    });
    expect(res.status).toBe(201);

    const stub = await prisma.user.findUnique({
      where: { username_homeserverDomain: { username: "alice", homeserverDomain: "alice.test" } },
    });
    expect(stub).not.toBeNull();
    expect(stub!.protocolId).toBe(realRemoteProtocolId);
    expect(stub!.isRemote).toBe(true);

    const incoming = await api
      .get("/api/v1/friends/requests?direction=incoming")
      .set("Authorization", `Bearer ${bob.accessToken}`);
    expect(incoming.body.requests).toHaveLength(1);
    expect(incoming.body.requests[0].from.id).toBe(realRemoteProtocolId);
  });

  it("re-delivering the same requestId is idempotent (upsert, not a duplicate row)", async () => {
    await registerUser("bob");
    const peer = await registerTestPeer("alice.test");
    const requestId = newProtocolId();
    const payload = {
      requestId,
      fromProtocolId: newProtocolId(),
      fromUsername: "alice",
      fromDisplayName: "Alice",
      toUsername: "bob",
    };

    await signedPost(peer, "/federation/v1/friend-requests", payload);
    await signedPost(peer, "/federation/v1/friend-requests", payload);

    const count = await prisma.friendRequest.count({ where: { protocolId: requestId } });
    expect(count).toBe(1);
  });
});

describe("POST /federation/v1/conversations and /messages", () => {
  async function setUpFederatedDm() {
    const bob = await registerUser("bob");
    const peer = await registerTestPeer("alice.test");
    const alicesProtocolId = newProtocolId();
    const conversationId = newProtocolId();

    const convoRes = await signedPost(peer, "/federation/v1/conversations", {
      conversationId,
      type: "DM",
      members: [
        { protocolId: alicesProtocolId, username: "alice", domain: "alice.test", displayName: "Alice" },
        { protocolId: bob.user.id, username: "bob", domain: "test.local", displayName: "Bob" },
      ],
    });
    expect(convoRes.status).toBe(201);
    return { bob, peer, alicesProtocolId, conversationId };
  }

  it("creates a local conversation row sharing the peer's protocolId", async () => {
    const { conversationId } = await setUpFederatedDm();
    const convo = await prisma.conversation.findUnique({ where: { protocolId: conversationId } });
    expect(convo).not.toBeNull();
    expect(convo!.type).toBe("DM");
  });

  it("relays a message from the real member into the conversation", async () => {
    const { bob, peer, alicesProtocolId, conversationId } = await setUpFederatedDm();

    const msgRes = await signedPost(peer, "/federation/v1/messages", {
      conversationId,
      messageId: newProtocolId(),
      fromProtocolId: alicesProtocolId,
      fromUsername: "alice",
      fromDomain: "alice.test",
      content: "hello from alice.test",
    });
    expect(msgRes.status).toBe(201);

    const fetched = await api
      .get(`/api/v1/conversations/${conversationId}/messages`)
      .set("Authorization", `Bearer ${bob.accessToken}`);
    expect(fetched.body.messages).toHaveLength(1);
    expect(fetched.body.messages[0].content).toBe("hello from alice.test");
  });

  it("rejects a message whose fromDomain doesn't match the signing origin", async () => {
    const { peer, alicesProtocolId, conversationId } = await setUpFederatedDm();

    const res = await signedPost(peer, "/federation/v1/messages", {
      conversationId,
      messageId: newProtocolId(),
      fromProtocolId: alicesProtocolId,
      fromUsername: "alice",
      fromDomain: "evil.test",
      content: "spoofed sender domain",
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("sender_domain_mismatch");
  });

  it("rejects a message from someone who is signed correctly but isn't a member of the conversation", async () => {
    const { conversationId } = await setUpFederatedDm();
    const mallory = await registerTestPeer("mallory.test");

    const res = await signedPost(mallory, "/federation/v1/messages", {
      conversationId,
      messageId: newProtocolId(),
      fromProtocolId: newProtocolId(),
      fromUsername: "mallory",
      fromDomain: "mallory.test",
      content: "I was never invited to this conversation",
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("not_a_member");
  });

  it("404s for a conversationId the receiving server has never heard of", async () => {
    const peer = await registerTestPeer("alice.test");
    const res = await signedPost(peer, "/federation/v1/messages", {
      conversationId: newProtocolId(),
      messageId: newProtocolId(),
      fromProtocolId: newProtocolId(),
      fromUsername: "alice",
      fromDomain: "alice.test",
      content: "orphaned message",
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /federation/v1/messages/:id/edit, /delete, /reactions", () => {
  // Sets up the same federated DM as setUpFederatedDm() above (duplicated
  // rather than shared, so this block's setup is self-contained and
  // doesn't depend on reaching into a sibling describe block), then relays
  // one message from alice (the remote peer) into it, to edit/delete/react
  // to in each test below.
  async function setUpFederatedMessage() {
    const bob = await registerUser("bob");
    const peer = await registerTestPeer("alice.test");
    const alicesProtocolId = newProtocolId();
    const conversationId = newProtocolId();
    const messageId = newProtocolId();

    const convoRes = await signedPost(peer, "/federation/v1/conversations", {
      conversationId,
      type: "DM",
      members: [
        { protocolId: alicesProtocolId, username: "alice", domain: "alice.test", displayName: "Alice" },
        { protocolId: bob.user.id, username: "bob", domain: "test.local", displayName: "Bob" },
      ],
    });
    expect(convoRes.status).toBe(201);

    const msgRes = await signedPost(peer, "/federation/v1/messages", {
      conversationId,
      messageId,
      fromProtocolId: alicesProtocolId,
      fromUsername: "alice",
      fromDomain: "alice.test",
      content: "original content from alice",
    });
    expect(msgRes.status).toBe(201);

    return { bob, peer, alicesProtocolId, conversationId, messageId };
  }

  it("applies an edit from the message's own sender's homeserver", async () => {
    const { bob, peer, conversationId, messageId } = await setUpFederatedMessage();

    const res = await signedPost(peer, `/federation/v1/messages/${messageId}/edit`, { content: "edited by alice" });
    expect(res.status).toBe(204);

    const message = await prisma.message.findUnique({ where: { protocolId: messageId } });
    expect(message!.content).toBe("edited by alice");
    expect(message!.editedAt).not.toBeNull();

    // Sanity check the edit is visible through the normal read path too,
    // not just the raw DB row.
    const fetched = await api
      .get(`/api/v1/conversations/${conversationId}/messages`)
      .set("Authorization", `Bearer ${bob.accessToken}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.messages[0].content).toBe("edited by alice");
  });

  it("rejects an edit from a domain that isn't the message's own sender's homeserver", async () => {
    const { messageId } = await setUpFederatedMessage();
    const mallory = await registerTestPeer("mallory.test");

    const res = await signedPost(mallory, `/federation/v1/messages/${messageId}/edit`, { content: "hijacked" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("not_message_owner");

    const message = await prisma.message.findUnique({ where: { protocolId: messageId } });
    expect(message!.content).toBe("original content from alice");
  });

  it("404s editing a message id the receiving server has never heard of", async () => {
    const peer = await registerTestPeer("alice.test");
    const res = await signedPost(peer, `/federation/v1/messages/${newProtocolId()}/edit`, { content: "x" });
    expect(res.status).toBe(404);
  });

  it("applies a delete from the message's own sender's homeserver", async () => {
    const { peer, messageId } = await setUpFederatedMessage();

    const res = await signedPost(peer, `/federation/v1/messages/${messageId}/delete`, {});
    expect(res.status).toBe(204);

    const message = await prisma.message.findUnique({ where: { protocolId: messageId } });
    expect(message!.deletedAt).not.toBeNull();
  });

  it("rejects a delete from a domain that isn't the message's own sender's homeserver", async () => {
    const { messageId } = await setUpFederatedMessage();
    const mallory = await registerTestPeer("mallory.test");

    const res = await signedPost(mallory, `/federation/v1/messages/${messageId}/delete`, {});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("not_message_owner");
  });

  it("applies a reaction from a real conversation member", async () => {
    const { peer, alicesProtocolId, messageId } = await setUpFederatedMessage();

    const res = await signedPost(peer, `/federation/v1/messages/${messageId}/reactions`, {
      fromDomain: "alice.test",
      fromProtocolId: alicesProtocolId,
      fromUsername: "alice",
      emoji: "👍",
    });
    expect(res.status).toBe(204);

    const reactions = await prisma.reaction.findMany({ where: { message: { protocolId: messageId } } });
    expect(reactions).toHaveLength(1);
    expect(reactions[0].emoji).toBe("👍");
  });

  it("rejects a reaction from someone who isn't a member of the message's conversation", async () => {
    const { messageId } = await setUpFederatedMessage();
    const mallory = await registerTestPeer("mallory.test");

    const res = await signedPost(mallory, `/federation/v1/messages/${messageId}/reactions`, {
      fromDomain: "mallory.test",
      fromProtocolId: newProtocolId(),
      fromUsername: "mallory",
      emoji: "👍",
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("not_a_member");
  });

  it("removes a previously-added reaction", async () => {
    const { peer, alicesProtocolId, messageId } = await setUpFederatedMessage();
    const add = await signedPost(peer, `/federation/v1/messages/${messageId}/reactions`, {
      fromDomain: "alice.test",
      fromProtocolId: alicesProtocolId,
      fromUsername: "alice",
      emoji: "👍",
    });
    expect(add.status).toBe(204);

    const remove = await signedPost(peer, `/federation/v1/messages/${messageId}/reactions/remove`, {
      fromDomain: "alice.test",
      fromProtocolId: alicesProtocolId,
      fromUsername: "alice",
      emoji: "👍",
    });
    expect(remove.status).toBe(204);

    const reactions = await prisma.reaction.findMany({ where: { message: { protocolId: messageId } } });
    expect(reactions).toHaveLength(0);
  });

  it("404s reacting to a message id the receiving server has never heard of", async () => {
    const peer = await registerTestPeer("alice.test");
    const res = await signedPost(peer, `/federation/v1/messages/${newProtocolId()}/reactions`, {
      fromDomain: "alice.test",
      fromProtocolId: newProtocolId(),
      fromUsername: "alice",
      emoji: "👍",
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /federation/v1/presence", () => {
  it("no-ops (204) for a remote username no local user has ever friended", async () => {
    const peer = await registerTestPeer("alice.test");
    const res = await signedPost(peer, "/federation/v1/presence", {
      username: "alice",
      domain: "alice.test",
      status: "BUSY",
    });
    expect(res.status).toBe(204);
    const stub = await prisma.user.findFirst({ where: { username: "alice", homeserverDomain: "alice.test" } });
    expect(stub).toBeNull();
  });

  it("updates presence on an existing remote stub", async () => {
    const bob = await registerUser("bob");
    const peer = await registerTestPeer("alice.test");
    const alicesProtocolId = newProtocolId();
    await signedPost(peer, "/federation/v1/friend-requests", {
      requestId: newProtocolId(),
      fromProtocolId: alicesProtocolId,
      fromUsername: "alice",
      fromDisplayName: "Alice",
      toUsername: "bob",
    });
    const incoming = await api
      .get("/api/v1/friends/requests?direction=incoming")
      .set("Authorization", `Bearer ${bob.accessToken}`);
    await api
      .post(`/api/v1/friends/requests/${incoming.body.requests[0].id}/accept`)
      .set("Authorization", `Bearer ${bob.accessToken}`);

    const res = await signedPost(peer, "/federation/v1/presence", {
      username: "alice",
      domain: "alice.test",
      status: "BUSY",
      customStatus: "in a meeting",
    });
    expect(res.status).toBe(204);

    const stub = await prisma.user.findUnique({
      where: { username_homeserverDomain: { username: "alice", homeserverDomain: "alice.test" } },
    });
    expect(stub!.presenceStatus).toBe("BUSY");
    expect(stub!.customStatus).toBe("in a meeting");
  });
});
