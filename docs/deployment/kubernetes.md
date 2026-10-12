# Kubernetes (Helm chart)

> Part of the [documentation](../../README.md#documentation).

```bash
helm install my-chat charts/federated-chat-app \
  --set domain=chat.example.com \
  --set server.publicUrl=https://api.chat.example.com \
  --set server.clientPublicUrl=https://chat.example.com \
  --set secrets.jwtAccessSecret=$(openssl rand -base64 32) \
  --set secrets.jwtRefreshSecret=$(openssl rand -base64 32) \
  --set postgresql.auth.password=$(openssl rand -base64 24)
```

One umbrella chart for both server and client, bundling plain Postgres/Redis
Deployments (same images the compose files in [docker.md](docker.md) use, not an external chart
dependency) so a single `helm install` gets a running stack - set
`postgresql.enabled: false` and `externalDatabase.url` instead for a
production-managed database. See
[`charts/federated-chat-app/README.md`](../../charts/federated-chat-app/README.md)
for the full values reference, the multi-replica/Redis requirement, and the
uploads-persistence caveat with more than one server replica.

Every tagged release also pushes the packaged chart to GHCR as an OCI
artifact (`.github/workflows/publish-helm-chart.yml`), so you don't need
this checkout to install a released version:

```bash
helm install my-chat oci://ghcr.io/sam-bowman/charts/federated-chat-app \
  --version 0.5.1 \
  --set domain=chat.example.com \
  # ...same required --set flags as above
```
