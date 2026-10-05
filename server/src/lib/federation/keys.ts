import { generateKeyPairSync } from "node:crypto";
import { prisma } from "../../db.js";

export interface ServerKeyPair {
  publicKey: string;
  privateKey: string;
}

let cached: ServerKeyPair | null = null;

/**
 * This homeserver's own long-lived Ed25519 signing keypair, used to sign
 * every outgoing federation request and published (public half only) via
 * .well-known so peers can verify them. Generated once on first boot and
 * persisted - never invent a crypto scheme here, this is just Node's
 * standard library.
 */
export async function getServerKeyPair(): Promise<ServerKeyPair> {
  if (cached) return cached;

  const existing = await prisma.serverIdentity.findUnique({ where: { id: 1 } });
  if (existing) {
    cached = { publicKey: existing.publicKey, privateKey: existing.privateKey };
    return cached;
  }

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyPair: ServerKeyPair = {
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };

  // Another process could race us on first boot (e.g. two tsx watch
  // restarts) - upsert so whoever wins, everyone ends up agreeing on one.
  const saved = await prisma.serverIdentity.upsert({
    where: { id: 1 },
    create: { id: 1, ...keyPair },
    update: {},
  });
  cached = { publicKey: saved.publicKey, privateKey: saved.privateKey };
  return cached;
}
