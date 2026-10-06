import { generateKeyPairSync } from "node:crypto";
import { prisma } from "../../src/db.js";
import { signRequest } from "../../src/lib/federation/signing.js";
import { api } from "./app.js";

export interface TestPeer {
  domain: string;
  privateKey: string;
  publicKey: string;
}

/**
 * Registers a fake remote homeserver by pre-seeding the FederationPeer cache
 * directly (same table `resolvePeer` reads from) - this exercises the exact
 * same cache-hit code path a real second server uses once it's already
 * discovered a peer, without needing an actual second process or network
 * call.
 */
export async function registerTestPeer(domain: string): Promise<TestPeer> {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  await prisma.federationPeer.upsert({
    where: { domain },
    create: { domain, baseUrl: `http://${domain}`, publicKey: publicKeyPem },
    update: { publicKey: publicKeyPem, baseUrl: `http://${domain}`, fetchedAt: new Date() },
  });
  return { domain, privateKey: privateKeyPem, publicKey: publicKeyPem };
}

/**
 * Builds and sends a correctly-signed POST to a /federation/v1/* route, the
 * way a real peer's `federationFetch` would. Signs the *exact* JSON string
 * sent as the body, since the server verifies the signature against its
 * captured raw request bytes.
 */
export function signedPost(peer: TestPeer, path: string, bodyObj: unknown) {
  const bodyString = JSON.stringify(bodyObj);
  const { timestamp, signature } = signRequest(peer.privateKey, "POST", path, bodyString);
  return api
    .post(path)
    .set("Content-Type", "application/json")
    .set("X-Federation-Origin", peer.domain)
    .set("X-Federation-Timestamp", timestamp)
    .set("X-Federation-Signature", signature)
    .send(bodyString);
}
