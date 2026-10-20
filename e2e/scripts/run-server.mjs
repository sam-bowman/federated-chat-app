// Starts one of the two homeservers the end-to-end tests run against, on its own empty database.
//
//   node scripts/run-server.mjs a|b
//
// playwright.config.ts starts this as a `webServer`, so Playwright waits for /healthz and stops the process afterwards.
// Everything here is kept apart from a developer's own setup: other ports, other databases (`*_e2e_*`), other uploads
// folder, and the database is wiped when the server starts.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SIDES, databaseUrl } from "../support/stack.mjs";

const side = process.argv[2];
if (side !== "a" && side !== "b") {
  console.error("usage: run-server.mjs a|b");
  process.exit(2);
}
const { domain, serverPort, clientPort, peer } = SIDES[side];
const url = databaseUrl(side);

// `prisma migrate reset` DROPS the database it is pointed at, so it only ever runs against one that is plainly a test
// database of this suite. (server/test/helpers/db.ts has the same rule for the integration tests.)
const name = new URL(url).pathname.slice(1);
if (!/_e2e_[ab]$/.test(name)) {
  console.error(`Refusing to reset "${name}": the end-to-end databases must be named *_e2e_a / *_e2e_b.`);
  process.exit(2);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const serverDir = join(root, "server");
const uploads = join(root, "e2e", ".data", `uploads-${side}`);
mkdirSync(uploads, { recursive: true });

/** @type {NodeJS.ProcessEnv} */
const env = {
  ...process.env,
  PORT: String(serverPort),
  SERVER_DOMAIN: domain,
  SERVER_NAME: `${domain} (e2e)`,
  DATABASE_URL: url,
  JWT_ACCESS_SECRET: `e2e-access-secret-${side}`,
  JWT_REFRESH_SECRET: `e2e-refresh-secret-${side}`,
  REGISTRATION_ENABLED: "true",
  UPLOADS_DIR: uploads,
  CORS_ORIGIN: `http://localhost:${clientPort}`,
  PUBLIC_BASE_URL: `http://localhost:${serverPort}`,
  // The two servers find each other on localhost, as the federation demo does; `.test` names never resolve.
  FEDERATION_PEER_OVERRIDES: JSON.stringify({ [peer.domain]: `http://localhost:${peer.serverPort}` }),
  // alice.test publishes a directory and bob.test does not, so a test can browse a server that does and one that does not.
  DIRECTORY_ENABLED: side === "a" ? "true" : "false",
  // Tests sign in dozens of fresh accounts from one address.
  RATE_LIMIT_MAX: "100000",
  AUTH_RATE_LIMIT_MAX: "100000",
  NODE_ENV: "development",
};
// Voice (e2e/tests/voice.spec.ts): only server "a" has it, and only when the LiveKit from e2e/docker-compose.livekit.yml is running
// (E2E_LIVEKIT=1), whose webhook points at this server's port. Without it the server has no voice, as in a default deployment.
if (side === "a" && process.env.E2E_LIVEKIT) {
  env.LIVEKIT_URL = "ws://localhost:7880";
  env.LIVEKIT_API_KEY = "e2ekey";
  env.LIVEKIT_API_SECRET = "e2e-livekit-secret-0123456789abcdef";
}
delete env.REDIS_URL;
delete env.DOTENV_CONFIG_PATH;

const prisma = join(root, "node_modules", "prisma", "build", "index.js");
const reset = spawnSync(process.execPath, [prisma, "migrate", "reset", "--force", "--skip-seed", "--skip-generate"], {
  cwd: serverDir,
  env,
  stdio: "inherit",
});
if (reset.status !== 0) process.exit(reset.status ?? 1);

const tsx = join(root, "node_modules", "tsx", "dist", "cli.mjs");
const server = spawn(process.execPath, [tsx, "src/index.ts"], { cwd: serverDir, env, stdio: "inherit" });
server.on("exit", (code) => process.exit(code ?? 0));
for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM"])) process.on(signal, () => server.kill(signal));
