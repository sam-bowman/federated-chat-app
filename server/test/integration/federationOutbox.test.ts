import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { config } from "../../src/config.js";
import { prisma } from "../../src/db.js";
import { enqueueFederationEvent, flushOutboxForDomain } from "../../src/lib/federation/outbox.js";
import { disconnectDb, resetDb } from "../helpers/db.js";

const TEST_DOMAIN = "outbox-test.invalid";

beforeEach(resetDb);
afterAll(disconnectDb);

// A real local HTTP server standing in for a peer homeserver - lets these
// tests exercise the actual federationFetch() call outbox.ts makes (real
// discovery doc, real request/response), not a mock of it. Matches the
// pattern in ssrfGuard.integration.test.ts for the same reason: none of
// the existing federation test helpers (registerTestPeer) point at a
// reachable address, since they only exercise the *inbound* signature-
// verification side.
describe("federation outbox", () => {
  let server: Server;
  let port: number;
  let responseStatus: number;

  beforeEach(async () => {
    responseStatus = 200;
    server = createServer((req, res) => {
      if (req.url === "/.well-known/communication-platform") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ federation: { enabled: true, publicKey: "test-key", apiBase: "" } }));
        return;
      }
      res.statusCode = responseStatus;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
    config.federationPeerOverrides[TEST_DOMAIN] = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    delete config.federationPeerOverrides[TEST_DOMAIN];
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("delivers immediately and leaves no row behind when the peer responds OK", async () => {
    await enqueueFederationEvent(TEST_DOMAIN, "/test-path", { hello: "world" });
    const rows = await prisma.federationOutboxEvent.findMany({ where: { domain: TEST_DOMAIN } });
    expect(rows).toHaveLength(0);
  });

  it("durably queues the event when the peer is unreachable, for later retry", async () => {
    responseStatus = 500;
    await enqueueFederationEvent(TEST_DOMAIN, "/test-path", { hello: "world" });

    const rows = await prisma.federationOutboxEvent.findMany({ where: { domain: TEST_DOMAIN } });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("PENDING");
    expect(rows[0].attempts).toBe(1);
    expect(rows[0].body).toEqual({ hello: "world" });
    expect(rows[0].nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  }, 20000);

  it("marks a 4xx rejection FAILED outright - not a transient failure worth retrying", async () => {
    responseStatus = 400;
    await enqueueFederationEvent(TEST_DOMAIN, "/test-path", {});

    const rows = await prisma.federationOutboxEvent.findMany({ where: { domain: TEST_DOMAIN } });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("FAILED");
    expect(rows[0].lastError).toBe("http_400");
  });

  it("flushOutboxForDomain delivers a queued event immediately once the peer is reachable again, ignoring its backoff timer", async () => {
    responseStatus = 500;
    await enqueueFederationEvent(TEST_DOMAIN, "/test-path", { hello: "world" });
    const queued = await prisma.federationOutboxEvent.findMany({ where: { domain: TEST_DOMAIN } });
    expect(queued).toHaveLength(1);
    // Confirms this test is actually exercising the "ignore nextAttemptAt"
    // behavior, not coincidentally passing because the backoff already
    // elapsed - BASE_DELAY_MS is 30s, so this should still be well in the
    // future immediately after queuing.
    expect(queued[0].nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 10000);

    responseStatus = 200; // peer "comes back up"
    await flushOutboxForDomain(TEST_DOMAIN);

    const rows = await prisma.federationOutboxEvent.findMany({ where: { domain: TEST_DOMAIN } });
    expect(rows).toHaveLength(0);
  }, 20000);

  it("only one concurrent attempt actually delivers a given row - the other sees it already claimed", async () => {
    let deliveryCount = 0;
    server.close();
    server = createServer((req, res) => {
      if (req.url === "/.well-known/communication-platform") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ federation: { enabled: true, publicKey: "test-key", apiBase: "" } }));
        return;
      }
      deliveryCount++;
      res.statusCode = 200;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
    config.federationPeerOverrides[TEST_DOMAIN] = `http://127.0.0.1:${port}`;

    // Queue it via a failure first (immediate delivery on enqueue would
    // otherwise just deliver it before there's anything left to race).
    responseStatus = 500;
    await enqueueFederationEvent(TEST_DOMAIN, "/test-path", {});
    responseStatus = 200;

    // Two concurrent flushes race to claim and deliver the same backlog.
    await Promise.all([flushOutboxForDomain(TEST_DOMAIN), flushOutboxForDomain(TEST_DOMAIN)]);

    expect(deliveryCount).toBe(1);
    const rows = await prisma.federationOutboxEvent.findMany({ where: { domain: TEST_DOMAIN } });
    expect(rows).toHaveLength(0);
  }, 20000);

  it("gives up (FAILED) after enough failed attempts instead of retrying forever", async () => {
    responseStatus = 500;
    await enqueueFederationEvent(TEST_DOMAIN, "/test-path", {});
    const [row] = await prisma.federationOutboxEvent.findMany({ where: { domain: TEST_DOMAIN } });

    // Fast-forwards past the real backoff schedule instead of actually
    // waiting hours for 20 real attempts - sets up "one attempt away from
    // the cap" directly, then lets the real code path take that last step.
    await prisma.federationOutboxEvent.update({
      where: { id: row.id },
      data: { status: "PENDING", attempts: 19, nextAttemptAt: new Date() },
    });

    await flushOutboxForDomain(TEST_DOMAIN);

    const [finalRow] = await prisma.federationOutboxEvent.findMany({ where: { domain: TEST_DOMAIN } });
    expect(finalRow.status).toBe("FAILED");
    expect(finalRow.attempts).toBe(20);
  }, 20000);
});
