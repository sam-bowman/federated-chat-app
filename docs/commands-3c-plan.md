# Buttons and select menus (phase 3c): implementation plan

> Part of the [documentation](../README.md#documentation). The plan for step 3c of [commands-design.md](commands-design.md) (embeds, 3a, and slash
> commands, 3b, are built). That note fixed the *what*: a message carries rows of buttons or a select menu, a press goes to the bot as an interaction,
> and the bot answers it, usually by editing the message. This one fixes the *how*: the shapes and limits, every route and event, the client behaviour,
> the edge cases, the tests and the PR split. **Nothing here is built.** It ends with the questions that need an answer before building.

## Split

Two PRs, as for cards and commands:

1. **Server**: `Message.components` and its validator, a bot's `components` on send and edit, the press route, the `component` interaction and its
   `update` answer, relay to other servers, the `interaction` snapshot for a press's reply, OpenAPI and the reference, the example bot's `/ask`, and the
   tests with mutation checks.
2. **Client**: drawing buttons and menus under a message, pressing, the waiting and failure states (reusing the notices of 3b), the disabled state for
   people on another server, and a browser test on two servers with the example bot.

Not in 3c: people on other servers pressing (3d), modals, autocomplete, webhooks sending buttons (a follow-up: see the end), outgoing HTTP delivery.

## Shapes and limits

A message carries up to **5 rows**. A row is **up to 5 buttons, or exactly one select menu** (never both). One validator, `lib/messageComponents.ts`
(config-free, with a property test like `richEmbed.ts`), strict on what a bot sends (a part over its limit is `400 invalid_components`, naming the
first problem) and lenient on what is stored or relayed (cut, never throws, idempotent).

```
button  { type: "button", style: "primary"|"secondary"|"danger", label (1-80), customId (1-100), disabled? }
        { type: "button", style: "link", label (1-80), url (http/https, no credentials), disabled? }       a link has no customId
select  { type: "select", customId (1-100), placeholder? (150), options [1-25 of { label (1-100), value (1-100), description? (100), default? }],
          minValues? (0-25, default 1), maxValues? (1-25, default 1), disabled? }
```

Rules: `customId`s are **unique within a message**; option values unique within a menu; `minValues <= maxValues <= options.length`; at most one
`default` unless `maxValues > 1`; all text cleaned like a card's (control and bidi characters removed). A **link button** opens its address in a new tab
through the same rules as an address in a message (`rel="noopener noreferrer nofollow"`, the host shown beside the label, `javascript:` impossible
because only http(s) is accepted twice, here and in the client). Everything is a stranger's text and is drawn as text.

A message with components still needs **text or a card** (`400 invalid_request` otherwise): buttons alone decorate nothing, the same reason a card
needs a title, description or field. Only **bots** may send them (`403 components_bots_only`, as for cards).

## Data

`Message.components` (JSON, nullable), set by the bot's send and PATCH (a list replaces; an empty list removes them), shown to everyone who can see the
message, returned by every message read. It is **not** the link previews' `embeds` or the cards' `richEmbeds`, and is never rebuilt from the text.

`Interaction` gains what a press needs; a command interaction is unchanged:

```
kind        COMMAND | COMPONENT   (default COMMAND, so every existing row and the 3b code stay as they are)
messageId   -> Message (cascade)  null for a command
customId    text?                 the component pressed
values      JSON?                 the chosen option values of a select ([] for a button)
commandName now nullable          a press has none
```

The state machine is unchanged (`RECEIVED` -> `DEFERRED` -> `DONE`, 5 s to start answering, 15 min to finish, pruned a day later). A press counts toward the
bot's 50 pending interactions, so a stuck bot is not sent more.

## Pressing

`POST /api/v1/messages/{messageId}/interactions` `{ customId, values? }` (a person's token; behind a limiter of its own, `componentLimiter`, 60 a
minute per person: paging through results is a burst of presses, which 20 a minute for commands would cut off). The server checks, in this order, with **one
404 that looks like any other** for the first four:

1. the message exists, is not deleted, is in a text channel of a community **this server hosts**, and the caller is a member (else 404);
2. its sender is a **bot** that is still a member of the community (else 404);
3. the message's **stored** components contain a component with that `customId` that is not disabled (else 404 `component_not_found`): a client cannot
   forge a press for something the bot never offered, and a press on a button the bot has since removed fails cleanly;
4. for a select, every `values` entry is one of its options' values and the count is within `minValues`..`maxValues` (else 400 `invalid_values`); for a
   button `values` must be absent or empty;
5. the caller holds the permissions the answer to Question 1 decides;
6. the bot has a live connection anywhere (else `409 bot_offline`, at once, as for a command), and has fewer than 50 pending (else `429 bot_busy`).

It creates a `COMPONENT` interaction and sends the bot `interaction:created` through `sendToUser` only, **live only and never in the sync log**, exactly as
a command is:

```json
{ "type": "interaction:created", "interaction": { "id": "...", "type": "component",
  "component": { "type": "select", "customId": "pick", "values": ["film"] },
  "message": { "id": "...", "content": "...", "richEmbeds": [...], "components": [...] },
  "channelId": "...", "communityId": "...", "user": { "id": "...", "username": "olive", "displayName": "Olive", "avatarUrl": null }, "createdAt": "..." } }
```

The message is included as it is **now** so the bot can decide without keeping state, and so a bot that restarted still knows what was on screen.
The answer is `201 { interaction: { id } }`, only that it was sent (the answer arrives as an edit, a message or a private reply).

## Answering

The same `POST /interactions/{id}/callback` and `/followup` as commands, with the same rules (this bot only, once, 5 s to start, 15 min to finish, a refused
visible reply does not use it up). For a `COMPONENT` interaction the kinds are:

| `type` | Means |
| --- | --- |
| `update` | **edits the message the component was on**: any of `content`, `embeds`, `components` that are present replace the old ones, those left out are unchanged. `{ "type": "update" }` alone is a plain acknowledgement (the bot may edit later with its own `PATCH`). The usual way to disable the buttons after a choice. |
| `message` | a new message from the bot in the channel (text, cards, and now components), as for a command |
| `ephemeral` | private to the person who pressed: a live `interaction:response`, never stored, as for a command |
| `deferred` | "thinking...", finished with one `/followup` (a `message`, or an `ephemeral` if the defer said so), as for a command |

An `update` is applied with a conditional write on the message still existing and not deleted (a deleted message answers `409 message_gone`, and the press is
used up). It is told to everyone by the **existing** `message:edited` event, so no client code is new for it, and relayed to other servers as an edit.
Two presses at once each get their own `update` and the last one written wins: the bot owns that ordering, as it owns what its buttons mean (stated in the
guide). `update` is allowed only on a message the **answering bot sent** (always true by check 2, restated so the callback does not rely on it).

## Relay to other servers

`components` is an optional field of the federated `POST /messages` and `.../edit`, `z.unknown()` in the schema on purpose and cleaned on arrival by the lenient
cleaner (a bad value is no components, never a rejected message), like `richEmbeds`. A server that predates it ignores the field and shows the text and cards,
which every message with components has. People on another server see the buttons and menus **disabled**, with one line under them, "Only people on
{home server} can use these" (the client's rule from the design note, decision 5), and link buttons work for everyone because they act on nothing. The relay
keeps `customId`s (3d needs them, and they are the bot's data about its own message, shown to members only).

## Client

- `MessageComponents` draws each row under the message's cards: a button is the app's `Button` (`primary`, `secondary`, `danger`; a link is a `ghost` link with its
  host), a select is a native `<select>` (see Question 4), each a real control with an accessible name (the label; a select's placeholder, else "Choose") inside a
  `role="group"` named "Actions from {bot}". `MessageList` gets `onPressComponent`, off by default like `canReport`, so a list shown on its own offers nothing.
- A press disables **that component** and sets `aria-busy` until the message arrives edited, or the interaction is answered another way, or 5.5 s pass (the 3b
  timing), so a double-click cannot press twice. If it times out the person sees the 3b notice, generalised: `Robo didn't respond to /request.` becomes
  `Robo didn't respond to that button.` (`commandNotices` gets a `what` in place of `commandName`; the rest of the reducer and hook are reused, so a press and a command
  share waiting, thinking, failed and private).
- A refusal is worded in the page (`componentFailure`, beside `commandFailure`): `bot_offline`, `bot_busy`, `component_not_found` ("That button isn't available any
  more."), `invalid_values`, `forbidden`.
- Whether to offer a press at all: the community is hosted here (the same `domain` test commands use), and the viewer holds the permissions of Question 1, taken from
  `viewerPermissions` and shown only as a hint (the server decides). Otherwise the row is disabled with the line above.
- A message with no components is drawn exactly as before, and a deleted message or an invitation draws none (as for cards).
- `MessageNotifier` is untouched; a report's snapshot text gains the labels (`embedsAsText` reads components too) so a report about a buttons-only prompt is not blank.

## Edge cases that must have a test

Duplicate `customId`, a link with a `customId`, a button and a select in one row, 6 rows, 6 buttons, 26 options, `min > max`, `max > options`, an `update` for a deleted
message, a press on a message edited so the button is gone, a press on a disabled button, a select value that is not an option, a press by a non-member (the same 404),
a press when the bot left the community, two presses at once, a press while the bot is offline, an `update` from a bot that is not the interaction's, a reply `message` that
needs the bot to hold `SEND_MESSAGES` (refused, not used up), an erased person's press (the `interaction` snapshot rule below), a stale client that presses after an edit,
`components` from a person or a webhook (403), and components relayed to and received from another server (cleaned, ignored when malformed).

## Tests and checks

Server: a property test for the validator (limits, uniqueness, idempotence, never throws), `components.test.ts` for every route and refusal above, relay both ways, erasure, and
the OpenAPI reference test (the new operation, the new answer kinds, `botAuth` where it applies). Mutation checks over each rule, then the survivors closed or removed as duplicate
guards, as for 3a and 3b. Client: unit tests for the pure parts, component tests for the row, the press states and the notices, the page wiring, and a mutation run. **Browser:**
`e2e/tests/components.spec.ts` with the example bot's new `/ask` (a card with Yes and No buttons and a select): the person on the home server presses, sees the buttons disable and
the card change live, the person on the other server sees the same change with the buttons disabled and the line under them, and a stopped bot is refused with "offline".

## Questions that need an answer

1. **Who may press?** The note says "anyone who can see the message, because the bot decides". The server still has to decide what *permission* a press needs, because
   a `message` answer is a post the person caused.
   - **(a) Same as running a command: `USE_COMMANDS` and `SEND_MESSAGES`** (recommended). One rule for "use a bot" everywhere, a community that took away commands also takes
     away presses, and someone who may not send messages cannot post through a bot. Cost: a community that wants a read-only announcement with a vote button must leave
     `SEND_MESSAGES` on, which is how every role works here (there are no channel overrides yet).
   - (b) Anyone who can see the message, no permission needed. Simplest, but a muted person can make a bot post.
   - (c) Only the person who ran the command that produced the message. Safest for "private" prompts, but it makes every shared poll or approval impossible.
2. **Does a public reply to a press say who pressed?** A reply to a command says "Olive used /request". For a press the equivalent is "Olive pressed *Approve*".
   - **(a) Yes, a line under the name, as for commands** (recommended): the same transparency, and people can see why the bot spoke. The label is the bot's text and is drawn as text.
   - (b) No line: a press is like a click in the bot's own interface, and the bot can write "Olive approved this" itself if it wants one.
3. **Is an `update` shown as "(edited)"?** A bot's own `PATCH` marks the message edited. An `update` is the bot advancing its own widget (disabling buttons, showing the result).
   - **(a) No "(edited)" for an `update`; yes for a `PATCH`** (recommended): a poll that changes every time someone votes would otherwise say "(edited)" under every poll. The edit is still
     told to everyone live.
   - (b) Always "(edited)": one rule, simpler to explain, but noisy.
4. **How is a select menu drawn and sent?** (3b decided plain menus for command options; a select here also has per-option descriptions and may allow several choices.)
   - **(a) Native `<select>`; one choice sends as soon as it is chosen; several choices (`maxValues > 1`) use `<select multiple>` with a Send button beside it** (recommended): nothing
     new to make accessible, consistent with 3b. Cost: descriptions are not shown inside the open list (the chosen option's description is shown under the menu).
   - (b) A small custom listbox with each option's label and description, checkboxes when several are allowed, and a Send button: nicer, but a new widget to build and make
     keyboard- and screen-reader-correct, for a feature nobody has asked for yet.

## Not in 3c, and where it goes

Webhooks sending **link buttons only** (a build server's "Open build" button: nothing to press, so no interaction) is a small follow-up once the validator exists, as webhook cards
were. Modals, autocomplete, components inside an ephemeral reply, voice or federated presses (3d), and outgoing HTTP delivery of interactions stay out, as in the design note.
