// The client pages backwards through history with `before=<oldest message id>`
// (see CommunityPage/ConversationPage "Load older messages"). Messages are
// seeded straight into the database with explicit, distinct timestamps: the
// cursor compares createdAt, so sending them over HTTP would make the test
// depend on two requests never landing in the same millisecond.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { newProtocolId } from "../../src/lib/ids.js";
import { api } from "../helpers/app.js";
import { authHeader, registerUser } from "../helpers/factory.js";
import { disconnectDb, resetDb } from "../helpers/db.js";

beforeEach(resetDb);
afterAll(disconnectDb);

const TOTAL = 120;
const BASE_TIME = Date.parse("2026-01-01T00:00:00Z");

async function seed(location: { channelId: string } | { conversationId: string }, senderId: string) {
  await prisma.message.createMany({
    data: Array.from({ length: TOTAL }, (_, i) => ({
      protocolId: newProtocolId(),
      senderId,
      content: `msg-${String(i).padStart(3, "0")}`,
      createdAt: new Date(BASE_TIME + i * 1000),
      ...location,
    })),
  });
}

async function setupChannel() {
  const alice = await registerUser("alice");
  const create = await api.post("/api/v1/communities").set(authHeader(alice.accessToken)).send({ name: "Paging" });
  const channelProtocolId = create.body.community.channels[0].id as string;
  const channel = await prisma.channel.findUniqueOrThrow({ where: { protocolId: channelProtocolId } });
  const aliceRow = await prisma.user.findUniqueOrThrow({ where: { protocolId: alice.user.id } });
  await seed({ channelId: channel.id }, aliceRow.id);
  return { token: alice.accessToken, url: `/api/v1/channels/${channelProtocolId}/messages` };
}

async function setupConversation() {
  const alice = await registerUser("alice");
  const bob = await registerUser("bob");
  const create = await api
    .post("/api/v1/conversations")
    .set(authHeader(alice.accessToken))
    .send({ type: "DM", memberUsernames: [bob.user.username] });
  const conversationProtocolId = create.body.conversation.id as string;
  const conversation = await prisma.conversation.findUniqueOrThrow({ where: { protocolId: conversationProtocolId } });
  const aliceRow = await prisma.user.findUniqueOrThrow({ where: { protocolId: alice.user.id } });
  await seed({ conversationId: conversation.id }, aliceRow.id);
  return { token: alice.accessToken, url: `/api/v1/conversations/${conversationProtocolId}/messages` };
}

const contents = (body: { messages: { content: string }[] }) => body.messages.map((m) => m.content);

describe.each([
  ["channel", setupChannel],
  ["conversation", setupConversation],
])("message history paging (%s)", (_name, setup) => {
  it("returns the newest 50 messages, oldest first, by default", async () => {
    const { token, url } = await setup();

    const res = await api.get(url).set(authHeader(token));

    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(50);
    expect(contents(res.body)[0]).toBe("msg-070");
    expect(contents(res.body)[49]).toBe("msg-119");
  });

  it("pages backwards with `before` through the whole history with no gaps or repeats, then runs dry", async () => {
    const { token, url } = await setup();

    const collected: string[] = [];
    let page = (await api.get(url).set(authHeader(token))).body.messages as { id: string; content: string }[];
    collected.unshift(...page.map((m) => m.content));

    while (page.length > 0) {
      const res = await api.get(`${url}?before=${page[0].id}`).set(authHeader(token));
      expect(res.status).toBe(200);
      page = res.body.messages;
      collected.unshift(...page.map((m) => m.content));
    }

    expect(collected).toEqual(Array.from({ length: TOTAL }, (_, i) => `msg-${String(i).padStart(3, "0")}`));
  });

  it("honours `limit`, and the page `before` the oldest message is the next-older slice", async () => {
    const { token, url } = await setup();

    const newest = await api.get(`${url}?limit=10`).set(authHeader(token));
    expect(contents(newest.body)).toEqual(Array.from({ length: 10 }, (_, i) => `msg-${110 + i}`));

    const older = await api.get(`${url}?limit=10&before=${newest.body.messages[0].id}`).set(authHeader(token));
    expect(contents(older.body)).toEqual(Array.from({ length: 10 }, (_, i) => `msg-${100 + i}`));
  });
});
