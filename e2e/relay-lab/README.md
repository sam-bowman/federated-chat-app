# Relay lab

A Docker network in which **a call can only connect through the relay** (#245): a browser that cannot send a single UDP packet, or
anything to 7881/tcp, to LiveKit. It is the test for [the relay](../../docs/deployment/voice.md#a-relay-for-locked-down-networks) and for the
message a person gets when the audio is blocked. It is manual (it needs the e2e stack running on your machine and downloads a 1 GB
browser image), and no CI job runs it.

What happens inside it (`docker-compose.yml`, `run.sh`, `probe.mjs`):

1. `certs` makes a throwaway certificate for `turn.test`, and `livekit` starts with its relay on (port 443, TLS, so that it looks like HTTPS).
2. `browser` (Chromium from Playwright's image) drops every UDP packet and 7881/tcp to LiveKit with `iptables`, signs up on the e2e
   stack on your machine, makes a voice channel, joins it, and prints how the call connected.

## Running it

```bash
# 1. The e2e stack on your machine (Postgres first: docker compose up -d postgres). hold.spec.ts keeps its servers up for ten minutes
#    (the servers answer on :4100 while it waits):
E2E_HOLD=1 E2E_LIVEKIT=1 npm run test --workspace e2e -- hold.spec.ts

# 2. A second Vite for the client, listening on every interface (the e2e one listens on ::1, which a container cannot reach),
#    pointed at the e2e server. Port 5290 is what run.sh forwards.
cd client && VITE_API_URL=http://localhost:4100 npx vite --mode a --port 5290 --strictPort --host 0.0.0.0

# 3. The lab (free port 7880 first: stop the e2e LiveKit, docker compose -f e2e/docker-compose.livekit.yml down)
cd e2e/relay-lab
docker compose --profile run run --rm browser                   # blocked, relay on:  OUTCOME CONNECTED, via turns:turn.test:443
RELAY=false docker compose up -d --force-recreate livekit
RELAY=false docker compose --profile run run --rm browser       # blocked, relay off: OUTCOME FAILED: Reached the voice server, but the audio couldn't get through...
BLOCK=0 RELAY=false docker compose --profile run run --rm browser   # nothing blocked, relay off: CONNECTED over plain UDP (the control)
docker compose down -v
```

`PAIRS` is the pair of candidates the audio really uses. A call through the relay reads
`{"local":"relay/udp/tls","remote":"host/udp","via":"turns:turn.test:443?transport=tcp"}`: relayed, reached over TLS.

## What it does not show

It is a flat network: LiveKit's address (172.30.0.10) is its own, so the relay's own ports are reachable by LiveKit without going
through a router. A real deployment behind NAT is **not** covered (see "What has and has not been verified" in
[voice.md](../../docs/deployment/voice.md)). The lab also tells LiveKit to accept private addresses as relay peers
(`allow_restricted_peer_cidrs`), which a server with a public address does not need.
