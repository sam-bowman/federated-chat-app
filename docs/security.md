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

Passwords are stored as bcrypt hashes with a work factor of 12; each extra
round doubles the time someone holding a copy of the database needs per guess.
`BCRYPT_ROUNDS` (4 to 31) changes it for *new* hashes, and existing ones keep
verifying because the cost is stored in the hash. Leave it unset: it exists so
the test suite can hash quickly, and a server started as a deployment
(`NODE_ENV=production` or a packaged binary) refuses a value below 10 unless
`ALLOW_INSECURE_DEFAULTS=true`.

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

## Deleting accounts

Deleting an account ([guide](deployment/account-deletion.md)) is the most destructive thing a person can do, so it is hard to do by accident
or from a stolen session:

- Asking needs the **password**, the **username typed out**, and a **code** (or recovery code) when two-factor sign-in is on, and is behind
  the sign-in rate limit. A stolen access token alone is not enough.
- Nothing is erased at once: the sessions end and a **grace period** (14 days by default) starts, in which signing in cancels it. A
  stolen password alone does not cancel a request on an account with two-factor sign-in (the second step does).
- The username is **reserved for ever**, so nobody can register it and be mistaken for the person.
- Another server may only make this server forget a person if it is **that person's own server** (the signed origin is compared with the
  home server cached for them), and it can never name an account on this server.
- What is erased is the person's own data. Backups taken earlier are not touched, and the guide says so.

## Link previews

Off by default (`LINK_PREVIEWS_ENABLED`, [guide](deployment/link-previews.md)). It is the one feature where the server makes a
request to an address a person typed, so it is built as an SSRF-resistant fetcher:

- Every address and every redirect hop is checked first: `http`/`https` only, ports 80 and 443 only, no credentials in the
  address, no `localhost` or private, loopback, link-local or otherwise internal IP (IPv4 or IPv6) - whether written as a
  literal or *resolved* from a name. The connection is made to the address that was checked (a custom DNS lookup), so a name
  that answers differently a second time (DNS rebinding) gets nothing.
- At most 3 redirects, 5 seconds in all, 256 KiB read, HTML content types only, no compression (so a small download cannot
  inflate into a large one).
- Rate limited per person (20 reads per 10 minutes) and per server (600 per hour, 4 at once), and results are cached, so a
  person cannot use the server as a request cannon.
- Only the server that accepted a message reads its links. Other servers are *told* the result and treat it as untrusted text
  from a stranger: they re-validate every field, cap lengths, strip control and bidirectional characters, accept only plain
  `http(s)` addresses, and never fetch anything themselves.
- The cards are text only and a link in one always shows the address's real host beside the page's own words. No picture is
  fetched or proxied, so reading a message never contacts the linked site.
