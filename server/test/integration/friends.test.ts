import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { authHeader, registerUser } from "../helpers/factory.js";

beforeEach(resetDb);
afterAll(disconnectDb);

describe("friend requests", () => {
  it("send -> appears as incoming for the recipient and outgoing for the sender", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");

    const sendRes = await api
      .post("/api/v1/friends/requests")
      .set(authHeader(alice.accessToken))
      .send({ username: "bob" });
    expect(sendRes.status).toBe(201);
    expect(sendRes.body.request.from.username).toBe("alice");
    expect(sendRes.body.request.to.username).toBe("bob");
    expect(sendRes.body.request.status).toBe("PENDING");

    const incoming = await api
      .get("/api/v1/friends/requests?direction=incoming")
      .set(authHeader(bob.accessToken));
    expect(incoming.body.requests).toHaveLength(1);
    expect(incoming.body.requests[0].from.username).toBe("alice");

    const outgoing = await api
      .get("/api/v1/friends/requests?direction=outgoing")
      .set(authHeader(alice.accessToken));
    expect(outgoing.body.requests).toHaveLength(1);
  });

  it("accept creates a friendship visible to both sides", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const sendRes = await api
      .post("/api/v1/friends/requests")
      .set(authHeader(alice.accessToken))
      .send({ username: "bob" });

    const acceptRes = await api
      .post(`/api/v1/friends/requests/${sendRes.body.request.id}/accept`)
      .set(authHeader(bob.accessToken));
    expect(acceptRes.status).toBe(200);

    const aliceFriends = await api.get("/api/v1/friends").set(authHeader(alice.accessToken));
    expect(aliceFriends.body.friends.map((f: { username: string }) => f.username)).toContain("bob");

    const bobFriends = await api.get("/api/v1/friends").set(authHeader(bob.accessToken));
    expect(bobFriends.body.friends.map((f: { username: string }) => f.username)).toContain("alice");
  });

  it("decline leaves no friendship on either side", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const sendRes = await api
      .post("/api/v1/friends/requests")
      .set(authHeader(alice.accessToken))
      .send({ username: "bob" });

    const declineRes = await api
      .post(`/api/v1/friends/requests/${sendRes.body.request.id}/decline`)
      .set(authHeader(bob.accessToken));
    expect(declineRes.status).toBe(204);

    const aliceFriends = await api.get("/api/v1/friends").set(authHeader(alice.accessToken));
    expect(aliceFriends.body.friends).toHaveLength(0);
  });

  it("rejects a second pending request between the same pair", async () => {
    const alice = await registerUser("alice");
    await registerUser("bob");
    await api.post("/api/v1/friends/requests").set(authHeader(alice.accessToken)).send({ username: "bob" });

    const dup = await api
      .post("/api/v1/friends/requests")
      .set(authHeader(alice.accessToken))
      .send({ username: "bob" });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe("request_already_pending");
  });

  it("rejects sending a request to yourself", async () => {
    const alice = await registerUser("alice");
    const res = await api
      .post("/api/v1/friends/requests")
      .set(authHeader(alice.accessToken))
      .send({ username: "alice" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("cannot_friend_self");
  });

  it("404s for a request to a user that doesn't exist", async () => {
    const alice = await registerUser("alice");
    const res = await api
      .post("/api/v1/friends/requests")
      .set(authHeader(alice.accessToken))
      .send({ username: "nobody" });
    expect(res.status).toBe(404);
  });
});

describe("blocking", () => {
  it("a block prevents the blocked user from being friended and removes any existing friendship", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const sendRes = await api
      .post("/api/v1/friends/requests")
      .set(authHeader(alice.accessToken))
      .send({ username: "bob" });
    await api.post(`/api/v1/friends/requests/${sendRes.body.request.id}/accept`).set(authHeader(bob.accessToken));

    const blockRes = await api
      .post("/api/v1/friends/blocks")
      .set(authHeader(alice.accessToken))
      .send({ username: "bob" });
    expect(blockRes.status).toBe(204);

    const aliceFriends = await api.get("/api/v1/friends").set(authHeader(alice.accessToken));
    expect(aliceFriends.body.friends).toHaveLength(0);

    const retryRes = await api
      .post("/api/v1/friends/requests")
      .set(authHeader(bob.accessToken))
      .send({ username: "alice" });
    expect(retryRes.status).toBe(403);
    expect(retryRes.body.error).toBe("blocked");
  });
});
