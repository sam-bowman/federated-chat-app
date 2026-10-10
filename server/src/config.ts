import dotenv from "dotenv";
import { existsSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { isSea } from "node:sea";

// A packaged binary (see docs/distribution.md "Native binaries") can't assume
// cwd is its own folder - unlike Docker/dev, where cwd is always set
// correctly, a double-clicked binary (or a Windows service) might be
// launched from anywhere. Everything below that resolves a path does so
// relative to the executable's own directory when packaged, and exactly as
// before (cwd-relative) otherwise - this is the only thing that branches on
// isSea(), so Docker/dev behavior is unchanged.
export const isPackagedBinary = isSea;
export const installDir = isSea() ? dirname(process.execPath) : process.cwd();

// Passing `path: undefined` falls back to dotenv's own default (cwd-relative
// ".env") UNLESS DOTENV_CONFIG_PATH is set, in which case dotenv.config()'s
// programmatic API (unlike the old side-effecting `import "dotenv/config"`
// this replaced) ignores that env var entirely and we have to pass it
// through ourselves - scripts/start-federation-demo.ps1 relies on exactly
// this (`set DOTENV_CONFIG_PATH=.env.a&& npm run dev`) to run two server
// instances from one checkout without each clobbering the other's `.env`.
dotenv.config({ path: isSea() ? join(installDir, ".env") : process.env.DOTENV_CONFIG_PATH });

// Packaged binaries bundle @prisma/client's JS directly into the
// executable (Node's Single Executable Applications can't require() an
// external package by bare specifier - only actual Node builtins resolve
// that way), but the native query engine is real machine code, not
// something a JS bundle can embed, so it ships as the one loose file next
// to the executable instead. Pointing PRISMA_QUERY_ENGINE_LIBRARY at it
// directly avoids depending on Prisma's own cwd-relative search order
// (confirmed empirically to work, but only because of which directory the
// process happened to be launched from - not something a double-clicked
// binary should rely on).
if (isSea() && !process.env.PRISMA_QUERY_ENGINE_LIBRARY) {
  const engineDir = join(installDir, "node_modules", ".prisma", "client");
  if (existsSync(engineDir)) {
    const engineFile = readdirSync(engineDir).find((f) => f.includes("query_engine") || f.includes("libquery_engine"));
    if (engineFile) process.env.PRISMA_QUERY_ENGINE_LIBRARY = join(engineDir, engineFile);
  }
}

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const storageDriver = (process.env.STORAGE_DRIVER ?? "disk") as "disk" | "s3";

// Only actually required (fails fast, like required() above) when
// STORAGE_DRIVER=s3 - disk storage (the default) never reads these, so an
// S3-less deployment doesn't need any of them set.
function requiredForS3(name: string): string | undefined {
  return storageDriver === "s3" ? required(name) : process.env[name];
}

function parsePeerOverrides(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

// Only packaged binaries resolve a relative UPLOADS_DIR against installDir
// instead of cwd - an absolute path (or anything under Docker/dev) is left
// exactly as before.
function resolveUploadsDir(raw: string): string {
  if (isAbsolute(raw) || !isSea()) return raw;
  return join(installDir, raw);
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  // The domain portion of this homeserver's identities, e.g. "@sam:<domain>".
  // Single-server today, but every identity/object already carries this so a
  // second, independently-run homeserver can federate later without any
  // existing IDs changing shape.
  domain: required("SERVER_DOMAIN", "localhost"),
  serverName: process.env.SERVER_NAME ?? "My Chat Server",
  databaseUrl: required("DATABASE_URL"),
  jwtAccessSecret: required("JWT_ACCESS_SECRET", "dev-insecure-access-secret-change-me"),
  jwtRefreshSecret: required("JWT_REFRESH_SECRET", "dev-insecure-refresh-secret-change-me"),
  accessTokenTtlSeconds: 15 * 60,
  refreshTokenTtlDays: 30,
  registrationEnabled: (process.env.REGISTRATION_ENABLED ?? "true") === "true",
  uploadsDir: resolveUploadsDir(process.env.UPLOADS_DIR ?? "uploads"),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 8 * 1024 * 1024),
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
  protocolVersion: "0.1.0",

  // This server's own publicly-reachable address. Real deployments would
  // just be `https://${domain}`; local dev needs it set explicitly since
  // nothing resolves `alice.test` to `http://localhost:4000` on its own.
  baseUrl: process.env.PUBLIC_BASE_URL ?? `http://localhost:${Number(process.env.PORT ?? 4000)}`,

  // Dev-only override map ({"bob.test":"http://localhost:4001"}) so two
  // local instances can discover each other without real DNS/TLS. A real
  // deployment leaves this unset and discovery hits `https://{domain}`
  // directly.
  federationPeerOverrides: parsePeerOverrides(process.env.FEDERATION_PEER_OVERRIDES),

  // Optional. Unset (the default) means this process is the only replica of
  // this homeserver - presence and realtime delivery (server/src/ws/gateway.ts)
  // stay purely in-memory, exactly as before. Set this to run more than one
  // replica behind a load balancer: it backs cross-replica WebSocket fan-out
  // and fleet-wide presence tracking via Redis pub/sub instead.
  redisUrl: process.env.REDIS_URL,

  // Rate limiting (server/src/middleware/rateLimit.ts). Both windows are 15
  // minutes; these two env vars only tune the request *count* within that
  // window. The integration test suite raises these defaults way up (see
  // test/setupEnv.ts) so normal test traffic - e.g. a single file
  // registering a dozen users - never trips them; a couple of test files
  // override them back down to exercise the actual 429 behavior.
  rateLimitMax: Number(process.env.RATE_LIMIT_MAX ?? 300),
  authRateLimitMax: Number(process.env.AUTH_RATE_LIMIT_MAX ?? 10),

  // Where uploaded files (avatars, message attachments, emoticon images)
  // are stored - see server/src/lib/storage/. "disk" (the default) writes
  // to uploadsDir and serves them via /uploads, exactly as before this was
  // configurable. "s3" uploads to an S3-compatible bucket (AWS, MinIO,
  // Cloudflare R2, DigitalOcean Spaces, ...) instead - the right choice
  // for more than one server replica, since uploadsDir's local disk isn't
  // shared across replicas/nodes the way a bucket is.
  storageDriver,
  s3: {
    bucket: requiredForS3("S3_BUCKET"),
    region: requiredForS3("S3_REGION"),
    accessKeyId: requiredForS3("S3_ACCESS_KEY_ID"),
    secretAccessKey: requiredForS3("S3_SECRET_ACCESS_KEY"),
    // Required when storageDriver is "s3" - deliberately not derived from
    // bucket/region/endpoint, since the right public URL shape varies by
    // provider (plain AWS virtual-hosted-style, a CDN in front, an R2/
    // Spaces public bucket URL, a MinIO reverse proxy, ...) in a way that
    // can't be guessed correctly for all of them. No trailing slash, e.g.
    // "https://my-bucket.s3.us-east-1.amazonaws.com" or "https://cdn.example.com".
    publicUrlBase: requiredForS3("S3_PUBLIC_URL_BASE"),
    // Optional - only set for a non-AWS S3-compatible endpoint (MinIO,
    // R2, Spaces, ...). Unset means the AWS SDK talks to real AWS S3.
    endpoint: process.env.S3_ENDPOINT,
    // Optional - some S3-compatible providers (notably MinIO) need
    // path-style requests (https://host/bucket/key) instead of the
    // virtual-hosted-style AWS defaults to (https://bucket.host/key).
    forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? "false") === "true",
  },

  // Whether registration checks a new password against the Have I Been
  // Pwned breach corpus (server/src/lib/passwordBreachCheck.ts) - on by
  // default. Not a hard requirement: the check fails open (registration
  // proceeds) on any network error, timeout, or non-200 response, so an
  // outage of that external API - or a deployment with no outbound
  // internet at all - never blocks registration, just silently skips the
  // extra check for however long that lasts. Set to "false" to disable
  // outright, e.g. for an air-gapped deployment that doesn't want the
  // outbound call attempted at all.
  passwordBreachCheckEnabled: (process.env.PASSWORD_BREACH_CHECK_ENABLED ?? "true") === "true",
};
