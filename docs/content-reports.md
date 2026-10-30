# Reporting content and the moderation queue

> Part of the [documentation](../README.md#documentation). Design note for [#58](https://github.com/sam-bowman/federated-chat-app/issues/58):
> who gets a report, what is kept, and what a report must never do. The first part is what is built; the last part is what is not.

## What a report is

A member can report **a message**, **a person** or **a community**, with a **reason** from a short list and, if they want, a few words of
their own. It lands in a queue; whoever it reaches looks at a **snapshot** of what was reported, and closes the report as **resolved** (with
what was done) or **dismissed** (with an optional note). A closed report can be reopened.

Reasons: spam, harassment, hate, illegal content, sexual content, impersonation, other.

## Who gets it

The right person is not always on this server, and for some content nobody is a moderator. The rule is decided by **what is reported and where
it lives**, not by who reports:

| What is reported | Where it lives | Who sees it |
|---|---|---|
| A message in a channel | a community **hosted here** | that community's **moderators**: whoever holds the new **Review reports** permission (the owner always does). Server admins can also see it. |
| A message in a channel | a community **hosted on another server** (this server only has a copy) | **Nobody here can act on it**, so it is refused with `409 remote_community` and the reporter is told which server to report it to. Relaying it to the other server's moderators needs a new signed federation message and is a separate step (see "Not built"). |
| A message in a **direct or group conversation** | here | **Server admins only**: there is no moderator. The only thing they can act on is an account on this server (suspend it). |
| A **person** | anywhere this server knows them | **Server admins only** (their profile, their behaviour over time). |
| A **community** | hosted here | **Server admins only**: the community's own moderators cannot judge their own community. |
| A community | hosted elsewhere | `409 remote_community`, as above. |

The reported person's own server is never asked; nothing is sent to another server in this version.

**Admins can see everything that reaches this server's queue**, community reports included (an operator can read the database anyway, so this
only makes it visible and logged). They resolve or dismiss like a moderator does; acting on the person or the community is done where it was
always done (the admin page: suspend, delete, hand over).

## What is kept

A report holds a **snapshot taken when it was made**, because a message can be edited or deleted afterwards and a report about a deleted
message is still real. This is the one place the server keeps what someone wrote **on purpose, for review**, so it is limited:

- **Message:** the text (cut at 2,000 characters), the names of up to 5 attached files' addresses (not the files), when it was sent and
  edited, who sent it, and the channel and community (or "direct conversation"/"group conversation") it was in. **Nothing around it:** the
  reporter cannot add context, so a direct message report shows that one message and no other.
- **Person:** username, display name, bio, pronouns and custom status, as they were.
- **Community:** name, description, icon text, who owns it.
- Text is cleaned of control and direction-override characters, and shown as **text only**, like every stranger's words.
- **Retention:** a report is deleted `REPORT_RETENTION_DAYS` days after it was made (default 180; 0 keeps them for ever), whatever its state:
  a daily pass, like the audit log's. A report that nobody opens does not keep a stranger's words indefinitely.
- **Erasure:** when the **reported** person's account is erased, the snapshot of what they wrote is **replaced** by a marker and their name
  becomes "Deleted user" (the report stays, with its reason, so moderators see that it was about someone who is now gone). When the
  **reporter's** account is erased, the report stays but no longer says who made it. When a **community** is deleted, its reports go with it.
- A person who is reported is **never told**, and nothing about reports is sent to them: no event, no field on anything they can read.
  A reviewer (a moderator or an admin) who is **the person reported** does not see the report either, whatever their permissions: it is
  absent from their list, a `404` if they ask for it by id, and they cannot close it. The owner of a community is a reviewer like any other here.

## Who knows who reported

- **Moderators and admins see the reporter** (a report they cannot weigh without knowing who made it), with how many reports that person has
  made **in this queue** and how many were dismissed, so a pattern of false reports is visible. A community's moderators see counts for
  their own community only, never for other communities.
- The reported person, other members and the audit log's readers who are not reviewers do **not**: creating a report is deliberately
  **not** an audit entry (a community's audit log is readable by its managers, who need not be reviewers).
- **Every action by a reviewer is audited** (`report.resolve`, `report.dismiss`, `report.reopen`), by id and kind only: never the snapshot,
  the reporter's words or the note. A report that went to a community's moderators is written to that community's log; one that went to the
  admins alone (a person, a community, a direct message) is written to the admins' log only, so the log of a community that was itself
  reported learns nothing of it.

## What stops a report being a weapon

- **One report of the same thing per person, ever** (while it is retained): `409 already_reported`.
- **A rate limit per person:** 10 reports an hour and 30 open at once (`429 too_many_reports`), counted in the database so it holds across
  replicas.
- You can report only what you can see: a message in a community you are a member of, a conversation you are in, a community you belong to,
  a person who has not blocked you. Anything else is `404`, as for a thing that does not exist, so a report cannot be used to probe.
- Not your own message, person or community (`400 cannot_report_self`).
- Moderators see the reporter's history (above) and can dismiss with a note.

## In the app

- **Reporting:** a **Report** button (a flag) on other people's messages, **Report** on a person's profile, and **Report** in a community's
  header for every member who is not its owner. A dialog asks for a reason and, if the person wants, a few words, says who will read it and
  that the person reported is not told, and afterwards says only that it was sent. A refusal is explained in words (already reported, too
  many reports, on another server: report it to that server's moderators).
- **Moderators:** a **Reports** tab in the community's Settings for whoever holds Review reports (and only them; managing the community is not
  enough). **Admins:** a **Reports** tab on the admin page with everything that reaches this server.
- Each report shows why, who made it (with how many reports they have made in that queue and how many were dismissed), the snapshot as text and
  the reporter's words, with Resolve (what was done, a note), Dismiss (a note) and, once closed, Reopen. It opens on what is still to look at.

## What a moderator can do from the queue

Read the snapshot, open the content in its place, **delete the message, kick or ban the person** with the actions and audit entries that
already exist, then **resolve** (choosing what was done: nothing, message deleted, member kicked, member banned, account suspended,
community changed, other) or **dismiss**, each with an optional note. Resolving does **not** do the action itself: it records that it was done,
so the existing permission checks and audit entries stay the single path to each action.

## The API

- `POST /api/v1/reports`: `{ kind: "message" | "user" | "community", id, reason, details? }`; any signed-in person. `201` says nothing but that it was
  received.
- `GET /api/v1/communities/{id}/reports` and `.../reports/{reportId}`, `POST .../resolve`, `.../dismiss`, `.../reopen`: **Review reports** in that
  community.
- `GET /api/v1/admin/reports`, `.../reports/{id}`, `POST .../resolve`, `.../dismiss`, `.../reopen`: admins. Like the rest of the admin API
  these answer `404` to everyone else. Closing and reopening need the admin's two-factor sign-in but **not sudo mode**: they change nothing but the report;
  what has consequences (suspending, deleting) keeps its own sudo requirement.

## Running it

`REPORT_RETENTION_DAYS` (default 180; a whole number from 0, which keeps reports for ever, to 3650; anything else stops the server at
startup rather than being guessed) is how long a report, with its snapshot, is kept. It is deleted that many days after it was made, whether
or not anyone opened it.

| How you run it | Where |
|---|---|
| Docker Compose | `REPORT_RETENTION_DAYS` in your `.env.selfhost` |
| Kubernetes | `server.reports.retentionDays` |
| Native binary or `npm run dev` | `REPORT_RETENTION_DAYS` in the server's `.env` |

Giving someone the **Review reports** permission is done where any permission is: a role in the community's settings. Nobody holds it by
default. Server admins need nothing more than their usual two-factor sign-in.

A backup keeps a deleted report until the backup itself is deleted, as with every other table.

## Not built (in this version)

- **Relaying a report to another server's moderators.** A new signed federation message with its own version and a defined answer from an
  older server that does not know it. Until then the reporter is told to report to that server. Tracked separately.
- **A notification** to moderators when a report arrives (the queue is read when opened, and there is no count on the Settings button), and any
  message to the reporter about the outcome. Opening the reported message in its place from the queue is not built either.
- **Automatic detection, appeals, a public transparency report, reporting to outside authorities** (out of scope in #58).
