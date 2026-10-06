import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { authHeader, registerUser } from "../helpers/factory.js";

beforeEach(resetDb);
afterAll(disconnectDb);

async function createDm(token: string, memberUsernames: string[]) {
  const res = await api
    .post("/api/v1/conversations")
    .set(authHeader(token))
    .send({ type: "DM", memberUsernames });
  return res;
}

describe("DM conversations", () => {
  it("creates a DM between two members", async () => {
    const alice = await registerUser("alice");
    await registerUser("bob");

    const res = await createDm(alice.accessToken, ["bob"]);
    expect(res.status).toBe(201);
    expect(res.body.conversation.type).toBe("DM");
    expect(res.body.conversation.members.map((m: { username: string }) => m.username).sort()).toEqual([
      "alice",
      "bob",
    ]);
  });

  it("is idempotent - creating the same pair's DM twice returns the same conversation", async () => {
    const alice = await registerUser("alice");
    await registerUser("bob");

    const first = await createDm(alice.accessToken, ["bob"]);
    const second = await createDm(alice.accessToken, ["bob"]);

    expect(second.status).toBe(200);
    expect(second.body.conversation.id).toBe(first.body.conversation.id);
  });

  it("refuses a block'd pair", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    await api.post("/api/v1/friends/blocks").set(authHeader(alice.accessToken)).send({ username: "bob" });

    const res = await createDm(bob.accessToken, ["alice"]);
    expect(res.status).toBe(403);
  });

  it("sends and fetches messages in order", async () => {
    const alice = await registerUser("alice");
    await registerUser("bob");
    const convo = await createDm(alice.accessToken, ["bob"]);

    await api
      .post(`/api/v1/conversations/${convo.body.conversation.id}/messages`)
      .set(authHeader(alice.accessToken))
      .send({ content: "hello" });
    await api
      .post(`/api/v1/conversations/${convo.body.conversation.id}/messages`)
      .set(authHeader(alice.accessToken))
      .send({ content: "world" });

    const fetched = await api
      .get(`/api/v1/conversations/${convo.body.conversation.id}/messages`)
      .set(authHeader(alice.accessToken));
    expect(fetched.body.messages.map((m: { content: string }) => m.content)).toEqual(["hello", "world"]);
  });

  it("a non-member cannot read or post messages", async () => {
    const alice = await registerUser("alice");
    await registerUser("bob");
    const eve = await registerUser("eve");
    const convo = await createDm(alice.accessToken, ["bob"]);

    const readRes = await api
      .get(`/api/v1/conversations/${convo.body.conversation.id}/messages`)
      .set(authHeader(eve.accessToken));
    expect(readRes.status).toBe(404);

    const postRes = await api
      .post(`/api/v1/conversations/${convo.body.conversation.id}/messages`)
      .set(authHeader(eve.accessToken))
      .send({ content: "sneaky" });
    expect(postRes.status).toBe(404);
  });
});

// Regression test for a real bug found during manual testing: community
// channel messages were briefly showing up inside an unrelated DM thread (and
// vice versa) because the realtime event for a new message didn't originally
// carry its conversationId/channelId, so the client had nothing to filter
// on. The fix was to always include that location on every message-related
// sync event. This asserts the fixed wire format at the source: the
// SyncEvent payload delivered via GET /api/v1/sync.
describe("message isolation between a DM and a community channel (regression)", () => {
  it("fetching one thread's messages never includes the other's, and sync events carry the correct location", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");

    const convo = await createDm(alice.accessToken, ["bob"]);
    const community = await api
      .post("/api/v1/communities")
      .set(authHeader(alice.accessToken))
      .send({ name: "Test Community" });
    const channelId = community.body.community.channels[0].id;
    await api
      .post(`/api/v1/communities/${community.body.community.id}/members`)
      .set(authHeader(bob.accessToken));

    await api
      .post(`/api/v1/conversations/${convo.body.conversation.id}/messages`)
      .set(authHeader(alice.accessToken))
      .send({ content: "dm message" });
    await api
      .post(`/api/v1/channels/${channelId}/messages`)
      .set(authHeader(alice.accessToken))
      .send({ content: "channel message" });

    const dmMessages = await api
      .get(`/api/v1/conversations/${convo.body.conversation.id}/messages`)
      .set(authHeader(alice.accessToken));
    expect(dmMessages.body.messages.map((m: { content: string }) => m.content)).toEqual(["dm message"]);

    const channelMessages = await api
      .get(`/api/v1/channels/${channelId}/messages`)
      .set(authHeader(alice.accessToken));
    expect(channelMessages.body.messages.map((m: { content: string }) => m.content)).toEqual(["channel message"]);

    // Bob is a member of both the DM and the community, so both events land
    // in his sync outbox - each must be tagged with the thread it belongs to.
    const sync = await api.get("/api/v1/sync?cursor=0").set(authHeader(bob.accessToken));
    const messageEvents = sync.body.events.filter((e: { type: string }) => e.type === "message:created");
    expect(messageEvents).toHaveLength(2);

    const dmEvent = messageEvents.find((e: any) => e.payload.message.content === "dm message");
    expect(dmEvent.payload.conversationId).toBe(convo.body.conversation.id);
    expect(dmEvent.payload.channelId).toBeUndefined();

    const channelEvent = messageEvents.find((e: any) => e.payload.message.content === "channel message");
    expect(channelEvent.payload.channelId).toBe(channelId);
    expect(channelEvent.payload.conversationId).toBeUndefined();
  });
});
