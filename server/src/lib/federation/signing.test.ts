import { generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { signRequest, verifySignature } from "./signing.js";

describe("federation request signing", () => {
  let publicKey: string;
  let privateKey: string;

  beforeAll(() => {
    const pair = generateKeyPairSync("ed25519");
    publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
    privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  });

  it("round-trips: a request signed with the private key verifies with the public key", () => {
    const { timestamp, signature } = signRequest(privateKey, "POST", "/federation/v1/messages", '{"hello":"world"}');
    const ok = verifySignature(
      publicKey,
      "POST",
      "/federation/v1/messages",
      '{"hello":"world"}',
      timestamp,
      signature
    );
    expect(ok).toBe(true);
  });

  it("rejects a tampered body", () => {
    const { timestamp, signature } = signRequest(privateKey, "POST", "/federation/v1/messages", '{"hello":"world"}');
    const ok = verifySignature(
      publicKey,
      "POST",
      "/federation/v1/messages",
      '{"hello":"tampered"}',
      timestamp,
      signature
    );
    expect(ok).toBe(false);
  });

  it("rejects a tampered path", () => {
    const { timestamp, signature } = signRequest(privateKey, "POST", "/federation/v1/messages", "{}");
    const ok = verifySignature(publicKey, "POST", "/federation/v1/friend-requests", "{}", timestamp, signature);
    expect(ok).toBe(false);
  });

  it("rejects a tampered method", () => {
    const { timestamp, signature } = signRequest(privateKey, "POST", "/federation/v1/messages", "{}");
    const ok = verifySignature(publicKey, "GET", "/federation/v1/messages", "{}", timestamp, signature);
    expect(ok).toBe(false);
  });

  it("rejects a signature from a different keypair", () => {
    const other = generateKeyPairSync("ed25519");
    const otherPublicKey = other.publicKey.export({ type: "spki", format: "pem" }).toString();
    const { timestamp, signature } = signRequest(privateKey, "POST", "/federation/v1/messages", "{}");
    const ok = verifySignature(otherPublicKey, "POST", "/federation/v1/messages", "{}", timestamp, signature);
    expect(ok).toBe(false);
  });

  it("rejects a timestamp more than 5 minutes in the past", () => {
    const sixMinutesAgo = (Date.now() - 6 * 60 * 1000).toString();
    const ok = verifySignature(publicKey, "GET", "/x", "", sixMinutesAgo, "irrelevant-signature");
    expect(ok).toBe(false);
  });

  it("rejects a timestamp more than 5 minutes in the future", () => {
    const sixMinutesAhead = (Date.now() + 6 * 60 * 1000).toString();
    const ok = verifySignature(publicKey, "GET", "/x", "", sixMinutesAhead, "irrelevant-signature");
    expect(ok).toBe(false);
  });

  it("rejects a non-numeric timestamp", () => {
    const ok = verifySignature(publicKey, "GET", "/x", "", "not-a-number", "irrelevant-signature");
    expect(ok).toBe(false);
  });

  it("rejects garbage signature input without throwing", () => {
    expect(() => verifySignature(publicKey, "GET", "/x", "", Date.now().toString(), "not-base64!!")).not.toThrow();
    expect(verifySignature(publicKey, "GET", "/x", "", Date.now().toString(), "not-base64!!")).toBe(false);
  });
});
