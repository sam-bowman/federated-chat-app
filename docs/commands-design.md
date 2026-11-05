# Slash commands, buttons and embeds: design note

> Part of the [documentation](../README.md#documentation). Design note for phase 3 of [#132](https://github.com/sam-bowman/federated-chat-app/issues/132)
> (phase 1, [bots](bots.md), and phase 2, [incoming webhooks](webhooks.md), are built). **Nothing here is built.** It lists the decisions,
> says why, and the last section records the answers that settled the open ones. **3a (embeds, with pictures) is built**: see "Cards" in [bots.md](bots.md). **3b (slash commands) is built**: see "Slash commands" in [bots.md](bots.md). The plan for 3c (buttons and select menus) is in [commands-3c-plan.md](commands-3c-plan.md).

## What it is for

The motivating bot is Requestrr: someone types `/request movie Dune`, the bot answers with a card (poster, summary), and a row of buttons
("Which Dune did you mean?") turns the answer into a conversation. Three things make that feel native instead of like a script reading chat:

1. **Embeds**: a message that is a structured card (title, description, fields, picture), not only text.
2. **Slash commands**: the app offers `/request`, asks for its options, and sends the bot a structured call, so no bot parses free text.
3. **Components**: buttons and select menus on a bot's message, and a press that comes back to the bot.

They are separable, and each is useful alone (embeds also help webhooks later), so they are built in this order, a server PR and a client
PR each: **3a embeds, 3b commands, 3c components**, then **3d** for people on other servers (below).

## What is already there, and what it constrains

- A bot **is** a member with a token and a websocket; it already sends, edits, deletes and reacts. Everything new follows `requireAuthOrBot`'s
  rule: a new route refuses bots until it is named in the reference as `botAuth` (`apiReference.test.ts` enforces it).
- `Message.embeds` **already exists, and means link previews**: what the author's server read from a linked page, three at most, plain text
  (`lib/linkPreview/embed.ts`). A bot's card is a different thing (chosen by the bot, much richer), so it gets its **own column** and its own
  validator. Reusing the column would let a bot's card be mistaken for, replaced by, or hidden along with the previews (turning previews off
  hides stored ones; editing a message rebuilds them).
- The composer is a single-line `<input role="combobox">` with `:` suggestions (`Composer.tsx`). A `/` picker is the same pattern.
- Everything in a bot's output is a **stranger's text** shown to other people: validated on the way in and again when shown, drawn as text,
  every address checked (no credentials, http(s) only), never HTML. The same discipline as link previews, reports and profiles.
- A bot lives on **one server**. People on other servers reach it only through the home server's relay, which matters for 3d.

## 3a. Embeds

A message sent by a bot (and later a webhook) may carry up to **3 embeds** next to its text. Caps, all enforced on the way in, on storage
and on what another server relays, by one `parseRichEmbeds` that never throws:

| Field | Limit |
| --- | --- |
| `title` | 150 characters, one line |
| `description` | 1,500 characters, line breaks kept |
| `url` (makes the title a link) | an absolute `http(s)` address, no credentials, 2,048 characters |
| `color` | `#rrggbb` |
| `fields` | at most 10 of `{name (60), value (300), inline}` |
| `footer` | 100 characters |
| `thumbnail`, `image` | one address each, an absolute `http(s)` address: the server keeps its own copy (below) |
| all text in one message's embeds | 4,000 characters |

Drawn as text only: no markdown, no links inside text (only the explicit `url`), emoticons and emoji as in a message. Embed-only messages are
allowed, but a message always carries non-empty `content` on the wire (a fallback built from the first title when the bot sent none),
because servers that predate embeds require it and show only that.

Stored in `Message.richEmbeds` (JSON) and returned by `serializeMessage` like `embeds`; changed by the bot's `PATCH /messages/{id}` (that is how a
card is updated); relayed to other servers as an optional `richEmbeds` that older servers ignore. A report snapshot includes an embed's title
and description text, cut like the message text.

**Pictures, in this first version.** Letting a card name any image address means every reader's browser contacts the bot author's server
when it loads the message: the reader is tracked, and the address can change after the fact. Link previews solved this by having the server
fetch the picture **once** through the guarded fetcher and keep its own copy, and embed pictures do the same, on the same machinery
(`fetchImage`, `imageInfo`: PNG, JPEG, GIF and WebP by their bytes, never SVG, size limits, the stored name from the kind found and never from
the address, `uploadFile`):

- A bot names an address in `image` or `thumbnail`; the card is **stored and announced at once without it**, the server fetches it after the
  answer (like previews, never inside the request), keeps a copy, and announces the message again with the copy. The existing
  `message:embeds` event and the federation `.../embeds` relay carry `richEmbeds` as well, and announcements of one message stay serialised
  (`announceEmbeds`), so a late picture cannot overwrite a newer edit.
- The whole feature is behind `LINK_PREVIEW_IMAGES_ENABLED`, and with it off a card shows without pictures. At most 2 pictures per embed
  and 4 per message.
- **A bot gets its own picture budget** (per bot per hour) on top of the server-wide caps the previews use, so a bot posting cards cannot
  use up the hour's allowance that link previews live on.
- **A trap to build around:** `pruneImages` removes copies that no message names, and it finds the ones in use by reading `Message.embeds`.
  It must read `Message.richEmbeds` too, or a copy a card is using would be deleted under it within two days. A test plants a card, ages the
  copy and checks it survives.
- The copy's address is what the card shows and what is relayed, so the reader's browser contacts the **sender's server**, never the bot
  author's (the same as a remote attachment).

## 3b. Slash commands

**Registering.** A bot sends its whole set at once: `PUT /api/v1/commands` (bot token), replacing the previous set (so removing a command is
leaving it out, and the call is safe to repeat). A command is `name` (1 to 32 of `a-z 0-9 _ -`), `description` (up to 100), and up to 10
`options`: `{name, description, type, required, choices?}` where `type` is `string`, `integer`, `number`, `boolean`, `member` or `channel`,
and `choices` (up to 25 fixed values) are optional. A bot may have 50 commands. They belong to the **bot**, not to a community: they show up
in every community the bot is a member of, and disappear when it is removed. Two bots with a `/play` are told apart in the picker by the bot's
name, and a call names the **command id**, never just a word, so one bot cannot receive another's call.

**Finding them.** `GET /api/v1/communities/{id}/commands` lists them, with the bot that owns each; the client asks when it opens a community
and again on the `community:updated` event (a bot added or removed) and a new `commands:updated` event (a bot changed its set).

**Typing one.** Typing `/` as the first character of an empty message, in a community that has commands, opens a list of them (name,
description, the bot's name and **Bot** badge), filtered as you type; Enter or a click picks one. Anything that is not a command is sent as
text as it is today: `/shrug`, a path, an unknown `/foo` are never intercepted, and Escape closes the list. The options are then asked for
in a small form above the composer (one labelled field per option, a menu for `choices`, a member or channel chooser for those types) with
**Send**. A form, not a typed `name:value` syntax, because the form validates, explains and needs no parsing rules; this is the one part
that is a real piece of interface design, and it is a question below. The picker says, once, that the bot will see what you enter.

**What the bot gets.** Sending a command is `POST /api/v1/communities/{id}/channels/{channelId}/commands/{commandId}` `{options}`. The server
checks the sender, that the bot is a member, that the options match the command's types, and creates an **interaction**: a short-lived row
(`Interaction`: its id, the bot, the community and channel, the person, the command and options, the time, when it was answered) so the answer
can be checked. The bot receives it on its websocket as `interaction:created` with `{id, type: "command", command, options, user, channelId,
communityId}`. It is **live only**: not stored in the sync log and not replayed, because it is useless after a few seconds, and it goes
through `sendToUser`, so it reaches a bot on another replica. A bot that is not connected cannot answer; the person sees "The bot didn't
respond" after 3 seconds (no outgoing webhooks yet, which is the natural way for a bot without a socket to be reached, and the reason to build
them next if one needs it).

**Answering.** `POST /api/v1/interactions/{id}/callback` with the bot's token (the id is not a secret, the token is, and the call is refused
unless this bot is the one the interaction was addressed to), once, within 3 seconds to *start* answering and 15 minutes to finish:

- `message`: a normal message in the channel (text and embeds; components in 3c), sent as the bot and marked "**@olive used /request**" (a
  small `interaction` field on the message with the person's id and the command's name);
- `ephemeral`: visible **only to the person who ran it**, delivered as a live event, never stored as a message and gone on reload;
- `deferred`: "the bot is thinking", answered later within 15 minutes by `POST /api/v1/interactions/{id}/followup`.

**Who may run one, and what the reply needs.** A new permission bit, **`USE_COMMANDS`** (bit 13, value 8192), so a community can stop
people running commands while still letting them talk. It is a **default**, back-filled by value into every existing `@everyone` role as
`CREATE_INVITE` and `CONNECT_VOICE` were, so nothing changes until a manager takes it away (and the client's role editor must offer it).
Running a command needs **both** `USE_COMMANDS` and `SEND_MESSAGES`, because a public reply is a message the person caused: someone who
has been stopped from sending messages must not be able to post through a bot. A bot's visible reply needs the bot itself to hold
`SEND_MESSAGES` (a manager who takes it away expects silence: "a bot is held to exactly what a member is"). An ephemeral reply needs
neither on the bot's side, it is not posted.

**Limits and safety.** The per-bot rate limiter already covers the callback; an interaction can be answered once; the person's options are
validated against the registered types before the bot ever sees them; an unknown or mismatched command id is a 404 that looks like any other.
Privacy: a command's arguments go to a third party the person chose to use, which is exactly what the picker says.

## 3c. Components

A bot's message may carry up to 5 rows of components: a row is up to 5 **buttons** or one **select menu**. A button has a `label` (80), a
`style` (`primary`, `secondary`, `danger` or `link`), a `customId` (100, the bot's own) and `disabled`; a `link` button has an http(s) `url`
instead and just opens it (through the same link rules and `rel`s as an address in a message, with the host shown). A select has up to 25
`options` (`label`, `value`, `description`), `minValues`/`maxValues`, a placeholder and `customId`. All validated like embeds (`parseComponents`),
stored in `Message.components`, shown to everyone who can see the message, relayed as an optional field.

**A press** is an interaction of type `component` sent to the bot exactly as a command is (`{id, type: "component", customId, values,
messageId, user, ...}`), answered with the same callback plus one more kind: `update`, which edits the message the button was on (the usual
way to disable the buttons after a choice). Anyone who can see the message can press, because the bot decides whether that person is allowed
(it knows who pressed). A press on a message whose bot is gone or offline fails the same way a command does, with the same words. A
button on a message the bot has since deleted or edited away is simply not drawn.

## 3d. People on other servers (not in this phase)

The bot and its interactions are on the **home server**. A person on another server who is in the community sees embeds and components
because they are relayed with the message, but **cannot run a command or press a button in 3a to 3c**: their client shows components
disabled with "Only people on this server can use these", and offers no commands in a community hosted elsewhere. Making it work is a proxy
(their server sends the call to the home server, as it already does for sending a message), plus a way to deliver an *ephemeral* reply back
to a person on another server (one signed event to their server), so it is a phase of its own after local use has proved the shapes.

## Data

`Message.richEmbeds` and `Message.components` (JSON, nullable); `Message.interaction` (JSON: the person's protocolId and the command's name,
cleared when that person's account is erased, with a test); `BotCommand` (bot, protocolId, name, description, options JSON, unique per bot
and name); `Interaction` (the short-lived rows above, pruned hourly like the other short-lived tables). One new permission bit,
`USE_COMMANDS`, back-filled into `@everyone` by its migration.

## Build order

1. **3a embeds, with pictures**: server (`richEmbeds`, validation, bot send/edit, the picture copy and its budget, `pruneImages` reading
   `richEmbeds`, relay, OpenAPI, tests, mutation checks) then client (drawing a card, with its pictures), and a browser test that a bot's card
   shows on both servers, pictures included. Webhooks can take embeds right after, as a small PR.
2. **3b commands**: server (the `USE_COMMANDS` bit and its migration, registration, listing, the `interaction:created` event, callback and
   follow-up, ephemeral delivery, `Interaction` rows and pruning, the example bot grows a command) then client (the picker, the options form,
   the role editor's new bit, ephemeral display, the "used /x" line), and a browser test with the example bot answering a real command.
3. **3c components**: the same two halves, including `update` and disabled-after-press.
4. **3d** (people on other servers) when wanted.

## Not covered, on purpose

Autocomplete (the bot answering live suggestions as someone types), per-community or per-channel command settings, per-command permissions,
message and user context menus, modals (a pop-up form a bot opens), voice or federated commands, commands in direct messages, a bot
directory, and outgoing HTTP delivery of interactions (the way a bot with no websocket would be reached).

## Decisions

Settled before building:

1. **Embed pictures are in the first version**, copied by the server like link-preview pictures (never hotlinked), with a budget of their own.
2. **Command options are asked for in a small form** above the composer, not a typed syntax.
3. **Commands belong to the bot** and appear in every community it is in; a community does not pick which to enable.
4. **A new `USE_COMMANDS` permission bit** (a default, back-filled into `@everyone`), needed together with `SEND_MESSAGES`.
5. **People on other servers cannot run commands or press buttons at first**; the federated half is a later phase (3d).
6. **"The bot didn't respond" after 3 seconds is acceptable**: a bot must hold a websocket; HTTP delivery of interactions waits for outgoing webhooks.
