# Deployment guides

> Part of the [documentation](../../README.md#documentation).

Pick the one that matches how you want to run it.

| I want to... | Guide |
|---|---|
| Self-host on a VPS, NAS or home server (the recommended path) | [Docker and Docker Compose](docker.md) |
| Run it on a Kubernetes cluster | [Kubernetes (Helm)](kubernetes.md) |
| Run it without Docker | [Native binaries](native-binaries.md) |
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
| Kubernetes | Run on a kind cluster from the published chart and images: install, `helm test`, every values-validation message, `helm upgrade` value handling, `0.7.0` -> `0.8.0` with data, a failed upgrade, `helm rollback`, backup and restore, password-change failure, `helm uninstall`. Ingress, S3, external DB and multi-replica not run. |
| Native binaries | Real `v0.8.0` Windows archives against PostgreSQL: config/uploads resolution, upgrade `0.7.0` -> `0.8.0` with data, downgrade crash, port conflict, client modes. Linux/macOS not run. |
| Desktop app | Not yet expanded to this depth. |
