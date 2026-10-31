import dotenv from "dotenv";
import { dirname, isAbsolute, join } from "node:path";
import { isSea } from "node:sea";
import { parseBcryptRounds } from "./lib/bcryptRounds.js";
import { parseFederationOutboxTimeoutMs, parseFederationRetryBaseMs } from "./lib/federationRetry.js";
import { parseFederationEnabled } from "./lib/federationEnabled.js";
import { parseRegistrationInviteOnly } from "./lib/registrationInviteOnly.js";
import { parseAccountDeletionGraceDays } from "./lib/accountDeletionGrace.js";
import { parseAdminEnabled } from "./lib/adminEnabled.js";
import { parseAuditRetentionDays } from "./lib/auditRetention.js";
import { parseReportRetentionDays } from "./lib/reports.js";
import { parseLinkPreviewsEnabled } from "./lib/linkPreview/setting.js";
import { parseVoiceConfig } from "./lib/voiceConfig.js";
import { createDomainPolicy, parseDomainList } from "./lib/federationPolicy.js";
import { parseUserDiscoverability } from "./lib/userDiscoverability.js";
import { parseDirectoryEnabled } from "./lib/directorySetting.js";
import { parseDirectoryPeople } from "./lib/directoryPeople.js";
import { parseContactPolicySetting } from "./lib/contactPolicy.js";
import { checkVisibilityDefault, effectiveVisibility, parseVisibilitySetting } from "./lib/communityVisibility.js";
import { parseCorsOrigins } from "./lib/corsOrigins.js";
import { parseTrustProxy } from "./lib/trustProxy.js";

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
// `quiet`: dotenv 17 and later print "injected env (N) from .env" to stdout on every load, which would head every server log and the
// output of the admin command (read by people and by scripts).
dotenv.config({ path: isSea() ? join(installDir, ".env") : process.env.DOTENV_CONFIG_PATH, quiet: true });

// (Until Prisma 7 a packaged binary had to be pointed at the native query engine file shipped beside it, PRISMA_QUERY_ENGINE_LIBRARY: there
// is no engine now, the client is plain JavaScript over the pg driver, and the whole server is in the one executable.)

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

// A server's defaults and limits for the choices its people and communities make (#189), each strict like the other settings. A LIMIT
// can only narrow what a person or community chose, never widen it; a DEFAULT is only what a new account or community starts with.
const communityVisibilityLimit = parseVisibilitySetting("COMMUNITY_VISIBILITY_LIMIT", process.env.COMMUNITY_VISIBILITY_LIMIT, "PUBLIC");
// Unset, new communities start where they always did (unlisted) or, if the limit is narrower than that, at the limit.
const communityVisibilityDefault = parseVisibilitySetting(
  "COMMUNITY_VISIBILITY_DEFAULT",
  process.env.COMMUNITY_VISIBILITY_DEFAULT,
  effectiveVisibility("UNLISTED", communityVisibilityLimit)
);
checkVisibilityDefault(communityVisibilityDefault, communityVisibilityLimit);

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
  // Registration needs an invite code (made with the registration-invites command). Strict: a typo refuses startup (lib/registrationInviteOnly.ts).
  registrationInviteOnly: parseRegistrationInviteOnly(process.env.REGISTRATION_INVITE_ONLY),
  // The admin page and its API (/admin, /api/v1/admin/*, #206): on unless switched off, and exposing nothing until the command line makes an admin. Strict (lib/adminEnabled.ts).
  adminEnabled: parseAdminEnabled(process.env.ADMIN_ENABLED),
  // Days the audit log keeps an entry (#59); 0 keeps them for ever. Strict (lib/auditRetention.ts).
  auditLogRetentionDays: parseAuditRetentionDays(process.env.AUDIT_LOG_RETENTION_DAYS),
  // Days a content report, with the snapshot of what was reported, is kept (#58); 0 keeps them for ever. Strict (lib/reports.ts).
  reportRetentionDays: parseReportRetentionDays(process.env.REPORT_RETENTION_DAYS),
  // Days an account waits, after its owner asks to delete it, before it is erased (#60). Strict (lib/accountDeletionGrace.ts).
  accountDeletionGraceDays: parseAccountDeletionGraceDays(process.env.ACCOUNT_DELETION_GRACE_DAYS),
  // Whether this server reads the pages linked in messages to show a preview card (#197). Off unless asked for; strict (lib/linkPreview/setting.ts).
  linkPreviewsEnabled: parseLinkPreviewsEnabled(process.env.LINK_PREVIEWS_ENABLED),
  // Voice channels: where the LiveKit server is, all or nothing (lib/voiceConfig.ts). Off unless LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET are all set.
  voice: parseVoiceConfig(process.env),
  uploadsDir: resolveUploadsDir(process.env.UPLOADS_DIR ?? "uploads"),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 8 * 1024 * 1024),
  // Comma-separated list of allowed browser origins; see lib/corsOrigins.ts.
  corsOrigins: parseCorsOrigins(process.env.CORS_ORIGIN ?? "http://localhost:5173"),

  // How many reverse proxies / load balancers sit in front of this server; see
  // lib/trustProxy.ts. false (the default) trusts none.
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
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

  // Whether this server talks to other homeservers at all (default true). False makes it private: it advertises that in
  // its discovery document, refuses every /federation/v1 request, sends nothing and starts no relationship with anyone
  // on another server; what already exists is kept and picks up again if it is turned back on. See
  // lib/federationEnabled.ts (strict on purpose) and docs/deployment/private-server.md.
  federationEnabled: parseFederationEnabled(process.env.FEDERATION_ENABLED),

  // Which other servers this one talks to (default: all of them). FEDERATION_ALLOWED_DOMAINS limits it to those servers,
  // FEDERATION_BLOCKED_DOMAINS excludes those; a server that is not permitted is neither contacted nor answered, and
  // what already exists with it is kept and waits. Strict on purpose: see lib/federationPolicy.ts and
  // docs/deployment/private-server.md.
  federationPolicy: createDomainPolicy(
    parseDomainList("FEDERATION_ALLOWED_DOMAINS", process.env.FEDERATION_ALLOWED_DOMAINS),
    parseDomainList("FEDERATION_BLOCKED_DOMAINS", process.env.FEDERATION_BLOCKED_DOMAINS)
  ),

  // Whether the people on this server can be found by servers they have no relationship with: default-on (people can hide;
  // new accounts are findable), default-off (new accounts start hidden) or forced-off (nobody is findable). Each person's own
  // setting can only narrow this. Strict on purpose: see lib/userDiscoverability.ts and docs/deployment/private-server.md.
  userDiscoverability: parseUserDiscoverability(process.env.FEDERATION_USER_DISCOVERABILITY),

  // Whether this server publishes a directory of its PUBLIC communities and the people who chose to be listed, for its own people
  // and, through their servers, others to browse. Off by default (nothing is published until the operator says so). Strict on
  // purpose: see lib/directorySetting.ts and docs/deployment/private-server.md.
  directoryEnabled: parseDirectoryEnabled(process.env.DIRECTORY_ENABLED),

  // Whether the people on this server are listed in that directory: each person chooses and starts unlisted (default-off), or new
  // accounts start listed (default-on), or nobody is listed (forced-off). See lib/directoryPeople.ts.
  directoryPeople: parseDirectoryPeople(process.env.DIRECTORY_PEOPLE),

  // Who may start something with the people here (lib/contactPolicy.ts): what new accounts start with, and the widest anyone may
  // be (a person's own choice can only narrow it; ANYONE is no limit). See docs/deployment/private-server.md.
  contactPolicyDefault: parseContactPolicySetting("FEDERATION_CONTACT_POLICY_DEFAULT", process.env.FEDERATION_CONTACT_POLICY_DEFAULT, "ANYONE"),
  contactPolicyLimit: parseContactPolicySetting("FEDERATION_CONTACT_POLICY_LIMIT", process.env.FEDERATION_CONTACT_POLICY_LIMIT, "ANYONE"),

  // Who may join the communities hosted here (lib/communityVisibility.ts): what a new community starts with, and the most exposed to
  // other servers any may be (PUBLIC is no limit; a community set wider behaves as the limit).
  communityVisibilityDefault,
  communityVisibilityLimit,

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
  // The admin API (/api/v1/admin/*), counted only for people who are admins: see middleware/rateLimit.ts.
  adminRateLimitMax: Number(process.env.ADMIN_RATE_LIMIT_MAX ?? 300),
  // Base delay between the in-request retries of one outbound federation call (it waits 1x, then 2x this
  // between its 3 attempts). 500 ms in production; the test suite sets it to 1 so a delivery to an
  // unreachable fake peer, which every federation test has, does not cost 1.5 s of sleeping each time.
  federationRetryBaseMs: parseFederationRetryBaseMs(process.env.FEDERATION_RETRY_BASE_MS),
  // How long one outbox delivery attempt waits for the peer to answer (default 10 s).
  federationOutboxTimeoutMs: parseFederationOutboxTimeoutMs(process.env.FEDERATION_OUTBOX_TIMEOUT_MS),
  // Work factor for new password hashes. Default 12; see lib/bcryptRounds.ts for why it is configurable at all.
  bcryptRounds: parseBcryptRounds(process.env.BCRYPT_ROUNDS),

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

// What the security-relevant settings were in the environment at the moment
// `config` above read them. required() applies its fallback silently, so
// config.domain / config.jwt*Secret alone cannot say whether the operator set
// them, and re-reading process.env later is not the same thing (a value that
// appears after this module settled on its fallbacks would read as "set"
// though the server is not using it). startupChecks.ts judges this snapshot,
// so it describes what the server is really running with.
export const configuredEnv = {
  BCRYPT_ROUNDS: process.env.BCRYPT_ROUNDS,
  SERVER_DOMAIN: process.env.SERVER_DOMAIN,
  JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET,
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET,
};
