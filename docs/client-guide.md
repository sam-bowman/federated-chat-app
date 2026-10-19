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
the **+** opens a picker with every Unicode emoji **and your emoticons**
(yours, saved ones, and your communities'): type to search, use the arrow
keys to move, Enter to react, Esc to close; recently used ones come first.
An emoticon reaction shows as its picture, **for everyone**, including people
who do not have that emoticon and people on other servers; hover it for its name
(an emoticon that looks like an emoji is still a separate reaction). Choosing
something you already reacted with takes your reaction back, and a
message can carry at most 20 different reactions. You can only add an emoticon
you can use; clicking someone else's emoticon reaction that you cannot use tells
you so and changes nothing. If the emoticon is later deleted, its reactions go
with it. The 📎 button attaches a
file; the smiley opens the emoji and emoticon picker (see "Adding emoticons and
emoji to a message"). You'll see a
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
  header opens a dialog with three ways in.
  - **Invites** are codes you make: choose how long it lasts (**1 hour**, **24
    hours**, **7 days** or **Never**) and how many people can use it (**No limit**
    or 1 to 100), then **Create invite** and **Copy** it. Anyone with it can join, on
    your server or another one: they paste it under **New community**, **Join by
    ID**. Below, **Your invites** lists the ones you made with their code, whether
    they are **Active**, **Expired**, **Used up** or **Revoked**, when they expire
    and how many have been used; **Revoke** stops one at once (people who already
    joined stay). Someone who can manage the community sees **All invites**, and
    can revoke anyone's.
  - **The community code** is the permanent one: it never expires and anyone with
    it can join, until the community is made invite-only or local-only (below).
  - **Invite a friend** lists your friends who are not in the community yet
    (searchable, including friends on other servers); **Invite** sends them a direct
    message with a card showing the community, who invited them and a **Join**
    button, so they join without copying anything. The card carries an invitation
    of its own that works once (once per person in a group chat) and lasts a week.
    Once they are in, the card says **Joined** and offers **Open**. If the
    invitation has **expired**, was **used**, was **cancelled** (revoked) or they were
    banned since, or the community is gone, pressing Join says which, and for an
    invitation that is no good the Join button goes away.

  Any member can create invites, unless a manager takes the **Create invites**
  permission away from the **@everyone** role in **Roles** (the owner always can).
  Someone without it sees why instead of the buttons. For a community on **another
  server** the dialog always offers to make an invite: that server makes it for you
  and decides whether you may (if not, the dialog says so), and only that server
  lists and revokes invites, so the dialog says that too. (If you are allowed to
  see the ban list, banned friends are left out of the friends; otherwise an
  invitation to one simply cannot be accepted.)
- **Browse** (the compass on the left, below the **+**): the communities a server lists as public and the
  people who chose to be listed, newest first, with a search box. It starts with your own server; type another
  server's name to browse its list, which your server fetches for you. **Join** a community from there, or
  **Add friend** to a person (their own setting still decides). Some servers publish no directory, and then it
  says so. You are listed only if you choose to be: **Settings -> Privacy -> List me in this server's directory of
  people** (and only while other servers can find you: hiding wins).
- **Who can join a community**: in **Settings**, **General**, **Who can join** (the
  owner, or anyone allowed to manage the community), choose one of four:
  - **Anyone with the community code** - how every community starts. Anyone who has
    the code can join, on this server or another, and old codes and cards keep working.
  - **Public: listed in the directory** - the same as the first, and the community also appears in
    **Browse** on this server (and, through their own servers, on other servers' people's screens), if the
    server publishes a directory. Where it does not, this behaves like the first.
  - **Only people with an invite** - the community code then lets no one in, and the
    Invite dialog stops showing it; people need an invite, which still works across
    servers (their server asks the community's server, which checks the expiry, the
    limit and whether it was revoked). Pasting a code under **Join by ID** that is
    **expired**, **used up**, **cancelled**, not valid, or missing says which.
  - **Only people on this server** - anyone on this server can join with the code, but
    people on other servers cannot: they are told "Couldn't find or join that
    community", the same as for a code that does not exist, so it can't even be
    confirmed to be there. The Invite dialog says who the code works for, leaves friends
    on other servers out of the ones you can invite, and a card can't be sent to one.
  A server may limit how open its communities can be: choices more open than it allows are greyed out and say so, and a community
  set wider before behaves as the most the server allows. Changing it **removes nobody**: everyone already in stays, including people from other
  servers if you choose the last one. The choice shows as soon as you make it.
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

### Updates (desktop app)

In the desktop app, **Settings -> Updates** keeps the app current. **Update automatically** is on by default: the app checks
now and then and downloads a new version in the background, then shows a banner (*Restart to update* / *Later*) and installs it
only when you press the button. Turn it off to stop the automatic checks; **Check for updates** always works. See
[the desktop app guide](deployment/desktop-app.md#upgrading). The web version has no such section: the server it comes from
updates it.

### Links in messages

A web address in a message is a link: click it and it opens in a new tab. Only `http://` and `https://` addresses
(and `www.` ones, which open as `https://`) become links, and a link always goes where its text says. Anything else
(`javascript:`, `file:`, an address with a name and password in it, `10:30`, an e-mail address) stays plain text. Punctuation
after an address is not part of it, so `see https://example.com/page.` links to `.../page`, and a link in brackets works.
There are no previews or embeds yet. In the desktop app a link is expected to open in your system browser; that was not
tried in a real desktop build.

### Adding emoticons and emoji to a message

You never need to remember a trigger. There are two ways in, and both put the
emoticon **at the cursor** (replacing any text you have selected) and leave the
cursor after it, so you can keep typing:

- **Type `:` and two letters** (`:pa`) and a list of matching emoticons appears
  above the message box, with a picture and the full trigger. Press **↑**/**↓**
  to move, **Enter** or **Tab** to complete it, **Esc** to dismiss the list (it
  comes back when you change what you are typing). A colon inside a word, such
  as `10:30` or a web address, never opens it.
- **The smiley button** opens a picker: type to search emoticon names, triggers
  and Unicode emoji, or browse *Recently used*, *Your emoticons*, *Saved*, *This
  community's* (first, when you are in one), other communities', and then every
  Unicode emoji by category. Arrow keys move, Enter picks, Esc closes, and so
  does a click anywhere else. To pick several in a row, hold **Shift** while
  you choose, or press the pin button next to the search box; the next one goes
  right after the last.

Only emoticons that will actually show as a picture when you send are offered.
If your own `:party:` and a community's `:party:` share a trigger, the
community's is what people see, so it is the only one listed. A Unicode emoji is
inserted as the character itself.

## Presence and status

Your status is always shown at the bottom of the sidebar: a coloured dot on your
avatar, and under your name the status in words with your custom status after it
("Busy · in a meeting"). Press your avatar or the status to open the status menu:
**Online**, **Away**, **Busy**, **Do not disturb** and **Invisible** (each with a
line saying what it means), and a **custom status** box with **Set** and
**Clear**. A choice applies at once and closes the menu. With the keyboard, Tab
to the status, Enter to open, the arrow keys to move, Enter to choose and Esc to
close (focus goes back to the status). The same choices, and the custom status,
are in Settings → **Presence**, and the two always agree. Your own status is kept
current on every device you are signed in on: connecting shows you as Online, and
a change made on your phone shows on your desktop straight away.

Friends see your status and custom message next to your name. **Invisible** shows
as offline to everyone except you; the footer spells it out ("Invisible (others
see you offline)") so you don't forget you're in it. Do not disturb and Busy are
shown to others as such; they don't silence your own notifications yet (that
comes with notifications, #47).

## Notifications

When a message arrives you can get a **sound** (a short two-note chime) and a **system notification** (the box in the corner
of your screen, with the sender and the start of the message). They are separate choices, and both are on by default.

- **For everything:** Settings -> Notifications. It also has buttons to try the sound and a notification, and to allow system
  notifications on the device you are using (a browser asks you first; the desktop app asks the system).
- **For one place:** the bell in the header of a conversation or channel. A conversation has its own sound and notification
  choice. A channel has its own, and below it the same two choices for **all of its community**. Each can be *Default* (follow
  the level above), *On* or *Off*. The most specific choice wins, so a channel you turned on still alerts in a community you
  muted. A bell shown as a crossed-out one means both are off there. Places with a choice of their own are listed in Settings
  -> Notifications, where **Reset** puts one back to the default.

You never get either for the conversation or channel you are looking at while the app has focus, and none while your status is
**Do not disturb** or for your own messages. Other chats still alert while the app has focus. If the app is in the background,
the open chat alerts like any other. A burst of messages makes one sound, not one each.

The choices are kept on your account, not in the browser, so they follow you to every device; whether *this device* may show
system notifications is the browser's or the system's own permission. A browser only plays sound after you have clicked or typed
in the page once. These are notifications while the app (or its tab) is running: nothing arrives once it is closed.

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

## Profiles

**Press anyone's picture or name** - on a message, in the Friends page (friends,
requests, blocked people and search results), in a direct message's header, or in
a community's member list - to open their profile. It shows their picture, name,
pronouns, identity (press it to copy), status, bio, and how long they have been a
member. Opened from a community, it also shows their **roles** there (and
**Owner**). Below the card are the actions that fit how you relate to them:

- **Message** opens (or creates) your direct message with them.
- **Add friend**, **Request sent**, **Accept friend request** or **Remove friend**,
  whichever applies.
- **Block** (asks first) or, for someone you blocked, **Unblock**. Blocking only
  works for people on your own server for now, so there is no Block for someone on
  another one.
- **Kick** and **Ban**, if you may do that in the community you opened it from -
  the same questions as the Members tab.
- On your own profile, **Edit profile**, which goes to Settings.

Someone on another server has a profile too: it is asked for from their own server
each time, so it is current. If their server can't be reached you see the copy
this server already had, with a note that it may be out of date. Fields an older
server doesn't have (pronouns, colour, join date) are simply left out. Someone who
has blocked you has no profile for you ("This profile isn't available").

Everything on a profile is text someone else wrote, and is shown as plain text:
HTML or markup in a name or bio appears as the characters, never as formatting.

### Editing yours

Settings → **Profile** is where you change your avatar, display name, **pronouns**
(up to 32 characters), **bio** (up to 512) and **profile colour** (the stripe across
the top of your card, chosen in the same colour picker as roles). A **live
preview** beside the form shows the card others will see, as you type, before you
save. The avatar is shown large at the top; **Change avatar** takes a picture (PNG,
JPEG, GIF or WebP, a square one works best since it is shown as a circle) and uses
it at once. A file that is not a picture, or one the server refuses (too large), is
reported under the button and your avatar stays as it was. Your identity
(`@username:domain`) itself can't be changed.

## Appearance

Settings -> **Appearance** sets how big the whole interface is: **Auto**, or one of
75%, 90%, 100%, 110%, 125%, 150%, 175% and 200%. The change applies at once (the page
you are looking at is the preview), is remembered **on this device only**, and is
in effect before the page first draws, so there is no flash of the wrong size when
you open the app.

**Auto** is the default and picks a size from your screen: 100% on a laptop or
full-HD screen, 125% on a 1440p monitor and 150% on a 4K one that your system is
showing at 100% (a 4K monitor your system already scales shows up as a smaller
screen and is left alone). It is chosen from the screen, not the window, so
resizing the window never changes it. **Auto (125%)** on the button tells you what
it is for this screen.

In the **desktop app**, **Ctrl** (or Cmd) and **+** / **-** step through the sizes
and **Ctrl** and **0** goes back to Auto, because the app's window may not have the
browser's own zoom keys. In a browser those keys are left to the browser's zoom.

At the larger sizes a small window has less room than it looks: 200% in a window
1280 pixels wide is laid out like a 640-pixel-wide one, so choose the size to suit
the window you use. Nothing is clipped or runs off the page down to that size
(the desktop app's window cannot be smaller than 640 by 480).

### Font

Under the size, **Font** sets the typeface: **Default** (Segoe UI, or your system's
own interface font), **Monospace (system)** (Cascadia Mono, SF Mono, Menlo, Consolas
or Liberation Mono, whichever your device has), **JetBrains Mono**, **IBM Plex
Mono** and **Fira Code**, or **Custom**, where you type the name of any font
installed on your device (if it is not found, the usual font is used; a name can
only contain letters, numbers, spaces and `. _ -`). A **Preview** line shows the
choice in its own font. The font applies to the whole interface, or, with **Use this
font for messages only**, just to what people write and the box you type in. **Ligatures**
(`->` and `!=` drawn as one symbol) is offered for the fonts that have them and is
off by default.

The three bundled fonts come with the app (latin letters only, 15 to 23 KB a file,
SIL Open Font License) and are served from the same place as the app itself, so
choosing one never contacts another site and it works offline and in the desktop
app. A font is only downloaded once you choose it. Like the size, the font is
remembered on this device only and is in effect before the page first draws; the
first time a bundled font is used the usual font shows for a moment while it loads.

## The sidebar

The left sidebar shows your full identity (`@username:domain`) under your name
and **wraps it onto a second line** rather than cutting it off, so a long name or
server is always readable (click it to copy). Its width is yours to set: drag its
right edge, or Tab to the edge and use Left/Right (a step at a time), Home
(narrowest) and End (widest); double-click it to go back to the default. The width
is remembered on this device. It is between 14 and 32 rem (the default is 20), and
on a narrow window it never takes more than 45% of the width. The desktop app's
window cannot be made smaller than 640 × 480.

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
- **A private server** (its owner turned federation off) doesn't connect to
  other servers at all. On one, the friend box says "this server only", people
  on other servers are greyed out in New message, and adding, messaging or
  joining anything on another server is refused with an explanation. Friends,
  conversations and communities you already had stay readable; what you write
  to people on other servers is kept and sent if the server connects again.
  See [deployment/private-server.md](deployment/private-server.md).
- **Hiding from other servers**: in Settings -> Privacy, "Let people on other servers find me". Turn it off and a server
  you have nothing to do with is told you don't exist, so its people can't look you up, send you a friend request or start a
  conversation with you. Friends, conversations and communities you already have with a server carry on, and people on your
  own server can still find you. A server's operator can turn this off for everyone, in which case the switch says so and
  can't be changed. If you try to add someone who has hidden from your server you are told "No one with that name was
  found", the same as for a name that doesn't exist.
- **Who can send you friend requests and start conversations**: also in Settings -> Privacy. Choose anyone, only people you
  share a community with (on this server or another), or only people on your own server. Your friends can always write to
  you, and conversations you already have are not affected. If you try to add someone, or start a conversation with
  someone, who does not accept it from you, you are told "This person isn't accepting friend requests from you" (or
  "...conversations"), however they have it set.
- **A server your server won't talk to**: its operator may limit which servers it federates with. Trying to add,
  message or join someone on one that is off limits is refused with "This server doesn't connect to that server".
  What you already had with it stays readable, and what you write to people there is kept and sent if that changes.
- **Presence isn't retried** the same way - if your friend's server was down
  when your status changed, they'll see your current status the next time it
  changes (or the next time your profile loads), not a backfilled history.

See [protocol/federation.md](../protocol/federation.md) for the technical
side of this, and [federation-architecture.md](federation-architecture.md)'s "Known federation
limitations" for what's still out of scope.
