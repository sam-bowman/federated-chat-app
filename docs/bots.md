# Bots

A **bot** is an account for a program, not a person. It can read and send messages, react, and catch up on what it missed, in the
communities whose managers have added it. Phase 1 of [#132](https://github.com/sam-bowman/federated-chat-app/issues/132): bot accounts,
tokens, the REST API and the WebSocket. Incoming webhooks are in [webhooks.md](webhooks.md); cards (embeds) are below; slash commands and buttons are not built yet (see the end).

The reference for every call is [api/reference.md](api/reference.md) (operations that accept a bot are marked with the `botAuth` scheme),
and [`examples/echo-bot`](../examples/echo-bot) is a small working bot written against it.

## Making a bot

1. Open **Settings → Developer** (it appears on servers that have bots), choose a name and **Make a bot**. A name is 3 to 32 lowercase
   letters, digits or underscores, from the same pool as everyone's.
2. **Copy the token now.** It is shown once. Only a fingerprint (SHA-256) is kept, so it cannot be shown again; if you lose it, use **New
   token**, which stops the old one working.
3. Ask a manager of the community (someone with **Manage community**) to add it: **Community settings → General → Add a bot**, by the bot's
   name. The bot joins like a member, holding the `@everyone` role. Give it more with the ordinary roles, and take it away with the ordinary
   **Remove**. A bot is held to exactly what a member is.

A person may have a few bots (`BOTS_PER_USER_LIMIT`, 5 by default). Deleting a bot erases it as an account is erased: its token stops
working at once, it leaves every community, its messages are deleted, and its name stays taken.

## Using the token

Send it as `Authorization: Bot <token>`. **Never in an address**: addresses end up in logs. A token that is wrong, replaced, or whose bot
was deleted or suspended is refused with `401 invalid_token`, at once.

A bot may call only these (everything else, including every account, security and management operation, answers `401`):

| What | Call |
| --- | --- |
| Who am I | `GET /api/v1/users/me` |
| My communities (with channels, roles, members) | `GET /api/v1/communities`, `GET /api/v1/communities/{id}` |
| Read a channel | `GET /api/v1/channels/{id}/messages` |
| Send a message | `POST /api/v1/channels/{id}/messages` |
| Edit or delete a message | `PATCH` / `DELETE /api/v1/messages/{id}` (its own; others' only with Delete messages) |
| React, or take a reaction back | `POST /api/v1/messages/{id}/reactions`, `DELETE /api/v1/messages/{id}/reactions/{emoji}` |
| Catch up on what it missed | `GET /api/v1/sync?cursor=…` |

A bot cannot create communities, change roles or channels, send friend requests, start conversations, upload files or sign in. In a
community it can do what its roles allow, and nothing outside the communities it is in (a channel of another community answers `404`).

## Listening for messages

Connect a WebSocket to `/ws` (`wss://…` for an https server) **with the `Authorization: Bot <token>` header**, not a token in the address
(the address form is for the apps and is refused for a bot). The same events the apps get arrive as JSON, only for the bot's communities:

```json
{ "type": "message:created", "channelId": "…", "message": { "id": "…", "content": "!ping", "sender": { "isBot": false, "…": "…" } } }
```

Others you may want: `message:edited`, `message:deleted`, `message:reaction_added`, `message:reaction_removed`, `channel:created`,
`community:updated` (the community changed, so fetch it again). A bot is **not** told about its own messages.

A socket stays open for days. If the token is replaced, the bot is deleted or suspended, or bots are switched off, the server closes it
with code `4001` (at once on the replica that made the change, within about 30 seconds on another). Do not reconnect on `4001`: the token
is no longer good. On any other close, reconnect with a growing delay, then call `GET /sync` with the cursor of the last event you
handled to get what you missed (the example keeps it simple and does not).

## Cards (embeds)

A bot can send a **card**: a structured block under (or instead of) its text, with a title, a description, fields, a colour, a footer and
pictures. Add `embeds` to `POST /channels/{id}/messages` (up to 3 cards), and change them later with `PATCH /messages/{id}` (`embeds`
replaces all the cards, `[]` takes them off, leaving it out keeps them). A message needs text or a card; only bots may send them.

```json
{
  "content": "Found it:",
  "embeds": [{
    "title": "Dune", "url": "https://example.com/dune", "color": "#5865f2",
    "description": "A 2021 film.\nDirected by Denis Villeneuve.",
    "fields": [{ "name": "Year", "value": "2021", "inline": true }, { "name": "Rating", "value": "8.0", "inline": true }],
    "footer": "via requests", "image": "https://example.com/poster.png", "thumbnail": "https://example.com/small.png"
  }]
}
```

| Part | Limit |
| --- | --- |
| `title` | 150 characters |
| `description` | 1,500 characters, line breaks kept |
| `fields` | 10, each `name` 60 and `value` 300 characters |
| `footer` | 100 characters |
| `url`, `color` | an http(s) address with no credentials; `#rrggbb` (anything else is dropped) |
| all the words in a message's cards | 4,000 characters |

- **Plain text only.** No markdown, no HTML, and the only link is the title's `url`. Control and direction-override characters are removed.
- **Too long is a `400`, not a quiet cut:** `invalid_embeds` (a part is over its limit, or a card shows nothing: it needs a title, a
  description or a field) or `embeds_too_large` (all the words together).
- **Pictures are copied, never linked.** `image` and `thumbnail` are addresses of pictures (PNG, JPEG, GIF or WebP, up to 2 MiB). The server
  that accepts the message fetches each **once** (with the same protections as link previews: no private addresses, the file's own bytes decide
  what it is), keeps its own copy and shows that, so a reader's browser never contacts your server. That happens after your request is answered,
  so the answer and the first announcement have the card **without** its pictures, and the card is announced again (the `message:embeds` event,
  which carries `richEmbeds` as well as link previews) when they are ready. It happens only on servers that keep pictures
  (`LINK_PREVIEW_IMAGES_ENABLED`), up to 60 pictures an hour per bot; otherwise the card is shown without them.
- A bot's card is **not** a link preview (`embeds` in a message, which is what the server read from a page): cards are `richEmbeds`.
- People on other servers in the community see the cards too (older servers show the message's text, or a plain stand-in for a message that
  is only cards).

The example bot sends a card for `!card <words>`.

## Limits

- **Per bot**: `BOT_RATE_LIMIT_MAX` requests a minute (120 by default), counted for each bot separately. Past it: `429`.
- **Per address**: every request, a bot's too, is also counted against the server's general limit (`RATE_LIMIT_MAX`, 300 per 15 minutes
  by default). A bot that talks a lot, or several bots on one machine, need an operator who raises it.
- Wrong tokens count against the address like any failed request.

## Security

- A token is a long-lived credential: treat it like a password. Anyone with it can act as the bot in every community it is in.
- **Add only bots you trust.** Anyone on the server can make a bot, and any manager can add any bot by name; once added, it reads every
  channel its roles let it see. Remove it at any time (**Remove**, or ban it).
- A bot is marked **Bot** beside its name everywhere, so nobody mistakes it for a person.
- What a bot does is in the community's audit log (adding it) and the server's (making, replacing a token for, and deleting one): ids and
  names only, never a token.
- A bot cannot be found, befriended or messaged, is never visible to other servers, cannot own a community and cannot be an admin.

## For the operator

| Setting | Default | What it does |
| --- | --- | --- |
| `BOTS_ENABLED` | `true` | `false` stops creating bots and refuses every bot's token (nothing is deleted; an owner may still delete). Strict: a typo stops the server starting. |
| `BOTS_PER_USER_LIMIT` | `5` | How many bots one person may have (0 to 50). |
| `BOT_RATE_LIMIT_MAX` | `120` | Requests per bot per minute. |

The discovery document says `features.bots` so a client knows whether to offer Settings → Developer.

## Not built yet (later phases of #132)

- **Outgoing webhooks** (events posted to the bot's URL). Incoming webhooks, a URL a script can post to, are in [webhooks.md](webhooks.md).
- **Slash commands, buttons and select menus** (what makes a bot like Requestrr feel native): [design note](commands-design.md). Cards (embeds) are built.
- **Bots in other servers' communities.** A bot can only join a community its own server hosts. People on other servers who are in such a community see its messages and reactions marked **Bot** (the server says so in what it relays); a server that predates this shows them as a person's.
- **Direct messages with bots**, **file uploads** by a bot, and a **bot directory**.
