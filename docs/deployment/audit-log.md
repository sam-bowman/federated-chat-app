# The audit log

> Part of the [deployment guides](README.md).

The server keeps a record of **who did what** for the actions that change something other people depend on: what moderators do in a community, and what operators do to accounts and the server. It answers "who banned them?" and "who changed that role?" after the fact.

## What is recorded

| Where | Actions |
|---|---|
| In a community, by someone who manages it | changing its settings, handing it to someone else, deleting it; removing, banning and unbanning a member; giving and taking away a role; making, changing and deleting roles and channels; **removing someone else's message** |
| By an operator or the system | asking for an account to be deleted, cancelling it, erasing it; suspending and unsuspending; resetting a password; turning off two-factor sign-in; making and removing an admin |

Each entry has **who** did it (their id and how they were called at the time; the command line and the server itself are "the operator (command line)" and "the server (automatic)"), **what** they did, **to what** (a person, a role, a channel, a message: its id and a label as it was at the time), **where** (the community), **when**, and **where it came from**: the app, the admin page, the command line, or the server.

## What is never recorded

- **What anyone wrote.** Not a message, not a direct message, not a description, not the reason a moderator gave for a ban (only that there was one). For a message a moderator removed, the entry says *which* message and in which channel, never what it said.
- **Anything secret.** No password, token or code. A password reset records that it happened, nothing about the new password.
- **Refused attempts, and ordinary use.** Someone trying to kick a member without the permission is not recorded; joining, leaving, talking and editing your own words are not.

An entry is plain text of limited length: a label is one short line, with control and direction-changing characters taken out.

## Who can read it

- **Admins**, on the [admin page](admin-ui.md): everything, newest first, filtered by what was done and where it came from. (An admin has to have two-factor sign-in on.)
- **A community's managers** (anyone who can manage the community), in **Community settings -> Audit log**: only that community's entries.

Nobody can change or delete an entry through the app or its API.

## Keeping and erasing

- **Retention.** Entries older than `AUDIT_LOG_RETENTION_DAYS` (365 by default) are deleted once a day. A whole number from 0 to 3650; **0 keeps everything**. Anything else stops the server at startup rather than being guessed.
- **Erasing an account** ([deleting accounts](account-deletion.md)) takes the person's **name** out of every entry: wherever they did something and wherever something was done to them it becomes "Deleted user". The entries stay (what was done is still true) and keep the ids, which mean nothing without the account. This also applies to a person on another server whose server tells yours they are gone.

| How you run it | What to set |
|---|---|
| Docker Compose | `AUDIT_LOG_RETENTION_DAYS` in your `.env.selfhost` |
| Kubernetes (Helm) | `server.auditLog.retentionDays` |
| Native binary or `npm run dev` | `AUDIT_LOG_RETENTION_DAYS` in the server's `.env` |

## Things to know

- **A failure to write an entry never undoes what was done.** If the database refuses it, the server says so in its log (`[audit] could not record an entry`) and the action stands. If you rely on the log, watch for that line.
- **Backups hold the log as it was**, including names that were later erased. Keep that in mind when deciding how long to keep them.
- **Not recorded:** making or revoking a community invite, and joining. A community that lives on **another server** keeps its own log: this server records only what happens in communities it hosts.

## How thoroughly it was checked

Run against a real database in the test suite: every action above (each with who, to what, where), what must not be recorded (a refused attempt, a ban reason, message text, secrets), the reading rules (an admin sees everything; a manager sees only their community; a member without the permission, a stranger and another community's owner see nothing), paging and every filter, retention, the erasure of a name, and mutation checks that each rule is needed. **Not run:** a very large log (the pages are indexed, but it has not been timed on millions of rows) and the daily pruning timer itself (the pruning is tested; the clock is not waited for).
