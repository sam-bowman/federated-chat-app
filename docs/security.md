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

**Behind a reverse proxy, set `TRUST_PROXY`.** Keying on `req.ip` only reflects the real
client when Express is told how many proxies sit in front of it. Without that, every request appears to come from the
proxy's own address, which collapses the rate limit to **one shared budget for all your users combined**: ten
logins by anyone lock everyone else out for 15 minutes (reproduced behind Traefik on Kubernetes, see
[the Kubernetes guide](deployment/kubernetes.md#everyone-gets-429-too-many-requests-after-a-few-logins)).

`TRUST_PROXY` (releases after `0.9.0`; `server.trustProxy` in the Helm chart) is:

- unset or `0` (the default): no proxy is trusted and `X-Forwarded-For` is ignored, correct when clients connect
  to the server directly;
- a number of hops, e.g. `1` for a single ingress controller or reverse proxy in front of the server;
- or a comma-separated list of the proxies themselves: `loopback`, `linklocal`, `uniquelocal`, IP
  addresses, or CIDR ranges.

It is deliberately strict. `true` and catch-all ranges (`0.0.0.0/0`) are refused at startup, because believing an
`X-Forwarded-For` that a client can set lets that client choose its own rate-limit identity. Count the hops
honestly: a load balancer in front of an ingress controller is two. Setting it correctly was checked behind Traefik:
different clients got separate budgets, and rotating a forged header did not evade the limit.

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
