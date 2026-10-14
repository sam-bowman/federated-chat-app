// Delivering a federation event to a peer used to happen INSIDE the request that caused it: a send in a
// community with a remote member whose server was down waited out the whole retry cycle (and with a peer
// that never answered, as long as the operating system allowed) before the sender got their response, once
// per such domain, one after another. The event is now recorded durably and delivered in the background.
// These pin what that has to keep doing: respond fast, deliver in order, not pile up on a dead peer, give up
// on a silent one, and still deliver later.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { config } from "../../src/config.js";
import { prisma } from "../../src/db.js";
import { newProtocolId } from "../../src/lib/ids.js";
import {
  flushOutboxForDomain,
  processDueOutboxEvents,
  waitForPendingDeliveries,
} from "../../src/lib/federation/outbox.js";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { authHeader, registerUser } from "../helpers/factory.js";

beforeEach(resetDb);
afterAll(disconnectDb);

// A peer that is down. It is CACHED as a known peer with an address nothing answers on (rather than only
// overridden), so the sender gets as far as the delivery's retry loop, where the three attempts and the waits
// between them happen - an unresolvable peer would fail before it, in discovery, with no waiting at all.
const DEAD = "http://127.0.0.1:1";

type Registered = Awaited<ReturnType<typeof registerUser>>;
const peerUrls: string[] = [];
const servers: Server[] = [];
const savedRetry = config.federationRetryBaseMs;
const savedTimeout = config.federationOutboxTimeoutMs;

afterEach(async () => {
  for (const domain of peerUrls.splice(0)) delete config.federationPeerOverrides[domain];
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  config.federationRetryBaseMs = savedRetry;
  config.federationOutboxTimeoutMs = savedTimeout;
});

/** A community owned by `bob` with one remote member per domain, each domain mapped to the given base URL. */
async function communityWithRemoteMembers(domains: Record<string, string>) {
  const bob = await registerUser("bob");
  const created = await api.post("/api/v1/communities").set(authHeader(bob.accessToken)).send({ name: "Relay Test" });
  expect(created.status).toBe(201);
  const community = created.body.community as { id: string; channels: { id: string }[] };
  const row = await prisma.community.findUniqueOrThrow({ where: { protocolId: community.id } });
  for (const [domain, url] of Object.entries(domains)) {
    if (url === DEAD) {
      await prisma.federationPeer.create({ data: { domain, baseUrl: DEAD, publicKey: "unused" } });
    } else {
      config.federationPeerOverrides[domain] = url;
      peerUrls.push(domain);
    }
    const stub = await prisma.user.create({
      data: { protocolId: newProtocolId(), username: "remy", displayName: "Remy", homeserverDomain: domain, isRemote: true },
    });
    await prisma.communityMember.create({ data: { communityId: row.id, userId: stub.id } });
  }
  return { bob, community };
}

const send = (bob: Registered, channelId: string, content: string) =>
  api.post(`/api/v1/channels/${channelId}/messages`).set(authHeader(bob.accessToken)).send({ content });

/** A peer that records what it is sent, optionally holding each request back by `delayFor(url)` ms first. */
async function startPeer(delayFor: (url: string) => number = () => 0) {
  const received: { method: string; url: string }[] = [];
  const server = createServer((req, res) => {
    if (req.url === "/.well-known/communication-platform") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ federation: { enabled: true, publicKey: "test-key", apiBase: "" } }));
      return;
    }
    req.resume();
    req.on("end", () => {
      setTimeout(() => {
        received.push({ method: req.method!, url: req.url! });
        res.statusCode = 200;
        res.end();
      }, delayFor(req.url!));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received };
}

describe("an unreachable remote member's server", () => {
  it("does not hold up the sender: the response comes back before the retry cycle would have finished", async () => {
    // One failed delivery costs three attempts and the waits between them: 300 ms + 600 ms = 900 ms here. Two
    // dead domains would have made the old, in-request delivery take ~1.8 s.
    config.federationRetryBaseMs = 300;
    const { bob, community } = await communityWithRemoteMembers({ "dead-one.test": DEAD, "dead-two.test": DEAD });

    const started = Date.now();
    const res = await send(bob, community.channels[0].id, "hello");
    const took = Date.now() - started;

    expect(res.status).toBe(201);
    expect(took).toBeLessThan(700);
    // Both events were recorded durably before the response, even though neither has been delivered.
    expect(await prisma.federationOutboxEvent.count()).toBe(2);
  });

  it("still gets the event, from the outbox: it stays queued with its failure recorded", async () => {
    const { bob, community } = await communityWithRemoteMembers({ "dead-one.test": DEAD });

    await send(bob, community.channels[0].id, "hello");
    await waitForPendingDeliveries();

    const rows = await prisma.federationOutboxEvent.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ domain: "dead-one.test", status: "PENDING", attempts: 1 });
    expect(rows[0].lastError).toBeTruthy();
    expect(rows[0].nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("is not tried again straight away for every following message (it backs off), but the messages are all queued", async () => {
    const { bob, community } = await communityWithRemoteMembers({ "dead-one.test": DEAD });

    await send(bob, community.channels[0].id, "one");
    await waitForPendingDeliveries(); // fails: the peer goes into its cooldown
    await send(bob, community.channels[0].id, "two");
    await send(bob, community.channels[0].id, "three");
    await waitForPendingDeliveries();

    const rows = await prisma.federationOutboxEvent.findMany({ orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => [r.status, r.attempts])).toEqual([
      ["PENDING", 1], // really tried, and failed
      ["PENDING", 0], // queued, not attempted: the peer had just failed
      ["PENDING", 0],
    ]);
  });

  it("is delivered once the peer is back, oldest first, and one failure stops the pass so nothing overtakes it", async () => {
    const { bob, community } = await communityWithRemoteMembers({ "back.test": DEAD });
    await send(bob, community.channels[0].id, "one");
    await waitForPendingDeliveries();
    await send(bob, community.channels[0].id, "two");
    await waitForPendingDeliveries();

    // Still dead: a flush tries the oldest, fails, and leaves the newer one alone rather than sending it past.
    await flushOutboxForDomain("back.test");
    const stillDead = await prisma.federationOutboxEvent.findMany({ orderBy: { createdAt: "asc" } });
    expect(stillDead.map((r) => r.attempts)).toEqual([2, 0]);

    // The peer comes up: the next flush delivers both, in order.
    const peer = await startPeer();
    config.federationPeerOverrides["back.test"] = peer.url;
    await prisma.federationPeer.deleteMany({ where: { domain: "back.test" } });
    await flushOutboxForDomain("back.test");

    expect(peer.received).toHaveLength(2);
    expect(await prisma.federationOutboxEvent.count()).toBe(0);
  });
});

describe("a peer that is up", () => {
  it("still receives the event promptly, and a message and its edit arrive in the order they were made", async () => {
    // The first request (the message) is held up for 120 ms by the peer; the edit is queued within a few
    // milliseconds of it. Unless attempts to one domain run one after another, the edit would arrive first.
    const peer = await startPeer((url) => (url.endsWith("/messages") ? 120 : 0));
    const { bob, community } = await communityWithRemoteMembers({ "up.test": peer.url });

    const sent = await send(bob, community.channels[0].id, "original");
    const messageId = sent.body.message.id as string;
    const edit = await api
      .patch(`/api/v1/messages/${messageId}`)
      .set(authHeader(bob.accessToken))
      .send({ content: "edited" });
    expect(edit.status).toBe(200);
    await waitForPendingDeliveries();

    expect(peer.received.map((r) => r.url.replace(/^.*\/channels\/[^/]+\//, ""))).toEqual([
      "messages",
      `messages/${messageId}/edit`,
    ]);
    expect(await prisma.federationOutboxEvent.count()).toBe(0);
  });

  it("is not made to wait for a dead peer in the same community", async () => {
    config.federationRetryBaseMs = 300;
    const peer = await startPeer();
    const { bob, community } = await communityWithRemoteMembers({ "dead.test": DEAD, "up.test": peer.url });

    const started = Date.now();
    await send(bob, community.channels[0].id, "hello");
    const took = Date.now() - started;
    await waitForPendingDeliveries();

    expect(took).toBeLessThan(700);
    expect(peer.received).toHaveLength(1);
    const left = await prisma.federationOutboxEvent.findMany();
    expect(left.map((r) => r.domain)).toEqual(["dead.test"]);
  });
});

describe("a peer that takes the connection and never answers", () => {
  it("is given up on after the outbox timeout instead of holding the attempt open, and the event stays queued", async () => {
    config.federationOutboxTimeoutMs = 300;
    // Accepts the request and says nothing.
    const silent = createServer((req, res) => {
      if (req.url === "/.well-known/communication-platform") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ federation: { enabled: true, publicKey: "test-key", apiBase: "" } }));
      }
    });
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    servers.push(silent);
    const { bob, community } = await communityWithRemoteMembers({
      "silent.test": `http://127.0.0.1:${(silent.address() as AddressInfo).port}`,
    });

    await send(bob, community.channels[0].id, "hello");
    const started = Date.now();
    await waitForPendingDeliveries();
    const took = Date.now() - started;

    // 3 attempts of 300 ms each, plus the tiny test retry waits.
    expect(took).toBeLessThan(3000);
    const rows = await prisma.federationOutboxEvent.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "PENDING", attempts: 1 });
    expect(rows[0].lastError).toMatch(/abort|timeout|timed out/i);
  });
});

describe("the background worker", () => {
  // A message that really failed backs off for 30 s; the ones queued behind it while the peer was still marked
  // down were never attempted, so their own timers are already due. Delivering those first would put them
  // ahead of an older event the peer has not seen.
  it("does not deliver newer events past an older one that is still backing off", async () => {
    const peer = await startPeer();
    const { bob, community } = await communityWithRemoteMembers({ "back.test": peer.url });
    const row = (content: string, nextAttemptAt: Date, createdAt: Date) =>
      prisma.federationOutboxEvent.create({
        data: {
          domain: "back.test",
          path: `/communities/${community.id}/channels/${community.channels[0].id}/messages`,
          body: { content, fromUsername: bob.user.username },
          nextAttemptAt,
          createdAt,
        },
      });
    const older = await row("older", new Date(Date.now() + 30_000), new Date(Date.now() - 2000));
    await row("newer", new Date(Date.now() - 1000), new Date(Date.now() - 1000));

    await processDueOutboxEvents();

    expect(peer.received).toHaveLength(0);
    expect(await prisma.federationOutboxEvent.count()).toBe(2);

    // Once the oldest is due, the whole queue goes, oldest first.
    await prisma.federationOutboxEvent.update({ where: { id: older.id }, data: { nextAttemptAt: new Date(Date.now() - 1) } });
    await processDueOutboxEvents();

    expect(peer.received).toHaveLength(2);
    expect(await prisma.federationOutboxEvent.count()).toBe(0);
  });

  it("serves a healthy domain even while another domain's oldest event is backing off", async () => {
    const up = await startPeer();
    const { bob, community } = await communityWithRemoteMembers({ "up.test": up.url, "slow.test": DEAD });
    const path = `/communities/${community.id}/channels/${community.channels[0].id}/messages`;
    await prisma.federationOutboxEvent.create({
      data: { domain: "slow.test", path, body: { content: "x", fromUsername: bob.user.username }, nextAttemptAt: new Date(Date.now() + 60_000) },
    });
    await prisma.federationOutboxEvent.create({ data: { domain: "up.test", path, body: { content: "y", fromUsername: bob.user.username } } });

    await processDueOutboxEvents();

    expect(up.received).toHaveLength(1);
    expect((await prisma.federationOutboxEvent.findMany()).map((r) => r.domain)).toEqual(["slow.test"]);
  });
});
