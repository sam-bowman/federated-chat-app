import { generateKeyPairSync } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../db.js";

export interface ServerKeyPair {
  publicKey: string;
  privateKey: string;
}

let cached: ServerKeyPair | null = null;
// Dedupes concurrent callers *within this process* onto one DB round trip -
// without this, several federation calls firing at once before the first
// one finishes (e.g. a receiving handshake independently verifying several
// third-party members in parallel, see federation/routes.ts) would each
// see no cached keypair and race each other below.
let inFlight: Promise<ServerKeyPair> | null = null;

/**
 * This homeserver's own long-lived Ed25519 signing keypair, used to sign
 * every outgoing federation request and published (public half only) via
 * .well-known so peers can verify them. Generated once on first boot and
 * persisted - never invent a crypto scheme here, this is just Node's
 * standard library.
 */
export async function getServerKeyPair(): Promise<ServerKeyPair> {
  if (cached) return cached;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const existing = await prisma.serverIdentity.findUnique({ where: { id: 1 } });
    if (existing) {
      return { publicKey: existing.publicKey, privateKey: existing.privateKey };
    }

    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const keyPair: ServerKeyPair = {
      publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
      privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    };

    try {
      const saved = await prisma.serverIdentity.upsert({
        where: { id: 1 },
        create: { id: 1, ...keyPair },
        update: {},
      });
      return { publicKey: saved.publicKey, privateKey: saved.privateKey };
    } catch (err) {
      // A genuinely concurrent *other process* (e.g. two replicas booting
      // at once) can still win a race upsert() alone doesn't close - both
      // can see no existing row and both attempt to create, so the loser
      // hits a unique-constraint error on an upsert that was supposed to
      // handle this. Treat that specific case as "someone else just wrote
      // it" and read back whatever they saved, rather than a real failure.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        const winner = await prisma.serverIdentity.findUniqueOrThrow({ where: { id: 1 } });
        return { publicKey: winner.publicKey, privateKey: winner.privateKey };
      }
      throw err;
    }
  })();

  try {
    cached = await inFlight;
    return cached;
  } finally {
    inFlight = null;
  }
}
