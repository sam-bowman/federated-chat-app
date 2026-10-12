# Desktop app

> Part of the [documentation](../../README.md#documentation).

A single-user desktop app for Windows/Linux/macOS (arm64), wrapping the
same web client in a native shell via [Tauri](https://tauri.app) -
`client/src-tauri/`, built from the exact same `client/` source as every
other client format, no changes needed to run inside it. Every tagged
release publishes installers (`.msi`/`.exe` on Windows, `.dmg`/`.app` on
macOS, `.deb`/AppImage on Linux) as GitHub Release assets, via
`.github/workflows/publish-desktop.yml`. Install and open it, then use the
same home-server picker described in the README's [Getting started](../../README.md#logging-into-a-different-server-home-server-picker) - type `@you:chat.example.com` (or
just the server's address) to log in, exactly as in the browser.

To build it yourself: `npm run tauri --workspace client -- dev` for a
dev-mode window (hot-reloads the same way `npm run dev` does), or
`npm run tauri --workspace client -- build` for a real installer under
`client/src-tauri/target/release/bundle/`.
