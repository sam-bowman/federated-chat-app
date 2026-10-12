# Federation: architecture and limitations

> Part of the [documentation](../README.md#documentation).

## Architecture notes — federation

See [`protocol/federation.md`](../protocol/federation.md) for the actual
server-to-server wire protocol (identity format, discovery, request
signing, every `/federation/v1/*` endpoint, delivery semantics) -
documented independently of this codebase, for anyone implementing a
compatible homeserver. This section below is about the implementation
choices *this* server made to support it, not the protocol itself.

A few foundational decisions in `server/prisma/schema.prisma` and `server/src/` are
what let federation get layered in without re-architecting the single-server code:

- Every federatable object (`User`, `Message`, `Conversation`, `Community`, `Channel`,
  `Emoticon`, `SyncEvent`, ...) has a `protocolId` (ULID) **separate from its local
  database id**. Local ids never leak into API responses — only `protocolId`. Two
  servers that both know about the same message/conversation/person agree on its
  `protocolId`, even though each stores it under its own local database id.
- Identity is always `@username:domain`, computed from a configurable `SERVER_DOMAIN`,
  never hardcoded to "the official server."
- `SyncEvent` is a per-recipient outbox with cursor-based resumable sync
  (`GET /api/v1/sync?cursor=`) — the client's own reconnect path, and conceptually the
  same shape a federation inbox needs.
- `GET /.well-known/communication-platform` is real server discovery: it carries the
  server's federation API base and Ed25519 public key.
- Friendships, DMs, and community membership are modeled as independent concerns (per
  Rules 2–4 in the spec) — nothing assumes same-server membership.

**How the federation protocol actually works** (`server/src/lib/federation/`,
`server/src/modules/federation/`):

- Each homeserver generates an Ed25519 keypair on first boot (`ServerIdentity` table)
  and publishes the public half via `.well-known`.
- `resolvePeer(domain)` fetches (and caches, `FederationPeer` table, 10 min TTL) a
  peer's `.well-known` document the first time it's needed — or, in local dev, reads
  the `FEDERATION_PEER_OVERRIDES` JSON env var instead, since `alice.test`/`bob.test`
  aren't real DNS names.
- Every outbound federation request is signed (`signRequest`): the canonical string
  `METHOD\nPATH\nTIMESTAMP\nSHA256(body)` is Ed25519-signed and sent as
  `X-Federation-Origin` / `X-Federation-Timestamp` / `X-Federation-Signature` headers.
  The receiving server's `requireFederationAuth` middleware resolves the claimed
  origin's public key and verifies the signature before any `/federation/v1/*` route
  runs, rejecting timestamps outside a ±5 minute window.
- A remote person is represented locally as a **cached stub User row**
  (`User.isRemote = true`, `User.homeserverDomain`, nullable `passwordHash`) carrying
  their *real* `protocolId` from their home server — not a locally-generated one, since
  the client matches live WebSocket events by `protocolId` and the two servers must
  agree on it. Because this stub is a completely ordinary `User` row, every existing
  table that references a user (`FriendRequest`, `Friendship`, `ConversationMember`,
  `Message.sender`) handles a remote person through the exact same foreign key it
  already used for a local one — no schema changes needed anywhere else, and the
  client renders federated data through the exact same `PublicUser`/`Message` shapes.
- Friend requests, DM conversation creation, message sends, and presence changes each
  have a thin "if any party is remote, also call their `/federation/v1/*` inbox"
  branch added to their existing local route handler (see
  `server/src/modules/friends/routes.ts`, `conversations/routes.ts`,
  `presence/presenceStore.ts`) — the local DB write always happens first and always
  succeeds even if the federation call then fails. For everything except presence
  (see below), that federation call goes through the durable outbox
  (`enqueueFederationEvent`, `server/src/lib/federation/outbox.ts`) rather than a bare
  `federationFetch` — see "Known federation limitations" for what that actually means.

## Known federation limitations

Honest, deliberate cuts for this phase — not bugs:

- ~~No durable outbox/retry queue~~ **Done.** `federationFetch` still retries a failed
  call a handful of times with backoff *within that one call*; beyond that, a friend
  request, conversation handshake, or message relay that doesn't deliver is durably
  queued (`FederationOutboxEvent`, `server/src/lib/federation/outbox.ts`) instead of
  just logged and lost. A background worker retries queued events on a capped
  exponential backoff (giving up, not deleting, after enough attempts), and any
  subsequent successful call to that domain immediately flushes its whole backlog -
  the [restart-resilience check](federation-demo.md#federation-demo-two-servers-talking-to-each-other)
  demonstrates exactly this: a message sent while the recipient's server is down
  shows up on their side automatically once it comes back, not lost or needing a
  resend. Presence pushes are deliberately *not* queued - retrying a stale presence
  update once a peer comes back would deliver outdated status, not current.
- ~~Replay protection is a timestamp window only~~ **Done.** A request whose signature
  has already been seen once is rejected outright (`401 replayed_federation_request`) -
  the signature itself doubles as the nonce, since it's unique per request and
  unforgeable without the origin's private key. Shared across replicas via Redis when
  `REDIS_URL` is set, in-memory otherwise - see `server/src/lib/federation/nonceCache.ts`
  and [`protocol/federation.md`](../protocol/federation.md#authentication).
- ~~Remote message edits, deletes, and reactions don't propagate~~ **Done.** An edit,
  delete, or reaction on a federated DM message relays to the other side the same way
  the initial send does (`POST /federation/v1/messages/{id}/edit|delete|reactions[/remove]`)
  - see [`protocol/federation.md`](../protocol/federation.md#post-messagesidedit). Each is its
  own independent outbox event, not bundled with the message it targets, so (documented
  honestly, not hidden) an edit/delete/reaction arriving before its message has synced is
  lost rather than buffered - unlikely in practice since the outbox flushes a domain's
  backlog oldest-first, but not prevented at the protocol level.
- ~~No group DMs or communities across servers~~ **Done.** Group DMs (2-10
  members spanning any number of domains) and communities (one authoritative
  home server; a remote member's own server holds a read cache, kept current
  by relay, and a remote member's send/edit/delete/react synchronously
  proxies to home for real authorization) both work across federation now -
  see [`protocol/federation.md`](../protocol/federation.md)'s "POST
  /conversations" and "Communities" sections. Still out of scope: a remote
  member exercising *management* permissions (roles/channels/kicks/bans)
  remotely (see "What's not here yet" in the [README](../README.md#whats-not-here-yet)).
- **Blocking a remote user is local-only** — it stops delivery on your side but doesn't
  notify their server, consistent with blocking being a privacy control rather than a
  negotiated state.
