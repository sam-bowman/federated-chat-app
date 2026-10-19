# Desktop app

> Part of the [documentation](../../README.md#documentation) and the
> [deployment guides](README.md).

A single-user desktop client for Windows, Linux and macOS (arm64), wrapping the
same web client in a native shell with [Tauri](https://tauri.app)
(`client/src-tauri/`, built from the exact same `client/` source as every other client
format). It is **only a client**: it needs a server run by you or someone else
(see [Docker Compose](docker.md) and the other guides), and it does not host
anything.

**How much of this was tested:** less than the other guides, and this page says
exactly what. The installers were **downloaded and inspected but never installed or
launched** for this guide. Statements below are marked as *checked* (verified on the
release artifacts, the code, or a running server), *recorded* (taken from this
repository's notes from earlier hands-on work, not repeated), or *not tested*.

## Installing

Every tagged release attaches the installers to its GitHub Release
(`.github/workflows/publish-desktop.yml`, which builds on `windows-latest`,
`ubuntu-latest` and `macos-latest`). The v0.8.0 assets *(checked: listed from the release)*:

| Platform | File | Size |
|---|---|---|
| Windows | `My.Chat.App_0.8.0_x64-setup.exe` | 2.0 MB |
| Windows | `My.Chat.App_0.8.0_x64_en-US.msi` | 3.0 MB |
| macOS (Apple silicon) | `My.Chat.App_0.8.0_aarch64.dmg`, `My.Chat.App_aarch64.app.tar.gz` | 4.1 MB, 3.4 MB |
| Linux | `.deb` 3.0 MB, `.rpm` 3.0 MB, `.AppImage` 81.7 MB | |

There is no Intel-Mac or Linux-arm64 build. Installing, launching and uninstalling were
**not tested on any platform**.

### The installers are not signed

*Checked:* both Windows installers report `NotSigned` from PowerShell's
`Get-AuthenticodeSignature`, and the publish workflow has no signing or notarization step
([#81](https://github.com/sam-bowman/federated-chat-app/issues/81)). Expect Windows
SmartScreen and macOS Gatekeeper to warn about an unidentified publisher. Those warnings were
not observed here, because the files were fetched with the GitHub CLI rather than a browser.
Verify what you download by getting it from the repository's Releases page.

## Using it

On start you get the home-server picker (the same one described in the README's
[Getting started](../../README.md#logging-into-a-different-server-home-server-picker)): type
`@you:chat.example.com` or just the server's address.

### The server must allow the app's origin

The app runs the web client from a different origin than a browser tab would, and a server
answers API calls only to the browser origins listed in its `CORS_ORIGIN` setting.

- On Windows the origin is `http://tauri.localhost` *(recorded: confirmed on Windows with
  WebView2 earlier; not repeated here)*. On macOS and Linux Tauri uses the system's WebKit and
  the origin **may differ** *(not tested)*.
- Finding the server (`/.well-known`) works from any origin, so the picker accepts a server
  that will then refuse every real request.
- `CORS_ORIGIN` takes a **comma-separated list** (releases after `0.9.0`; earlier ones accept
  exactly one, so a server could serve its web client or the desktop app, never both -
  [#79](https://github.com/sam-bowman/federated-chat-app/issues/79)). List the web client and the app:
  `CORS_ORIGIN=https://chat.example.com,http://tauri.localhost`. **The Helm chart and the Compose file allow
  `http://tauri.localhost` by default**, so there is nothing to add; a server that does not want desktop clients
  turns it off with `server.desktopApp.enabled: false` (Helm) or an empty `DESKTOP_APP_ORIGIN=` in `.env.selfhost`
  (Compose). That is the origin on **Windows** only: macOS and Linux use another web engine and may send a different
  one, which goes in `server.extraCorsOrigins` / `CORS_EXTRA_ORIGINS` once someone has confirmed it. Verified against a real browser with two
  listed origins and one unlisted (see [Docker troubleshooting](docker.md#the-page-loads-but-every-request-fails-cors)),
  not with the desktop app itself.

If login fails with a network error and the browser developer tools mention CORS, this is the
cause: your server's `CORS_ORIGIN` does not include the app's origin.

## Upgrading

### Updates inside the app

From the first release that includes it (installed copies of earlier releases have no updater and must be reinstalled by hand
once), the app updates itself ([#48](https://github.com/sam-bowman/federated-chat-app/issues/48)).
**Settings -> Updates** has:

- **Update automatically** - on by default. The app checks about 15 seconds after it starts and every 6 hours, and downloads a
  new version in the background. It is **never installed without being asked**: a banner says "Version X is ready" with
  *Restart to update* and *Later* (the installer closes the app, so that is your choice). Turn it off and the app
  makes no request to the update server by itself.
- **Check for updates** - always works, whether or not automatic updates are on. If there is a newer version, *Update to vX*
  downloads it and restarts into it.

The release notes shown are plain text from the update server. The setting is remembered on this device (like the size and
font settings).

**Trust.** An update is installed only if its signature matches the public key built into the app
(`client/src-tauri/tauri.conf.json`). The updates come from the latest GitHub release's `latest.json`
(`https://github.com/sam-bowman/federated-chat-app/releases/latest/download/latest.json`). This is the app's own signing key and is
**not** Windows code signing: the installers still show a SmartScreen warning ([#81](https://github.com/sam-bowman/federated-chat-app/issues/81)).

*Checked for real* on Windows 11, with two installers (0.99.0 and 0.99.1, signed with the real key, a local update server and a
local homeserver, the installed app driven over the webview's DevTools protocol):

- the default is on; with it on, the app found 0.99.1 by itself, downloaded it, showed the banner, and **did not install it**;
  *Restart to update* installed it, the app relaunched **by itself** into 0.99.1 and was still signed in;
- with it off (and remembered after the app was closed and started again) nothing asked the update server for 35 seconds;
  *Check for updates* found 0.99.1, the notes were plain text, nothing was downloaded until *Update to v0.99.1* was pressed, and the
  update then installed; the setting was still off afterwards;
- an update whose signature belongs to another file was **refused** ("The signature verification failed"), nothing was installed
  and the app carried on.

**Not tested:** macOS and Linux (the same plugin, but the AppImage/`.app` update paths were not run), an update of the MSI
installer, a very slow or interrupted download, and how an in-place update treats a **real** user's saved settings beyond the
sign-in and the update setting above. The scheduled interval (6 hours) was not waited out; the timing is covered by unit tests.

App and server versions move in lockstep ([versioning.md](../versioning.md)); running an older app against a newer server was not
tested. There is no data to back up on the client: accounts, messages and uploads live on the server - see
[upgrading-and-backups.md](upgrading-and-backups.md) for that.

### Releasing desktop updates (maintainers)

- **The signing key.** Each release's installers are signed with a minisign key: the private key and its password are the repository
  secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, and the public half is in `tauri.conf.json`.
  **Keep a backup of the private key and its password somewhere safe that is not the repository.** If it is lost or leaked, every
  installed copy must be replaced by hand: an app only accepts updates signed by the key it was built with, and there is no way to
  hand over to a new one. A leaked key means someone could publish an update that installs; replace the key, release, and tell
  people to reinstall.
- **Making a key** (new project, or after a leak): `npx tauri signer generate -w <file>` (from `client/`), put the public half in
  `plugins.updater.pubkey`, and set the two secrets with `gh secret set`.
- **A release without the key fails** the desktop build on purpose, so no unsigned update is published.
- **A local build** (`npm run tauri -- build`) also fails at the end without the key (*A public key has been found, but no private key*;
  the installer itself is still produced). To build locally without it:
  `npm run tauri -- build -- --config '{"bundle":{"createUpdaterArtifacts":false}}'`.
- **After every release** the *Verify the update manifest* job downloads the published `latest.json` and checks it names the
  release's version, has a signature and an https download for Windows, macOS and Linux, and that each download exists, since a
  broken manifest fails silently for everyone (the app just never sees an update).
- **Testing an update yourself:** build two installers with different `version`s in `--config` (and a different `productName` and
  `identifier`, so a real installed copy is never touched), set `plugins.updater.endpoints` to a local address with
  `dangerousInsecureTransportProtocol: true`, serve a `latest.json` with the newer installer's `.sig` contents as `signature`, and
  install the older one.

## Building it yourself

*Recorded, not re-run for this guide* (a `target/` directory from an earlier build exists in the
development checkout):

```bash
npm run tauri --workspace client -- dev      # dev window, hot reload
npm run tauri --workspace client -- build    # real installers under client/src-tauri/target/release/bundle/
```

The `--` after `tauri` is required, otherwise npm swallows the argument. You need the Rust
toolchain (the workspace was built here with Rust 1.96) and Tauri's platform prerequisites; on
Ubuntu the workflow installs `libwebkit2gtk-4.1-dev` and friends - read
`.github/workflows/publish-desktop.yml` for the exact list. In **dev mode** the window loads the
Vite dev server and inherits `client/.env`, so with `VITE_API_URL` set you get the fixed-server
UI, not the picker; a packaged build has no such file and shows the picker *(recorded)*.

## Troubleshooting

- **Everything fails after picking a server, console mentions CORS** - the origin problem
  above.
- **The picker doesn't appear in a dev build** - `client/.env` sets `VITE_API_URL`; expected.
- **A security warning when installing** - the installers are unsigned (above).
- **Settings -> Updates says "Couldn't update: ..."** - the message is the updater's own (no network, no `latest.json` yet because
  the release is still building, or *The signature verification failed*). Try again later; the app keeps working.

No other failure modes have been seen, because the app was not run for this guide.

## Resource sizing

Installers are 2-4 MB (Windows, macOS, deb/rpm) except the 81.7 MB AppImage, which bundles its
runtime libraries. Installed size and the app's memory use were **not measured**. No load
testing is relevant: it is one user's client.

## What was not tested

Installing, launching or uninstalling on any OS; the real macOS/Linux origin; SmartScreen and
Gatekeeper behaviour; upgrading over an existing install; rebuilding from source.
