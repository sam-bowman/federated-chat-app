# Running a private server

> Part of the [deployment guides](README.md).

By default a server federates: its people can add, message and join people and
communities on other servers, and other servers can do the same with it. Set
**`FEDERATION_ENABLED=false`** and it does not. It becomes a private server for
the people on it, which is what you want for a family, a team or a club that has
no business with the rest of the network.

This is phase 1 of [#109](https://github.com/sam-bowman/federated-chat-app/issues/109):
one switch for the whole server. Choosing *which* servers may talk to yours
(allow and deny lists), who can be found, and how communities are listed come
later (see "Not done yet").

## Turning it on

It is read once, at startup. Change it and restart the server; nothing happens
to a running one.

| How you run it | What to set |
|---|---|
| Docker Compose (`docker-compose.selfhost.yml`) | `FEDERATION_ENABLED=false` in your `.env` |
| Kubernetes (Helm) | `server.federation.enabled: false` in your values |
| Native binary, or `npm run dev` | `FEDERATION_ENABLED=false` in the server's `.env` (or the environment) |

Only `true`/`false` (also `1`/`0`, `yes`/`no`, `on`/`off`, any case) are
accepted. Anything else, such as `fasle`, **stops the server at startup** with a
message saying so. That is deliberate: a typo in a switch like this must not
leave a server you meant to be private open to the network.

At startup the server logs that it is private. You can also check from outside:

```bash
curl -s https://chat.example.com/.well-known/communication-platform
```

A private server answers `"federation": { "enabled": false }` and `"features": { "federation": false }`,
with no `apiBase` and no public key.

## What it does

**Nothing comes in.** Every `/federation/v1/*` request is refused with
`403 federation_disabled`, before its signature is even looked at. Other servers
cannot look your people up, send them messages, or ask about your communities.

**Nothing goes out.** The server never contacts another one: no lookups, no
deliveries, no presence updates.

**Nobody on it can start something with the outside.** Adding a friend on another
server, starting a direct or group message with someone there, joining a
community there (by ID, by invite or from a card), and sending into one of its
channels through the proxy are all refused with `403 federation_disabled`. The
app says so in plain words instead ("This server doesn't connect to other
servers, so this can only be done with people on it") and greys out what cannot
work, such as people on other servers in the New message dialog.

**What already exists is kept, read-only.** Friends, conversations and
communities from before stay in the lists and can be read. Messages, edits,
deletes and reactions that would go to someone on another server are **queued,
not refused**, and the conversation shows a notice saying so.

**Queued means kept.** The outbox holds those events untouched (still pending,
no attempts used). Set the switch back to `true` and restart, and they are
delivered in order. The same holds the other way round: a server that *was*
public and talked to yours keeps retrying with backoff while yours is private,
and its messages arrive once you federate again. A peer that is private is
treated like one that is down, never as one that rejected the message, which
would have thrown the message away for good.

**People from other servers in your communities are cut off, not removed.** They
stay members, but your server answers them nothing until you federate again.

## Checking it

These were run for real, with two servers (`alice.test` public, `bob.test`
private) from `scripts/start-federation-demo.ps1`:

- the private server's discovery document says it is not federating, and an
  unsigned call to its federation API gets `403 federation_disabled`
- someone on the private server adding, messaging or joining a person or community
  on the public one gets `403 federation_disabled`, and the browser shows the
  messages above
- the same person still reads the community they had joined, their friend list and
  their direct message history
- a message written in an existing conversation while private, and one sent to
  them from the public server, were both held, and after restarting with
  federation on **both arrived on both sides**, nothing lost
- the public server's own outbox kept the event pending with the error
  `peer_federation_disabled` rather than failing it
- adding a remote friend worked again after re-enabling

Not run: a real Kubernetes or Compose deployment with the switch set (the chart
renders the variable and CI checks that; the Compose file passes it through), and
the desktop app.

## Not done yet

- **Allow and deny lists** (phase 2): talking to *some* servers, not all or none.
- **Who can be found** (phase 3): a person's setting for whether people on other
  servers can look them up.
- **Community visibility** (phase 4), beyond what invites and "open to anyone"
  already give you.
- **A directory** (phase 5).
- **Changing it without a restart.**
- Edits, deletes, reactions and messages toward people on other servers are
  queued while private rather than blocked in the app, with a notice. A card
  sent to a remote friend queues too.
