# Incoming webhooks

> Part of the [documentation](../README.md#documentation). Phase 2 of [#132](https://github.com/sam-bowman/federated-chat-app/issues/132);
> phase 1, bot accounts, is in [bots.md](bots.md).

A **webhook** is a secret address a program can `POST` to, to put a message in one channel: a CI job, Sonarr or Radarr, a cron script, a
monitoring alert. Whatever sends it only needs to be given an address. It does not log in and does not hold a connection open.

The reference for every call is [api/reference.md](api/reference.md) (the *Webhooks* section).

## Making one

1. You need the **Manage webhooks** permission in the community. The owner has it; it is **not** a default and **not** part of *Manage
   community*, so an owner can give integrations to someone without giving them the rest. A webhook posts **without** the *Send messages*
   permission, which is why it has a permission of its own.
2. Open **Community settings → Integrations**, choose a name (how its messages are shown), a text channel and, if you like, a picture. (Or
   call `POST /api/v1/communities/{id}/webhooks` with a `name` and a `channelId`.)
3. **Copy the address now.** It is shown once. Only a fingerprint (SHA-256) of its secret is kept, so it cannot be shown again; if you lose
   it, choose **New address** (`POST …/webhooks/{webhookId}/url`), which stops the old one working at once.

A webhook belongs to one text channel (you can move it to another), and a community may have a few (`WEBHOOKS_PER_COMMUNITY_LIMIT`, 10 by
default). Deleting the channel or the community deletes its webhooks. Deleting a webhook **keeps the messages it posted**, shown under its
name.

## Posting

```bash
curl -X POST "https://chat.example.com/api/v1/webhooks/<id>/<secret>" \
  -H "Content-Type: application/json" \
  -d '{"content": "Build 42 passed"}'
```

The answer is `201 {"id": "<message id>"}`. `content` is 1 to 8,000 characters, like any message; links in it get the same previews as any
message when the server has them on. That is all a webhook can send for now: text only, no attachments or embeds.

Everything that can go wrong with the address is the **same `404 not_found`**: a wrong id, a wrong or replaced secret, a deleted webhook or
channel, and a server with webhooks switched off. So the answer never says whether an id is real. A body that is not valid is `400`, and
more than `WEBHOOK_RATE_LIMIT_MAX` posts a minute to one webhook (30 by default) is `429`. Every request, wrong secrets included, also counts
against the server's per-address limit.

## What the messages look like

The message is sent by an account of the webhook's own, marked **Bot** beside the name you gave it, in the channel and in the member's
history like any other message. That account is **not a member** (it is not in the member list) and **not a person**: it has no password or
token, cannot be found, befriended or messaged, and is never visible to other servers by any lookup. Its messages can be reported and
removed by moderators like any message. People on other servers in the community see its messages with its name and the Bot mark too.

The webhook cannot choose its own name or picture per message: a sender that could would be able to pose as a member. The manager sets
them, and changing them changes how the earlier messages are shown too.

## Security

- **The address is a credential.** Anyone who has it can post in that channel as the webhook, without the *Send messages* permission. Share
  it only with the program that needs it, keep it out of repositories and logs, and replace it if it leaks (**New address**, or `POST …/webhooks/{webhookId}/url`).
- The secret is 32 random bytes (`mcw_` and 43 characters, so a secret scanner can recognise it), compared in constant time against a hash.
  It is never in a list, an audit entry or this server's own log: a failed request is logged by its route, with the secret left out. The
  operator's reverse proxy may log full addresses; keep that log private.
- Only people holding **Manage webhooks** can make, change, re-key or delete a webhook, and only on a community **this server hosts**. A
  bot's token is refused on all of it.
- What happens to webhooks is in the community's **audit log**: making, changing, replacing the address of and deleting one, by name and id,
  never the secret. A post is not an event in it.

## For the operator

| Setting | Default | What it does |
| --- | --- | --- |
| `WEBHOOKS_ENABLED` | `true` | `false` stops making webhooks and refuses every post with the usual `404` (nothing is deleted; a manager can still delete). Strict: a typo stops the server starting. |
| `WEBHOOKS_PER_COMMUNITY_LIMIT` | `10` | How many webhooks one community may have (0 to 100). |
| `WEBHOOK_RATE_LIMIT_MAX` | `30` | Posts to one webhook a minute. |

The discovery document says `features.webhooks`. The Helm chart has `server.webhooks.enabled` and `server.webhooks.perCommunityLimit`.

## How it works (for contributors)

- Each webhook owns a synthetic user (`User.isWebhook`, also `isBot`, no owner, no token, username `~webhook-<id>`, which the sign-up
  pattern can never produce). The message model, the Bot badge, reports and the relay to other servers therefore work unchanged. It is left
  out where an *account* is meant: `GET /bots`, adding a bot to a community, the operator's and the admin page's account lists and counts.
- `deliverChannelMessage` (`modules/channels/deliver.ts`) is the one place a channel message is announced (to members live and to other
  servers); the channel's send route and a webhook post both use it.
- The relay to other servers carries `fromIsBot` and `fromDisplayName`, so a webhook is not shown as `~webhook-…` there
  ([protocol/federation.md](../protocol/federation.md)).
- When a webhook is deleted its sender stays, inert, for as long as a message names it; `pruneRetiredWebhookSenders` removes the ones nothing
  names (after a webhook, channel or community delete).

## Not built yet

- **Outgoing webhooks** (the server posting events to a program's address). A bot that wants events has the websocket and `GET /sync`; this
  one needs its own design (the server calling arbitrary addresses, signing, retries).
- **Attachments, embeds and a name or picture per message**, and **adapters for other tools' request bodies** (Discord- and Slack-shaped).
- **Webhooks in communities hosted on another server**, and a **"Webhook" label** distinct from "Bot".
- **A limit that cannot be passed by one**: two webhooks made at the same moment can take a community one past its limit.
