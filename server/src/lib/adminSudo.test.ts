import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { describe, expect, it } from "vitest";
import { SUDO_TTL_SECONDS, isValidSudoToken, signSudoToken } from "./adminSudo.js";

const SECRET = "an-access-secret-for-tests";
const NOW = new Date("2026-01-01T12:00:00Z");

describe("a sudo token", () => {
  it("is good for the admin it was made for, for ten minutes", () => {
    const { token, expiresAt } = signSudoToken(SECRET, "admin-1", NOW);
    expect(expiresAt.getTime() - NOW.getTime()).toBe(SUDO_TTL_SECONDS * 1000);
    expect(SUDO_TTL_SECONDS).toBe(600);
    expect(isValidSudoToken(SECRET, token, "admin-1", NOW)).toBe(true);
    expect(isValidSudoToken(SECRET, token, "admin-1", new Date(NOW.getTime() + 599_000))).toBe(true);
  });

  it("ends when the ten minutes do", () => {
    const { token } = signSudoToken(SECRET, "admin-1", NOW);
    expect(isValidSudoToken(SECRET, token, "admin-1", new Date(NOW.getTime() + 601_000))).toBe(false);
    expect(isValidSudoToken(SECRET, token, "admin-1", new Date(NOW.getTime() + 24 * 3600_000))).toBe(false);
  });

  it("is no good to another admin, even with a valid signature", () => {
    const { token } = signSudoToken(SECRET, "admin-1", NOW);
    expect(isValidSudoToken(SECRET, token, "admin-2", NOW)).toBe(false);
  });

  it("is not made under a different secret", () => {
    const { token } = signSudoToken("another-secret", "admin-1", NOW);
    expect(isValidSudoToken(SECRET, token, "admin-1", NOW)).toBe(false);
  });

  it("cannot be forged from the access secret itself: an access token is not a sudo token", () => {
    const access = jwt.sign({ sub: "admin-1", username: "alice" }, SECRET, { expiresIn: "15m" });
    expect(isValidSudoToken(SECRET, access, "admin-1")).toBe(false);
    // Nor one that says the right thing but is signed with the plain secret.
    const forged = jwt.sign({ purpose: "admin_sudo", sub: "admin-1" }, SECRET, { expiresIn: "10m" });
    expect(isValidSudoToken(SECRET, forged, "admin-1")).toBe(false);
  });

  it("cannot be made from another derived token, such as the two-factor challenge", () => {
    // The challenge token is signed with a key derived under another label and says another thing.
    const key = (label: string) => crypto.createHmac("sha256", SECRET).update(label).digest("hex");
    const challenge = jwt.sign({ challenge: "totp_challenge", sub: "admin-1" }, key("totp-challenge:v1"), { expiresIn: "5m" });
    expect(isValidSudoToken(SECRET, challenge, "admin-1")).toBe(false);
    // Even signed with the sudo key, a token that does not say it is for sudo is refused.
    const wrongPurpose = jwt.sign({ purpose: "something_else", sub: "admin-1" }, key("admin-sudo:v1"), { expiresIn: "10m" });
    expect(isValidSudoToken(SECRET, wrongPurpose, "admin-1")).toBe(false);
  });

  it("is signed under its own label: a token made with that key is good, one made with the plain or an empty-label key is not", () => {
    const key = (label: string) => crypto.createHmac("sha256", SECRET).update(label).digest("hex");
    const claims = { purpose: "admin_sudo", sub: "admin-1" };
    expect(isValidSudoToken(SECRET, jwt.sign(claims, key("admin-sudo:v1"), { expiresIn: "10m" }), "admin-1")).toBe(true);
    expect(isValidSudoToken(SECRET, jwt.sign(claims, key(""), { expiresIn: "10m" }), "admin-1")).toBe(false);
    expect(isValidSudoToken(SECRET, jwt.sign(claims, key("totp-challenge:v1"), { expiresIn: "10m" }), "admin-1")).toBe(false);
  });

  it("refuses nothing, garbage, and a token with the signature removed, without throwing", () => {
    expect(isValidSudoToken(SECRET, undefined, "admin-1")).toBe(false);
    expect(isValidSudoToken(SECRET, "", "admin-1")).toBe(false);
    expect(isValidSudoToken(SECRET, "not a token", "admin-1")).toBe(false);
    const { token } = signSudoToken(SECRET, "admin-1", NOW);
    const [head, body] = token.split(".");
    expect(isValidSudoToken(SECRET, `${head}.${body}.`, "admin-1", NOW)).toBe(false);
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${body}.`;
    expect(isValidSudoToken(SECRET, none, "admin-1", NOW)).toBe(false);
  });
});
