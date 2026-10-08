// Loaded as a Vitest `setupFiles` entry for the integration suite, which
// guarantees this runs - and these env vars are set - before any test file
// (and transitively, src/config.ts) is imported. Deliberately has NO other
// imports of its own, so nothing here can trigger config.ts to load before
// these assignments run.
//
// CI sets its own values for these (see .github/workflows/ci.yml); `??=`
// here only fills in defaults for running `npm run test:integration` on a
// local dev machine against the chat_test database (see README "Testing").
process.env.SERVER_DOMAIN ??= "test.local";
process.env.SERVER_NAME ??= "Test Server";
process.env.DATABASE_URL ??= "postgresql://chat:chat@localhost:5433/chat_test";
process.env.JWT_ACCESS_SECRET ??= "test-access-secret";
process.env.JWT_REFRESH_SECRET ??= "test-refresh-secret";
process.env.REGISTRATION_ENABLED ??= "true";
process.env.UPLOADS_DIR ??= "test-uploads";
process.env.CORS_ORIGIN ??= "http://localhost:5173";
process.env.PUBLIC_BASE_URL ??= "http://localhost:4000";
// Only read by tests that specifically exercise Redis-backed fan-out
// (test/integration/presenceFanout.test.ts) - every other integration test
// runs with REDIS_URL unset, exactly like a single-replica deployment.
// Raised way above the production defaults (300 / 10 - see src/config.ts)
// so ordinary test traffic within one file (e.g. conversations.test.ts
// registering a dozen users) never trips rate limiting incidentally.
// test/integration/rateLimit.test.ts and rateLimit.redis.test.ts override
// these back down to actually exercise the 429 behavior.
process.env.RATE_LIMIT_MAX ??= "100000";
process.env.AUTH_RATE_LIMIT_MAX ??= "100000";
