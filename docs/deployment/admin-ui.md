# The admin page

> Part of the [deployment guides](README.md).

The admin page (`/admin`) is where an operator manages the server from a browser instead of a shell. **It is being built in steps.** What exists today is the foundation (who counts as an admin, how the page is hidden from everyone else, how it is kept safe), the **Users** page (find an account and suspend it, set its password, turn off its two-factor sign-in, delete it, or make it an admin) and the **[audit log](audit-log.md)**. Communities, registration invites, settings and an overview come in the next steps. The [admin command](admin-cli.md) does all of that today.

## Who is an admin

An admin is an account with the `isAdmin` flag, and **the first one can only be made by the operator's command**:

```bash
users make-admin <username>      # lets them use the page
users remove-admin <username>    # takes it away
```

Run it the way the [admin command](admin-cli.md) is run (`docker compose exec server node dist/adminCli.js users make-admin alice`, `kubectl exec ...`, `./my-chat-server admin users make-admin alice`, `npm run admin --workspace server -- users make-admin alice`). Nothing in the API can set it for the first admin, so a stolen ordinary session can never promote itself: being able to run the command where the server runs is the authority, as for everything the command does. Once there is an admin, they can pass it on (and take it away) from the Users page.

**An admin must have two-factor sign-in on.** Until they have, the page opens only to say so. An admin account can see and change things for everyone, so a password alone is not enough.

## It is invisible to everyone else

Everything under `/api/v1/admin` answers **404 `not_found`** (the very answer a path that does not exist gives) to:

- a signed-out visitor, or a token that is wrong or expired;
- an ordinary account;
- an account that is suspended or has been erased;
- an admin, once the flag is taken away (the account is looked up on **every** request, so access ends at once, not when the token runs out);
- everyone, when the page is switched off.

So nobody can tell whether a server has an admin page, and **a server that never makes an admin exposes nothing**. In the app the page is loaded only when someone goes to `/admin` (ordinary people never download it), and for anyone who is not an admin it shows the same "Page not found" as any other address. The way in (Settings -> Server administration) appears only for an admin.

## Users

The **Users** page lists the accounts on **this** server, oldest first, 25 to a page, with a search (part of a username or name; what you type is taken literally, so `%` is just a percent sign) and two filters (suspended only, admins only). A cached copy of someone on another server, and an account that was erased, are not listed: they are not ours to manage. Choosing one shows when they joined and were last seen, whether they have two-factor sign-in, whether they are suspended or being deleted, how many sessions they have, the communities they own, and the note on the registration invite they joined with. **No messages, direct messages or files, and never a password hash, 2FA secret, recovery code or token.**

What you can do to an account, and what it does (each is the same code the [command](admin-cli.md) runs, and each is written to the [audit log](audit-log.md) as you, from the page):

| Action | What it does |
|---|---|
| **Suspend** (asks first) / **Unsuspend** | Stops it signing in or refreshing a session, and ends its sessions now. (An access token already issued is good for at most 15 minutes.) |
| **Set a new password** | Sets the one you type (held to the sign-up rules) and ends every session. Tell it to them privately; it is never recorded. |
| **Turn off two-factor** (asks first) | For someone who lost their authenticator: turns it off and deletes their recovery codes. |
| **Delete** | Asks for the account to be deleted as the person could: sessions end, and after the waiting period (`ACCOUNT_DELETION_GRACE_DAYS`) it is erased unless they sign in first. [What that removes](account-deletion.md). |
| **Erase now** | Erases it at once. This cannot be undone, so it also needs the username typed out. |
| **Cancel the deletion** | Takes a pending deletion back, without waiting for them to sign in. |
| **Make admin** / **Remove admin** (ask first) | Passes the page on, or takes it away, at once. Not for someone who is suspended, and they still have to turn on two-factor sign-in before it opens for them. |

An account that **owns a community** cannot be deleted: the page says which, and they have to hand each one on (or you delete it with the command) first.

### Sudo mode

Everything that changes something asks you to **confirm it is you**: your password and a code from your authenticator (or one recovery code) again, even though you are signed in. That is because an admin session is the most valuable thing on the server, and one that was stolen must not be enough to lock people out or erase them. It stays confirmed for **ten minutes**, held in the page's memory only (reload the page and it asks again), and a code works once, so if you have just used one, wait for the next. Looking (the lists, the details, the audit log) never asks. Behind it, the server checks a token that names *you*: another admin's is no good, and it cannot be mistaken for any other kind of token.

### What the page will not do, on purpose

An account that is an **admin** can only be changed in one way from the page: taking admin away. Suspending, deleting, setting the password of, or turning off two-factor for an admin has to go through the command (or you remove admin first). Otherwise an admin whose session was taken could lock out or take over every other admin, and the way back in after a lock-out must never depend on the page. This also means:

- **you cannot do anything to yourself**, including taking away your own admin, so **the last admin can never be removed from the page**;
- the first admin, and recovery when nobody can sign in, are the command's alone.

## Settings

| How you run it | What to set |
|---|---|
| Docker Compose | `ADMIN_ENABLED` in your `.env.selfhost` |
| Kubernetes (Helm) | `server.admin.enabled` |
| Native binary or `npm run dev` | `ADMIN_ENABLED` in the server's `.env` |

`true` by default. `false` removes the page and its API entirely (the command is unaffected). It must be `true`/`false` (also `1`/`0`, `yes`/`no`, `on`/`off`): a typo such as `fasle` stops the server at startup rather than leaving the page on. There is also `ADMIN_RATE_LIMIT_MAX` (300 requests per 15 minutes, counted only for admins: were it counted for everyone, hitting it would tell a stranger the page exists) and the confirmation itself is behind the sign-in limit (`AUTH_RATE_LIMIT_MAX`), since it is a way to guess a password.

## What it can and cannot see

Metadata about the server and what was done to it: **no messages, direct messages, attachments or channel content**, and never a password hash, 2FA secret, token or JWT secret. There is no "sign in as this person".

## Where it stops, for now

- **Communities, registration invites, editable settings and an overview** are not on the page yet.
- You cannot see or change a person's messages, and nothing here will.

## How thoroughly it was checked

Run against a real database in the test suite: the 404 for every kind of stranger, two-factor sign-in required, access ending at once when the flag is taken away; that **every action that changes something refuses a missing, expired, garbled, forged or another admin's token**; each action does what it says to the person (they are locked out, their sessions end, the new password works) and is recorded as the admin's from the page; that an admin account, and you yourself, are refused everything except taking admin away; the typed username for erasing; paging and every filter; that nothing secret is in any answer; with mutation checks that each rule is needed. In real browsers: confirming, backing out, a wrong password, suspending and unsuspending, a new password, demoting, and erasing. **Not run:** the page behind a real reverse proxy, the 429 behaviour of the admin rate limit, and a list of thousands of accounts.
