# Link previews

> Part of the [deployment guides](README.md).

When a message contains a web address, the server can read that page once and show a small **text card** under the message: the page's title, a short description and the site it is on. It is **off by default**, because switching it on makes your server make outbound requests to addresses that people type. A second switch, also off by default, adds the page's **picture** to the card (see [Pictures](#pictures)).

## Turning it on

Either set it where the server is deployed (read at startup, so restart after changing it), or leave it unset there and change it live from the admin page's **Settings** tab ([admin page](admin-ui.md)): a value set in the environment is locked there.

| How you run it | What to set |
|---|---|
| Docker Compose (`docker-compose.selfhost.yml`) | `LINK_PREVIEWS_ENABLED=true` in your `.env.selfhost` |
| Kubernetes (Helm) | `server.linkPreviews: true` in your values |
| Native binary or `npm run dev` | `LINK_PREVIEWS_ENABLED=true` in the server's `.env` |
| The admin page | Settings -> Link previews, when it is not set in the environment |

The value must be `true`/`false` (also `1`/`0`, `yes`/`no`, `on`/`off`). Anything else stops the server at startup and says so. The discovery document says `features.linkPreviews`, which is how the apps know to offer the "Show link previews" setting.

## What it does

- **Only the server that accepted the message reads the page**, once, a moment after the message is sent. The cards appear a second or two later, pushed to everyone who has the chat open. Nobody who reads the message ever contacts the linked site: no reader's address is shown to it. Without [pictures](#pictures) the card is text, with nothing to load.
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

## Pictures

Off by default, and a switch of its own: `LINK_PREVIEW_IMAGES_ENABLED=true` (Helm: `server.linkPreviewImages: true`; the admin page's **Settings** tab, "Pictures in link previews"). It does nothing unless link previews are on too. It means your server **downloads pictures from other people's sites and stores them**, so it is a separate decision.

What it adds:

- A card shows the page's picture (its `og:image`, or Twitter's), and **a link that is itself a picture** (PNG, JPEG, GIF or WebP) is shown as the picture, with the site it is on.
- The server that accepted the message fetches the picture **once**, with every rule a page read has (public addresses only, checked on the address actually connected to, every redirect checked, ports 80/443, no cookies), with its own limits: at most **2 MiB**, **4096 pixels a side and 16 million pixels** in all, **8 seconds**, 2 at a time, **300 pictures an hour** for the whole server.
- **The other site's word is never taken.** Only the file's own first bytes decide what it is: PNG, JPEG, GIF or WebP, and the size is read from the file's header. SVG (which can carry script) and anything else is refused, whatever content type the site gave. The copy is named from the bytes it turned out to be (`.png`, `.jpg`, ...), never from the address, and is served by the uploads route with `X-Content-Type-Options: nosniff`. It is **not re-encoded**: a file that starts like a picture and is then garbage shows as a broken picture and cannot be anything else, and a picture keeps whatever metadata the site put in it. An animated GIF or WebP stays animated, within the size limit.
- The copy is stored the way uploads are (the uploads volume, or the S3 bucket). **A copy lives while a message that is not deleted still shows it**, and for two days after it was last given to a message. Once nothing shows it, it is removed (the file and its record), checked **every hour**. Delete the message, take the preview off, or edit the link away, and the picture goes with them. **Turn pictures off and every copy is removed within the hour**, and cards go back to text at once.
- No more than **1 GiB** of copies in all: past that, new cards are shown without a picture. The same address is fetched once however many pages name it.
- A picture that cannot be had (missing, too big, not a picture) is only a card without a picture. It never costs the card.

### Other servers, and who contacts whom

This was the question to settle first. A server that holds a copy of the message (a friend or community member on another server) is told, with the preview, **where the sender's server keeps its copy** (an `image` with an address and a size; see [the federation protocol](../../protocol/federation.md)). It **never fetches anything itself**: not the page, not the picture. So the linked site is only ever contacted by the server that accepted the message, as before.

The reader's browser then loads the picture from the address the sender's server gave. The effect is that **a reader's browser tells the sender's server that someone is reading that message**, in the same way it already does for a file attached to a message from another server. It never tells the linked site, which was the thing that mattered. The alternatives were worse: every server making its own copy would make *every* server read the linked site (breaking "only the accepting server reads it"), and no picture at all is what text-only previews were.

Two honest limits of that:

- A server only has the sender's word that the address is a copy on the sender's server. A malicious server could name any address and make its readers' browsers ask it, exactly as it can for an attachment. The address is checked to be a plain `http(s)` address with no credentials and a sane size, nothing more.
- A reader can say no. **Settings -> Link previews -> "Show the pictures on link previews"** (on this device) hides the pictures and the cards that are only a picture, and a server with pictures off shows none from other servers either, so its readers' browsers never ask.

## Limits and what is remembered

| | |
|---|---|
| Pages one person can make the server read | 20 per 10 minutes |
| Pages the server reads for everyone | 600 per hour, 4 at a time |
| A page that gave a preview is remembered | 24 hours |
| A page that gave nothing is remembered | 1 hour |
| Pictures kept in all | 1 GiB, 300 fetched an hour (see [Pictures](#pictures)) |

A remembered page costs nothing to show again, so a link many people post is read once. The memory is the `LinkPreviewCache` table (address, title, description, site name, time; nothing else) and old entries are cleared out over time. Over a limit a message simply gets no card; the message itself is never held up or refused.

The request says who is asking: `User-Agent: FederatedChatLinkPreview/<version> (+<your server's address>)`.

## Privacy, in short

- The linked site sees **your server**, not your people. It learns that someone on your server posted that address, nothing about who.
- Your server stores the title, description and site name it read, for the message and for the cache. With pictures on it also stores a copy of each picture.
- A person can hide the cards, and separately their pictures, on their own device in Settings -> Link previews; that only changes what *they* see.

## Checking it works

1. Turn it on and restart.
2. Open Settings: a "Link previews" section appears (it does not on a server that has it off).
3. Send a message containing the address of a public page. A card appears under it within a few seconds.
4. Send one containing `http://localhost:4000/` or `http://192.168.1.1/`: no card, the message is sent as usual.

**No card for a public page, and the log says `could not read a page: error (ENOTFOUND)`?** The server cannot look up names. The server logs why a
page could not be read (a connection that failed or timed out, at most once in five minutes for each reason; a 404 or a page that is not HTML is
ordinary and not logged), and on Kubernetes the usual cause is the pod's search domains:
[Link previews do nothing, or other servers cannot be found](kubernetes.md#link-previews-do-nothing-or-other-servers-cannot-be-found).
Federation needs the same lookups, so it fails the same way.
