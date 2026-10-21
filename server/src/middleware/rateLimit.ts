import { rateLimit, type Options } from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import { config } from "../config.js";
import { getRateLimitRedisClient } from "../lib/redis.js";

// Keys on req.ip (via express-rate-limit's own default keyGenerator, which
// already normalizes IPv6 addresses - see ipKeyGenerator in its docs). Behind a
// reverse proxy req.ip is only the real client when the TRUST_PROXY setting
// (config.trustProxy -> app.set("trust proxy") in app.ts) matches the actual proxy
// topology; it is deliberately off by default, because picking a hop count
// without knowing the topology would mean trusting a spoofable X-Forwarded-For.
// See docs/security.md ("Rate limiting").
// `keyPrefix` must be distinct per limiter: generalLimiter and authLimiter
// both key on the same req.ip, and express-rate-limit's own
// ERR_ERL_DOUBLE_COUNT validation throws if two of its instances ever
// increment the exact same (store, prefixed key) pair for one request -
// which is exactly what stacking two limiters on the same auth request
// would do without each getting its own Redis key namespace.
/** Where LiveKit posts its webhooks (mounted in app.ts). */
export const VOICE_WEBHOOK_PATH = "/api/v1/voice/webhook";

function makeLimiter(keyPrefix: string, options: Partial<Options>) {
  const redisClient = getRateLimitRedisClient();
  return rateLimit({
    standardHeaders: true,
    legacyHeaders: false,
    store: redisClient
      ? new RedisStore({
          prefix: `rl:${keyPrefix}:`,
          sendCommand: (...args: string[]) => {
            const [command, ...rest] = args;
            return redisClient.call(command, ...rest) as ReturnType<RedisStore["sendCommand"]>;
          },
        })
      : undefined,
    ...options,
  });
}

// Covers every route mounted under /api/v1 and /federation/v1 (all 49
// originally-flagged js/missing-rate-limiting routes) with one middleware,
// mounted once in app.ts right before those mounts. /healthz and the
// wellknown router aren't behind this - neither was flagged, and the
// wellknown document needs to stay reachable for the home-server picker.
export const generalLimiter = makeLimiter("general", {
  windowMs: 15 * 60 * 1000,
  limit: config.rateLimitMax,
  // The voice server's webhook comes from ONE address (LiveKit) and is busy on a busy server: counted like a person, it
  // would shut itself out and everyone's "who is in the channel" would go stale. It proves who it is by a signature
  // over the body, checked before anything is read or written.
  skip: (req) => req.method === "POST" && req.path === VOICE_WEBHOOK_PATH,
});

// The admin API (#206), counted only for people who are admins (it sits behind requireAdmin): were it in front, anyone could tell the page
// exists by getting a 429 on it that no other path gives.
export const adminLimiter = makeLimiter("admin", {
  windowMs: 15 * 60 * 1000,
  limit: config.adminRateLimitMax,
});

// Stricter limit specifically in front of auth routes (login/register - the
// standard credential-stuffing/brute-force target), on top of the general
// limiter above.
export const authLimiter = makeLimiter("auth", {
  windowMs: 15 * 60 * 1000,
  limit: config.authRateLimitMax,
});
