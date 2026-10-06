import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// presenceStore.ts and sync/events.ts both push live updates through the WS
// gateway; mocked here so this test only exercises the REST + DB layer
// (there are no real sockets in an integration test) and so we can inspect
// exactly what payload a "presence" broadcast would have sent.
vi.mock("../../src/ws/gateway.js", () => ({
  sendToUser: vi.fn(),
  sendToUsers: vi.fn(),
  isUserOnline: vi.fn(() => false),
  getOnlineUserIds: vi.fn(() => []),
}));

import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { authHeader, registerUser } from "../helpers/factory.js";
import { sendToUsers } from "../../src/ws/gateway.js";

beforeEach(resetDb);
afterAll(disconnectDb);

async function becomeFriends(aliceToken: string, bobUsername: string, bobToken: string) {
  const sendRes = await api
    .post("/api/v1/friends/requests")
    .set(authHeader(aliceToken))
    .send({ username: bobUsername });
  await api.post(`/api/v1/friends/requests/${sendRes.body.request.id}/accept`).set(authHeader(bobToken));
}

describe("PATCH /api/v1/users/me/presence", () => {
  it("persists the new status and is reflected for a friend", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    await becomeFriends(alice.accessToken, "bob", bob.accessToken);

    const patchRes = await api
      .patch("/api/v1/users/me/presence")
      .set(authHeader(alice.accessToken))
      .send({ status: "BUSY" });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.user.presence.status).toBe("BUSY");

    const bobsView = await api.get("/api/v1/friends").set(authHeader(bob.accessToken));
    const aliceAsSeenByBob = bobsView.body.friends.find((f: { username: string }) => f.username === "alice");
    expect(aliceAsSeenByBob.presence.status).toBe("BUSY");
  });

  // Regression test: presence broadcasts used to send the user's LOCAL
  // DATABASE id in the WebSocket "presence" event's `userId` field, but the
  // client matches friends by `protocolId` (the only id it's ever given) -
  // so the event silently matched nothing and friends appeared stuck online
  // forever. The fix threads protocolId through the whole broadcast path.
  it("broadcasts the changed user's protocolId, never their local database id, to friends", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    await becomeFriends(alice.accessToken, "bob", bob.accessToken);
    vi.mocked(sendToUsers).mockClear();

    await api.patch("/api/v1/users/me/presence").set(authHeader(alice.accessToken)).send({ status: "AWAY" });

    expect(sendToUsers).toHaveBeenCalled();
    const [, payload] = vi.mocked(sendToUsers).mock.calls.at(-1)!;
    expect(payload).toMatchObject({ type: "presence", userId: alice.user.id, status: "AWAY" });
  });

  it("reports INVISIBLE to friends as OFFLINE", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    await becomeFriends(alice.accessToken, "bob", bob.accessToken);

    await api.patch("/api/v1/users/me/presence").set(authHeader(alice.accessToken)).send({ status: "INVISIBLE" });

    const bobsView = await api.get("/api/v1/friends").set(authHeader(bob.accessToken));
    const aliceAsSeenByBob = bobsView.body.friends.find((f: { username: string }) => f.username === "alice");
    expect(aliceAsSeenByBob.presence.status).toBe("OFFLINE");
  });
});
