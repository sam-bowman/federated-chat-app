import { rateLimit, type Options } from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import { config } from "../config.js";
import { getRateLimitRedisClient } from "../lib/redis.js";

// Keys on req.ip (via express-rate-limit's own default keyGenerator, which
// already normalizes IPv6 addresses - see ipKeyGenerator in its docs). A
// reverse-proxied production deployment needs its own correctly-scoped
// Express `trust proxy` setting for req.ip to reflect the real client
// rather than the proxy itself - that's NOT configured here, since picking
// a hop count without knowing the actual proxy topology would be its own
// security bug (trusting a spoofable X-Forwarded-For blindly). See
// README/CLAUDE.md for this documented limitation.
// `keyPrefix` must be distinct per limiter: generalLimiter and authLimiter
// both key on the same req.ip, and express-rate-limit's own
// ERR_ERL_DOUBLE_COUNT validation throws if two of its instances ever
// increment the exact same (store, prefixed key) pair for one request -
// which is exactly what stacking two limiters on the same auth request
// would do without each getting its own Redis key namespace.
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
});

// Stricter limit specifically in front of auth routes (login/register - the
// standard credential-stuffing/brute-force target), on top of the general
// limiter above.
export const authLimiter = makeLimiter("auth", {
  windowMs: 15 * 60 * 1000,
  limit: config.authRateLimitMax,
});
