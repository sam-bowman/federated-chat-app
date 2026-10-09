# federated-chat-app Helm chart

Deploys the server, client, and (optionally) Postgres/Redis to Kubernetes.
See [DISTRIBUTION.md](../../DISTRIBUTION.md) and the main
[README.md](../../README.md) for what this project is; this file is just
about running it on Kubernetes.

Bundles plain, hand-rolled Postgres/Redis Deployments (the same images
`docker-compose.yml`/`docker-compose.selfhost.yml` at the repo root use)
rather than depending on an external chart like `bitnami/postgresql` -
avoids a network-fetched chart dependency, license-term drift, and a much
larger values surface than this project needs. For a production cluster
with its own managed Postgres, set `postgresql.enabled: false` and
`externalDatabase.url` instead.

## Quick start

```bash
helm install my-chat . \
  --set domain=chat.example.com \
  --set server.publicUrl=https://api.chat.example.com \
  --set server.clientPublicUrl=https://chat.example.com \
  --set secrets.jwtAccessSecret=$(openssl rand -base64 32) \
  --set secrets.jwtRefreshSecret=$(openssl rand -base64 32) \
  --set postgresql.auth.password=$(openssl rand -base64 24)
```

Or put those in a `values.yaml` override file and `helm install my-chat . -f values.yaml`.
`domain`, `server.publicUrl`, `server.clientPublicUrl`, both JWT secrets,
and (when `postgresql.enabled`, the default) `postgresql.auth.password`
are all required - the chart fails to template with a clear message if
any are left unset, rather than silently deploying with
`server/src/config.ts`'s dev-insecure JWT fallback.

Verify the install:

```bash
helm test my-chat
```

## What this doesn't set up

**TLS and ingress are opt-in** (`server.ingress.enabled` /
`client.ingress.enabled`, both `false` by default) - without them you get
`ClusterIP` Services only, reachable via `kubectl port-forward` or your
own `Service`/`Ingress` wiring. When enabled, the chart templates a plain
`networking.k8s.io/v1 Ingress` that works with any ingress controller
(nginx, Traefik, ...); TLS termination/cert-manager annotations are up to
your cluster's own setup via `server.ingress.tls` / `.annotations`.

**The client's `API_URL` is fetched by the browser**, not proxied
server-side (see `client/nginx.conf` - no `/api` location block) - so
`server.publicUrl` and `server.clientPublicUrl` must be real,
externally-reachable addresses, never in-cluster Service names.

**Rate limiting keys on `req.ip`** - behind an ingress controller, that
only reflects the real client if the server's `trust proxy` setting
matches your ingress's actual proxy chain, which this chart does not
configure (see the main README's "Rate limiting" section for why, and
`server.extraEnv` for how to pass additional env vars this chart doesn't
have a dedicated value for).

## Multiple server replicas

`server.replicaCount > 1` requires `redis.enabled: true` (or
`externalRedisUrl` set) - the chart refuses to template otherwise. See the
main README's "Running multiple replicas" for why: without Redis, each
replica tracks presence/rate-limits/realtime delivery independently,
which silently breaks cross-replica behavior rather than failing loudly.

Multiple replicas also need every replica to see the same uploaded files
(avatars/attachments/emoticon images). The default `server.storage.driver:
disk` shares one uploads `PersistentVolumeClaim`
(`server.uploads.persistence`) across replicas, which only actually works
with a `StorageClass` that supports `ReadWriteMany` - with the default
`ReadWriteOnce`, replicas scheduled on different nodes may fail to mount
it. Set `server.storage.driver: s3` instead to avoid this entirely: every
replica reads/writes the same bucket, so there's no PVC-sharing problem to
work around.

## S3-compatible object storage

`server.storage.driver: s3` uploads to a bucket (AWS S3, MinIO, Cloudflare
R2, DigitalOcean Spaces, ...) instead of the local-disk PVC:

```yaml
server:
  storage:
    driver: s3
    s3:
      bucket: my-chat-uploads
      region: us-east-1
      accessKeyId: AKIA...
      secretAccessKey: ...
      publicUrlBase: https://my-chat-uploads.s3.us-east-1.amazonaws.com
```

`bucket`, `region`, `publicUrlBase`, and the credentials (or
`server.storage.s3.existingSecret`, pointing at a Secret with keys
`access-key-id`/`secret-access-key`) are required when the driver is
`s3` - the chart fails to template with a clear message otherwise, same
as every other required value. `publicUrlBase` can't be derived
automatically (plain AWS, a CDN in front, a provider's own public-bucket
URL, and a MinIO reverse proxy all shape it differently) - set it to
wherever the bucket is actually publicly readable from. `endpoint` and
`forcePathStyle` are only needed for a non-AWS provider.

## Key values

See `values.yaml` for the full set with comments. The required ones:

| Value | What it is |
|---|---|
| `domain` | This homeserver's own domain - part of every user id |
| `server.publicUrl` | Server's externally-reachable origin |
| `server.clientPublicUrl` | Client's externally-reachable origin (becomes `CORS_ORIGIN`) |
| `secrets.jwtAccessSecret` / `jwtRefreshSecret` | JWT signing secrets (or `secrets.existingSecret`) |
| `postgresql.auth.password` | Bundled Postgres's password (or `postgresql.auth.existingSecret`, or set `postgresql.enabled: false` + `externalDatabase.url`) |
| `server.storage.s3.*` | Only required when `server.storage.driver: s3` - see "S3-compatible object storage" below |

## Testing this chart during development

```bash
helm lint .
helm template test-release . -f <your-test-values.yaml>
```

For a real deployment test, this chart was verified against a local
[kind](https://kind.sigs.k8s.io/) cluster: `helm install` with `--wait`,
`helm test`, a real register/login round-trip through `kubectl
port-forward`, then `helm upgrade` to confirm the Postgres `PersistentVolumeClaim`
survives a rolling restart (login still worked against the same user
afterward).
