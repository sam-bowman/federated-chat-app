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
  type. They'll see it on their own Incoming tab.
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
icons (edit/delete only on your own messages). The 📎 button attaches a
file; the smiley opens your emoticon picker (see below). You'll see a
"typing…" indicator under the composer when the other person (or someone in
a group chat) is typing.

Leaving a DM or group ("Delete chat" / "Leave group" in the header) removes
it from your own list - it doesn't delete it for anyone else.

## Communities and channels

Click **+** at the bottom of the server rail (far left) to create a
community, or switch to the **Join by ID** tab and paste a community ID
someone shared with you. A freshly-created community starts with one
channel, `#general`.

- **Inviting people**: the **Invite · N members** button in a community's
  header copies its ID to your clipboard - share it with whoever you want to
  invite, who then uses "Join by ID."
- **Creating a channel**: the **+** next to the community name in the
  sidebar (community owner only, for now).
- **Community settings**: the **Settings** button in the header (owner
  only) lets you rename the community or change its description.
- **Leaving**: non-owners get a **Leave** button in the header instead of
  Settings; you can rejoin later with the same community ID.

Sending, reacting, editing, and deleting messages in a channel works exactly
like a DM - same hover actions, same composer.

> Member management beyond leaving - kicking, banning, or assigning roles -
> isn't exposed in the client UI yet, even though the server supports it.
> See [ROADMAP.md](../ROADMAP.md)'s "Admin/moderation web UI" entry.

## Emoticons

The **Emoticons** page (sidebar, below Friends) has three tabs:

- **My emoticons**: ones you created. Upload an image, give it a name and a
  `:trigger:`, and typing that trigger in any message renders it. Delete
  your own anytime.
- **Saved**: emoticons created by someone else that you've saved under your
  own trigger (via the **Save** button on a community/other-creator
  emoticon, if its creator allows saving). A save is a live reference - if
  the original image changes, yours updates too; only the trigger you use
  is your own.
- **Community**: emoticons visible to you through a community you're in.

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
side of this, and [README.md](../README.md)'s "Known federation
limitations" for what's still out of scope.
