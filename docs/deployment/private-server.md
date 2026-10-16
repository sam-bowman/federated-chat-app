# Running a private or restricted server

> Part of the [deployment guides](README.md).

By default a server federates: its people can add, message and join people and
communities on other servers, and other servers can do the same with it. Set
**`FEDERATION_ENABLED=false`** and it does not. It becomes a private server for
the people on it, which is what you want for a family, a team or a club that has
no business with the rest of the network.

If you want it to talk to *some* servers, not none (just your family's, or everyone except a
few), see [Limiting which servers it talks to](#limiting-which-servers-it-talks-to) below.

This is phases 1 to 4 of [#109](https://github.com/sam-bowman/federated-chat-app/issues/109):
the switch for the whole server, allow and deny lists, whether the people on it can be found by
other servers ([Who on your server can be found](#who-on-your-server-can-be-found)), and who may start
something with them ([Who can contact people on your server](#who-can-contact-people-on-your-server)).
Which communities may be joined from other servers is the managers' choice
([Communities that stay on your server](#communities-that-stay-on-your-server)); how they are listed comes later
(see "Not done yet").

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

## Who on your server can be found

A server that federates tells other servers who is on it when they ask: look someone up by handle, send them a friend
request, put them in a conversation. Each person can hide from that (**Settings -> Privacy -> "Let people on other
servers find me"**), and you, the operator, can set what new accounts start with or switch it off for everyone.

| `FEDERATION_USER_DISCOVERABILITY` | Effect |
|---|---|
| `default-on` (the default) | Each person can hide themselves. New accounts are findable, as every account always was. |
| `default-off` | Each person can choose. New accounts start hidden until they opt in. |
| `forced-off` | Nobody is findable and nobody can change it (the switch in Settings is off, disabled, and says why). |

| How you run it | Where |
|---|---|
| Docker Compose | `FEDERATION_USER_DISCOVERABILITY` in your `.env` |
| Kubernetes (Helm) | `server.federation.userDiscoverability` |
| Native binary, or `npm run dev` | the same variable in the server's `.env` or the environment |

Like the other federation settings it is read at startup and checked strictly: any other value stops the server, because a
guess might expose people who meant to be hidden. The server can only narrow what people choose, never widen it: a person
who is hidden stays hidden under `default-on`, and `forced-off` hides even someone who opted in.

**What hiding does.** A server that has *nothing to do with* the person is told they **do not exist**, in every way it can
ask: a profile lookup, a friend request and a conversation all get the same `404` a person who really does not exist
gets, with the same body, so the answer says nothing. (Both do the same work to answer, so it cannot be told by how long it
takes either.) It cannot send a friend request or start a conversation with them either, because to it they are not there.
It is a setting about being found by handle: someone who already has the handle still cannot reach a hidden person from a
server with no connection to them.

**What it leaves alone.** A server counts as having something to do with the person when someone on it is their friend, has
a pending friend request with them (either way), is in a conversation with them, or shares a community with them (or hosts
a community they belong to). For those servers nothing changes: friends, conversations and communities carry on exactly as
before, they can still look the person up, and a person who hides can still start things themselves. People on **your own
server** are not affected: they can still search for, add and message someone who is hidden from other servers. If a
relationship ends (they unfriend, leave the community), that server stops being able to find them.

**Not covered:** it does not stop someone who shares a community with a hidden person from seeing them in it (they
already know them), and it is not a block: a hidden person can still be messaged by anyone they have a relationship with.
Who may START something with a person, beyond being findable, is a separate setting (below).

## Who can contact people on your server

Separately from being *found*, each person chooses who may **start** something with them: send a friend request, or put them
in a conversation (**Settings -> Privacy -> "Who can send me friend requests and start conversations"**).

| Choice | Who is let in |
|---|---|
| Anyone (the default) | Anyone who can find them |
| People I share a community with | Only people who are in a community with them, on this server or another |
| People on this server | Only people on their own server |

This one is the person's alone (there is no server-wide switch for it). A **friend is always let in**, whatever was chosen, and
nothing that already exists is touched: a conversation they already have stays open and keeps working, and an existing
friendship stays. Everyone starts on "Anyone", so nothing changes until someone chooses.

- **Same server.** Someone on your server who is not allowed is told "This person isn't accepting friend requests from you"
  (or "...conversations"), the same whichever choice the other person made, so it does not say what they chose.
- **Another server.** The person's own server decides. It tells the asking server early, with the profile lookup (a
  `contact` verdict), so the sender is refused straight away with the same message instead of sending something that
  vanishes. It decides again when the request or conversation actually arrives, so a server that skips the question gets
  nothing through: a friend request that is not allowed is not shown to the person, and the sender sees it as **declined**
  (which is what it looks like whether a person or a setting said no); a conversation is refused `403 contact_not_allowed`
  and not created. A group is made only if **every** person added accepts it.
- **"A community in common" across servers.** A server holds the member list of the communities it hosts, but of one hosted
  elsewhere it only knows its own members and the owner, so for those it **asks the community's home server** whether the
  sender is in it (only for a person who chose this setting, at most ten such servers per decision, and an answer that is not a
  clear yes, such as a server that is down, counts as no). That is also why the home server answers
  `GET /federation/v1/communities/{id}/membership` for a server that already has a member there.

## Communities that stay on your server

Each community's managers choose who may join it (**Settings -> General -> Who can join**): anyone with the community code
(how every community started), only people with an invite, or **only people on this server**. There is nothing for you to
set as the operator; this is how a community on your server keeps to your own people even though the server federates.

A community that takes only your server's accounts is invisible to other servers: someone elsewhere who tries to join it,
with or without an invite, is told it does not exist (the same answer as for a code nobody has), and a server with no member
in it is told the same when it asks about it. It does **not** remove anyone: people from other servers who were already in
stay in. Switching a community to this is therefore not a way to evict them; kick or ban them for that.

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

**Who can be found.** Run through the real Settings page, two real servers and a browser (the end-to-end suite,
`e2e/tests/discoverability.spec.ts`): a person on `bob.test` hides, and someone on `alice.test` adding them is told "No
one with that name was found"; they stop hiding and the request goes through; friends who were already talking keep
talking in both directions while one of them is hidden; someone on the hidden person's own server can still find them.
The integration tests cover each relationship that keeps a server able to find them, the identical answers for a hidden and
a missing person, and the server-wide modes.

**Who can contact people.** Run through the real Settings page, two real servers and a browser
(`e2e/tests/contact.spec.ts`): someone who accepts only their own server refuses a friend request from the other and accepts it
once they change their mind; a person on the same server still gets through; with "people I share a community with" a request
from another server is refused until they are both in a community, and then goes through (the community's home server is asked);
a friend can still start a conversation, and what already exists carries on.

**Communities.** Run through the real settings dialog and two real servers (`e2e/tests/community-visibility.spec.ts`): a
community set to "only people on this server" cannot be found from the other server and can from its own; an invite-only
community tells someone with just its code so, and opening it again lets them in; someone from the other server who was
already in stays in. The community's `openJoin` is still sent (derived from the new setting), and the existing database was
carried over by the migration: a community that needed an invite became invite-only, every other became "anyone with the
code".

Not run: a real Kubernetes or Compose deployment with these settings (the chart renders the variables and CI checks
that, including that a domain in both lists, or a value that is not one of the three modes, is refused at install time;
the Compose file passes them through), and the desktop app.

## Not done yet

- **A server-wide default or lock** for who may contact people (the findable setting has one).
- **A notice on someone's profile or in the friend search** that they do not accept requests from you: you find out when
  you try.
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
