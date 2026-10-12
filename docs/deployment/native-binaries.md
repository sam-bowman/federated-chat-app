# Native binaries

> Part of the [documentation](../../README.md#documentation).

For running either side without Docker at all - see
[docs/distribution.md](../distribution.md) for the full packaging matrix. Every
tagged release publishes a `.tar.gz` for Windows/Linux/macOS of each, as
GitHub Release assets, via
[Node's Single Executable Applications](https://nodejs.org/api/single-executable-applications.html)
(`.github/workflows/publish-binaries.yml`):

```bash
# Server - extract, then run from wherever you extracted it. Configuration
# is the same env vars as the Docker image (see docker.md).
tar xzf federated-chat-app-server-0.3.1-linux-x64.tar.gz
SERVER_DOMAIN=chat.example.com \
DATABASE_URL=postgresql://chat:chat@postgres-host:5432/chat \
JWT_ACCESS_SECRET=<a long random string> \
JWT_REFRESH_SECRET=<a different long random string> \
CORS_ORIGIN=https://chat.example.com \
  ./my-chat-server-linux-x64

# Client - same deal, picker mode if API_URL is unset (see "Home-server
# picker" in CLAUDE.md).
tar xzf federated-chat-app-client-0.3.1-linux-x64.tar.gz
API_URL=https://api.chat.example.com PORT=8080 ./my-chat-client-linux-x64
```

**The server's archive isn't just the one executable** - it also contains
`node_modules/.prisma/client/` (the native Prisma query engine, which can't
be embedded in a single-file binary the way the rest of the JS can) and
`prisma/migrations/` (applied automatically at startup, same as the Docker
image, just without the `prisma` CLI - see `server/src/standaloneMigrate.ts`).
Keep the whole extracted folder together; don't move the executable out on
its own. `uploads/` and a `.env` file, if you use one, are read relative to
wherever the executable itself lives, not wherever you ran it from - so a
double-clicked binary or a service pointed at it from a different working
directory still finds the right files.

The client's archive is genuinely just the one file - it has no loose
dependencies at all.
