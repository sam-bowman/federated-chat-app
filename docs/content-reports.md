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
| A message in a channel | a community **hosted on another server** (this server only has a copy) | **Nobody here can act on it**, so it is refused with `409 remote_community` and the reporter is told which server to report it to. [Relaying it](#reports-about-content-on-another-server-proposed-not-built) to the other server's moderators is proposed. |
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

## Reports about content on another server (proposed, not built)

> **Status: a proposal, for review before any code.** Everything above is how it works today; this section is how it would change.
> Until it is built, a report about a message or community hosted on another server is refused with `409 remote_community`.

### The problem

A community has one home server, and only its moderators can act on what is said in it. A member whose own server only holds a cached
copy has nobody to report to on their own server. Today they are told to find the other server's moderators themselves, which in practice
means the report is not made. The fix is for the reporter's server to **carry the report to the community's home server**, where the
moderators and admins are.

Only two kinds go: **a message in a community hosted elsewhere** and **that community itself**. A report about a *person* or a *direct or
group message* is still read by this server's admins, as today (they can act on their own members' side of it; the person's own server is
not asked). That could be relayed too, but it is a different question (the other server's admins have no context for a conversation they
are not in), so it is left out on purpose.

### What travels

One signed request from the reporter's server **R** to the community's home server **H**, in the same style as the other things a remote
member does in a community (`POST /federation/v1/communities/{id}/reports`):

```json
{ "username": "robin", "kind": "message", "id": "<message protocolId>", "reason": "spam", "details": "optional, at most 500" }
```

`kind` is `message` or `community` (`id` is then the community's). **R sends no snapshot and no text of the message**: H builds the
snapshot itself, from its own copy, with the same limits and cleaning as a local report, so a hostile or buggy R cannot put words into a
report or change what the moderators see. The reporter is `username` at the domain in `X-Federation-Origin`, never a domain in the body.

H then runs **exactly the checks a local report gets**, through the same function (`createReport`), so the rules cannot drift:

| Check | Answer |
|---|---|
| The caller's domain has no member in the community, or the community / message does not exist, or the message is not in *this* community | `404 report_target_not_found`, the same for all three, so the request cannot be used to find out what exists (deliberately stricter than the snapshot endpoint, which says `403 not_a_member_domain` for a community that exists) |
| The caller's domain has members but this person is not one (left, banned) | `403 not_a_member` |
| The message is deleted | `404 report_target_not_found` |
| Their own message / community | `400 cannot_report_self` |
| Reported before | `409 already_reported` (the unique key is the reporter's real `protocolId`, which H already has for a member) |
| Too many | `429 too_many_reports`: the per-person limits as today, **plus one per origin domain** (see below) |
| Bad body | `400 invalid_request` |
| Taken | `201 { "received": true }` |

H writes the report as `scope: COMMUNITY` (a message) or `SERVER` (the community), exactly as if the reporter were local: its moderators
see it in Settings -> Reports and its admins in the admin page, with the reporter shown as `@robin:r.example`. **H tells no one**: not the
person reported, not R beyond the answer above, and not the other servers with members.

### What R does

1. The checks it can make itself, before any network call: the same limits (10 an hour, 30 open), only what the reporter can see (a member
   of the cached community, else 404), not their own, not already reported (its own record, below).
2. The call to H goes through `proxyToHomeServer`, so a private server, the allow and block lists, the SSRF guard and the timeout are
   inherited as they are for sending a message. A server that cannot be reached is `502 federation_unreachable`; the person is told to try
   again and **nothing is recorded**.
3. On `201`, or on `409 already_reported` (H knows better than R), R keeps **a record that the report was made and nothing it said**:
   a `Report` row with a new scope `REMOTE`, the reporter, the target key and `communityId` (the cached copy), an empty snapshot and **no
   `details`**. It exists for three reasons: to stop the same thing being sent twice without asking H, to count towards the reporter's
   limits (a person must not be able to send ten an hour to *every* server), and so that erasing the reporter on R can remove it.
   It is in **no queue**: `visibleTo` excludes `REMOTE`, so R's admins and moderators never see it, and it is not counted as "open" because
   R can never close it. It is deleted with the same retention as any report, and with the reporter's account (not merely blanked).
4. If R crashes between H accepting and R writing the record, nothing is lost: the person tries again, H says `already_reported`, R
   records it then.

`403 not_a_member` from H reaches the person as "you are not a member of that community any more"; `429` as the ordinary
"too many reports"; `404 report_target_not_found` as "that is not available to report any more".

### Why a blocking call, not the outbox

The outbox is for things that should happen eventually whatever the answer. A report can be *refused* for reasons the reporter should be
told (already reported, no longer a member, too many), and the outbox treats a `4xx` as permanent with nowhere to say so. A blocking call
is also what every other member action in a remote community does. The cost is that a report made while H is down is not made: the
person is told so and can try again, which is a better failure than "sent" for something that was never delivered.

### Servers that do not know the endpoint

An older H has no such route and answers the federation router's generic `404 { "error": "not_found" }`. The new endpoint **never uses that
code**: its own not-found is `report_target_not_found`. So R reads a `404 not_found` on this path as "that server cannot take reports from
other servers yet" and answers its own person `409 remote_community`, **the code and words they get today** ("report it to that server's
moderators instead"), so nothing changes for them against an older server and no client has to learn anything. This needs no version
negotiation and no cache of what a peer supports, which could go stale the day the peer upgrades. The discovery document also gains
`features.reports: true`, for a person or tool that wants to know; R does not rely on it. `protocolVersion` stays `0.1.0`: this adds an
endpoint, as invites and embeds did.

This is an assumption about older servers that I have **read from the code, not run**: the first thing the implementation does is point
the previous release's image at a signed request to this path and record what it really answers, and the design changes if it is not
`404 not_found`.

### What stops it being a weapon

- **A hostile server cannot report as someone it has not got.** The reporter must already be a member of the community on H, which H
  decides, not R; a server cannot join people to a community it has no business with.
- **A hostile server can make up members of its own** (create accounts, join, report). So H also limits **one origin domain to 100
  reports an hour** (counted in the database, in addition to the per-person limits), and an operator who sees abuse already has
  `FEDERATION_BLOCKED_DOMAINS`. The number is a guess, kept as a constant rather than a setting until someone needs it to be one.
- **A hostile H cannot do anything with the answer.** R reads only the status and a known error code, never copies text from the body.
- **No id mixing.** A message must belong to the community in the path (as for delete), and the reporter's standing is looked up in *that*
  community.
- **Replays** are already refused by the signature check; a retry after a timeout is safe because of `already_reported`.

### What this does not do

No answer about the outcome goes back to the reporter, and nothing tells H's moderators sooner than they open the queue (as for local
reports). A message edited or deleted on H after the report is as described above (the snapshot is what it was). Relaying a person or a
direct message, and a reply path for the outcome, are out of scope.

### What would change in the code

- **Server (H):** `POST /federation/v1/communities/{id}/reports` calling `createReport` with the remote member as reporter; a per-origin
  count in `createReport`'s limits; `features.reports` in the discovery document.
- **Server (R):** `POST /reports` relays instead of refusing `remote_community` when the community is cached from a peer; `REMOTE` scope
  (one migration: a new enum value) excluded from the queues and the open count; deletion of `REMOTE` rows on erasure.
- **Client:** the dialog says where it is going ("Your report goes to *far.example*, where this community lives") and the new refusals are
  worded; nothing else.
- **Docs:** `protocol/federation.md` (the endpoint, the error codes, the 404 rule), this note, the OpenAPI text of `POST /reports`.
- **Tests:** H's side with a signed fake peer (every row of the table, plus the per-origin limit and a message from another community); R's
  side with a fake home server (relay, `409`, `502`, the record, no queue shows it, erasure); a real run of the **previous release's
  image as H** to prove the `404 not_found` really is what an old server says; and a browser test with the two demo servers
  (`alice.test` / `bob.test`): a member of one reports a message in the other's community and its owner sees it, with the reporter as
  `@name:bob.test`. Mutation checks on every guard above, as for the rest.

### Questions for review

1. **Scope:** only a message and the community itself, not people or direct messages. Agree?
2. **Blocking call**, not the outbox, with "try again" when the other server is down. Agree?
3. **R keeps a record** (no text, in no queue) so limits and duplicates hold without asking H. Or should R keep nothing and rely on H?
4. **100 reports an hour per origin domain** at H, a constant. Right order of magnitude?
5. One PR (both servers' sides, the small client change, the protocol text and the tests), or the protocol and server first and the
   client wording after?

## Not built (in this version)

- **Relaying a report to another server's moderators.** [Proposed above](#reports-about-content-on-another-server-proposed-not-built), not built.
  Until then the reporter is told to report to that server.
- **A notification** to moderators when a report arrives (the queue is read when opened, and there is no count on the Settings button), and any
  message to the reporter about the outcome. Opening the reported message in its place from the queue is not built either.
- **Automatic detection, appeals, a public transparency report, reporting to outside authorities** (out of scope in #58).
