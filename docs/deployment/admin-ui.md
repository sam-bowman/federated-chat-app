# The admin page

> Part of the [deployment guides](README.md).

The admin page (`/admin`) is where an operator manages the server from a browser instead of a shell. **It is being built in steps.** What exists today is the foundation (who counts as an admin, how the page is hidden from everyone else, how it is kept safe), the **Overview** (the page opens on it: the server at a glance), the **Users** page (find an account and suspend it, set its password, turn off its two-factor sign-in, delete it, or make it an admin), the **Communities** page (see the communities this server hosts, hand one to another member, or delete one), the **Invites** page (make, copy and revoke the codes an [invite-only](invite-only.md) server asks for), the **Reports** page (every [report](../content-reports.md) that reaches this server, to resolve, dismiss or reopen) and the **[audit log](audit-log.md)**. Editable settings come in the next step. The [admin command](admin-cli.md) does most of that today (not handing a community to someone else: that is only on the page).

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

## Overview

The page opens on the **Overview**: what this server is, how it is set up and how busy it is, on one screen. It only looks, so it never asks you to confirm it is you, and it does not update by itself: it says when it was made, and **Refresh** makes it again.

- **Server**: its name, domain and software version, whether uploaded files are on the disk or in S3, and whether several replicas share the realtime parts through Redis.
- **People**: how many accounts there are, how many were seen in the last day, week and month, how many joined in the last week, and how many are admins, suspended, waiting to be erased, or have no two-factor sign-in. An erased account and a copy of someone on another server are not counted.
- **Communities**: how many this server hosts, how many members and channels they have, how many of each kind of "who can join", and how many copies of communities on other servers people here are in (counted apart).
- **Registration**: whether anyone can register, only people with an invite code, or nobody, and how many codes can still be used.
- **Other servers**: whether federation is on (or the server is private), whether it is limited to an allow list or has a block list (how many servers each names, never which), how many servers it has looked up, and what is **waiting to be sent** to them: how many, how many are being retried, how long the oldest has waited, and how many gave up.
- **Features**: voice, the public directory, link previews, and how many entries were written to the audit log in the last day.
- **Settings in effect**: the settings that shape the server (how long a deleted account waits, how long the audit log is kept, who can join a community and the most open one may be, who may start something with people, whether people can be found and listed, the largest upload), each in words and with the name of the variable that sets it. They are read when the server starts, so changing one takes a restart; editing them from the page is the next step.

A box at the top, **Worth a look**, appears only when something needs attention: messages for other servers that gave up (and will not be sent again by themselves), or something that has waited an hour or more. When it is not there, nothing is waiting too long.

It shows **counts and switches, never a name**: no message or direct message, no name of a person or community, no address on an allow or block list, and no secret (no key, password, or database address). A test plants a person, a community, a message, a peer and a list entry and checks none of them is in the answer.

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

An account that **owns a community** cannot be deleted: the page says which, and they have to hand each one on first (you can do that for them on the [Communities](#communities) page, or delete the community).

### Sudo mode

Everything that changes something asks you to **confirm it is you**: your password and a code from your authenticator (or one recovery code) again, even though you are signed in. That is because an admin session is the most valuable thing on the server, and one that was stolen must not be enough to lock people out or erase them. It stays confirmed for **ten minutes**, held in the page's memory only (reload the page and it asks again), and a code works once, so if you have just used one, wait for the next. Looking (the lists, the details, the audit log) never asks. Behind it, the server checks a token that names *you*: another admin's is no good, and it cannot be mistaken for any other kind of token.

### What the page will not do, on purpose

An account that is an **admin** can only be changed in one way from the page: taking admin away. Suspending, deleting, setting the password of, or turning off two-factor for an admin has to go through the command (or you remove admin first). Otherwise an admin whose session was taken could lock out or take over every other admin, and the way back in after a lock-out must never depend on the page. This also means:

- **you cannot do anything to yourself**, including taking away your own admin, so **the last admin can never be removed from the page**;
- the first admin, and recovery when nobody can sign in, are the command's alone.

## Communities

The **Communities** page lists the communities **this** server hosts, oldest first, 25 to a page, with a search by part of the name (taken literally, like the users search). A copy of another server's community is theirs, not ours to manage, so it is not listed. Choosing one shows who owns it, how many members it has (and how many of them are on this server and on which others), how many text and voice channels, who can join (in the words Settings uses) and when it was made. **No description, channel names, messages or member list**: nothing anyone wrote in it.

| Action | What it does |
|---|---|
| **Hand to another member…** | Makes someone else its owner, by their username. For when the owner cannot or will not do it themselves (the app's own way asks the owner for their password), for instance an account that is being closed, which cannot be deleted while it owns a community. The new owner has to be **a member, on this server** (a community cannot be managed by a member of another one) and **not suspended**, and not already the owner. The old owner stays a member and nothing else about their account changes. Everyone in the community is told at once, and other servers are told to refresh their copy. |
| **Delete…** | Deletes the community **exactly as its owner deleting it would** (the same code): channels, messages, roles, memberships, bans and emoticons go, its voice rooms are closed, members are told, other servers drop their copy and files nothing else uses are removed. It cannot be undone, the owner is not asked, and **its name has to be typed out** first. |

Both need [sudo mode](#sudo-mode) and are recorded in the [audit log](audit-log.md) as the admin's, from the admin page, with the community's name as it was (and, for a hand-over, who got it). Deleting a community whose owner is an admin is fine: it is the community that is touched, not the account.

## Invites

The **Invites** page is the [registration invite codes](invite-only.md) an invite-only server asks for, the same ones the `registration-invites` command makes. It lists the codes that can still be used, newest first (a tick box also shows the revoked, expired and used-up ones; at most 200 are shown, and it says how many there are). Each shows how often it was used, when it ends, your note and **who joined with it**.

- **Make invites** asks for how many accounts each code can make (1 to 10 000, or no limit), how many days until it ends (1 to 3650, or never), a note that is only for you, and how many codes to make (1 to 50). The defaults are one use and a week, like the command. It then shows the new codes at the top, with **Copy the codes** and **Copy the links** for handing out a batch.
- **Copy code** and **Copy link** on a code: the link goes to the register screen with the code already filled in (`/register?invite=CODE`).
- **Revoke** stops a code being used at once, after asking. People who already made an account with it keep theirs.
- The page says when the codes do not matter yet: registration is off (`REGISTRATION_ENABLED=false`), or the server is not invite-only (`REGISTRATION_INVITE_ONLY`), in which case codes made now work once it is.

A code is a credential: whoever has it can make an account. The page shows it to an admin (as the command's `list` does) and nowhere else, and **it is never written to the audit log**: an entry names the invite by an id and the **last four characters** of the code, and says whether there was a note, never what it said. Making and revoking go through [sudo mode](#sudo-mode); looking does not. Making codes is recorded as "made a registration invite", from the admin page (or the command line, for the command: it now records what it does too).

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

- **Editable settings** are not on the page yet (the overview shows what they are now, read-only).
- You cannot change a community's own settings, roles or channels from here, and you cannot look inside one: that is what its owner and managers are for.
- You cannot see or change a person's messages, and nothing here will.

## How thoroughly it was checked

Run against a real database in the test suite: the 404 for every kind of stranger, two-factor sign-in required, access ending at once when the flag is taken away; that **every action that changes something refuses a missing, expired, garbled, forged or another admin's token**; each action does what it says to the person (they are locked out, their sessions end, the new password works) and is recorded as the admin's from the page; that an admin account, and you yourself, are refused everything except taking admin away; the typed username for erasing; paging and every filter; that nothing secret is in any answer; with mutation checks that each rule is needed. For invites: that a code made on the page really lets a person register (and a revoked one does not), the limits the form offers are the ones the server accepts (a test compares the two), that two revokes at once are recorded once, and that no code or note is ever in the audit log. For the overview: every number against data seeded for it (a remote person, an erased account and a copy of another server's community are not counted; the time windows follow the moment it is made for), the server's version, registration and feature switches against the server's own values, that it needs two-factor sign-in and cannot be written to, and that nothing a person or community was called or wrote, no list entry and no secret is in it; in a real browser, that it is where the page opens, that what it says of the server is what the server's own discovery document says, and that a new account makes the number go up. For communities: that only hosted ones are listed, that no description, channel name or message is in any answer, every refusal of a hand-over (a copy of another server's community, someone who is not a member, remote, suspended, or already the owner) and that two at once cannot both win, that the typed name is needed to delete one, and that members and other servers are told in both cases, as when the owner does it (the owner's own transfer shares its code, and its tests are unchanged). In real browsers: confirming, backing out, a wrong password, suspending and unsuspending, a new password, demoting, and erasing, making, copying and revoking an invite, and handing a community to a member (who really gets its settings while the old owner loses them) and deleting it (it leaves the members' rail). **Not run:** the page behind a real reverse proxy, the 429 behaviour of the admin rate limit, and a list of thousands of accounts.
