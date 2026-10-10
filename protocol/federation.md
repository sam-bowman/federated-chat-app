# Federation protocol

**Protocol version: `0.1.0`** (`server/src/config.ts`'s `protocolVersion` -
advertised at `.well-known/communication-platform`; see "Versioning" below
for what bumping it means). This document describes the server-to-server
wire protocol as actually implemented today, independently of this
repository's own server code, so a third party can implement a compatible
homeserver without reading it. See
[`../docs/spec.md`](../docs/spec.md) for the broader, partly-aspirational
product spec this project is working toward; this document only covers
what's real today. See [`../ROADMAP.md`](../ROADMAP.md) for what federation
doesn't do yet (federated communities) - this spec describes the current
surface honestly, gaps included, not where it's headed.

A **homeserver** is a single deployment, identified by a domain. Every
federatable object (a user, message, friend request, conversation, ...)
carries a stable, globally-unique ID independent of any one server's own
database - see "Identifiers" below. Federation is peer-to-peer: any two
homeservers that can reach each other over HTTPS can federate, with no
central registry or approval step.

## Identity

A person's identity is `@username:domain` - `domain` is the homeserver that
authenticates them (issues their session, stores their password hash).
Usernames are case-insensitive (lowercased on parse) and match
`[a-z0-9_]+`. A bare `username` (no `:domain`) means "a user on *my own*
homeserver" - only valid when resolved by a client or server that already
knows what "my own" means, never valid in a federation payload between two
servers, where identities must always be fully qualified.

Reference implementation: `server/src/lib/ids.ts`'s `identityFor`/
`parseIdentity`.

## Identifiers

Every federatable object gets a **protocolId**: a [ULID](https://github.com/ulid/spec)
(Crockford Base32, 26 characters, millisecond-precision time-sortable,
e.g. `01ARZ3NDEKTSV4RRFFQ69G5FAV`). This is separate from whatever primary
key a given homeserver's own database uses internally - protocolIds are
the only identifiers that ever cross the wire or appear in a public API
response. A homeserver mentioning a *remote* person, message, or request
in a federation payload must always carry that object's real protocolId
from its own homeserver, never invent a fresh one locally - two servers
that both know about the same person must agree on one ID for them, or
realtime event matching (e.g. a `presence` push naming a `userId`) breaks.

## Server discovery

`GET https://<domain>/.well-known/communication-platform` (no
authentication) returns:

```json
{
  "protocolVersion": "0.1.0",
  "domain": "chat.example.com",
  "serverName": "My Chat Server",
  "apiBase": "/api/v1",
  "websocketPath": "/ws",
  "registration": { "enabled": true },
  "features": {
    "friends": true, "directMessages": true, "groupDms": true,
    "presence": true, "communities": true, "emoticons": true,
    "voice": false, "federation": true, "e2ee": false
  },
  "federation": {
    "enabled": true,
    "apiBase": "/federation/v1",
    "publicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
  }
}
```

`federation.enabled` and `federation.publicKey` are required for a domain
to be treated as federation-capable; `federation.apiBase` defaults to
`/federation/v1` if omitted. `publicKey` is the domain's long-lived Ed25519
signing public key (SPKI, PEM-encoded) - see "Authentication" below. This
document carries no secrets and is served with a permissive CORS policy
deliberately, so a browser-based client can query *any* domain the user
types in before that domain is a trusted origin for anything else.

A homeserver caches a peer's discovery result (`baseUrl` + `publicKey`)
for 10 minutes before re-fetching - trust-on-first-discovery, not a
central PKI. There is no revocation mechanism for a compromised or
rotated key beyond that cache simply expiring and re-fetching the current
document.

Reference implementation: `server/src/wellknown.ts`,
`server/src/lib/federation/discovery.ts`.

## Authentication

Every `/federation/v1/*` request must carry three headers:

| Header | Value |
|---|---|
| `X-Federation-Origin` | The sending domain, e.g. `alice.example.com` |
| `X-Federation-Timestamp` | `Date.now()` at signing time, as a string (milliseconds since epoch) |
| `X-Federation-Signature` | Base64-encoded Ed25519 signature (see below) |

**Canonical string** signed (and verified against):

```text
{METHOD}\n{path}\n{timestamp}\n{base64(sha256(rawBodyBytes))}
```

- `METHOD` is the HTTP method, uppercased (`GET`, `POST`).
- `path` is the request path including `apiBase`, e.g.
  `/federation/v1/messages` - exactly what the receiving server sees as
  its own request path (scheme/host excluded). None of the endpoints below
  take a query string; one isn't part of the signed canonical string, so
  a server adding one to a future endpoint needs to account for that
  explicitly rather than assuming it's covered.
- For a body-less request (`GET`, or a `POST` with an empty object body),
  the body hash is still computed over an empty string / `"{}"`
  respectively - never omitted.

The receiving server resolves the claimed origin's current public key via
server discovery (fetching and caching it if this is the first time it's
seen that domain), then verifies the Ed25519 signature over the
reconstructed canonical string using that key. A request is also rejected
if `|now - timestamp| > 5 minutes` (clock-skew window).

**Replay protection**: a request whose signature has already been seen
once (within the timestamp window above) is rejected outright - the
signature itself doubles as a nonce, since it's unique per (method, path,
timestamp, body) and unforgeable without the origin's private key, so
there's no separate nonce for a sender to generate or supply. A genuine
retry of the same logical request re-signs with a fresh timestamp
(producing a different signature), so this only ever catches an actual
replay - literally resending previously-sent bytes - never a legitimate
retry. The receiving server remembers a signature for slightly longer
than the timestamp window itself (so nothing is forgotten before it would
have aged out of that check anyway) in a store shared across all of that
server's replicas when it runs more than one (see
`../README.md#running-multiple-replicas`) - a single process's own memory
otherwise, correct for one replica.

Failure responses: `401 missing_federation_signature` (a header is
missing), `401 unknown_or_unreachable_peer` (discovery failed for the
claimed origin), `401 invalid_federation_signature` (signature didn't
verify or the timestamp is out of window), `401 replayed_federation_request`
(a valid signature, but one already seen).

Reference implementation: `server/src/lib/federation/signing.ts` (the
canonical string + sign/verify), `server/src/lib/federation/nonceCache.ts`
(replay protection), `server/src/middleware/federationAuth.ts` (the
inbound check, wiring both together), `server/src/lib/federation/client.ts`
(outbound signing).

### Outbound request safety

A homeserver making an outbound federation call validates the target
hostname isn't a private/loopback/link-local/reserved address (blocking
server-side request forgery via a maliciously-chosen domain) before every
real network call, and refuses to follow HTTP redirects on federation
requests. See `server/src/lib/federation/ssrfGuard.ts`.

## Endpoints

All under `{federation.apiBase}` (`/federation/v1` by default) on the
target domain, from "server B" to "server A" for each of these. All
require the authentication headers above. All request/response bodies are
`application/json`.

### `GET /users/{username}`

Resolves a local user on the receiving server. Used when another server
needs to look up someone who was only referenced by a bare `@user:domain`
(e.g. before delivering a friend request to them).

Response `200`:

```json
{ "user": { "id": "<protocolId>", "identity": "@bob:domain", "username": "bob",
            "displayName": "Bob", "avatarUrl": null, "bio": null,
            "presence": { "status": "ONLINE", "customStatus": null, "lastSeenAt": null } } }
```

`404 not_found` if the username doesn't exist on this server.

### `POST /friend-requests`

Delivers a friend request originating on the sending server.

```json
{
  "requestId": "<protocolId, generated by the sender>",
  "fromProtocolId": "<sender's protocolId>",
  "fromUsername": "alice",
  "fromDisplayName": "Alice",
  "fromAvatarUrl": null,
  "toUsername": "bob",
  "message": "optional text"
}
```

The receiving server creates (or no-ops, idempotently, if `requestId`
already exists) a `PENDING` friend request and caches the sender as a
remote user stub. `201 { "ok": true }` on success, `404 user_not_found` if
`toUsername` doesn't exist locally.

### `POST /friend-requests/{id}/accept` / `.../decline`

Callback telling the *originating* server that the recipient (on the
receiving server of this call) accepted or declined. `{id}` is the same
`requestId` from the original `POST /friend-requests`. Only accepted from
the domain that currently owns the recipient side of that request (the
call is rejected as `404` if the caller isn't the request's original
recipient's homeserver). On accept, both servers end up with their own
`Friendship` row for their own local user, each pointing at the other's
cached stub. `204` on success, `404 not_found` / `409 already_resolved`
otherwise.

### `POST /conversations`

Seeds a matching conversation on the receiving server so every member's
homeserver ends up with a matching row to relay messages against. Covers
both `DM` (exactly 2 members) and `GROUP` (2 to 10 members, across any
number of distinct domains) - a `DM` payload with other than 2 members is
rejected with `400 dm_requires_exactly_two_members`; a `members` array
outside 2-10 entries is rejected as `400 invalid_request` before any
member-level processing happens.

```json
{
  "conversationId": "<protocolId, generated by the creator>",
  "type": "GROUP",
  "members": [
    { "protocolId": "...", "username": "alice", "domain": "alice.example.com", "displayName": "Alice", "avatarUrl": null },
    { "protocolId": "...", "username": "bob", "domain": "bob.example.com", "displayName": "Bob", "avatarUrl": null },
    { "protocolId": "...", "username": "carol", "domain": "carol.example.com", "displayName": "Carol", "avatarUrl": null }
  ]
}
```

Each member is trusted differently depending on who's vouching for them -
this matters for a `GROUP` conversation spanning more than one remote
domain, where most members weren't described by the authenticated caller
themselves:

- A member whose `domain` is the receiving server's own domain must
  already exist as a local user (`404 user_not_found` otherwise).
- A member whose `domain` equals the authenticated `X-Federation-Origin`
  (the calling peer describing one of its own users) is trusted directly
  from the payload - a peer is always authoritative for its own users.
- A member on **any other domain** is never trusted from the payload
  alone. The receiving server independently verifies them via `GET
  /federation/v1/users/{username}` against *that member's own* claimed
  domain, and uses whatever that domain reports (protocolId, displayName,
  avatarUrl) - the payload's claims about a third party are discarded even
  if present. This exists specifically so a calling peer can't plant an
  arbitrary `protocolId` for a user on a domain it doesn't control; since a
  cached remote-user stub's `protocolId` is never overwritten once set
  (see "Identifiers"), a successful plant would permanently break that
  real user's identity matching once they actually federate for real.
  Verification failure (the third domain is unreachable, or doesn't
  recognize that username) fails the whole handshake with `502
  member_verification_failed` - there is no partial acceptance or silent
  drop of an unverifiable member.

Idempotent on `conversationId`. `201 { "ok": true }`.

### `POST /messages`

Relays a single message into an existing (already-handshaken) conversation.

```json
{
  "conversationId": "<protocolId>",
  "messageId": "<protocolId, generated by the sender>",
  "fromProtocolId": "<sender's protocolId>",
  "fromUsername": "alice",
  "fromDomain": "alice.example.com",
  "content": "hello",
  "createdAt": "2026-01-01T00:00:00.000Z",
  "attachments": [
    { "url": "https://alice.example.com/uploads/abc.png", "filename": "photo.png", "contentType": "image/png", "size": 12345 }
  ]
}
```

`fromDomain` must equal the authenticated `X-Federation-Origin` (`403
sender_domain_mismatch` otherwise - a server can only relay messages from
its own users). The sender must already be a member of `conversationId`
on the receiving side (`403 not_a_member`) - membership comes from a prior
`POST /conversations` handshake, never inferred from this payload alone.
`attachment.url` must be an **absolute** URL reachable from the receiving
server/its users (the sending server's own responsibility to make
absolute before sending - see "Media references" below); `content` is
plain text, max 8000 characters. Idempotent on `messageId`. `404
conversation_not_found` if no matching conversation exists locally (i.e.
the `/conversations` handshake never happened or hasn't arrived yet).
`201 { "ok": true }`.

### `POST /messages/{id}/edit`

Relays an edit to a message's content. `{id}` is the `messageId` from the
original `POST /messages`.

```json
{ "content": "updated text" }
```

No explicit sender field - ownership is purely `message.sender`'s own
cached homeserver domain matching the authenticated `X-Federation-Origin`
(`403 not_message_owner` otherwise), the same shape as
`POST /friend-requests/{id}/accept`'s ownership check. `404 not_found` if
`{id}` doesn't match a known, non-deleted message. `204` on success.

### `POST /messages/{id}/delete`

Relays a (soft) delete - the receiving side marks the message deleted
(content cleared, row kept) rather than removing the row, same as a local
delete. Empty body `{}`. Same ownership check and failure modes as
`.../edit` above. `204` on success.

### `POST /messages/{id}/reactions`

Adds a reaction from a conversation member - unlike edit/delete, the
actor here isn't necessarily the message's own sender, so their identity
has to be carried explicitly, the same shape as a fresh `POST /messages`:

```json
{
  "fromDomain": "alice.example.com",
  "fromProtocolId": "<reactor's protocolId>",
  "fromUsername": "alice",
  "emoji": "👍"
}
```

`fromDomain` must equal `X-Federation-Origin` (`403
sender_domain_mismatch` otherwise). The reactor must already be a member
of the message's conversation (`403 not_a_member`) - checked the same way
`POST /messages` checks a sender's membership, caching the reactor as a
remote stub first if this is the first time they've been seen. `404
not_found` if `{id}` doesn't match a known, non-deleted conversation
message. Idempotent per (message, reactor, emoji) triple. `204` on
success.

### `POST /messages/{id}/reactions/remove`

Removes a previously-added reaction. Same request shape, ownership check,
and failure modes as `.../reactions` above - a removal for a reaction
that was never added, or already removed, is still a `204` no-op, not an
error.

### `POST /presence`

Pushes a presence change for one of the sending server's users to any of
*our* local users who have them as a friend.

```json
{ "username": "alice", "domain": "alice.example.com", "status": "ONLINE", "customStatus": null }
```

`domain` must equal `X-Federation-Origin`. A no-op `204` if no local user
has this remote person cached (i.e. nobody's friended them yet - there's
nobody to notify). `INVISIBLE` is never sent over federation; a server
reports its own invisible users as `OFFLINE` to everyone, including peers.

## Delivery semantics

A homeserver making an outbound call (friend request, conversation
handshake, or message relay - **not** presence, see below) retries a
transient failure (network error, 5xx) a handful of times immediately;
beyond that, the event is durably queued for later retry with capped
exponential backoff, and automatically flushed in full the next time any
call to that same domain succeeds. This means delivery is **at-least-once,
not exactly-once** - a receiving server must treat every endpoint above as
idempotent on the protocolId it carries (`requestId`/`conversationId`/
`messageId`), which the reference implementation does via upsert. A `4xx`
response is treated as a permanent rejection (not retried); only a network
error or `5xx` is queued for retry.

**Presence is deliberately not retried or queued** - it's current-state
only, and replaying a stale push after a peer comes back online would
deliver outdated status rather than current. A server that was
unreachable during a presence change simply never saw it; the next
natural presence change (or the next time that person's profile is
otherwise fetched) is what catches a peer back up, not a backfill
mechanism.

There is no durable ordering guarantee *across* event types or
conversations - only within one conversation does `createdAt` give
messages a natural order to display by. A server implementation should
not assume federation events for unrelated objects arrive in the order
they were sent. Concretely: an edit, delete, or reaction is enqueued as
its own independent outbox event, separate from the message-create event
it targets - if the create is still queued (peer was down) when the edit
is attempted, the edit's `404 not_found` is treated as terminal, not
retried, and is simply lost rather than buffered until the message
arrives. In practice this only happens if the create and the edit don't
share the same queued-and-later-flushed fate (the common case when a peer
is down for a stretch is that both get queued and flushed in creation
order, since the outbox processes a domain's backlog oldest-first) - but
it isn't prevented at the protocol level, just made unlikely.

Reference implementation: `server/src/lib/federation/outbox.ts`.

## Media references

A URL in `avatarUrl`/`attachment.url` is relative (e.g. `/uploads/x.png`,
resolved against the server that stored it) when used *within* one
homeserver's own API responses, but **must always be absolute** when it
crosses a federation boundary - the receiving server, and its users'
browsers, have no way to resolve a path relative to a server they aren't
talking to. A sending server is responsible for this conversion before
relaying anything; see `server/src/lib/mediaUrl.ts`. There's no
federation-level media proxying, caching, or re-upload - the receiving
side's clients fetch the URL directly from wherever the sending server
says it lives.

## Error handling

Every endpoint returns a JSON body `{ "error": "<code>" }` (snake_case) on
failure, no further machine-readable detail beyond the code and the HTTP
status. There's no error code registry beyond what's documented per
endpoint above; an unrecognized error code should be treated as a generic
failure of that request.

## Versioning

`protocolVersion` (currently `0.1.0`) is **independent of the reference
server's own application version** (see `../VERSIONING.md`) - it changes
only when the wire protocol itself changes in a way that affects
interoperability with another server's implementation, not on every app
release. There is currently no version negotiation beyond what
`.well-known` advertises; a homeserver implementing this spec should
expect the shapes documented here to be what `0.1.x` means; a breaking
protocol change will bump this to `0.2.0` and be called out explicitly in
`../CHANGELOG.md`.
