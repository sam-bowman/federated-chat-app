# Incoming webhooks: design note

> Part of the [documentation](../README.md#documentation). Design note for phase 2 of [#132](https://github.com/sam-bowman/federated-chat-app/issues/132)
> (see [bots.md](bots.md) for phase 1, which is built). **Nothing here is built.** It lists the decisions, says which one I recommend and
> why, and ends with the questions that are yours.

## What it is for

A **webhook** is a URL a script can `POST` to, to put a message in one channel: Sonarr and Radarr notifications, a CI job, a cron script, a
monitoring alert. The sender cannot hold a websocket open or log in; usually it can only be given an address. That last point drives most
of the design below.

## Scope: incoming only, for now

The issue also lists **outgoing** webhooks (the server POSTing events to a bot's URL). I recommend leaving them out of this phase:

- A bot that wants events already has the websocket and `GET /sync` to catch up; nothing is blocked on outgoing.
- It makes the server call arbitrary addresses on someone's behalf: the same SSRF surface as link previews (it would have to reuse
  `safeLookup` and the per-hop checks), plus signing, retries, delivery logs and disabling a URL that keeps failing. The federation outbox
  is keyed by peer domain and signed with the server's key, so it is not reusable as it stands.
- It is a design of its own. Build it when a real bot cannot hold a socket.

## Decisions

### 1. Who is the sender? A synthetic bot account per webhook (recommended)

A message must have a `senderId` (a required `User`), and everything downstream (serialising, the Bot badge, reactions, reports, erasure,
the federation relay and its `fromIsBot` flag) already works for a user sender. Making the sender optional would touch all of it.

So each webhook owns a **synthetic bot user**: `isBot`, no password, no token (`botTokenHash` null, so the bot REST API and websocket never
accept it), `botOwnerId` null (so `GET /bots` does not list it), username `~webhook-<protocolId>` (the sign-up pattern can never make a `~`
name, the same trick the erased-account tombstones use, so it cannot clash with or be found as a person), and the webhook's name and picture
as its display name and avatar. It is **not a community member**, so it does not appear in the member list and is not a recipient of events.

What this costs: every place that reads `isBot` to mean "an account somebody owns" must be checked. The list to review in the
implementation: `GET /bots` (excluded by the null owner), `POST /communities/:id/bots` (must refuse it), the admin users list and its
`LOCAL` filter, `purgeAccount`, user search, and `isVisibleToDomain`. Each gets a test that plants a webhook and expects it to be left out.

**No per-request name or picture.** Discord lets the sender of a webhook choose the name and avatar of each message. Here the name is set
once by the community manager. A sender that can pick its own name can pose as a member, and nothing a CI job needs requires it.

### 2. Who may make one? A new permission bit, `MANAGE_WEBHOOKS`

A webhook posts **without** the `SEND_MESSAGES` check, in a channel of its manager's choice, so creating one is a way to give a program a
voice the roles may not have given it. Reusing `MANAGE_COMMUNITY` would hand that to everyone who can edit the community; a separate bit
lets an owner delegate integrations alone, as `REVIEW_REPORTS` lets them delegate moderation alone.

- Bit 12 (value 4096), **not** in the defaults, **not** implied by `MANAGE_COMMUNITY`, the owner holds it as every bit. The client's role
  editor must offer it (`permissions.test.ts` fails otherwise).
- On a community this server **hosts** only (409 `not_community_home` otherwise, as invites and bots).

### 3. The secret is in the address

Bots send `Authorization: Bot <token>` and the guide says never to put a token in an address. A webhook is different: the senders that
matter can usually only be given a URL, so **the URL is the secret** (`POST /api/v1/webhooks/{id}/{secret}`), and the header form is not
offered. To make that safe enough:

- The secret is 32 random bytes, base64url, with a prefix (`mcw_`) so a leaked one is recognisable to scanners. Only its SHA-256 is kept.
- Shown **once**, at creation and at **New URL** (rotation), which stops the old one at once. Never in a list, an audit entry or a log.
- A wrong secret and an unknown id answer the **same** `404 not_found` after the same work (compare against a dummy hash when the id does not
  exist), so neither is a probe.
- **Logs.** `app.ts` logs `req.originalUrl` when a request fails (a 500), which would write the secret to the server log. That line must
  print the route, not the path, for this endpoint. The operator's reverse proxy access log is theirs; the guide says to keep it private.
- Limits: the per-address limiter (every request counts, wrong secrets included) plus a **per-webhook** one, `WEBHOOK_RATE_LIMIT_MAX`
  (30 a minute by default), applied after the secret is verified. Body size stays at the server's JSON limit; `content` is 1 to 8,000
  characters like any message.

### 4. What can be posted

v1 takes `{ "content": "…" }` and nothing else: text, with the ordinary link previews if they are on (read as the webhook's synthetic user,
so the per-person read limit applies to it). No attachments, no embeds (embeds are phase 3 and belong to the message model, not to webhooks).

**Compatibility adapters** (a body shaped like Discord's or Slack's, which Sonarr, Radarr and Grafana already know how to send) are a
possible later step: each would be a pure translation to the same `content` call, behind its own path. Not in v1; worth asking whether
you want one first, since it decides whether your own tools work without a script in between.

### 5. One channel each, and what deleting does

A webhook is bound to **one text channel** (changeable by its manager). Deleting the channel or the community deletes the webhook with it
(cascade). Deleting a webhook **keeps its messages**, shown under its name: a CI history should not vanish when the integration is
retired. That means the synthetic user row stays as an inert, retired user (no webhook, no way to post). Rows left by a deleted channel or
community have no messages either and can be pruned by the existing daily maintenance. (A bot's deletion erases its messages; this
deliberately differs, because a bot is a person-like account and a webhook is a pipe.)

### 6. Other servers see it as a bot, with its real name

Messages relay to other servers like any member's, with `fromIsBot: true` (already built). The catch: `ensureRemoteUser` caches the sender
by `fromUsername`, and a remote server shows that as the name, so people on other servers would read `~webhook-01J…`. (The same is true of
a bot today: it shows its plain username there, which is the known limit PR #340 left.) I recommend carrying an optional
**`fromDisplayName`** in the community message relay, the same shape and the same compatibility as `fromIsBot` (older servers ignore it,
and the receiver treats it as untrusted text, length-capped and cleaned like a profile field). That fixes bots too. The picture stays
absent on other servers for now.

### 7. Audit, reports, moderation

- **Audit** (the community's log, ids and labels only): `webhook.create`, `webhook.update` (field names), `webhook.rotate`,
  `webhook.delete`. Never the secret. A message posted by a webhook is not audited (as a member's is not).
- A member can **report** a webhook message like any message (it reaches the community's reviewers). Moderators with `DELETE_MESSAGES` can
  delete it. There is no ban for a webhook: the manager deletes or rotates it.
- **Limits and switches:** `WEBHOOKS_ENABLED` (strict boolean, default on, environment only like `BOTS_ENABLED`, `features.webhooks` in the
  discovery document; off refuses posting at once and hides the settings tab), `WEBHOOKS_PER_COMMUNITY_LIMIT` (default 10).

## Shape of the API

| Call | Who | Notes |
| --- | --- | --- |
| `POST /api/v1/webhooks/{id}/{secret}` `{content}` | whoever has the URL | `201 {id}`; `404` for a wrong id or secret, a deleted webhook, webhooks switched off, or a deleted channel; `400` invalid; `429` |
| `GET /api/v1/communities/{id}/webhooks` | `MANAGE_WEBHOOKS` | never the secret |
| `POST /api/v1/communities/{id}/webhooks` `{name, channelId, avatarUrl?}` | `MANAGE_WEBHOOKS` | `201 {webhook, url}`, the URL shown once |
| `PATCH …/webhooks/{webhookId}` `{name?, channelId?, avatarUrl?}` | `MANAGE_WEBHOOKS` | |
| `POST …/webhooks/{webhookId}/url` | `MANAGE_WEBHOOKS` | rotates: `{url}`, the old one stops working |
| `DELETE …/webhooks/{webhookId}` | `MANAGE_WEBHOOKS` | `204` |

The post endpoint has no header credential, so `apiReference.test.ts` needs the same treatment as the other operations that answer `404`
to a stranger (`x-hidden-from-others`) rather than the `401 missing_token` check.

## Data

A `Webhook` table: `protocolId`, `communityId` and `channelId` (both cascade), `senderId` (the synthetic user, unique), `createdById`
(set null on deletion), `name`, `secretHash` (unique), `createdAt`, `lastUsedAt` (written at most once a minute, so a busy webhook is not a
write per message). The user row and the `Webhook` are made in one transaction.

## Client

**Community settings → Integrations** (the tab appears with `MANAGE_WEBHOOKS`): a list (name, channel, who made it, last used), **Make a
webhook** (name, channel, optional picture through the existing upload), the URL shown once with a Copy button and a plain warning, **New
URL**, **Delete** (with a confirm that says its messages stay). Its messages show the existing **Bot** badge in v1; a separate "Webhook"
label is possible but needs a flag in the user payload, so I would leave it.

## Build order

1. **Server** (one PR): the table and migration, the bit, the routes, the post endpoint, limits and switches, audit, `fromDisplayName` in the
   relay, OpenAPI and the reference, `docs/webhooks.md` (the guide, replacing this note), tests and mutation checks, including a test that
   every place listed in decision 1 leaves a webhook out.
2. **Client + e2e** (a second PR): the Integrations tab, the role editor bit, and a browser test that posts to the URL with a plain HTTP
   request, sees the message with the badge, rotates the URL and watches the old one stop, and on two servers sees the name and badge.

## Not covered, on purpose

Outgoing webhooks; per-message name and picture; attachments and embeds; Discord and Slack body adapters; webhooks in communities hosted on
other servers; a "Webhook" label distinct from "Bot"; IP allow lists for the sender.

## Questions for you

1. **`MANAGE_WEBHOOKS` as a new bit** (my recommendation), or reuse `MANAGE_COMMUNITY` and skip the bit?
2. **Is deleting a webhook leaving its messages** right, or should it erase them as deleting a bot does?
3. **Carry `fromDisplayName`** to other servers (small protocol addition that also fixes bots' names there), or accept `~webhook-…` names
   on other servers for now?
4. **A Discord-style adapter** in the first server PR (so Sonarr and Radarr can post without a script), or native JSON only to start?
5. Is **deferring outgoing webhooks** right?
