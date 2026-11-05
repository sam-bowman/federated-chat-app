# Slash commands (phase 3b): implementation plan

> Part of the [documentation](../README.md#documentation). The plan for step 3b of [commands-design.md](commands-design.md) (embeds, 3a, are
> built). That note fixed the *what* (commands belong to a bot, a small form asks for the options, `USE_COMMANDS`, live-only interactions, no
> people from other servers yet). This one fixes the *how*: the data, every route and event, the client behaviour, the edge cases, the tests, and
> the PR split. **Nothing here is built.** It ends with the answers that settled the open ones.

## Split

Two PRs, as for webhooks and cards:

1. **Server**: the `USE_COMMANDS` bit and its migration, `BotCommand` and `Interaction`, the bot's registration routes, listing for a community,
   invoking, the `interaction:created` event, the callback and follow-up, ephemeral delivery, `Message.interaction`, pruning, OpenAPI and the
   reference, the example bot's commands, and the tests with mutation checks.
2. **Client**: the `/` picker in the composer, the options form, the waiting and failure states, an ephemeral reply, the "used /x" line, the role
   editor's new bit, and a browser test with the example bot.

Not in 3b: components (3c), people on other servers (3d), autocomplete, context menus, modals, per-community command settings.

## The permission

`USE_COMMANDS` is bit 13 (value 8192; bit 12 is `MANAGE_WEBHOOKS`). It joins `DEFAULT_MEMBER_PERMISSIONS`, and its migration writes it **by value**
into every `@everyone` role as the invite and voice bits did (`UPDATE "Role" SET "permissions" = "permissions" | 8192 WHERE "isDefault" = true`), so
nothing changes until a manager takes it away; do not renumber it. The owner holds it as every bit. The client's role editor must offer it
(`permissions.test.ts` fails otherwise). **Running a command needs both `USE_COMMANDS` and `SEND_MESSAGES`**; a bot's visible reply needs the bot to hold
`SEND_MESSAGES`; an ephemeral reply needs neither.

## Data

```
BotCommand  id, protocolId (unique), botId -> User (cascade), name, description, options (JSON), position, createdAt, updatedAt
            unique (botId, name)

Interaction id, protocolId (unique), botId -> User (cascade), communityId -> Community (cascade), channelId -> Channel (cascade),
            userId -> User (the invoker, cascade), commandId -> BotCommand (set null), commandName, options (JSON, as validated),
            ephemeral (bool, set when the answer is deferred), state, createdAt, expiresAt (+15 min), answeredAt
            index (botId, state), index (createdAt)
```

`state` is `RECEIVED` (sent to the bot, nothing yet), `DEFERRED` (the bot said it is thinking), `DONE` (answered, nothing more accepted). Rows are
pruned hourly once a day old (`startInteractionPruning`, the same shape as `startImagePruning`). `Message` gains `interaction` (JSON, nullable):
`{ id, command, userId, name }`, the snapshot of who ran what and under what name **at that moment**, so reading a message needs no join. **Erasing a
person's account sets `interaction` to null on every message that names them** (a test), so "Deleted user used /request" never appears.

## Registering commands (bots)

`PUT /api/v1/commands` with the bot's token replaces its **whole** set, so removing a command is leaving it out and the call is safe to repeat:

```json
{ "commands": [ { "name": "request", "description": "Ask for a film", "options": [
    { "name": "title", "description": "What to look for", "type": "string", "required": true },
    { "name": "kind", "description": "Film or show", "type": "string", "choices": [ { "name": "Film", "value": "film" }, { "name": "Show", "value": "show" } ] } ] } ] }
```

- A command: `name` 1 to 32 of `a-z 0-9 _ -`, `description` 1 to 100, at most 10 options, at most 50 commands, names unique. An option: `name` (same rule),
  `description` (1 to 100), `type` (`string`, `integer`, `number`, `boolean`, `member`, `channel`), `required` (default false), `choices` (at most 25,
  each `{name (1 to 100), value}` with the value of the option's type; `string`, `integer` and `number` only). **Required options come first** (`invalid_commands`
  otherwise), so a form and a bot never meet a gap.
- A command that keeps its **name keeps its id** (it is updated in place), so an open form, a pending interaction and a client's cache survive a bot
  restarting and registering again. Anything wrong is `400 invalid_commands` naming the first thing, and nothing is changed.
- `GET /api/v1/commands` (bot) reads its own back. Both are `botAuth` operations, refused when `BOTS_ENABLED` is off, and a bot that is deleted takes its
  commands with it (cascade).
- After a registration the server pushes `commands:updated { botId }` live to the members of every community the bot is in (live only: a client that
  is not connected asks when it opens a community anyway).

## Finding them (people)

`GET /api/v1/communities/{id}/commands` (a member; 404 otherwise) answers `{ commands, canUse }`:

```json
{ "canUse": true, "commands": [ { "id": "…", "name": "request", "description": "Ask for a film", "options": [ … ],
    "bot": { "id": "…", "username": "robo", "displayName": "Robo", "avatarUrl": null, "isBot": true }, "botOnline": true } ] }
```

`canUse` is `USE_COMMANDS` and `SEND_MESSAGES` for the viewer (so the client shows no picker to someone who could not run one). `botOnline` is whether the
bot has a socket **anywhere** (`countFleetConnections` with Redis, `isUserOnline` without), so the picker can say so before anyone waits. Only bots that are
**members of this community** appear. A community this server only caches answers `{ commands: [], canUse: false }`.

## Running one (people)

`POST /api/v1/channels/{id}/commands/{commandId}` with `{ "options": { "title": "Dune", "kind": "film" } }`:

1. The channel is a text channel of a community **hosted here** (a cached copy is `409 not_community_home`); the person is a member (else 404, as always); they
   hold `USE_COMMANDS` and `SEND_MESSAGES` (`403 forbidden`); the command exists and its bot is a member (`404 not_found`, one answer for every other case).
2. **The options are validated against the registered types before the bot sees anything** (`400 invalid_options` with the first offender's name): unknown names refused,
   required ones present, `integer` a whole number, `number` finite, `boolean` a boolean, `choices` one of the values, a `member` the protocolId of a **member of this
   community**, a `channel` a **text channel of it**, a `string` at most 2,000 characters with control and direction-override characters removed (one line).
3. The bot must be connected: **`409 bot_offline` at once** instead of three seconds of waiting.
4. At most 50 interactions pending for one bot (`429 bot_busy`), and a limit per person (20 a minute, `commandLimiter`, after the checks).
5. The row is written and `interaction:created` goes to the bot. The answer is `202 { interaction: { id } }`.

`interaction:created` reaches the bot as a **live-only** event through `sendToUser` (never `emitSyncEvent`: it is useless after seconds, so it is not in the sync log and not
replayed; with Redis `sendToUser` already reaches a bot on another replica):

```json
{ "type": "interaction:created", "interaction": { "id": "…", "type": "command", "command": { "id": "…", "name": "request" },
  "options": { "title": "Dune", "kind": "film" }, "channelId": "…", "communityId": "…",
  "user": { "id": "…", "username": "olive", "displayName": "Olive", "avatarUrl": null },
  "resolved": { "members": { "<id>": { "…publicUser": "…" } }, "channels": { "<id>": { "id": "…", "name": "general" } } },
  "createdAt": "…" } }
```

`resolved` names what a `member` or `channel` option pointed at, so a bot need not ask. The bot sees the invoker's public profile and what was typed in the form, and
the picker says so once.

## Answering (bots)

`POST /api/v1/interactions/{id}/callback` with the bot's token (and `botAuth`): the id is not a secret, the token is, and the call is `404 not_found` unless **this bot** is
the one addressed (the same answer as an interaction that does not exist). Bodies:

| `type` | Means | Needs |
| --- | --- | --- |
| `message` | a normal message in the channel, `content` and/or `embeds` as for sending, marked "**Olive used /request**" | the bot holds `SEND_MESSAGES`; `201 { message: { id } }`; state `DONE` |
| `ephemeral` | the same, visible **only to the person who ran it**, never stored, gone on reload | nothing; `204`; state `DONE` |
| `deferred` | "Robo is thinking…"; `ephemeral: true` makes the later answer private | nothing; `204`; state `DEFERRED` |

`POST /api/v1/interactions/{id}/followup` answers a `DEFERRED` interaction **once**, as a message or an ephemeral reply according to how it was deferred, within 15 minutes of
the person running the command; the state becomes `DONE`.

Time and state: the **first** callback must arrive within **5 seconds** of the person running it (the promise is 3; two more seconds absorb clocks and latency), else
`410 interaction_expired`, so the "didn't respond" the person was shown stays true. A second answer to a `DONE` interaction is `409 already_answered`. A follow-up
after 15 minutes is `410`. An interaction whose bot has since been removed from the community can still be answered ephemerally; a public reply is `403` (the bot no
longer holds the right), the same rule as everywhere.

**Ephemeral delivery.** The invoker alone gets `interaction:response { interactionId, bot, content, embeds, channelId, commandName, createdAt }` through `sendToUser`
(not stored). Deferred shows to the invoker as `interaction:update { interactionId, state: "deferred" }`. A public answer is the ordinary `message:created`, whose message
carries `interaction: { id, command, user: { id, name } }`, so the client matches it to the one it is waiting for.

**One path for messages.** The channel send route's body (permission, `prepareRichEmbeds`, `deliverChannelMessage`, `schedulePictures`) moves into a function the route, the
callback and the follow-up all use, so the three cannot drift (the same move `deliverChannelMessage` was for webhooks).

## The client

- **API and types**: `BotCommand`, `CommandOption`, `listCommunityCommands`, `runCommand`; `lib/commands.ts` (filtering by name, the form's values turned into the typed `options`,
  the same validation as the server so a mistake is shown beside its field); a `useCommands(communityId)` hook that asks when a community opens and again on
  `commands:updated`, `community:updated` and `ws:open`, and shares one answer.
- **The picker**: typing `/` as the **first character** of an **empty** message in a community with commands (and `canUse`) opens a list in the composer's own combobox pattern
  (name, description, the bot's name with the **Bot** badge, "offline" for a bot that is). Arrow keys, Enter, Tab or a click choose; Escape closes it. Anything else that starts
  with `/` (`/shrug`, a path, an unknown name, a bot that is offline) is sent as ordinary text, never intercepted, and a community without commands behaves as today.
- **The form**: choosing a command clears the box and opens a small form above the composer (`role="form"`, named "Run /request"): one labelled field per option (text, a
  whole-number or number input, a checkbox, a `<select>` for `choices`, a `<select>` of members or of text channels), required ones marked, the bot's name and a one-line
  "Robo will see what you enter" under it, **Send** and **Cancel** (Escape cancels and focus returns to the box). Errors appear beside the field; the button is disabled
  until the required ones are filled and while the bot is offline (with the reason).
- **After Send**: a local "Waiting for Robo…" row (an `aria-live` status) in the message list, replaced by the reply, or "Robo didn't respond" after 3 seconds
  (dismissible), "Robo is thinking…" for a deferred one up to 15 minutes. A private reply is a local row with "Only you can see this" and a dismiss button, kept in the page's
  state for the channel being viewed and gone on reload or when the channel changes. A public reply shows a small "**Olive used /request**" line above the bot's message.
- **Role editor**: the new bit. Everything in rem; nothing in the picker or form is built on a media query.

## Edge cases settled

- **Two bots with the same command name** both appear, told apart by the bot's name; a call names the command **id**, so one bot never receives the other's. No "first
  registered wins" rule.
- A bot **removed** from the community leaves the picker at once (`community:updated`); its commands come back if it is added again. A bot **banned**, suspended or
  deleted likewise; `BOTS_ENABLED=false` empties every list.
- **Options are untrusted input to the bot**, as text a stranger typed: the docs say so, as they do for message text.
- Interactions are **not audited** (like messages); registering commands is not a manager's action, so it is not either.
- **Federated communities**: not offered, and a bot's public reply to a local person is relayed to other servers as an ordinary bot message **without** the "used" line
  (the relay is unchanged in 3b; a remote reader sees the bot's words, and the line is a local nicety).
- Reports of a bot's reply carry its words (cards already do); the "used /x" line is not part of the snapshot.

## Tests

Server integration: registration (valid, every refusal, ids stable across re-registration, required-first, a removed command gone, another bot's untouched); listing (members
only, only member bots, `canUse` with and without each bit, `botOnline`, a cached community empty); running (every validation, the permission matrix, `bot_offline`, the
limits, a stranger or non-member 404, the bot gets exactly the event and no other bot does); answering (each type, the 5 s window with a fake clock, the 15 min follow-up,
`already_answered`, another bot's interaction 404, the public reply needs `SEND_MESSAGES`, ephemeral reaches only the invoker, a deferred then a follow-up, `message.interaction`
shape, erasure clears it); the live-only rule (nothing in the sync log); the migration back-fill (an existing `@everyone` gains the bit); the reference test covers every
new answer and the bot-or-not rule; mutation checks on each rule above. Client: component and unit tests for the picker, the form, the states, the ephemeral row and the "used"
line, run with `client/.env` hidden, plus mutation checks. Browser: the example bot's `/ping` and `/echo` and a deferred `/slow` in a real browser (picker, form, a public reply,
a private reply, "didn't respond" with the bot stopped, a role with the bit removed losing the picker), and a person on the other server seeing the bot's reply.

## Decisions

Settled before building:

1. **A bot with no socket is refused at once** (`409 bot_offline`) and its commands are shown greyed as offline.
2. **The first answer is held to 3 seconds plus 2 of grace**; after that `410 interaction_expired`, so "didn't respond" stays true.
3. **People on other servers see a bot's reply without the "used /request" line**; the relay is unchanged in 3b.
4. **Member and channel options are plain menus.**
5. **Two bots with the same command name are both shown**, told apart by the bot's name.
