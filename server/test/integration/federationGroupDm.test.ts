// Covers the receiving side of federated GROUP conversations spanning more
// than one remote domain - see protocol/federation.md's "POST
// /conversations" section for the three-way trust split this exercises.
//
// registerTestPeer() (test/helpers/federation.ts) only seeds the
// FederationPeer cache for *inbound* signature verification - it never
// points at a reachable address, so it can't stand in for a third-party
// domain we need to call *out* to for independent verification. For that,
// this file combines it with the real-local-http.createServer +
// config.federationPeerOverrides pattern from federationOutbox.test.ts /
// ssrfGuard.integration.test.ts, used here for the first time together.
import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { config } from "../../src/config.js";
import { prisma } from "../../src/db.js";
import { newProtocolId } from "../../src/lib/ids.js";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { registerTestPeer, signedPost } from "../helpers/federation.js";
import { registerUser } from "../helpers/factory.js";

const CAROL_DOMAIN = "carol.invalid";

beforeEach(resetDb);
afterAll(disconnectDb);

describe("POST /federation/v1/conversations (group DMs spanning multiple domains)", () => {
  let carolServer: Server;
  let carolPort: number;
  let carolRealProtocolId: string;
  let carolReachable: boolean;

  beforeEach(async () => {
    carolRealProtocolId = newProtocolId();
    carolReachable = true;
    carolServer = createServer((req, res) => {
      if (req.url === "/.well-known/communication-platform") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ federation: { enabled: true, publicKey: "carol-key", apiBase: "/federation/v1" } }));
        return;
      }
      if (req.url === "/federation/v1/users/carol" && carolReachable) {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            user: { id: carolRealProtocolId, username: "carol", displayName: "Carol", avatarUrl: null },
          })
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => carolServer.listen(0, "127.0.0.1", resolve));
    carolPort = (carolServer.address() as { port: number }).port;
    config.federationPeerOverrides[CAROL_DOMAIN] = `http://127.0.0.1:${carolPort}`;
  });

  afterEach(async () => {
    delete config.federationPeerOverrides[CAROL_DOMAIN];
    await new Promise<void>((resolve) => carolServer.close(() => resolve()));
  });

  // The core regression test for the cache-poisoning concern: a calling
  // peer claims a wrong protocolId for a third-party member, and the
  // receiving server must store what that member's own domain reports,
  // never the caller's claim.
  it("stores the third-party member's real protocolId, not the one the calling peer claimed for them", async () => {
    const bob = await registerUser("bob");
    const alice = await registerTestPeer("alice.test");
    const conversationId = newProtocolId();
    const attackerClaimedProtocolId = newProtocolId();

    const res = await signedPost(alice, "/federation/v1/conversations", {
      conversationId,
      type: "GROUP",
      members: [
        { protocolId: newProtocolId(), username: "alice", domain: "alice.test", displayName: "Alice" },
        { protocolId: bob.user.id, username: "bob", domain: "test.local", displayName: "Bob" },
        { protocolId: attackerClaimedProtocolId, username: "carol", domain: CAROL_DOMAIN, displayName: "Carol (fake)" },
      ],
    });

    expect(res.status).toBe(201);
    const stored = await prisma.user.findFirst({ where: { username: "carol", homeserverDomain: CAROL_DOMAIN } });
    expect(stored).not.toBeNull();
    expect(stored!.protocolId).toBe(carolRealProtocolId);
    expect(stored!.protocolId).not.toBe(attackerClaimedProtocolId);
    expect(stored!.displayName).toBe("Carol"); // carol's own server's answer, not the payload's "Carol (fake)"
  });

  it("rejects the whole handshake when a third-party member's domain can't be verified, with no partial writes", async () => {
    carolReachable = false;
    const bob = await registerUser("bob");
    const alice = await registerTestPeer("alice.test");
    const conversationId = newProtocolId();

    const res = await signedPost(alice, "/federation/v1/conversations", {
      conversationId,
      type: "GROUP",
      members: [
        { protocolId: newProtocolId(), username: "alice", domain: "alice.test", displayName: "Alice" },
        { protocolId: bob.user.id, username: "bob", domain: "test.local", displayName: "Bob" },
        { protocolId: newProtocolId(), username: "carol", domain: CAROL_DOMAIN, displayName: "Carol" },
      ],
    });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("member_verification_failed");
    expect(await prisma.conversation.findUnique({ where: { protocolId: conversationId } })).toBeNull();
    expect(await prisma.user.findFirst({ where: { username: "carol", homeserverDomain: CAROL_DOMAIN } })).toBeNull();
  });

  it("still accepts a plain 2-member, single-remote-domain GROUP handshake", async () => {
    const bob = await registerUser("bob");
    const alice = await registerTestPeer("alice.test");
    const conversationId = newProtocolId();

    const res = await signedPost(alice, "/federation/v1/conversations", {
      conversationId,
      type: "GROUP",
      members: [
        { protocolId: newProtocolId(), username: "alice", domain: "alice.test", displayName: "Alice" },
        { protocolId: bob.user.id, username: "bob", domain: "test.local", displayName: "Bob" },
      ],
    });

    expect(res.status).toBe(201);
    const convo = await prisma.conversation.findUnique({
      where: { protocolId: conversationId },
      include: { members: true },
    });
    expect(convo!.members).toHaveLength(2);
  });

  it("rejects a DM payload that doesn't name exactly two members", async () => {
    const bob = await registerUser("bob");
    const alice = await registerTestPeer("alice.test");

    const res = await signedPost(alice, "/federation/v1/conversations", {
      conversationId: newProtocolId(),
      type: "DM",
      members: [
        { protocolId: newProtocolId(), username: "alice", domain: "alice.test", displayName: "Alice" },
        { protocolId: bob.user.id, username: "bob", domain: "test.local", displayName: "Bob" },
        { protocolId: newProtocolId(), username: "carol", domain: CAROL_DOMAIN, displayName: "Carol" },
      ],
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("dm_requires_exactly_two_members");
  });

  it("rejects a handshake naming more than the member cap", async () => {
    const alice = await registerTestPeer("alice.test");
    const members = Array.from({ length: 11 }, (_, i) => ({
      protocolId: newProtocolId(),
      username: `member${i}`,
      domain: "alice.test",
      displayName: `Member ${i}`,
    }));

    const res = await signedPost(alice, "/federation/v1/conversations", {
      conversationId: newProtocolId(),
      type: "GROUP",
      members,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });
});
