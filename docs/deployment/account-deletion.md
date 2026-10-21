# Deleting accounts

> Part of the [deployment guides](README.md).

A person can delete their own account (Settings -> **Delete account**), and you can do it for them with the [admin command](admin-cli.md). Because it is the one destructive thing that other people and other servers can see, it works in three steps, and it never happens at once by accident.

## What happens

1. **Asking.** The person gives their password, types their username, and (with two-factor sign-in on) a code. Nothing is erased. Their sessions end and a **grace period** starts.
2. **Waiting.** For `ACCOUNT_DELETION_GRACE_DAYS` (14 by default) **signing in again cancels it**: the sign-in works as normal, the account is untouched, and the person is told it was cancelled. Nobody else can tell the account is waiting.
3. **Erasing.** When the time is up, a background pass (once an hour) erases the account. You can erase one at once with `users delete <name> --now`.

An account that **owns a community** cannot be deleted (asking is refused, naming the communities): the community would be left without an owner. The owner hands each one to another member, or deletes it, first. You can do the second for them with `communities delete`.

## What erasure removes

| Removed | Notes |
|---|---|
| Every message they wrote, in channels, direct messages and groups | Reactions and attachments on them go too. A reply to one keeps its words and loses the quote. |
| Their friendships, friend requests and blocks | |
| Their membership of communities, bans against them, roles, read marks | |
| Group-chat membership | A group carries on without them. |
| Emoticons they made for themselves, and the ones they saved | An emoticon a **community** has is the community's and stays. |
| Community invite codes they made | |
| Sessions, two-factor secret and recovery codes, notification choices | |
| Files only they used: their picture, what they attached | A file anything else still points at is kept. |

## What is left

A **tombstone**, not a deleted row, because other rows point at it (a direct message's other member, an emoticon a community keeps):

- The name is **"Deleted user"**, with no picture, bio or other profile, no password and no way to sign in.
- A **direct message** stays for the other person, with "Deleted user" as the other side and none of their messages. Nobody can send into it. A conversation that nobody on this server is left in is removed.
- The **username can never be registered again** (it is kept in `DeletedUsername`: the name and the date, nothing about the person). This stops anyone taking the name and being mistaken for them on a server that still remembers.

## Other servers

Every server that knows the person (a friend there, a conversation or community they were in, a member of a community this server hosts) is sent `POST /federation/v1/account-deleted` (see the [protocol](../../protocol/federation.md#post-account-deleted)). It forgets them the same way: their messages, friendships and memberships go, and a tombstone is left. It is only believed from the person's own server, and is safe to receive twice.

A **private server** (`FEDERATION_ENABLED=false`) records the message and sends it when federation is switched on again, like any other event. A server that is unreachable gets it when it is back.

## Settings

| How you run it | What to set |
|---|---|
| Docker Compose | `ACCOUNT_DELETION_GRACE_DAYS` in your `.env.selfhost` |
| Kubernetes (Helm) | `server.accountDeletion.graceDays` |
| Native binary or `npm run dev` | `ACCOUNT_DELETION_GRACE_DAYS` in the server's `.env` |

A whole number of days from **0 to 365**; anything else (`7d`, `-1`) stops the server at startup and says why, rather than being guessed. `0` means no waiting: the account is erased at the next hourly pass. Read at startup. Lowering it applies to accounts already waiting: one asked for 10 days ago is erased at the next pass if you set it to 7.

## Commands for the operator

```bash
users delete <username> [--now] [--yes]   # ask for it, as the person could; --now erases it at once
users cancel-deletion <username>          # take a pending deletion back
```

`users list` marks accounts waiting as `DELETING`, and `users show` gives the date. See the [admin command](admin-cli.md).

## Things to know

- **Backups are not changed.** A deleted account stays in every backup you took before it was deleted until you delete that backup. Keep that in mind when deciding how long to keep them, and if you restore one, the account comes back as it was (erase it again).
- **A session token already issued lives out its 15 minutes.** Asking ends every session that can be refreshed, but an access token is good until it expires, as with suspending. After `--now` the account has nothing it can act on, but it is the same short window.
- **The worker needs the server running.** Accounts are erased by the server's own hourly pass, so a server that is stopped erases nothing until it is started. It looks about 30 seconds after starting, then every hour.
- **Live updates for people on this server.** When an account is erased by the worker, people on this server see it at once (chats, friends, communities refresh and the person's messages disappear). With `users delete --now` they see it on reload, unless the server has Redis, for the same reason as other admin commands.
- **Moderation.** If a person was banned or reported, deleting their account removes the bans and messages along with the rest. If you need to keep evidence, take a copy first.

## How thoroughly it was checked

Run for real, with a database and two servers: asking and every way it is refused, the grace period, signing in to cancel (including with two-factor), erasure (every table above, with mutation checks that each rule is needed), the tombstone, the files, the events people on the server get, what is sent to other servers and what a server accepts from another, in the test suite; and in real browsers on two real servers (asking, cancelling, an operator erasing an account and a friend on the other server forgetting them). **Not run:** a long wait through a real grace period (the date arithmetic is tested; the hourly timer is not waited for), a very large history (erasure runs in one transaction and has not been timed on one), and the Windows and Linux native binaries.
