# Federation demo: two servers talking to each other

> Part of the [documentation](../README.md#documentation).

This spins up **two separate homeservers** — `alice.test` and `bob.test` — each with
its own database, running as genuinely independent processes, so you can see real
server-to-server federation rather than a single-server simulation of it.

```powershell
.\scripts\start-federation-demo.ps1   # brings up both homeservers + both clients
.\scripts\stop-federation-demo.ps1    # stops all four processes + the Postgres container
```

This is a separate pair of scripts from `start.ps1`/`stop.ps1`, using its own
`chat_a`/`chat_b` databases, its own `server/.env.a`/`.env.b` and
`client/.env.a`/`.env.b` (created from `.env.a.example`/`.env.b.example` the first
time, same pattern as the regular `.env`), and its own PID files. The two setups can
run at the same time, since they share the one Postgres container (`docker compose up`
is idempotent) — but `stop-federation-demo.ps1` stops that shared container, so don't
run it while you still want the single-instance app (`start.ps1`) up too; just stop
its own two processes by PID in that case instead.

Once it's up:

1. Open `http://localhost:5173` and register a user, e.g. `alice` (this is
   `alice.test`'s client).
2. Open `http://localhost:5174` in a **different browser profile or incognito
   window** (same `localStorage` caveat as in the README's [Getting started](../README.md#getting-started), now across two different origins
   too) and register a user, e.g. `bob` (this is `bob.test`'s client).
3. From either side, add the other as a friend using their full identity —
   `@bob:bob.test` from Alice's client, or `@alice:alice.test` from Bob's — in the
   "Add a friend" box on the Friends page.
4. Accept the request on the other side. You're now friends across two independent
   servers.
5. Click **Message** to open a federated DM and send messages both ways — each
   server relays the message to the other's `/federation/v1/messages` inbox.
6. Change your presence status (Settings → Presence) on one side and watch it update
   live on the other's friends list, with no page refresh — that's a
   `/federation/v1/presence` push arriving over the live WebSocket.
7. **Restart resilience**: stop one server (`taskkill /PID <pid> /T /F` using its
   `.run\server-a.pid` / `server-b.pid`, or just close its window if you started it
   another way) and send a message to that now-unreachable user. It sends fine on your
   own side — the local write always succeeds — and the other server, being down,
   doesn't receive it *yet*: the failed delivery is durably queued
   (`FederationOutboxEvent` - see [Known federation limitations](federation-architecture.md#known-federation-limitations))
   instead of just being dropped. Restart it with `start-federation-demo.ps1` again (it
   only restarts whatever isn't already listening); the queued message shows up on the
   other side within moments, delivered automatically by the sender's background outbox
   worker (or immediately, if anything else happens to talk to that domain successfully
   first) - no need to resend it by hand, and the other server was never affected by the
   outage in the first place.

Each server's own `.well-known/communication-platform` document
(`http://localhost:4000/.well-known/communication-platform` /
`:4001/...`) advertises its federation API base and Ed25519 public key; that's what
the other server fetches (and caches) the first time it needs to talk to a new peer
domain.

Since there's no real DNS for `alice.test`/`bob.test` on a dev machine, each server's
`FEDERATION_PEER_OVERRIDES` env var (JSON, dev-only) maps those domains straight to
the other's real `localhost` URL instead of doing a live DNS/TLS lookup.

## What this demo does *not* cover

The numbered walkthrough above only exercises friending, 1:1 DMs, presence, and
outbox restart-resilience - it doesn't include steps for federated group DMs,
federated communities, or remote message edit/delete/reaction propagation, even
though all of those work today (see [Known federation
limitations](federation-architecture.md#known-federation-limitations) for what's actually still out of
scope, and `protocol/federation.md` for how each one works). Creating a community on
one side and joining it by `<communityId>:<domain>` from the other, or starting a
group DM across both, follows the same pattern as steps 3-6 above.
