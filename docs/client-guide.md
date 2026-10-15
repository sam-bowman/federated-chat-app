# Using the client

A walkthrough of the web client from an end user's point of view - adding a
friend, starting a chat, creating a community, setting up 2FA. For building,
deploying, or developing the app instead, see [README.md](../README.md) and
[docs/distribution.md](distribution.md); this file is the other side of that -
what to do once it's running in front of you.

Screenshots aren't included since the UI is still evolving - this follows the
actual control flow (which button, which field) instead, so it stays correct
longer.

## Your identity

Every account is `@username:yourserver.com` - the username you chose plus the
domain of the homeserver you registered on. You'll see this as `user.identity`
in your own Settings page, and it's what you give someone on a *different*
server to be found by them (see "Federation" below).

If the client isn't locked to one fixed server (a self-hosted deployment
usually is; the project's own hosted client isn't), the first thing you'll
see is a **"Find your server"** screen. Enter either your full identity
(`@you:chat.example.com`) or just the server's address, and it resolves the
rest automatically. Once resolved, the login/register form below it shows
which server you're on, with a "Not you? Switch server." link if you got the
wrong one.

## Creating an account / signing in

Registration needs a username, an optional display name, and a password of
at least 8 characters with an uppercase letter, a lowercase letter, a number,
and a symbol. The server also checks it against known-breached password
lists - if it's been seen in a public data breach, you'll be asked to pick a
different one, independent of the character-complexity check.

If you have two-factor authentication enabled (see below), signing in is a
second step: after your password, you're prompted for a 6-digit code from
your authenticator app (or one of your recovery codes).

> **Multiple accounts**: your session is stored per browser profile, shared
> across tabs. To be signed in as two different people at once, use two
> separate browser profiles (or one normal + one incognito window), not two
> tabs in the same profile.

## Friends

The **Friends** page (left sidebar, below the DM rail) has four tabs:
Friends, Incoming, Outgoing, and Blocked.

- **Add a friend**: type a username (or `@them:theirserver.com` for someone
  on a different server) into the search box at the top and hit **Send
  request**, or pick them from the live search results that appear as you
  type. The results leave out people you can't add right now: yourself,
  existing friends, anyone you have a pending request with (either way), and
  anyone blocked either way. Use the arrow keys and Enter to pick one; Esc,
  clicking elsewhere or choosing a result closes the list. They'll see the
  request on their own Incoming tab.
- **Accept / decline**: from the Incoming tab.
- **Cancel**: an outgoing request you haven't had a response to yet, from
  the Outgoing tab.
- **Remove**: unfriends someone you're already connected with, from the
  Friends tab.
- **Block**: available from a search result or an existing friend row. A
  blocked user can't message or friend-request you; manage the block list
  from the Blocked tab.

## Direct messages and group chats

Click **+** next to "Chats" in the sidebar to start a new conversation.
Check one friend for a 1:1 DM, or more than one for a group chat (up to 10
members total, including you). Every conversation you're part of shows up in the sidebar under
"Direct Messages," with a bold title and a dot when there's something
unread.

Inside a conversation, hovering a message reveals reaction, edit, and delete
icons (edit/delete only on your own messages). After the five quick reactions,
the **+** opens a picker with every Unicode emoji: type to search, use the arrow
keys to move, Enter to react, Esc to close; recently used emoji come first.
Choosing an emoji you already reacted with takes your reaction back, and a
message can carry at most 20 different reactions. The 📎 button attaches a
file; the smiley opens your emoticon picker (see below). You'll see a
"typing…" indicator under the composer when the other person (or someone in
a group chat) is typing.

A conversation opens at its 50 most recent messages. To read further back,
scroll to the top and click **Load older messages** - it loads another 50 at
a time and keeps your place, and the button disappears once you've reached
the beginning. Channels in a community work the same way.

Leaving a DM or group ("Delete chat" / "Leave group" in the header) removes
it from your own list - it doesn't delete it for anyone else.

## Communities and channels

Click **+** at the bottom of the server rail (far left) to create a
community, or switch to the **Join by ID** tab and paste a community ID
someone shared with you. A freshly-created community starts with one
channel, `#general`.

- **Inviting people**: the **Invite · N members** button in a community's
  header opens a dialog with two ways in. The **invite code** (with **Copy**)
  works for anyone, on your server or another one: they paste it under **New
  community**, **Join by ID**. Under **Invite a friend** are your friends who are
  not in the community yet (searchable, including friends on other servers);
  **Invite** sends them a direct message with a card showing the community, who
  invited them and a **Join** button, so they join without copying anything. Once
  they are in, the card says **Joined** and offers **Open**; if they were banned
  since, or the community is gone, pressing Join says so. Any member can invite.
  (If you are allowed to see the ban list, banned friends are left out; otherwise
  an invitation to one simply cannot be accepted.)
- **The community's icon** (the tile on the left rail): in **Settings** (the
  owner, or anyone allowed to manage the community), **General**, **Icon**.
  **Upload a picture** (applied as soon as you choose it; **Remove picture** goes
  back to letters) or, without a picture, choose 1 to 3 **letters** and a **tile
  colour** and press **Save icon**. The two previews show the tile as the rail
  will draw it, normal and selected. With no letters it shows the first two
  letters of the name; the text colour (black or white) is picked to read on
  your colour. Members on this and other servers see the change without
  reloading.
- **Creating a channel**: the **+** next to the community name in the
  sidebar (community owner only, for now).
- **A channel's topic**, if it has one, shows in the channel header after the
  name: one line, cut off with an ellipsis when long (hover for the whole
  text, or click it to expand it in place), and as a tooltip on the channel in
  the sidebar. It is always shown as plain text.
- **Community settings**: the **Settings** button in the header (the owner,
  and anyone whose roles grant a management permission, who see only the
  tabs and buttons they can use) opens a panel with five tabs. **General** renames the community or
  changes its description. **Members** lists everyone in it, with **Kick**
  (they can rejoin with the community ID) and **Ban** (they can't rejoin
  until unbanned) buttons on every member except you, plus a chip for each
  role - click one to give it to that member or take it away. **Channels**
  lets you reorder channels with the arrows, **Edit** a channel's name and
  topic, or **Delete** one. **Roles** is where you make and edit roles
  (below). **Banned** lists banned users, each with an **Unban** button.
  Deleting a channel **permanently deletes every message in it, for
  everyone** - you're asked to confirm, and a community always keeps at least
  one channel.
- **Handing over or deleting a community** (owner only): at the bottom of
  **General**, the **Danger zone** has **Transfer ownership...**, which gives
  the community to another member who has an account on your server (you
  confirm with your password; you then become an ordinary member and only the
  new owner can give you management back), and **Delete community...**, which
  permanently removes it and everything in it for every member, and needs the
  community's name typed to confirm. To keep a community going without you,
  transfer it, then leave.
- **Leaving**: anyone but the owner gets a **Leave** button in the header
  (alongside Settings if their roles grant some); you can rejoin later with
  the same community ID. An owner can't leave: transfer or delete first.

Sending, reacting, editing, and deleting messages in a channel works exactly
like a DM - same hover actions, same composer.

### Roles

A role is a named bundle of permissions you can give to members. Everyone
automatically has **@everyone**, which sets what any member can do by default
(it can be edited but not renamed or deleted). In the **Roles** tab, **New
role** lets you pick a name, an optional colour, and any of these permissions:
send messages, kick members, ban members, manage channels, manage roles, and
manage the community. A member's abilities are everything granted by all the
roles they have, so a "Moderator" role with just *Kick members* lets whoever
holds it kick people without giving them anything else. Deleting a role takes
it away from everyone who had it.

The colour is chosen in the app's own picker (press the colour button): presets first, then a custom colour by hue, saturation and brightness (or by dragging in the square) or typed as hex, with a preview on the dark sidebar and a warning if the colour would be hard to see on it. **No colour** is one of the choices. **Apply** (or Enter) keeps it, **Cancel** or Esc throws it away; everything works from the keyboard.

Someone you give *Manage roles* to can create and hand out roles too, but only
roles made up of permissions they hold themselves - so they can't give
themselves (or anyone) more power than they were trusted with.

A member's Settings panel shows only what their roles allow: *Kick members* or
*Ban members* give the Members tab with that button (and *Ban members* the Banned
tab), *Manage roles* the Roles tab and the role chips, *Manage channels* the
Channels tab and the **+** by the community name, *Manage community* the General
tab. Only the owner sees the Danger zone.

## Emoticons

The **Emoticons** page (sidebar, below Friends) has three tabs:

- **My emoticons**: ones you created, plus any you've forked (below). Upload
  an image, give it a name and a `:trigger:`, and typing that trigger in any
  message renders it. Use **Edit** to rename one, replace its image, or
  choose whether other people can **Save** it and/or **Fork** it (both are on
  by default; turning one off only stops *new* saves and forks - anyone who
  already has one keeps it). The trigger can't be changed, since messages and
  saves refer to it. Delete it anytime.
- **Saved**: emoticons created by someone else that you've saved under your
  own trigger (via the **Save** button on a community/other-creator
  emoticon, if its creator allows saving). A save is a live reference - if
  the original image changes, yours updates too; only the trigger you use
  is your own.
- **Community**: emoticons visible to you through a community you're in.

**Save or Fork?** Both appear on someone else's emoticon (Fork only if its
creator allows it). **Save** keeps a link to the original: it always looks like
the original, and you only choose your own trigger. **Fork** makes your own
independent copy - you pick its name and trigger, and can start from a different
image - that you own and can delete, and it doesn't change when the original
does. A fork remembers where it came from ("forked from Wave by pager") and has
a **Sync fork** button on the My emoticons tab: click it when you want to pull
the original's current image into your copy. Syncing only ever replaces the
image - your fork's name and trigger stay yours - and nothing updates unless you
click it. That includes replacing an image you've customised yourself, so only
sync when you want the original's picture back. If the original is later
deleted, your fork lives on as a regular emoticon of your own.

When the creator **edits** an emoticon, everyone who *saved* it sees the new
image and name straight away, while forks keep their current image until their
owners sync.

The emoticon picker (smiley icon in the composer) inserts a trigger at your
cursor from anything you have access to - your own, saved, or a community's.

## Presence and status

Settings → **Presence** lets you set ONLINE / AWAY / BUSY / DO NOT DISTURB /
INVISIBLE, plus a free-text custom status message. Friends see your status
and custom message next to your name; INVISIBLE shows as OFFLINE to
everyone except you.

## Two-factor authentication

Settings → **Two-factor authentication** → **Set up two-factor
authentication**. You'll need to re-enter your password first (also true
when disabling it later - a stolen session alone can't enable or remove
your 2FA). Then:

1. Scan the QR code with an authenticator app (Google Authenticator, Authy,
   1Password, etc.), or enter the shown secret manually.
2. Enter the 6-digit code it generates to confirm.
3. **Save the 10 recovery codes shown next** - each works once, for signing
   in if you ever lose your authenticator app. They're shown exactly once.

From then on, signing in asks for a code after your password. Lost your
authenticator app? Use a recovery code instead - there's a link for that on
the 2FA login screen.

## Your profile

Settings is also where you change your avatar (upload an image), display
name, and bio. Your identity (`@username:domain`) itself can't be changed.

## Federation: talking to people on other servers

Nothing above changes when the other person is on a different homeserver -
friending, DMing, group chats, and communities all work the same way,
addressed by `@username:domain` instead of just `username`. A few things
worth knowing:

- **Joining a community hosted elsewhere** uses the same "Join by ID" flow,
  but the ID includes the domain: `<communityId>:homeserver.example.com`.
- **If the other server is briefly unreachable**, a message you send still
  queues and delivers automatically once it's back - you don't need to
  resend it.
- **Presence isn't retried** the same way - if your friend's server was down
  when your status changed, they'll see your current status the next time it
  changes (or the next time your profile loads), not a backfilled history.

See [protocol/federation.md](../protocol/federation.md) for the technical
side of this, and [federation-architecture.md](federation-architecture.md)'s "Known federation
limitations" for what's still out of scope.
