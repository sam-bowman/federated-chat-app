// Link preview announcements go out in order (#334). Telling people what a message's previews are takes several awaits after the row is read,
// so an announcement started BEFORE the author took the previews off could finish AFTER the one that said "none", and people were left with a
// card that had been removed. The tests below hold one announcement part way through (after it has read the row, before it has worked out who to
// tell) and run the removal to the end meanwhile, which is the order that went wrong; this is not left to chance and a sleep.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../../src/db.js";
import { announceEmbeds, removeEmbeds } from "../../src/modules/linkPreview/service.js";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { authHeader, registerUser } from "../helpers/factory.js";

// The first call to find who to tell waits for the gate (a promise the test opens, or rejects), and says when it got there.
const gate = vi.hoisted(() => ({ hold: null as Promise<void> | null, entered: null as (() => void) | null }));
vi.mock("../../src/modules/messages/federationRelay.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/modules/messages/federationRelay.js")>();
  return {
    ...real,
    localMessageRecipients: async (...args: Parameters<typeof real.localMessageRecipients>) => {
      const wait = gate.hold;
      gate.hold = null;
      if (wait) {
        gate.entered?.();
        await wait;
      }
      return real.localMessageRecipients(...args);
    },
  };
});

beforeEach(async () => {
  await resetDb();
  gate.hold = null;
  gate.entered = null;
});
afterAll(disconnectDb);

type Registered = Awaited<ReturnType<typeof registerUser>>;
const row = (user: Registered) => prisma.user.findUniqueOrThrow({ where: { protocolId: user.user.id } });
const eventsFor = async (user: Registered, type: string) => prisma.syncEvent.findMany({ where: { recipientId: (await row(user)).id, type }, orderBy: { seq: "asc" } });

const PREVIEW = [{ url: "https://example.com/page", title: "A page", description: null, siteName: null }];

/** A message of alice's, in a chat with bob, that already has a preview stored (as if the page had just been read). */
async function messageWithPreview() {
  const alice = await registerUser("alice");
  const bob = await registerUser("bob");
  const chat = (await api.post("/api/v1/conversations").set(authHeader(alice.accessToken)).send({ type: "DM", memberUsernames: ["bob"] })).body.conversation.id as string;
  const sent = await api.post(`/api/v1/conversations/${chat}/messages`).set(authHeader(alice.accessToken)).send({ content: "hello" });
  const message = await prisma.message.update({ where: { protocolId: sent.body.message.id }, data: { embeds: PREVIEW } });
  return { bob, id: message.id };
}

/** Holds the next announcement after it has read the row, until the returned function is called with how it should go on. */
function holdNextAnnouncement() {
  let go!: (outcome: "continue" | Error) => void;
  const entered = new Promise<void>((resolve) => (gate.entered = resolve));
  gate.hold = new Promise<void>((resolve, reject) => (go = (outcome) => (outcome === "continue" ? resolve() : reject(outcome))));
  return { entered, go };
}

describe("announcing a message's previews", () => {
  it("tells people 'none' last when the previews were taken off while an earlier announcement was still on its way", async () => {
    const { bob, id } = await messageWithPreview();
    const held = holdNextAnnouncement();

    const first = announceEmbeds(id); // reads the row (the preview is there) and stops before it has found who to tell
    await held.entered;
    const removal = removeEmbeds(id); // clears the row and announces that, while the first is still waiting
    await new Promise((r) => setTimeout(r, 100)); // long enough for the row to be cleared and, without the fix, for the second telling to be sent
    held.go("continue");
    await Promise.all([first, removal]);

    const told = await eventsFor(bob, "message:embeds");
    expect(told.length).toBeGreaterThan(0);
    expect((told[told.length - 1].payload as { embeds: unknown[] }).embeds).toEqual([]);
  });

  it("does not let an announcement that fails stop the ones behind it", async () => {
    const { bob, id } = await messageWithPreview();
    const held = holdNextAnnouncement();

    const first = announceEmbeds(id);
    await held.entered;
    const second = announceEmbeds(id);
    held.go(new Error("the first one could not find who to tell"));

    await expect(first).rejects.toThrow("could not find who to tell");
    await second;
    const told = await eventsFor(bob, "message:embeds");
    expect(told).toHaveLength(1);
    expect((told[0].payload as { embeds: unknown[] }).embeds).toHaveLength(1);
  });
});
