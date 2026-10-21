# Deployment guides

> Part of the [documentation](../../README.md#documentation).

Pick the one that matches how you want to run it.

| I want to... | Guide |
|---|---|
| Self-host on a VPS, NAS or home server (the recommended path) | [Docker and Docker Compose](docker.md) |
| Run it on a Kubernetes cluster | [Kubernetes (Helm)](kubernetes.md) |
| Run it without Docker | [Native binaries](native-binaries.md) |
| Keep a server to just the people on it, or to chosen servers | [Private or restricted server](private-server.md) |
| Let only people I invite make an account | [Invite-only registration](invite-only.md) |
| Add voice channels to a server | [Voice channels](voice.md) |
| Let people delete their accounts, or delete one for them | [Deleting accounts](account-deletion.md) |
| Manage the server from a browser (being built in steps) | [The admin page](admin-ui.md) |
| See who did what: moderation and what operators did | [The audit log](audit-log.md) |
| Show a title and description under messages that link to a web page | [Link previews](link-previews.md) |
| List and manage the accounts and communities on my server | [The admin command](admin-cli.md) |
| Run it on my own machine to use or hack on it | [Local development](local-development.md) |
| Give people a desktop client for a server someone runs | [Desktop app](desktop-app.md) |

Shared by all of them: **[Upgrading and backups](upgrading-and-backups.md)** -
versioning, migrations, what state you have to protect, tested backup and
restore commands, and why "rollback" means "restore a backup".

## How thoroughly each guide was checked

These guides separate what was run from what was read. Each says which parts
were run against the real published artifacts, and marks the rest **not
tested**. Resource numbers are single measurements with their conditions
stated; **no load testing has been done**.

| Guide | Status |
|---|---|
| Docker Compose | Run against the published images: first start, every required-variable error, port conflict, database auth/host/name failures, CORS mismatch in a real browser, upgrade `0.7.0` -> `0.8.0` with data, backup and restore. |
| Upgrading and backups | As above. |
| Kubernetes | Run on a kind cluster from the published chart and images: install, `helm test`, every values-validation message, `helm upgrade` value handling, `0.7.0` -> `0.8.0` with data, a failed upgrade, `helm rollback`, backup and restore, password-change failure, `helm uninstall`. Ingress with Traefik (plain HTTP and TLS, WebSocket, rate limiting behind a proxy) run on kind. A root-owned volume's upload failure was reproduced on kind, and the fix (a group-writable uploads directory) was then confirmed by the maintainer on a **real Longhorn cluster** (k3s on arm64, Traefik, cert-manager DNS-01 certificates): install, `helm test`, bound volumes, write test, an avatar upload through the app, the Postgres pod deleted and recreated with its data intact. Not yet: node failure, volume expansion, RWX. S3, external DB and multi-replica not run. |
| Native binaries | Real `v0.8.0` Windows archives against PostgreSQL: config/uploads resolution, upgrade `0.7.0` -> `0.8.0` with data, downgrade crash, port conflict, client modes. Linux/macOS not run. |
| Local development | `start.ps1`/`stop.ps1` run from fresh clones: first run, a dead server after a clean install, port conflict, wrong folder name, dev rate limit (429) and its reset. Only Windows; Docker-not-running path and the manual route not run. |
| Admin command | Every command run for real against PostgreSQL in the test suite, with mutation checks; run from the real Windows native binary. Not run in the Docker image, on Kubernetes, or on Linux or macOS. |
| Desktop app | Release assets listed and the Windows installers' signatures checked; **never installed or launched**. Origin and build notes are marked as recorded, not re-run. |
