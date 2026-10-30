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

The dynamic scan (below) runs weekly. None of these is a penetration test or a load test, and none replaces the targeted regression tests
described in [testing.md](testing.md).

**The workflows themselves are part of what is protected.** Every action they use is pinned to a full commit hash (a tag can be moved by
whoever controls that action's repository; a hash cannot), with the version in a comment so Dependabot can keep it current. The default
token of every workflow is read-only; a job that needs more (attaching files to a release, signing provenance, publishing an image) asks
for exactly that itself. Checkouts do not leave the token in the working copy. Each release's images and binaries get signed provenance and
a list of what is in them: see [deployment/verifying-releases.md](deployment/verifying-releases.md).

## Dynamic scanning (DAST)

`dast.yml` attacks a **throwaway copy of the app** with [OWASP ZAP](https://www.zaproxy.org) (pinned by tag and digest in
`.github/zap/Dockerfile`, run from its container image like the image scanner). `.github/scripts/dast.sh` does the work, and can be run
on a machine with Docker:

```bash
SERVER_IMAGE=my-server:test CLIENT_IMAGE=my-client:test bash .github/scripts/dast.sh zap-out
```

It runs every Monday, by hand, and on a pull request that changes the scan itself. It is **not** a required check (it is slow, and a new
ZAP rule would otherwise block unrelated work), and it fails only on a **HIGH risk** alert that is not accepted in `.github/zap/ignore`
(a rule id, a reason and an expiry, like the image scanner's). Medium and low alerts are listed in the run's summary and kept, with the
HTML reports, as an artifact for two weeks.

**What it does.** It starts the server and client images against an empty database with the rate limits raised (or the scan would be
answered `429` for most of its run), makes two people, a community, a role, an invite, a direct chat and a message through the real API,
and then:

1. **API scan:** imports `docs/api/openapi.yaml` (about a hundred operations, each path parameter given a real id from the step above;
   without it every `{id}` becomes the word "id" and the scan only ever sees `400`), signs in as the first person, an ordinary account, and
   runs ZAP's passive and active scan for up to 15 minutes.
2. **Web client scan:** ZAP's passive baseline scan of the client served by nginx.

**What it does not cover.** Be clear about this when reading a green run:

- One ordinary account. The admin routes answer `404` to it, which is the right answer and all the scan sees of them; **whether one person
  can reach another's data** (access control) is not something a scanner can know, and is what the integration tests are for.
- The federation protocol (`/federation/v1`), the WebSocket, voice, and anything that needs a second server.
- A server with data in it, with a proxy in front, or with link previews, S3 or Redis on.
- It is not a penetration test, and it finds nothing a rule does not describe.

**A scan that tests nothing looks exactly like a clean one**, so the script checks its own work: it fails if fewer than 100 operations were
imported, and the setup was checked once against a server that logs every request it gets (all of ZAP's requests carried the
`Authorization` header, and the paths had real ids). ZAP's `zap-api-scan.py` with its `-z` option for adding that header did not: it sent
no request to the target at all and still reported a clean scan. That is why the API scan is an Automation Framework plan. Never point this
at a server that is not the throwaway one the script starts: the API scan sends attacks, and creates and deletes things.

**What the first run found** (2026-10-22, run locally; the scheduled run will show the current state):

- Two **real defects in the API, now fixed**: `GET /sync` with a cursor that is not a whole number (or a limit that is not one) answered
  `500`, and a file upload with a body that stops in the middle answered `500`; both are `400` now, with tests.
- `Cross Site Scripting Weakness (Persistent in JSON Response)`, low confidence: the API returns the text people stored (a community name
  of `<script>alert(1);</script>`), as JSON. That is by design: the content type is JSON, not HTML, and the client renders every stranger's
  text as text (see the [threat model](threat-model.md)). Not a defect, and not accepted by an entry, since only HIGH can fail.
- The web client sent none of the browser-hardening headers (a Content-Security-Policy, anti-clickjacking, `nosniff`, ...), two of them
  rated Medium. Fixed in [#281](https://github.com/sam-bowman/federated-chat-app/issues/281); see "Browser security headers" below. The
  scan still lists two Medium alerts about the policy's two deliberate trade-offs, and a Low one for `Cross-Origin-Embedder-Policy`.

## Browser security headers

The client image's nginx (the Docker image, and so the Helm chart) sends these on **every** response, including a 404 and a `304`. So does the
**native client binary** (`client/src/bin/requestHandler.ts`), from the **same generator**, so the two cannot differ. The **desktop app** has a policy
of its own, [below](#the-desktop-app).

| Header | Value | Why |
|---|---|---|
| `Content-Security-Policy` | see below | stops a script that was injected from running |
| `X-Frame-Options`, and `frame-ancestors 'none'` in the policy | `DENY` | nothing may embed the client in a page of its own (clickjacking) |
| `X-Content-Type-Options` | `nosniff` | a file is what its type says it is |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | other sites get this site's address, not the page you were on |
| `Permissions-Policy` | the microphone for this site only; no camera, location, screen capture, USB, serial, Bluetooth or payment | voice calls are the only thing that asks |
| `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy` | `same-origin` | a page opened from here cannot reach back, and others cannot embed these files |
| `Server` | `nginx` (no version) | |

**The policy** is `script-src 'self'` plus the **hashes** of the page's two inline scripts (the one that sets the size before the first
paint, and the one that reloads the page when a build's files disappear during an upgrade). There is no `unsafe-inline` and no
`unsafe-eval` for scripts, so a script that gets into the page through someone's text cannot run. The hashes are made in the image build
from the `index.html` that was just built (`client/scripts/security-headers.mjs`), so a changed script gets a new hash by itself, and the
policy can never name one that is not there. Styles are the same: `style-src 'self'`, with **no `unsafe-inline`** (see below). The rest: images,
media and connections to `https:`, `http:` and (for connections) `wss:` and `ws:`; and `object-src`, `frame-src`, `frame-ancestors` `'none'`, `base-uri` and `form-action` `'self'`.

**One thing in it is looser than it could be, on purpose**, and the dynamic scan lists it as a Medium alert:

- **`https:` and `wss:` for connections, pictures and media.** The client is pointed at whichever server a person types, shows pictures from
  other people's servers, and joins a voice server whose address the home server supplies at run time, so none of those can be named. The
  script rule above is what does the protecting.

**Styles need no `unsafe-inline`** (#299; it was there until then, on the belief that React's inline `style` props required it). A policy does
not restrict what script does through the CSSOM (`element.style.color = ...`, `style.setProperty(...)`), which is how React applies `style={{ ... }}`
and how the page's own inline script sets the UI scale. What `style-src 'self'` refuses is a `style` attribute or a `<style>` element that
arrives as **markup** (the HTML parser, `innerHTML`, `setAttribute("style", ...)`): the way CSS is injected to hide or restyle the page, or to read
an attribute out through a selector. Tried before it was changed: the whole end-to-end suite against the built image with it enforced (voice
calls through a real LiveKit included, where `closeAll` fails a test on any refusal) passes; a probe in the same browser showed the CSSOM write
applying and the markup `style` attribute, `innerHTML` style and `<style>` element all refused; and the built bundle has no `<style>` element
creation and no markup `style` (the only `style="` text is in a QR-code library's table output, which the app does not use: it uses the SVG
one, which has none). A new dependency or a `dangerouslySetInnerHTML` that builds markup with `style="..."` would now be refused: the end-to-end
suite reports it, and `.github/scripts/check-desktop-app.mjs` checks both halves in the real desktop app.

**Not sent**: `Cross-Origin-Embedder-Policy` (`require-corp` would block pictures from every server that does not send a resource policy)
and `Strict-Transport-Security`. HSTS is for your **reverse proxy or ingress**, the part that terminates TLS, to send (the image and the
binary are plain HTTP and do not know whether the person is on HTTPS); if it also sets a Content-Security-Policy of its own, the browser
applies both and the stricter wins for each directive.

### The desktop app

The desktop app draws the same page from its own origin (`http://tauri.localhost` on Windows), so it has a policy of its own in
`client/src-tauri/tauri.conf.json`: the web client's, with the differences it needs, and nothing else. `script-src` is `'self'` only (Tauri adds
the hash of each inline script of the page, and its own, when it builds, so the page's two are named by hash as on the web); and `connect-src`
adds `ipc:` and `http://ipc.localhost`, which is how the page calls Tauri (without it notifications, updates and the restart after one fail,
and nothing says why). There is no `frame-ancestors` (the app is not a page anyone can embed). `client/src/tauriCspGuard.test.ts` says which
directives differ and fails if the two drift apart.

**Tried in a real build on Windows** (`.github/scripts/check-desktop-app.mjs`, which runs the built app and attaches to its window): the page
draws, the inline script that sets the UI scale before the first paint runs, a call to Tauri works, a server over plain http can be reached,
and a script the page injects, one from a `data:` address, a frame and a `style` attribute that arrives as markup are all refused, while a style
written through the CSSOM (what React does) applies and the page is styled (#299). The same check against the old configuration
(`"csp": null`) fails on six counts. **Not tried on macOS or Linux**, which draw in other engines with no way to attach to the window; the
policy is the same text there, but nobody has run it, so whether those platforms need other sources for Tauri's calls is not known.

**How it is kept honest.** A pull request that touches the image runs the built client and checks every kind of response for every header,
and that the policy names exactly the inline scripts of the page it is served with (`.github/scripts/check-client-headers.mjs`). The same
check runs on the built **binary** (`client-binary.yml`, and before every release on all three systems). The **desktop app** has a guard test
(`client/src/tauriCspGuard.test.ts`) in CI, and its real policy is checked **by hand** on a Windows machine
(`.github/scripts/check-desktop-app.mjs`), because GitHub's hosted Windows runners could not be attached to (see
[testing.md](testing.md#security-checks-and-what-each-one-is-for)). The
end-to-end tests fail when the browser refuses anything under the policy (see [testing.md](testing.md#running-the-end-to-end-tests-against-the-built-client)).
That second check found a real bug: the build ran on Windows files with CR LF line endings, and a hash taken from that text never matches,
because a browser turns CR LF into LF before it hashes a script. The generator now does the same, with a test.

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

## Reports

A report ([design](content-reports.md)) is the one place the server keeps what someone wrote **on purpose, for review**, so it is limited and
temporary: a snapshot cut to a size and cleaned of characters that could reorder or hide text, kept for `REPORT_RETENTION_DAYS` days (180 by
default) whatever its state, replaced by a marker when the reported person's account is erased. **The person reported is never told**: no
event, no field on anything they can read, no audit entry for the report being made, and a reviewer who is the person reported does not see
it. What a report reaches depends on what it is about (a message in a community: its moderators and the admins; a direct message, a person
or a community: the admins alone), and a report cannot be used to probe, flood or harass: only what you can see can be reported (anything
else is a `404`), once per thing, 10 an hour and 30 open per person, counted in the database.

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
