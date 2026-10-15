# Running a private or restricted server

> Part of the [deployment guides](README.md).

By default a server federates: its people can add, message and join people and
communities on other servers, and other servers can do the same with it. Set
**`FEDERATION_ENABLED=false`** and it does not. It becomes a private server for
the people on it, which is what you want for a family, a team or a club that has
no business with the rest of the network.

If you want it to talk to *some* servers, not none (just your family's, or everyone except a
few), see [Limiting which servers it talks to](#limiting-which-servers-it-talks-to) below.

This is phases 1 and 2 of [#109](https://github.com/sam-bowman/federated-chat-app/issues/109):
the switch for the whole server, and allow and deny lists. Who can be found and how
communities are listed come later (see "Not done yet").

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

## Limiting which servers it talks to

Instead of switching federation off, name the servers it may (or may not) talk to. Both are comma-separated
lists of **exact domains**, as they appear after the colon in a username (`chat.example.com`, or
`chat.example.com:8443` if the server runs on another port). No wildcards, no `https://`, no paths.

| Setting | Effect |
|---|---|
| `FEDERATION_ALLOWED_DOMAINS` | Talk **only** to these servers. Every other server is refused. |
| `FEDERATION_BLOCKED_DOMAINS` | Talk to every server **except** these. |
| neither (the default) | Talk to every server, as ever. |

| How you run it | Where |
|---|---|
| Docker Compose | `FEDERATION_ALLOWED_DOMAINS` / `FEDERATION_BLOCKED_DOMAINS` in your `.env` |
| Kubernetes (Helm) | `server.federation.allowedDomains` / `blockedDomains`, as lists |
| Native binary, or `npm run dev` | the same variables in the server's `.env` or the environment |

```
FEDERATION_ALLOWED_DOMAINS=family.example.com,club.example.org
```

Like the switch, they are read at startup and **checked strictly**: an entry that is not a plain domain (a
wildcard, a URL, a typo with a space in it), or a domain in both lists, **stops the server** with a message naming
the entry, rather than being dropped, which would leave you thinking you had a restriction you do not. An empty
list means no limit at all, so to talk to nobody use `FEDERATION_ENABLED=false`, not an empty allow list. If both
lists are set, the block list still takes away from the allow list. Case, and a trailing dot, do not matter; a
different port is a different server.

For a server that is not permitted:

- **Nothing comes in.** A request that says it is from that server is refused `403 federation_domain_blocked`
  before anything else is done, including before its signature is checked: checking it would mean fetching that
  server's discovery document, and this server does not contact it. A forged claim to be a blocked server just gets
  the same refusal. A server that is merely not on the allow list gets the identical answer, so it does not say which
  list is in use.
- **Nothing goes out.** It is never looked up or contacted, and not sent presence.
- **Nothing new starts with it.** Adding someone on it, messaging or joining there are refused with
  `403 federation_domain_blocked`, and the app says "This server doesn't connect to that server, so this can't be
  done" (or, when joining, names the server).
- **What exists is kept, and waits**, as on a private server: the friends, conversations and communities from before
  can be read; what is written toward that server is queued, untouched and without using up retries, and is
  delivered, in order, if you take the server off the block list or add it to the allow list and restart. Other servers
  are not held up by it. Its people who are members of your communities are cut off, not removed.
- **The discovery document does not change** and does not say who is allowed: it stays public, because a client's
  server picker reads it.

**The other side.** If *another* server blocks yours, it answers you `403 federation_domain_blocked`. That is
treated as that server not being reachable, like one that is down: what you send it is kept and retried with the
usual backoff, and your people are told it "could not be reached", not that *you* blocked it. As with any peer that
stays away, an event is given up on after the usual number of attempts (20 attempts, about 13 hours with the backoff growing to an hour), so a server that blocks
yours for longer than that loses what was queued for it in the meantime.

The app does not know the lists, so it learns a server is off limits only when something is refused. Messages written
toward one (to a friend already there) therefore look sent while they wait; there is no notice on that conversation
yet (see "Not done yet").

## Checking it

**The switch.** Run for real, with two servers (`alice.test` public, `bob.test`
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

**The lists.** Run for real with the same two servers, `bob.test` blocking `alice.test`:

- `bob.test` still says it federates (a block is not private), and answers a request claiming to be from
  `alice.test` `403 federation_domain_blocked` without looking it up
- someone on `bob.test` adding, messaging or joining a person or community on `alice.test` gets
  `403 federation_domain_blocked`, and the browser says "This server doesn't connect to that server, so this can't be
  done"
- the same person still reads their history; a message written in the existing conversation, and one sent to them
  from `alice.test`, were both held: `bob.test`'s own stayed pending with no attempt used, and `alice.test`'s
  recorded `peer_federation_domain_blocked` and will retry, not failed
- a malformed list, a wildcard, and a domain in both lists each stop the server at startup with a message naming the
  entry
- after lifting the block and restarting, both held messages arrived on both sides

Not run: a real Kubernetes or Compose deployment with the settings (the chart renders the variables and CI checks
that, including that a domain in both lists is refused at install time; the Compose file passes them through), and the
desktop app.

## Not done yet

- **Wildcards** in the lists (`*.example.com`): entries are exact domains.
- **A notice in the app** on a conversation or community that is on a server this one does not talk to: the app does not
  know the lists, so messages toward such a server look sent while they wait.
- **Who can be found** (phase 3): a person's setting for whether people on other
  servers can look them up.
- **Community visibility** (phase 4), beyond what invites and "open to anyone"
  already give you.
- **A directory** (phase 5).
- **Changing it without a restart.**
- Edits, deletes, reactions and messages toward people on other servers are
  queued while private rather than blocked in the app, with a notice. A card
  sent to a remote friend queues too.
