# Security

> Part of the [documentation](../README.md#documentation).

## Reporting a vulnerability, and dependency updates

To report a vulnerability privately, see [SECURITY.md](../SECURITY.md) at the root of the repository. What the server trusts, and which control
answers each threat, is in the [threat model](threat-model.md).

Dependencies are kept current by Dependabot (`.github/dependabot.yml`, weekly, new releases wait five days). Updates come grouped, so there are few
pull requests: all minor and patch updates in one, all major updates in one (npm and cargo), and all base images in one, with a low
limit per kind. A major group that fails CI is split by hand. Held back on purpose: a new Node major (the project is on Node 22 everywhere) and a new Postgres or Redis
major in the compose files (a data migration, not a version bump). Every pull request, Dependabot's included, runs CodeQL,
`npm audit`, the dependency review and the secret scan.

## Image scanning

The published container images are scanned with [Trivy](https://trivy.dev) for known vulnerabilities in the operating-system packages
and in the application's own dependencies (`.github/scripts/scan-image.sh`; Trivy itself runs from a container image pinned by tag and
digest in `.github/trivy/Dockerfile`, which Dependabot keeps current, rather than from a third-party action).

| When | What is scanned | What happens on a finding |
|---|---|---|
| Before a release's tags are made (`publish-images.yml`) | each image just pushed, by digest | a **CRITICAL** finding with a fix stops the publish: no tag, `latest` included, points at it |
| A pull request that changes a Dockerfile, `package-lock.json` or the Prisma schema (`image-scan.yml`) | the image it would build | the check fails on the same rule (it is not a required check, so it informs and does not block the merge) |
| Every Monday, and by hand (`image-scan.yml`) | what is published as `latest` | the run fails on the same rule, and the job summary lists every fixable HIGH and CRITICAL finding |

Only findings that **have a fix** count: nobody can act on the others, and a rebuild cannot change them. HIGH findings are listed, not
failed on. The scan looks at known vulnerabilities in packages; it does not look at the application's own code (that is CodeQL), at
secrets (gitleaks) or at the configuration of a running server.

Why the weekly look matters: an image that was clean when it was released is not clean for ever, because vulnerabilities are found in
old packages. When it fails, the answer is a **release** (or a manual republish of the existing one: *Publish Docker images* ->
*Run workflow* on the release's tag), which rebuilds the images. The Dockerfiles run `apk upgrade`, so a rebuild picks up the
operating-system fixes released since the base image was made, and the server image has no npm (nothing in it runs it, and its bundled
packages are what scanners flag). The price of `apk upgrade` is that two builds of the same commit on different days are not byte for
byte the same.

**A finding you have looked at and accept** goes in `.github/trivy/trivyignore`: one id per line with a reason above it and an expiry
(`CVE-2026-0000 exp:2027-01-31`), so it comes back for a decision. Never ignore a package or a severity.

**Scanning the image you run:** `docker run --rm aquasec/trivy image --ignore-unfixed --severity HIGH,CRITICAL ghcr.io/sam-bowman/federated-chat-app-server:<your tag>`
(and `-client`). Following the project's releases is the way to get fixes; see [deployment/upgrading-and-backups.md](deployment/upgrading-and-backups.md).

## What is checked on every change

| Check | Kind | When | Stops a merge? |
|---|---|---|---|
| CodeQL | static analysis of the code | every pull request, and `master` | yes, on a High or higher alert |
| `npm audit` (High and above, dev dependencies too) | known-vulnerable dependencies | every pull request that changes code | yes |
| Dependency review | what a pull request adds or changes | every pull request | yes |
| Secret scan (gitleaks, plus GitHub's own push protection) | committed secrets | every pull request | yes |
| Image scan (Trivy) | known vulnerabilities in the container images | see [Image scanning](#image-scanning) | no, but it can stop a release |
| Dependabot | out-of-date dependencies | weekly | no (it opens grouped pull requests) |

None of these is a dynamic scan of a running server (DAST), a penetration test or a load test, and none replaces the targeted regression
tests described in [testing.md](testing.md).

**The workflows themselves are part of what is protected.** Every action they use is pinned to a full commit hash (a tag can be moved by
whoever controls that action's repository; a hash cannot), with the version in a comment so Dependabot can keep it current. The default
token of every workflow is read-only; a job that needs more (attaching files to a release, signing provenance, publishing an image) asks
for exactly that itself. Checkouts do not leave the token in the working copy. Each release's images and binaries get signed provenance and
a list of what is in them: see [deployment/verifying-releases.md](deployment/verifying-releases.md).

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

## The admin page and the audit log

The admin page ([guide](deployment/admin-ui.md)) is the most valuable thing on a server, so it is built to be invisible and hard to abuse:

- **Invisible.** Every admin route answers `404 not_found` (the same body as a path that does not exist) to a signed-out visitor, a wrong token,
  an ordinary account, a suspended or erased one, and when `ADMIN_ENABLED=false`. A server that has made no admin exposes nothing. Its rate
  limit sits *behind* that check, so a stranger can never get a 429 that no other path gives.
- **Only the operator's command makes an admin.** The flag cannot be set by the API (registration and the profile ignore it), so a stolen
  session cannot promote itself. Being able to run the command where the server runs is the authority.
- **Looked up on every request.** Taking the flag away, suspending or erasing the account ends admin access at once, not when the token's
  15 minutes run out.
- **Two-factor sign-in is required** of an admin before anything but "what is missing" answers.
- **Sudo mode for everything that changes something.** Suspending, setting a password, turning off 2FA, deleting, erasing and passing admin on
  each need a token from `POST /admin/sudo`, which is only given for the admin's **password and a code from their authenticator** (a code works
  once), lasts **ten minutes**, is kept in the page's memory only and names the admin it was made for. It is signed with a key derived from the
  server secret under its own label, so it cannot be an access token or a 2FA challenge, and none of those can be it. A hijacked admin session
  can read, but cannot act. The confirmation is behind the sign-in rate limit.
- **An admin account is protected from the page.** An account that is an admin can only be changed by taking admin away: suspending it, deleting
  it, setting its password or turning off its 2FA is the command's alone, and an admin can do nothing to themselves, so **the last admin can never
  be removed from the page** and an admin whose session was taken cannot lock out or take over the others. The first admin is made only by the command.
- **Metadata only.** No message, direct message, attachment, password hash, 2FA secret or token is readable through it.

The audit log ([guide](deployment/audit-log.md)) is append-only through the app: nothing edits or deletes an entry except retention
(`AUDIT_LOG_RETENTION_DAYS`) and the removal of a person's name when their account is erased. It records ids and short labels, never
what anyone wrote, and a failure to write an entry is logged loudly but never undoes the action.

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
