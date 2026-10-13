# Kubernetes (Helm chart)

> Part of the [documentation](../../README.md#documentation) and the
> [deployment guides](README.md).

One umbrella chart for the server and client, bundling plain Postgres (and
optionally Redis) Deployments so a single `helm install` gets a running stack.
The full values reference is in
[`charts/federated-chat-app/README.md`](../../charts/federated-chat-app/README.md);
this page is about running it: install, upgrade, back up, and what goes wrong.

Everything here was run against the **published chart and images** on a local
[kind](https://kind.sigs.k8s.io/) cluster (Helm 3.17, Kubernetes via kind
0.25, one node, Docker Desktop on Windows). Things that were **not** tested are
listed [at the end](#what-was-not-tested).

## Quick start

Keep your configuration in a values file and pass it on **every** install and
upgrade (the reason is [below](#upgrading)). It contains secrets - don't commit it.

```yaml
# values.yaml
domain: chat.example.com
serverName: My Chat Server
server:
  publicUrl: https://api.chat.example.com
  clientPublicUrl: https://chat.example.com
secrets:
  jwtAccessSecret: <openssl rand -base64 32>
  jwtRefreshSecret: <a different openssl rand -base64 32>
postgresql:
  auth:
    password: <openssl rand -base64 24>
```

```bash
helm install chat oci://ghcr.io/sam-bowman/charts/federated-chat-app \
  --version 0.8.0 -f values.yaml --wait --timeout 6m
helm test chat
```

Pin `--version` to an exact release (every release publishes the matching chart
and image tag; the chart installs the image version equal to its own
`appVersion`). From a checkout you can use `charts/federated-chat-app` instead of
the `oci://` reference.

On a fresh single-node kind cluster, `--wait` returned in about 35 seconds
including pulling the images, with no restarts, and `helm test` passed.

### Reaching it

Without ingress you get `ClusterIP` Services only:

```bash
kubectl port-forward svc/chat-federated-chat-app-server 4000:4000
kubectl port-forward svc/chat-federated-chat-app-client 8080:8080
```

`server.publicUrl` and `server.clientPublicUrl` are fetched/checked by the
**browser**, so they must be the addresses a browser really uses - for a
port-forward test, `http://localhost:4000` and `http://localhost:8080`. The
chart can also template Ingress objects (`server.ingress`, `client.ingress`); see
[Ingress with Traefik](#ingress-with-traefik). The resource names above assume the release is
called `chat`; otherwise they are `<release>-federated-chat-app-<component>`.

## Ingress with Traefik

The chart's `server.ingress` and `client.ingress` are plain `networking.k8s.io/v1` `Ingress`
objects, and that is enough for Traefik: no `IngressRoute` custom resource, no extra
templates. Verified on a kind cluster with the official Traefik chart (`41.7.1`, Traefik
`v3.7.14`, installed as a NodePort service) and this chart: the client and the API each on
their own hostname, `http://` and `https://` (a self-signed certificate in a Secret), and the
WebSocket over both `ws://` and `wss://`.

Releases after `0.9.0` also need `server.trustProxy: 1` - see
[the rate-limit trap](#everyone-gets-429-too-many-requests-after-a-few-logins) before you skip it.

```yaml
# values.yaml - the parts that matter behind Traefik
domain: chat.example.com
server:
  publicUrl: https://api.chat.example.com        # what a browser uses, scheme and port included
  clientPublicUrl: https://chat.example.com
  trustProxy: 1                                  # one ingress controller in front
  ingress:
    enabled: true
    className: traefik
    host: api.chat.example.com
    annotations:
      traefik.ingress.kubernetes.io/router.entrypoints: websecure
    tls:
      - secretName: chat-tls
        hosts: [api.chat.example.com]
client:
  ingress:
    enabled: true
    className: traefik
    host: chat.example.com
    annotations:
      traefik.ingress.kubernetes.io/router.entrypoints: websecure
    tls:
      - secretName: chat-tls
        hosts: [chat.example.com]
```

What was observed:

- **`ingressClassName: traefik` is all it needs** to be picked up; no annotation is required for
  plain HTTP. Both objects can share one TLS Secret if its certificate covers both names.
- **WebSockets need nothing special.** The realtime socket is `/ws` on the **API** host. Through
  Traefik, a socket opened with a real login token connected, and an event triggered over
  HTTP arrived on it (`ws://` and `wss://`). In a browser the signed-in session showed as online,
  which the server only records when its socket connects.
- **TLS** comes from `ingress.tls` plus a Secret of type `kubernetes.io/tls` in the release's
  namespace. With `router.entrypoints: websecure`, plain `http://` to the same hosts returned
  Traefik's `404`; leave the annotation off if you want both entrypoints. Redirecting HTTP to HTTPS is
  configured on Traefik's entrypoint, not by this chart, and was **not tested**. Getting the Secret
  from cert-manager (by annotating the Ingress) was also **not tested**.
- **Two hostnames.** The client and the API are separate hosts, so both names must resolve to
  Traefik, and the URLs in the values must match what the browser really requests (a non-default
  port included, for example `https://chat.example.com:8443`): the server only answers the browser
  origins listed in `CORS_ORIGIN`, which comes from `server.clientPublicUrl`.

`IngressRoute` would only be worth adding for something an annotation can't express (Traefik
middlewares, say); nothing found so far needs it.

## Configuration

Required values; the chart refuses to render without them (messages below are
copied from real runs - Helm reports one at a time):

| Missing | Message |
|---|---|
| JWT secrets | `secrets.jwtAccessSecret and secrets.jwtRefreshSecret are required (generate each with: openssl rand -base64 32), or set secrets.existingSecret ...` |
| `domain` | `domain is required - this homeserver's own domain, becomes part of every user id (@user:domain)` |
| `postgresql.auth.password` | `postgresql.auth.password is required when postgresql.enabled is true ...` |
| `externalDatabase.url` | `externalDatabase.url is required when postgresql.enabled is false` |
| Redis with replicas | `server.replicaCount > 1 needs redis.enabled: true (or externalRedisUrl set ...)` |
| S3 settings | `server.storage.s3.bucket is required when server.storage.driver is "s3"` (and likewise region, `publicUrlBase`, credentials) |

(`server.publicUrl` and `server.clientPublicUrl` are required the same way.)
Prefer `secrets.existingSecret` / `postgresql.auth.existingSecret` over putting
passwords in a values file if you manage Secrets separately.

`domain` becomes part of every user id and cannot change later. The browser-facing
URLs and `CORS_ORIGIN` (`server.clientPublicUrl`, plus any `server.extraCorsOrigins` - for example the
[desktop app](desktop-app.md)'s `http://tauri.localhost`; releases up to `0.9.0` take only one) work as
described in [docker.md](docker.md#configuration), and the same CORS symptom
applies - see [its troubleshooting entry](docker.md#the-page-loads-but-every-request-fails-cors).

## Upgrading

Read [upgrading-and-backups.md](upgrading-and-backups.md) first - especially
[why rolling back is a restore](upgrading-and-backups.md#why-re-tagging-is-not-a-rollback)
and [the `localhost` backfill](upgrading-and-backups.md#the-localhost-backfill).
Then, after a [backup](#backing-up-and-restoring):

```bash
helm upgrade chat oci://ghcr.io/sam-bowman/charts/federated-chat-app \
  --version 0.8.0 -f values.yaml --wait --timeout 6m
```

Verified: `0.7.0` -> `0.8.0` this way with a user, a community and an upload
present. The new server pod logged `Applying migration 20261009174740_totp_2fa`
and `20261010172336_federated_communities`, login and the upload still worked,
and the community's `homeserverDomain` had been set to `localhost` (the known
backfill problem).

### How `helm upgrade` treats your values

This is easy to get wrong, so here is what each form actually did:

| Command | Result |
|---|---|
| `helm upgrade ... --version X` (no values flags at all) | Works - Helm reuses the previous release's values. |
| `helm upgrade ... --version X --set serverName=Renamed` | **Fails**: `UPGRADE FAILED: ... secrets.jwtAccessSecret and secrets.jwtRefreshSecret are required ...`. Passing *any* `--set` without `-f` or `--reuse-values` discards your earlier values. The release is left untouched. |
| `helm upgrade ... --version X --reuse-values --set serverName=Renamed` | Works. (Not tested beyond this: how it treats values a newer chart adds.) |
| `helm upgrade ... --version X -f values.yaml` | Works. **Recommended.** |

So: always `-f values.yaml`. The failure above is the safe one. The unsafe version
is regenerating secrets inline (`--set secrets.jwtAccessSecret=$(openssl ...)`),
which succeeds and silently rotates them - see the password case under
[troubleshooting](#troubleshooting).

### If an upgrade does not become ready

With a nonexistent server image tag, `helm upgrade --wait --timeout 60s` returned
`UPGRADE FAILED: context deadline exceeded` and recorded the revision as
`failed`. The **old server pod kept running and serving** (the new one sat in
`ErrImagePull`), so nobody was down. Fix the cause and run the same upgrade
again.

### Rollback

`helm rollback` rolls back the *manifests*, not the database. On a `0.8.0`
database it reports `Rollback was a success!`, the `0.7.0` pod starts, and it
then crashes the moment someone creates a community. Do not use it after an
upgrade that ran migrations. Restore a backup instead.

## Backing up and restoring

State: the Postgres PVC (default 10Gi) and the uploads PVC (default 5Gi), unless
you use S3 or an external database. The Secrets are not data you can recover
from the cluster - keep your values file. See
[what state exists](upgrading-and-backups.md#what-state-exists) (the database
dump holds the federation private key).

**Back up** (run from a normal shell; names assume release `chat`):

```bash
PG=$(kubectl get pod -l app.kubernetes.io/component=postgresql -o name | sed 's#pod/##')
SV=$(kubectl get pod -l app.kubernetes.io/component=server -o name | sed 's#pod/##')

kubectl exec $PG -- pg_dump -U chat -Fc chat -f /tmp/chat.dump
kubectl cp $PG:/tmp/chat.dump ./chat.dump
kubectl exec $SV -c server -- tar czf - -C /app/uploads . > uploads.tgz
```

(In Git Bash on Windows, set `MSYS_NO_PATHCONV=1` first or `/tmp` and `/app` are
rewritten into Windows paths and the commands fail.)

**Restore** (this is also the rollback). Put the release on the version the
backup came from first, then:

```bash
kubectl scale deploy/chat-federated-chat-app-server --replicas=0
kubectl cp ./chat.dump $PG:/tmp/chat.dump
kubectl exec $PG -- psql -U chat -d chat -v ON_ERROR_STOP=1 \
  -c 'DROP SCHEMA public CASCADE' -c 'CREATE SCHEMA public'
kubectl exec $PG -- pg_restore -U chat -d chat --no-owner /tmp/chat.dump
kubectl scale deploy/chat-federated-chat-app-server --replicas=1
kubectl rollout status deploy/chat-federated-chat-app-server
SV=$(kubectl get pod -l app.kubernetes.io/component=server -o name | sed 's#pod/##')
kubectl exec -i $SV -c server -- tar xzf - -C /app/uploads < uploads.tgz
```

Why `DROP SCHEMA` rather than `pg_restore --clean`: the latter fails, and leaves a
half-restored database, when the live database is newer than the dump - see
[restoring into a database that already has data](upgrading-and-backups.md#restoring-into-a-database-that-already-has-data).
Tested end to end: after this, the pre-backup user logged in, their upload was
served, a user created after the backup was gone, and creating a community worked.
Files uploaded after the backup remain on the uploads volume as orphans.

### `helm uninstall` and your data

In releases that include the `keepVolumesOnUninstall` value (after `0.9.0`), `helm uninstall` leaves both
PVCs in place and reinstalling under the same release name reuses them, including the Postgres
password they were created with. Verified on kind: after uninstall both PVCs stayed `Bound`, a
reinstall found the migrated database (`No pending migrations to apply`), and reinstalling with a
different password crash-looped with `P1000`. **Older charts delete both PVCs on uninstall** - that
was observed on `0.8.0` (they went to `Terminating` at once) - and whether the volumes survive
then depends on your StorageClass reclaim policy. Either way, back up before uninstalling.

## Troubleshooting

### `UPGRADE FAILED` / `INSTALL FAILED` naming a required value
You hit the validation above. For an upgrade, you almost certainly forgot
`-f values.yaml`.

### `ErrImagePull` / `ImagePullBackOff`
```
Failed to pull image "ghcr.io/sam-bowman/federated-chat-app-server:9.9.9": ... NotFound
```
Wrong `server.image.tag` / `client.image.tag`. Leave them empty to follow the
chart's `appVersion`.

### Server pod in `CrashLoopBackOff` with `P1000`
```
Error: P1000: Authentication failed against database server at `chat-federated-chat-app-postgresql`, the provided database credentials for `chat` are not valid.
```
You changed `postgresql.auth.password` after the data volume already existed. Postgres
only applies that password when it first initialises an empty volume, so the Secret
and the real database password now disagree. The trap is that this does **not**
show up immediately: `helm upgrade` reported `deployed`, because running pods read
the Secret only at start. It appeared on the next restart of the server pod, where the
new pod crash-looped (while the old one kept serving). Put the original password
back in the values file and upgrade again - that recovered it. To genuinely change
the password, the approach would be to change it inside Postgres first (`ALTER USER`),
then update the values - that route was **not tested**.

### `kubectl port-forward` stops working after an upgrade
```
error: lost connection to pod
```
A port-forward is bound to one pod; when the pod is replaced it dies. Start it again.

### The page loads but requests fail (CORS)
See [docker.md](docker.md#the-page-loads-but-every-request-fails-cors); the value is
`server.clientPublicUrl`.

### Everyone gets `429 Too many requests` after a few logins
Behind an ingress controller the server sees every request coming from the controller's own
address, so without `server.trustProxy` **all users share one rate-limit bucket**: 10 login or register
attempts per 15 minutes for the whole server. Reproduced behind Traefik: after ten wrong logins from one
machine, a different client going through the same Traefik got `429`, while that client talking straight to
the server got `401`. The server log also showed
`ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` ("the 'X-Forwarded-For' header is set but the Express 'trust proxy'
setting is false").

Set `server.trustProxy: 1` for one ingress controller (a number of hops, or a list of proxy addresses/CIDRs if a cloud
load balancer sits in front of it too; "trust everything" is refused on purpose). After that, a different client
had its own bucket (`401`), the log line stopped, and forging `X-Forwarded-For` from outside did not
evade the limit: twelve attempts with twelve different forged headers still hit `429` after ten, because Traefik
discards a forged header from an untrusted source. Chart releases after `0.9.0` print a warning in their notes
when an ingress is enabled and `server.trustProxy` is empty; `0.9.0` and earlier cannot be configured this way at all.

### Traefik serves "TRAEFIK DEFAULT CERT" instead of my certificate
The Secret named in `ingress.tls` is missing, or in a different namespace. Traefik's log says so:
`Error configuring TLS ... secret default/chat-tls does not exist`. Create it
(`kubectl create secret tls chat-tls --cert=... --key=...`) and Traefik picks it up within seconds, with no restart.

### A brief `504 Gateway Timeout` right after an upgrade
Seen once, seconds after a rollout of the single server replica, then gone. With one replica there is a short window
while the old pod is replaced; not investigated further. Run more than one replica (which needs
Redis and S3 uploads, see [scaling.md](../scaling.md)) if that matters.

### Crash loops hide the cause
Read `kubectl logs deploy/chat-federated-chat-app-server -c server`. Add
`--previous` for a pod that already restarted. A bare `kubectl get pods` just
shows the restart count. In releases up to and including `0.9.0`, an unhandled error
in an async route exited the server process
([#76](https://github.com/sam-bowman/federated-chat-app/issues/76)), so one bad request
looked like a restart; newer releases return a 500 and log `[http] <METHOD> <URL> failed:`
instead.

## Resource sizing

**The chart sets no resource requests or limits** (`resources: {}` for every
component), so the scheduler knows nothing about these pods, and there is no
default to recommend. **No load testing has been done.**

Measured once on the kind cluster above with `0.8.0`, a few minutes after start,
with one registered user and no clients connected, using the container cgroup's
`memory.current` (the cluster had no metrics-server, so `kubectl top` returned
`Metrics API not available`):

| | Memory |
|---|---|
| server | 34.5 MiB |
| client (nginx) | 5.1 MiB |
| postgres | 98.7 MiB |

Caveats: `memory.current` includes the kernel's page cache (Postgres had just had
a database restored into it, which inflates it), and the server was only about a
minute old, so this is not comparable with the Compose figures in
[docker.md](docker.md#resource-sizing), which came from a longer-running stack
via `docker stats`. Treat these as the floor and measure your own load. The
Postgres data directory was 64 MB after the restore. PVC defaults are 5Gi
(uploads) and 10Gi (database); the bundled Postgres has no replication or
backup of its own - for anything you can't afford to lose, set
`postgresql.enabled: false` with `externalDatabase.url`. More than one server
replica needs Redis and shared (S3) uploads - see [scaling.md](../scaling.md).

## What was not tested

- **Ingress controllers other than Traefik** (ingress-nginx, a cloud load balancer), Traefik's HTTP to HTTPS
  redirect, cert-manager, and a real DNS name with a trusted certificate. Traefik itself was tested only on kind with
  NodePorts and a self-signed certificate. The rate-limit setting is explained in
  [security.md](../security.md#rate-limiting).
- **S3 storage**, an **external database** (`externalDatabase.url`), and
  **multiple replicas with Redis** at runtime - only the chart's rendering
  checks for these were exercised, not a running cluster.
- Managed Kubernetes (EKS/GKE/AKS), non-default StorageClasses, `ReadWriteMany`
  volumes, arm64 nodes.
- Federation between two clusters.
