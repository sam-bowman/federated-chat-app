// GET /api/v1/sync read its cursor and limit straight from the address: a cursor that is not a whole number reached BigInt() and a limit
// that is not one reached the database, and both answered 500. Found by the dynamic scan (#250, `GET /sync?cursor=cursor`).
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { authHeader, registerUser } from "../helpers/factory.js";

beforeEach(resetDb);
afterAll(disconnectDb);

type Registered = Awaited<ReturnType<typeof registerUser>>;
const sync = (as: Registered, query: string) => api.get(`/api/v1/sync${query}`).set(authHeader(as.accessToken));

/** Bob is sent `count` messages by Alice, so he has that many events (at least) to be told about. */
async function bobWithEvents(count: number) {
  const alice = await registerUser("alice");
  const bob = await registerUser("bob");
  const dm = await api.post("/api/v1/conversations").set(authHeader(alice.accessToken)).send({ type: "DM", memberUsernames: ["bob"] });
  expect(dm.status).toBe(201);
  for (let i = 0; i < count; i++) {
    const sent = await api.post(`/api/v1/conversations/${dm.body.conversation.id}/messages`).set(authHeader(alice.accessToken)).send({ content: `hello ${i}` });
    expect(sent.status).toBe(201);
  }
  return bob;
}

describe("a cursor that is not a sequence number", () => {
  it.each(["cursor", "-1", "1.5", "1e3", "0x10", " 1", "99999999999999999999", "1,2"])("is refused with 400, not a 500: %j", async (cursor) => {
    const bob = await bobWithEvents(1);
    const res = await sync(bob, `?cursor=${encodeURIComponent(cursor)}`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid_request" });
  });

  it("is refused when it is given twice", async () => {
    const bob = await bobWithEvents(1);
    expect((await sync(bob, "?cursor=1&cursor=2")).status).toBe(400);
  });
});

describe("a limit that is not a whole number of at least 1", () => {
  it.each(["abc", "0", "-5", "1.5", ""])("is refused with 400: %j", async (limit) => {
    const bob = await bobWithEvents(1);
    const res = await sync(bob, `?limit=${encodeURIComponent(limit)}`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid_request" });
  });

  it("is refused when it is given twice", async () => {
    const bob = await bobWithEvents(1);
    expect((await sync(bob, "?limit=1&limit=2")).status).toBe(400);
  });

  it("is cut to 500, not refused, as before", async () => {
    const bob = await bobWithEvents(1);
    const res = await sync(bob, "?limit=100000");
    expect(res.status).toBe(200);
    expect(res.body.hasMore).toBe(false);
  });
});

describe("what a good request still does", () => {
  it("returns the events after the cursor, in order, and a cursor to continue from", async () => {
    const bob = await bobWithEvents(3);
    const all = await sync(bob, "");
    expect(all.status).toBe(200);
    const total = all.body.events.length;
    expect(total).toBeGreaterThanOrEqual(3);

    const first = await sync(bob, "?cursor=0&limit=2");
    expect(first.body.events).toHaveLength(2);
    expect(first.body.hasMore).toBe(true);

    const rest = await sync(bob, `?cursor=${first.body.nextCursor}&limit=100`);
    expect(rest.body.events).toHaveLength(total - 2);
    expect(rest.body.hasMore).toBe(false);
    const ids = [...first.body.events, ...rest.body.events].map((e: { id: string }) => e.id);
    expect(ids).toEqual(all.body.events.map((e: { id: string }) => e.id));
  });

  it("keeps the cursor when there is nothing new, and treats an empty cursor as none", async () => {
    const bob = await bobWithEvents(1);
    const caughtUp = await sync(bob, "");
    const again = await sync(bob, `?cursor=${caughtUp.body.nextCursor}`);
    expect(again.body.events).toEqual([]);
    expect(again.body.nextCursor).toBe(caughtUp.body.nextCursor);

    const empty = await sync(bob, "?cursor=");
    expect(empty.status).toBe(200);
    expect(empty.body.events).toHaveLength(caughtUp.body.events.length);
  });
});
