# The admin page

> Part of the [deployment guides](README.md).

The admin page (`/admin`) is where an operator manages the server from a browser instead of a shell. **It is being built in steps; this is the first.** What exists today is the foundation (who counts as an admin, how the page is hidden from everyone else, how it is kept safe) and its first page, the **[audit log](audit-log.md)**. Managing users, communities, registration invites and settings, and the overview, come in the next steps. The [admin command](admin-cli.md) does all of that today.

## Who is an admin

An admin is an account with the `isAdmin` flag, and **only the operator's command can set it**:

```bash
users make-admin <username>      # lets them use the page
users remove-admin <username>    # takes it away
```

Run it the way the [admin command](admin-cli.md) is run (`docker compose exec server node dist/adminCli.js users make-admin alice`, `kubectl exec ...`, `./my-chat-server admin users make-admin alice`, `npm run admin --workspace server -- users make-admin alice`). Nothing in the API can set it, so a stolen ordinary session can never promote itself: being able to run the command where the server runs is the authority, as for everything the command does.

**An admin must have two-factor sign-in on.** Until they have, the page opens only to say so. An admin account can see and change things for everyone, so a password alone is not enough.

## It is invisible to everyone else

Everything under `/api/v1/admin` answers **404 `not_found`** (the very answer a path that does not exist gives) to:

- a signed-out visitor, or a token that is wrong or expired;
- an ordinary account;
- an account that is suspended or has been erased;
- an admin, once the flag is taken away (the account is looked up on **every** request, so access ends at once, not when the token runs out);
- everyone, when the page is switched off.

So nobody can tell whether a server has an admin page, and **a server that never makes an admin exposes nothing**. In the app the page is loaded only when someone goes to `/admin` (ordinary people never download it), and for anyone who is not an admin it shows the same "Page not found" as any other address. The way in (Settings -> Server administration) appears only for an admin.

## Settings

| How you run it | What to set |
|---|---|
| Docker Compose | `ADMIN_ENABLED` in your `.env.selfhost` |
| Kubernetes (Helm) | `server.admin.enabled` |
| Native binary or `npm run dev` | `ADMIN_ENABLED` in the server's `.env` |

`true` by default. `false` removes the page and its API entirely (the command is unaffected). It must be `true`/`false` (also `1`/`0`, `yes`/`no`, `on`/`off`): a typo such as `fasle` stops the server at startup rather than leaving the page on. There is also `ADMIN_RATE_LIMIT_MAX` (300 requests per 15 minutes, counted only for admins: were it counted for everyone, hitting it would tell a stranger the page exists).

## What it can and cannot see

Metadata about the server and what was done to it: **no messages, direct messages, attachments or channel content**, and never a password hash, 2FA secret, token or JWT secret. There is no "sign in as this person".

## Where it stops, for now

- The **audit log** is the page's only content so far. It reads and filters; it cannot change anything.
- There is **no way to edit settings, manage accounts or communities** from the page yet.
- The first admin, and recovery when no admin can sign in, are the command's alone, and will stay so.

## How thoroughly it was checked

Run against a real database in the test suite: the 404 for every kind of stranger (compared with the answer for a path that does not exist), two-factor sign-in required, access ending at once when the flag is taken away, the account suspended or erased, and the switch off; that the flag cannot be set through registration or the profile; that it is shown only to its owner; and in a real browser. **Not run:** the page behind a real reverse proxy, and the 429 behaviour of the admin rate limit.
