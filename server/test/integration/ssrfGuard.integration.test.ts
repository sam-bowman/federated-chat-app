import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { config } from "../../src/config.js";
import { resolvePeer } from "../../src/lib/federation/discovery.js";
import { SsrfBlockedError } from "../../src/lib/federation/ssrfGuard.js";
import { disconnectDb, resetDb } from "../helpers/db.js";

beforeEach(resetDb);
afterAll(disconnectDb);

// None of federation.test.ts's existing coverage exercises the real
// discovery fetch path - registerTestPeer() seeds the FederationPeer cache
// directly, bypassing resolvePeer/fetchAndCachePeer entirely (see
// test/helpers/federation.ts). These tests cover the path that does hit it.
describe("resolvePeer SSRF protection", () => {
  it("rejects a domain that is literally localhost", async () => {
    await expect(resolvePeer("localhost")).rejects.toThrow(SsrfBlockedError);
  });

  it("rejects a domain that is a private/loopback IP literal", async () => {
    await expect(resolvePeer("127.0.0.1")).rejects.toThrow(SsrfBlockedError);
  });

  it("rejects a domain that resolves to a private address (cloud metadata IP)", async () => {
    await expect(resolvePeer("169.254.169.254")).rejects.toThrow(SsrfBlockedError);
  });

  describe("FEDERATION_PEER_OVERRIDES bypass", () => {
    let server: Server;
    let port: number;
    const overrideDomain = "ssrf-test-peer.invalid";

    beforeEach(async () => {
      server = createServer((req, res) => {
        if (req.url === "/.well-known/communication-platform") {
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              federation: { enabled: true, apiBase: "/federation/v1", publicKey: "test-public-key" },
            })
          );
          return;
        }
        res.statusCode = 404;
        res.end();
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      port = (server.address() as { port: number }).port;
      config.federationPeerOverrides[overrideDomain] = `http://127.0.0.1:${port}`;
    });

    afterEach(async () => {
      delete config.federationPeerOverrides[overrideDomain];
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("still resolves successfully, skipping the SSRF check, for an overridden domain", async () => {
      const peer = await resolvePeer(overrideDomain);
      expect(peer.baseUrl).toBe(`http://127.0.0.1:${port}`);
      expect(peer.publicKey).toBe("test-public-key");
      expect(peer.trusted).toBe(true);
    });
  });
});
