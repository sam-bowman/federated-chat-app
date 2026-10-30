# Threat model

> Part of the [documentation](../README.md#documentation). For how to report a problem, see [SECURITY.md](../SECURITY.md); for the
> controls in detail, [security.md](security.md) and [federation-architecture.md](federation-architecture.md).

This page is for someone deciding whether to run a server, or reviewing the project: **who and what is trusted, what is not, and which
control (and which test) answers each threat.** It is a map of decisions already made in the code, not a guarantee. Where something is
not defended, or is not defended yet, it says so in [What is not covered](#what-is-not-covered).

## What is protected

| Asset | Where it lives |
|---|---|
| Accounts: password hashes, two-factor secrets and recovery codes, sessions | the PostgreSQL database |
| Messages, direct messages, community structure and roles | the database |
| Uploaded files (pictures, attachments, emoticons) | the uploads volume, or the S3 bucket |
| The server's **federation signing key** (its identity to other servers) | the database (`ServerIdentity`) |
| The server's secrets: the two JWT secrets, the LiveKit key and secret, S3 keys, the database URL | the environment (`.env`, a Kubernetes Secret) |
| Backups of all of the above | wherever the operator puts them |

## Who is trusted, and who is not

**Trusted (the project cannot defend against these):**

- **The operator, and whoever can run commands where the server runs.** They can read the database, so they can read every message:
  there is **no end-to-end encryption**. The [admin command](deployment/admin-cli.md) talks to the database directly, so running it *is* the
  authority; the admin web page is built on the same service and adds sign-in, two-factor and sudo mode on top.
- **The host, the database, the reverse proxy and the voice server (LiveKit) the operator runs.** `TRUST_PROXY` must be set to describe the
  proxy truthfully, or every visitor shares one rate-limit bucket.

**Not trusted (everything below is treated as hostile input):**

- **Other servers (peers) and their users.** Federation is open: any server can talk to yours.
- **Every person on your own server**, for anything that crosses to someone else: their text, display names, pronouns, status, pictures,
  emoticons and links.
- **Uploaded files, and the pages that links in messages point to.**
- **Anyone on the network**, before they have signed in.

## Threats, controls, and where they are checked

| Threat | Control | Checked by |
|---|---|---|
| **A server pretends to be another server** | Federation requests are signed with the sending server's key and carry a nonce (replays are refused). The claimed origin is judged before any lookup is made, so a forged origin cannot make the server fetch anything. | the `federation*` tests, the signing and nonce-cache tests; [federation-architecture.md](federation-architecture.md) |
| **A server lies about who a person is** | A remote person is only believed from their own home server; a member vouched for by a third party is verified with *that* party's server; a remote stub's `protocolId` is never overwritten; "this account was deleted" is accepted only from the account's own home server. | the `protocolId`, group-conversation and `account-deleted` tests |
| **A hostile peer sends bad data** | Everything from a peer is re-validated on arrival, never passed through: profiles (`sanitizeRemoteProfile`), link-preview cards (`parseEmbeds`), directory pages (`sanitize*Page`), community snapshots and emoticon references. A bad field is dropped, not trusted. | unit tests for each sanitiser |
| **Making the server fetch something internal (SSRF)** | Every outbound federation request and every link-preview fetch is checked, and the connection itself refuses private addresses, so the address checked is the address connected to (this also defeats DNS rebinding). Link previews are read by the server that accepted the message and **never** by other servers or the reader's browser. | `ssrfGuard`, `safeLookup` and link-preview tests |
| **Using one community's permission in another** | Permissions are taken from the **message's own community**, never from an id in the URL, and the federation handlers check that a message belongs to the community and channel they are told. | `communityPermissionBits` and the federation tests |
| **Taking over an account** | Passwords are checked against a breached-password list and a policy; two-factor (TOTP) codes work once; sign-in and sign-up are rate-limited (10 attempts per 15 minutes per client); a login challenge cannot be used as an access token; sessions are revocable; a suspended account cannot sign in or refresh. | auth, 2FA, rate-limit and suspension tests |
| **Getting at the admin page** | The admin API answers `404 not_found`, exactly as for a missing page, to everyone who is not an admin, so it cannot be probed; admins need two-factor sign-in, and every change also needs **sudo mode** (password and a fresh code, ten minutes). An admin cannot be changed from the page except to remove their admin right, and the last admin cannot remove themselves. | `adminAccess`, `adminUsers` and `adminSudo` tests |
| **Hiding what an operator or moderator did** | An audit log records who did what, as ids and labels at the time. It **never** records what anyone wrote or any secret, and an erased person's name is removed from it. | `auditLog` tests |
| **Reporting used to harass, flood or spy** | A report can be made only about what the reporter can see (anything else answers as if it did not exist), once per thing, with a limit per person counted in the database; the snapshot is cut and cleaned and shown as text; the person reported is never told and does not see it even as a reviewer; reports are deleted after `REPORT_RETENTION_DAYS` and their snapshot is replaced when the person is erased; moderators see only reports about messages in their own community. A report about a community on another server is carried to its home server, which reads the message from its own copy (the sender supplies no text), runs the same checks and also limits a whole origin server to 100 an hour; the reporter's server keeps only that a report was made. | `reports` and `reportRelay` tests (mutations of their guards, all caught) |
| **Script injection through messages and profiles** | Messages and every other stranger's text are rendered as React elements, never as HTML, and the client image sends a Content-Security-Policy that does not allow an injected script to run (see below). A link always goes where its text says, with no credentials in it, `rel="noopener noreferrer nofollow"`; control and direction-override characters cannot hide in an address; picture addresses are checked before they reach the page. | `linkify`, `mediaUrl`, link-preview card tests; CodeQL |
| **Someone learning that a person exists, or messaging them** | A person can hide from servers they have no relationship with (a missing and a hidden person answer identically and cost the same time), and choose who may start a conversation or friendship with them. The operator can narrow these, never widen them. | discoverability and contact-policy tests |
| **A server meant to be private becoming public** | The switches that decide this (`FEDERATION_ENABLED`, the allow and block lists, invite-only registration) are parsed **strictly**: a typo refuses to start instead of defaulting to open. | the configuration parsing tests |
| **Running with the wrong secrets** | A deployment refuses to start with placeholder or missing JWT secrets or no `SERVER_DOMAIN`, and against a database containing migrations it does not know. | `startupChecks` tests |
| **Hostile input to the API** | Every request body and query is validated and a bad one is a `400`; the weekly dynamic scan sends malformed and hostile input to every documented operation and fails on a HIGH alert. Its first run found two places that answered `500` to bad input (a sync cursor, a truncated upload), now fixed. | the integration tests; `dast.yml` |
| **Flooding** | A general rate limit and a stricter one on sign-in; link previews are capped per person, per server and by how many run at once, with a size and time limit on each page. | rate-limit and link-preview tests. **No load testing has been done.** |
| **Leaking data on request** | Account export contains only the person's own data and a plain pointer to others, built field by field (a new column is not exported until someone decides it should be); the admin page and the overview are built the same way and tests search the answers for planted messages, names and secrets. | `accountExport`, `adminCommunities`, `adminOverview` tests |
| **Deleting an account while other data still points at it** | Erasure leaves a tombstone, the real username is reserved for ever, other servers are told, and there is a grace period in which signing in cancels it. | `accountDeletion` tests and the end-to-end suite |
| **Voice** | A join token is minted only for someone who is a member with the voice permission; it can publish a microphone only; the room's membership comes from LiveKit, not a copy kept here; LiveKit's webhook is believed only after its signature is verified; taking the permission away, or removing someone, ends their call. | voice tests; an end-to-end call in CI |
| **A vulnerable dependency, or a leaked secret, reaching the code** | CodeQL (static analysis), `npm audit` and a dependency review on every pull request, a secret scan, Dependabot, and a scan of the container images before release and weekly. See [security.md](security.md). | CI; every one of those is a required check except the image scan |
| **Tampering with a release** | Every action in the workflows is pinned to a commit hash (Dependabot updates the pins), workflow tokens are read-only unless a job needs more, the scanner runs from a container image pinned by digest, and releases carry signed provenance and a list of what is in them. See [deployment/verifying-releases.md](deployment/verifying-releases.md). | CI; the signed provenance has not yet run on a real release |

## What is not covered

Stated plainly, so nobody relies on a protection that is not there:

- **No end-to-end encryption.** The operator can read messages, and (for voice) the operator's LiveKit decrypts audio to pass it on. Other
  servers hold the messages they are sent.
- **A federated message, once delivered, is on the other server.** Deleting it here asks the other server to delete it; a hostile or
  modified server may not.
- **A taken access token lives out its 15 minutes** after a password reset, suspension or erasure (the server does not look the person up on
  each request, on purpose). Admin requests do look the person up each time.
- **Backups keep what was deleted** until the operator deletes the backup.
- **The desktop installers are unsigned** (Windows and macOS will warn), tracked in the repository's issues. Updates *are* verified: the app
  installs an update only if it carries a valid signature from the project's key.
- **No penetration test and no load test** have been done. A weekly dynamic scan (OWASP ZAP) attacks the API and looks at the web client, but
  only as one ordinary account on an empty server, and not the federation protocol, the WebSocket or voice; see [security.md](security.md#dynamic-scanning-dast).
- **The web client's Content-Security-Policy is looser than it could be**: connections, pictures and media may go to any `https:` or `wss:` server
  (the client has to reach whichever servers it is pointed at). Scripts are strict (this origin and the page's two inline scripts by hash) and
  so are styles (this origin's stylesheets, nothing inline). The Docker and Helm image, the **native client binary** and the **desktop app** all
  send it (the desktop app on Windows is the one that was run; macOS and Linux were not). See [security.md](security.md#browser-security-headers).
- **Voice relay (TURN) is not built**, so on a network that blocks the audio ports calls do not connect (see [deployment/voice.md](deployment/voice.md)).
- **Anything that needs the operator or the host to be hostile**, as above.

If you find something this page says is covered and is not, that is a vulnerability: see [SECURITY.md](../SECURITY.md).
