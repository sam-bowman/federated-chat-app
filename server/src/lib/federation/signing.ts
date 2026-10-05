import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

function canonicalString(method: string, path: string, timestamp: string, bodyHash: string): string {
  return `${method.toUpperCase()}\n${path}\n${timestamp}\n${bodyHash}`;
}

function hashBody(body: string): string {
  return createHash("sha256").update(body).digest("base64");
}

export function signRequest(privateKeyPem: string, method: string, path: string, body: string) {
  const timestamp = Date.now().toString();
  const bodyHash = hashBody(body);
  const message = canonicalString(method, path, timestamp, bodyHash);
  const key = createPrivateKey(privateKeyPem);
  const signature = cryptoSign(null, Buffer.from(message), key).toString("base64");
  return { timestamp, signature };
}

export function verifySignature(
  publicKeyPem: string,
  method: string,
  path: string,
  body: string,
  timestamp: string,
  signature: string
): boolean {
  const age = Date.now() - Number(timestamp);
  if (!Number.isFinite(age) || Math.abs(age) > MAX_CLOCK_SKEW_MS) return false;

  try {
    const message = canonicalString(method, path, timestamp, hashBody(body));
    const key = createPublicKey(publicKeyPem);
    return cryptoVerify(null, Buffer.from(message), key, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}
