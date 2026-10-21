// Loaded as a Vitest `setupFiles` entry for the integration suite, which
// guarantees this runs - and these env vars are set - before any test file
// (and transitively, src/config.ts) is imported. Deliberately has NO other
// imports of its own, so nothing here can trigger config.ts to load before
// these assignments run.
//
// CI sets its own values for these (see .github/workflows/ci.yml); `??=`
// here only fills in defaults for running `npm run test:integration` on a
// local dev machine against the chat_test database (see docs/testing.md "Testing").
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
// bcrypt's minimum work factor (production default 12, see src/lib/bcryptRounds.ts). The suite
// registers hundreds of users and at cost 12 the pure-JS bcryptjs spends a large part of its time
// hashing; the tests are about routes, not about how hard a password is to crack.
// test/integration/passwordHashing.test.ts pins what each setting really does.
process.env.BCRYPT_ROUNDS ??= "4";
// Production waits 500 ms, then 1000 ms, between the 3 attempts of one outbound federation call. Nearly every
// federation test sends to a fake peer that is never reachable, so that was a flat 1.5 s of sleeping per
// delivery; the tests are about what happens after the failure, not about the waiting itself.
process.env.FEDERATION_RETRY_BASE_MS ??= "1";
process.env.AUTH_RATE_LIMIT_MAX ??= "100000";
process.env.ADMIN_RATE_LIMIT_MAX ??= "100000";
// Off by default - the production default is "true", but an outbound call
// to the real Have I Been Pwned API on every one of the suite's many
// registerUser() calls would make the whole suite slow and dependent on
// external network access. authPasswordPolicy.test.ts overrides this back
// to "true" (with a mocked fetch) to actually exercise that path.
process.env.PASSWORD_BREACH_CHECK_ENABLED ??= "false";
