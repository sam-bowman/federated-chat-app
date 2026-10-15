# Scaling out

> Part of the [documentation](../README.md#documentation).

## Running multiple replicas

By default this server keeps presence and realtime WebSocket delivery entirely
in-process - correct and simplest for the common case of one replica. Set
`REDIS_URL` to run more than one replica of the *same* homeserver behind a load
balancer (not to be confused with the [federation demo](federation-demo.md), which runs two
*different* homeservers):

```bash
docker compose up -d redis   # local dev Redis, mapped to host port 6380
```

```env
REDIS_URL=redis://localhost:6380
```

With it set, every replica publishes outgoing events (messages, presence
changes, typing) to a shared Redis pub/sub channel instead of writing straight
to its own in-memory socket map, and every replica (including the one that
published) delivers to whichever of the target users it has locally connected -
so a message sent while handling a request on replica A still reaches a user
whose live socket happens to be open on replica B. Fleet-wide presence
(`ONLINE`/`OFFLINE` transitions, and not flipping a user offline just because
*one* of their tabs disconnected while another is open on a different replica)
is tracked the same way, via short-lived per-connection Redis keys refreshed on
the existing 30s heartbeat - a replica that crashes outright simply stops
refreshing its keys, and they expire on their own rather than leaving someone
stuck "online" forever.

Without `REDIS_URL` set, none of this changes - every replica behaves exactly
as it did before Redis support existed, and a single-replica deployment never
touches Redis at all. See `server/src/ws/presenceFanout.ts` for the mechanism
and `server/test/integration/presenceFanout.test.ts` for tests that prove one
publish reaches multiple independent subscriber connections (standing in for
multiple replicas).

### Uploads with several replicas

With `STORAGE_DRIVER=disk` every replica needs to see the same `UPLOADS_DIR`: a shared network filesystem, or (the simpler fix) the S3 driver below. On Kubernetes the Helm chart refuses `replicaCount > 1` with a disk uploads volume that is not `ReadWriteMany`; see [Running more than one server replica](deployment/kubernetes.md#running-more-than-one-server-replica) for what was verified and the known limits (rolling restarts, presence on restart, federation ordering).

## S3-compatible object storage

Uploaded files (avatars, message attachments, emoticon images -
`POST /api/v1/media/upload`) default to local disk (`UPLOADS_DIR`, served at
`/uploads`) - correct for a single replica, where local disk is exactly as
durable as the server process itself, but not shared across replicas the way
Postgres/Redis above are. Set `STORAGE_DRIVER=s3` to upload to an
S3-compatible bucket instead (AWS S3, MinIO, Cloudflare R2, DigitalOcean
Spaces, ...) - the actual fix once there's more than one replica:

```env
STORAGE_DRIVER=s3
S3_BUCKET=my-chat-uploads
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=AKIA...
S3_SECRET_ACCESS_KEY=...
S3_PUBLIC_URL_BASE=https://my-chat-uploads.s3.us-east-1.amazonaws.com
```

All five are required when `STORAGE_DRIVER=s3` - the server fails to start
with a clear message otherwise, rather than silently falling back to disk.
`S3_PUBLIC_URL_BASE` can't be derived automatically from the other settings:
plain AWS, a CDN in front, a provider's own public-bucket URL, and a MinIO
reverse proxy all shape the public URL differently, so it has to be set to
wherever the bucket is actually publicly readable from. `S3_ENDPOINT` and
`S3_FORCE_PATH_STYLE` are only needed for a non-AWS provider - see
`server/.env.example` for what each one does.

Uploaded files get a **permanent public URL**, not a pre-signed/expiring one
- message attachments, avatars, and emoticon images are stored once and
reused indefinitely (same as under the disk driver), so the bucket (or a CDN
in front of it) needs to actually allow public reads for this to work; that's
on you to configure, same as pointing `S3_PUBLIC_URL_BASE` at the right
place. See `server/src/lib/storage/` for the driver implementations.
