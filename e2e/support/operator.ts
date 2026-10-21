import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import type { Person } from "./app";
import { PASSWORD } from "./app";
import { SIDES, databaseUrl } from "./stack.mjs";

/**
 * The operator's command, run against server "a"'s own database the way `npm run admin` runs it: how an account is erased at once, or made
 * an admin. It needs the same environment the server was started with (scripts/run-server.mjs): the database, the domain, the secrets and,
 * since `.test` names do not resolve, how the two servers find each other.
 */
export function operator(...args: string[]) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const tsx = join(root, "node_modules", "tsx", "dist", "cli.mjs");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: databaseUrl("a"),
    SERVER_DOMAIN: SIDES.a.domain,
    JWT_ACCESS_SECRET: "e2e-access-secret-a",
    JWT_REFRESH_SECRET: "e2e-refresh-secret-a",
    FEDERATION_PEER_OVERRIDES: JSON.stringify({ [SIDES.b.domain]: `http://localhost:${SIDES.b.serverPort}` }),
    NODE_ENV: "development",
  };
  delete env.REDIS_URL;
  delete env.DOTENV_CONFIG_PATH;
  const result = spawnSync(process.execPath, [tsx, "src/adminCli.ts", ...args], { cwd: join(root, "server"), env, encoding: "utf8" });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** The six-digit code an authenticator app shows for this secret now (RFC 6238: SHA-1, 30-second steps), so a test needs no library for it. */
export function totp(secret: string, at = Date.now()): string {
  let bits = "";
  for (const char of secret.replace(/=+$/u, "").toUpperCase()) bits += BASE32.indexOf(char).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/gu)!.map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const hmac = createHmac("sha1", key).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const value = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(value % 1_000_000).padStart(6, "0");
}

/** Turns on two-factor sign-in for a person on server "a" through the API with their own session, and returns the secret. */
export async function enableTwoFactor(person: Person): Promise<string> {
  const token = await person.page.evaluate(() => localStorage.getItem("chat.accessToken"));
  const api = `http://localhost:${SIDES.a.serverPort}/api/v1/auth`;
  const headers = { Authorization: `Bearer ${token}` };
  const setup = await person.page.request.post(`${api}/2fa/setup`, { headers, data: { password: PASSWORD } });
  expect(setup.status()).toBe(200);
  const { secret } = (await setup.json()) as { secret: string };
  const verify = await person.page.request.post(`${api}/2fa/verify`, { headers, data: { code: totp(secret) } });
  expect(verify.status()).toBe(200);
  return secret;
}
