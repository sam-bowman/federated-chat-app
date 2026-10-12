# Security

> Part of the [documentation](../README.md#documentation).

## Rate limiting

Every route under `/api/v1` and `/federation/v1` sits behind a general limiter
(300 requests/15 min per client), with a stricter one (10 requests/15 min)
layered on top of `/api/v1/auth` specifically (login/register - the standard
brute-force target). Both key on the client's IP address. With `REDIS_URL` set
(see "Running multiple replicas" in [scaling.md](scaling.md#running-multiple-replicas)), the limiter counters live in Redis so
a fleet of replicas shares one budget per client instead of each replica
enforcing its own independent one; without it, each process tracks its own
counters in memory, correct for a single-replica deployment.

**Known limitation**: keying on `req.ip` only reflects the real client when
Express's `trust proxy` setting is configured correctly for your deployment's
actual proxy topology - which this project does not set. Running behind a
reverse proxy or load balancer without `trust proxy` configured means every
request appears to come from the proxy's own IP, collapsing the rate limit
down to one shared budget for all your users combined. This is deliberate,
not an oversight: guessing a hop count without knowing the real proxy chain
would mean blindly trusting a spoofable `X-Forwarded-For` header, which is its
own security bug. If you deploy behind a proxy, set `app.set("trust proxy",
<your topology>)` yourself - see [Express's own
docs](https://expressjs.com/en/guide/behind-proxies.html).

## Password policy

New registrations require at least 8 characters, with an uppercase letter, a
lowercase letter, a number, and a symbol. Existing accounts can still log in
with a weaker password - only new registrations are held to this.

New passwords are also checked against the [Have I Been
Pwned](https://haveibeenpwned.com/Passwords) breach corpus, via its
k-anonymity range API: only the first 5 hex characters of the password's
SHA-1 hash are ever sent, never the password or its full hash. This check
fails open - a network error, timeout, or non-200 response from that API
never blocks registration, it just silently skips the extra check for that
request. Set `PASSWORD_BREACH_CHECK_ENABLED=false` to disable the outbound
call outright (e.g. for an air-gapped deployment).

## Two-factor authentication

Optional TOTP (RFC 6238) 2FA, compatible with any standard authenticator app
(Google Authenticator, Authy, 1Password, ...) - enable it from Settings.

- **Setup**: scan the QR code (or enter the secret manually), then confirm
  with a code from the app. 10 one-time recovery codes are shown once - save
  them somewhere safe. They're for signing in if you lose access to the
  authenticator app; each can only be used once.
- **Login**: with 2FA enabled, `POST /auth/login` returns a short-lived
  challenge token instead of real tokens. `POST /auth/2fa/login` redeems it
  with a code (or a recovery code) for the real access/refresh tokens. The
  challenge token is signed with a key *derived* from the server's JWT
  secret, not the secret itself - it can never be mistaken for, or reused
  as, a real access token.
- **Enrolling and disabling both require re-entering your password**, not
  just your existing session - otherwise a hijacked access token could
  enable 2FA with an attacker-only secret (locking you out) or disable your
  real protection outright, neither of which should be possible without the
  password.
- Codes allow +-30s of clock drift between your phone and the server (RFC
  6238's recommended tolerance), and a used code (or recovery code) can't be
  reused within its own still-valid window.
