# Link previews

> Part of the [deployment guides](README.md).

When a message contains a web address, the server can read that page once and show a small **text card** under the message: the page's title, a short description and the site it is on. It is **off by default**, because switching it on makes your server make outbound requests to addresses that people type.

## Turning it on

Read once, at startup: change it and restart the server.

| How you run it | What to set |
|---|---|
| Docker Compose (`docker-compose.selfhost.yml`) | `LINK_PREVIEWS_ENABLED=true` in your `.env.selfhost` |
| Kubernetes (Helm) | `server.linkPreviews: true` in your values |
| Native binary or `npm run dev` | `LINK_PREVIEWS_ENABLED=true` in the server's `.env` |

The value must be `true`/`false` (also `1`/`0`, `yes`/`no`, `on`/`off`). Anything else stops the server at startup and says so. The discovery document says `features.linkPreviews`, which is how the apps know to offer the "Show link previews" setting.

## What it does

- **Only the server that accepted the message reads the page**, once, a moment after the message is sent. The cards appear a second or two later, pushed to everyone who has the chat open. Nobody who reads the message ever contacts the linked site: no reader's address is shown to it, and the card has no picture to load (pictures are deliberately not built).
- A message gets cards for at most its **first 3 addresses**. Only `http://` and `https://` addresses (and `www.` ones) count. Messages that are invitations, deleted, or sent by someone on another server are not read.
- Editing a message reads the new addresses again; deleting it removes the cards. The sender can take the cards off their own message with the ✕ on the card (for everyone, and editing does not bring them back).
- **Other servers do not read the page.** A server that holds a copy of the message (a friend or a community member on another server) is *told* what this one found, and checks it before showing it: only plain `http(s)` addresses, text only, cut to length. A server with previews off ignores what it is told, so "off" means no cards at all there.
- Cards are text. The app shows the linked address's own host beside whatever the page calls itself, because the page can say anything about itself.

## What it will not read

Because a person controls the address, the server refuses to be a way into your network. Every address, **and every redirect it leads to**, is checked before a connection is made:

- Only ports **80 and 443**.
- Not `localhost`, not an address that is a private, loopback, link-local, multicast or otherwise internal address (IPv4 and IPv6), and not a name that *resolves* to one: the connection itself is made to the address that was checked, so a name cannot answer differently the second time.
- At most **3 redirects**; a redirect to an internal address is refused like any other.
- Only pages that say they are HTML; a **5 second** limit for the whole read; at most **256 KiB** read, the rest is dropped.

It is the same kind of guard that protects the server's requests to other federation servers. If your server has to preview pages on your own network (it normally should not), there is no setting for it on purpose.

## Limits and what is remembered

| | |
|---|---|
| Pages one person can make the server read | 20 per 10 minutes |
| Pages the server reads for everyone | 600 per hour, 4 at a time |
| A page that gave a preview is remembered | 24 hours |
| A page that gave nothing is remembered | 1 hour |

A remembered page costs nothing to show again, so a link many people post is read once. The memory is the `LinkPreviewCache` table (address, title, description, site name, time; nothing else) and old entries are cleared out over time. Over a limit a message simply gets no card; the message itself is never held up or refused.

The request says who is asking: `User-Agent: FederatedChatLinkPreview/<version> (+<your server's address>)`.

## Privacy, in short

- The linked site sees **your server**, not your people. It learns that someone on your server posted that address, nothing about who.
- Your server stores the title, description and site name it read, for the message and for the cache.
- A person can hide the cards on their own device in Settings -> Link previews; that only changes what *they* see.

## Checking it works

1. Turn it on and restart.
2. Open Settings: a "Link previews" section appears (it does not on a server that has it off).
3. Send a message containing the address of a public page. A card appears under it within a few seconds.
4. Send one containing `http://localhost:4000/` or `http://192.168.1.1/`: no card, the message is sent as usual.
