# Voice channels

> Part of the [deployment guides](README.md).

A community can have **voice channels**: people join a call in them from the web app or the desktop app. The audio goes through a
**LiveKit** server ([livekit.io](https://livekit.io), open source, Apache-2.0) that you run beside the chat server. Voice is **off
until you set it up**: a server with no LiveKit configured behaves exactly as before and offers no voice channels.

## What it needs

Three things have to be reachable from the people using it:

| What | Port | Through |
|---|---|---|
| The **signalling websocket** and API (`wss://`) | 7880 | Your reverse proxy or Ingress, at a host name of its own, for example `voice.chat.example.com`, with TLS. LiveKit expects the root path, so a name of its own is simplest. |
| The **audio**, over UDP | **7882/udp** | Forwarded straight to the machine or cluster, not through a proxy (it is not HTTP). |
| The **audio**, over TCP, for networks that block UDP | **7881/tcp** | Forwarded the same way. |

So, beyond the DNS name and the certificate you already have for the chat itself, **you forward two ports from your router** to wherever
LiveKit runs. Nothing else about your network changes. The chat server needs no new inbound ports: LiveKit calls it (its webhook) and
it asks LiveKit who is in a room, all on your own network.

A person on a network that blocks outbound UDP *and* the TCP port above (a hotel or office network that lets only HTTPS through)
cannot connect with just that. For them there is an optional **relay**, which carries the audio over TLS on port 443 so it looks like
HTTPS: see [A relay for locked-down networks](#a-relay-for-locked-down-networks).

## How it fits together

```
 browser / desktop app ──wss, https──► your proxy ──► LiveKit :7880   (who may join: a pass from the chat server)
          │                                              ▲   │
          └──────────── audio: 7882/udp, 7881/tcp ───────┘   │ webhook: someone joined / left
                                                              ▼
                                                        chat server  ── asks LiveKit who is in a room
```

- To join, the app asks **the chat server** for a pass to one channel's room (it checks the person is a member with the *Connect to
  voice channels* permission), then connects to LiveKit with it. The pass can listen and use a microphone; it cannot publish video,
  a screen or data.
- LiveKit tells the chat server when someone joins or leaves (a signed webhook); the chat server tells the community's members.
- The audio never passes through the chat server.

## Turning it on

Three settings, all or none (a server with only some of them refuses to start, saying which are missing):

| Setting | What it is |
|---|---|
| `LIVEKIT_URL` | The address the apps connect to: `wss://voice.chat.example.com` |
| `LIVEKIT_API_KEY` | The name of the key the chat server and LiveKit share (not secret), for example `chat` |
| `LIVEKIT_API_SECRET` | Its secret: **at least 32 characters** (`openssl rand -base64 32`) |
| `LIVEKIT_INTERNAL_URL` | *Optional.* Where the chat server asks LiveKit who is in a room, if that differs from the public address (inside Docker or the cluster: `http://livekit:7880`). Default: the public address. |

The server logs `Voice channels are on` at startup, and its discovery document says `features.voice: true`.

### Docker Compose

The self-host compose file has an optional `livekit` service behind a `voice` profile. In `.env.selfhost`:

```
LIVEKIT_URL=wss://voice.chat.example.com
LIVEKIT_API_KEY=chat
LIVEKIT_API_SECRET=<openssl rand -base64 32>
LIVEKIT_INTERNAL_URL=http://livekit:7880
```

then start it with the profile:

```bash
docker compose -f docker-compose.selfhost.yml --env-file .env.selfhost --profile voice up -d
```

Point your reverse proxy at the machine's port **7880** for `voice.chat.example.com` (websockets must be allowed through; for nginx that
is the usual `Upgrade`/`Connection` headers), and forward **7881/tcp** and **7882/udp** from your router to the machine. LiveKit finds
the machine's public address by asking a STUN server and gives that to the apps.

### Kubernetes (Helm)

```yaml
voice:
  enabled: true
  apiKey: chat
  apiSecret: <openssl rand -base64 32>      # or existingSecret: <a Secret with the key api-secret>
  ingress:
    host: voice.chat.example.com
    className: traefik                       # whatever your other Ingresses use
    annotations: {}                          # e.g. the cert-manager issuer annotation, as on your other hosts
    tls:
      - secretName: voice-tls
        hosts: [voice.chat.example.com]
  media:
    serviceType: LoadBalancer                # see below
```

The chart adds a LiveKit Deployment (one pod: rooms live in its memory), a Service and Ingress for the websocket, and a **second
Service for the two audio ports**. How those ports get out of the cluster depends on the cluster:

- **k3s** (and anything with a built-in load balancer): `serviceType: LoadBalancer` opens 7881 and 7882 on the node. Forward them from your
  router to the node's address.
- **Other clusters, no load balancer:** `serviceType: NodePort`, with fixed ports so the router rule never changes:
  `media.nodePorts: { tcp: "30881", udp: "30882" }`, and forward *external* 7881/7882 to those node ports.
- If LiveKit cannot work out your public address by itself, set `media.externalIp`.

`helm upgrade` with `voice.enabled: false` removes it again. `helm test` checks that LiveKit answers.

### A relay for locked-down networks

LiveKit has a relay (TURN) built in. Turn it on if people tell you *"Reached the voice server, but the audio couldn't get through"*
(that is what the app says when the voice server answered but no audio connection came up). Without it, those people cannot join; with
it, the app falls back to the relay on its own, and the call panel's *Quality* readout should say *through a relay* (the readout reads the browser's own statistics; not seen on a live relayed call here).

**What it needs, all of it from the outside:**

| What | Port | Notes |
|---|---|---|
| **TURN over TLS** | **443/tcp** on its own DNS name, for example `turn.chat.example.com` | The apps are *always* told port 443 for this, whatever port LiveKit listens on, so it has to be 443 on an address that reaches LiveKit. |
| TURN over UDP | 3478/udp | Helps networks that block most but not all UDP. Useless on the networks the TLS one is for. |
| A certificate and key for that DNS name | | LiveKit terminates the TLS itself and reads the files **when it starts** (restart it after a renewal). |

Port 443 is the catch. Your reverse proxy or Ingress controller normally owns it on the machine's main address, and the relay cannot
share it by path (it is not HTTP). Give the relay **an address of its own** (a second IP on the machine, a second node, a load balancer
address), or have a TCP proxy that routes by the TLS server name (SNI) pass `turn.chat.example.com` through to LiveKit untouched (that
last arrangement is **not tried here**).

**Docker Compose** (`.env.selfhost`; put the certificate and key in a directory, `./livekit-turn-certs` by default):

```
LIVEKIT_TURN_DOMAIN=turn.chat.example.com
LIVEKIT_TURN_CERT_FILE=fullchain.pem        # in LIVEKIT_TURN_CERT_DIR (default ./livekit-turn-certs)
LIVEKIT_TURN_KEY_FILE=privkey.pem
LIVEKIT_TURN_BIND=203.0.113.7               # the address that should answer: published on 127.0.0.1 until you set this
LIVEKIT_TURN_TLS_PORT=443
```

Setting `LIVEKIT_TURN_DOMAIN` is what turns the relay on. Then forward **443/tcp** and **3478/udp** of that address to the machine.

**Kubernetes (Helm):**

```yaml
voice:
  turn:
    enabled: true
    domain: turn.chat.example.com
    tlsSecretName: turn-cert          # a kubernetes.io/tls Secret (tls.crt, tls.key) for that name, in this namespace
    service:
      type: LoadBalancer              # its own Service (…-livekit-turn): 443 -> the pod, and 3478/udp
      loadBalancerIP: 203.0.113.7     # an address that is not your Ingress controller's
```

The chart refuses `enabled: true` without a domain or a certificate Secret. On k3s the built-in load balancer binds the node's ports,
so port 443 clashes with Traefik's on the same node: use a second node, or another load balancer such as MetalLB.

**Checking it:**

1. `openssl s_client -connect turn.chat.example.com:443 -servername turn.chat.example.com` from outside your network should show your
   certificate. If it does not, the relay is not reachable on 443.
2. The real test is a call from a network that blocks the audio. If you do not have one, [`e2e/relay-lab`](../../e2e/relay-lab/README.md)
   builds one in Docker (every UDP packet and 7881/tcp to LiveKit dropped) and joins a call in it. With the relay on, the call connects
   through `turns:…:443`; with it off, the same network fails with the message above.
3. In a browser, the *Quality* readout on the call panel says *through a relay*; `chrome://webrtc-internals` shows a `relay` candidate.

**What has and has not been verified.** Verified, with real browsers and the LiveKit version the chart installs: the relay allocates
over TLS and UDP; the apps are told `turns:<domain>:443`; and **on a flat network, with every direct audio path blocked, a call
connects through TLS on 443** (and fails with the relay off, with the message above). The Compose file was run with the relay on and
off, and the TLS handshake on its published port presents the certificate. The chart was rendered and checked (CI does the same), but
**not installed on a cluster**. **Not verified:** a relay behind a home router or a cloud address translation. As far as LiveKit's source
shows, the relay's own UDP ports (30000 to 40000 by default) are advertised at LiveKit's public address and LiveKit has to reach
*itself* there; on a flat network that is trivial, behind NAT it would depend on the router looping traffic back (hairpin). If the TLS
handshake works but calls still fail from a locked-down network, look there first. LiveKit's own advice for NAT (running it on the
host's network) is not something this chart does.

One more thing the lab showed: a private (RFC 1918) address as LiveKit's address (`media.externalIp`, or an internal network) needs
`turn.allow_restricted_peer_cidrs` in LiveKit's config, because the relay refuses private peers by default. A server with a public
address needs nothing. Neither the chart nor the Compose file exposes that setting.

### An LiveKit you already run

Set the three `LIVEKIT_*` settings on the chat server only, and add to LiveKit's own config a webhook to
`https://<your chat server>/api/v1/voice/webhook` with the same `api_key`.

## Trying it

1. Make a channel (the **+** next to the channel list): **Voice** is offered once the server has voice.
2. Press it to join. The panel at the bottom of the sidebar says *Voice connected*.
3. From another device on another network (a phone on mobile data is a good test), join the same channel.

## If it does not work

| What you see | Likely cause |
|---|---|
| Making a channel offers no *Voice* choice | The chat server has no voice: check the three settings, and that the startup log says `Voice channels are on`. |
| "Couldn't connect to the voice server" | The apps cannot reach `LIVEKIT_URL`: DNS, TLS, or the proxy is not passing websockets. `curl https://voice.chat.example.com/` should answer `OK`. |
| Joined, but nobody hears anybody (or *Reconnecting…* for ever) | The audio ports are not reachable: check 7882/udp and 7881/tcp are forwarded and open, and LiveKit's log for the address it advertises (`nodeIP`). |
| Works for your friends, not for you at home | Your router may not loop traffic for its own public address back inside (NAT hairpinning). Test from outside your network. Not verified here: set `externalIp` to the machine's LAN address for testing from the LAN. |
| "Reached the voice server, but the audio couldn't get through" | The server answered but no audio connection came up in about 15 seconds: the network blocks the audio ports (7882/udp and 7881/tcp, or the router has not forwarded them). Check the two ports first; if they are open for most people, it is that person's network, and the [relay](#a-relay-for-locked-down-networks) is the fix. |
| Nobody in the list although people are in a call | LiveKit cannot reach the chat server's webhook (`http://server:4000/api/v1/voice/webhook` in the bundled setups): check LiveKit's log and the chat server's. |

## What to know

- **Audio is encrypted between each device and LiveKit, but not end to end**: LiveKit decrypts it to pass it on, so whoever runs your
  LiveKit could listen. That is you.
- People in a call **do not see each other's IP addresses** (they only talk to LiveKit); LiveKit sees all of them.
- **Restarting LiveKit ends the calls** in progress (the apps say so, and people can rejoin).
- One LiveKit pod, no clustering. Nothing here has been load tested.
- Taking *Connect to voice channels* away ends the calls of whoever can no longer connect, at once: editing or deleting a role, taking a
  role from a person, or handing the community to a new owner. The person is removed from the call and told so. Removing someone
  from the community does the same. If LiveKit cannot be reached at that moment the call is not ended (it is logged), and the
  person simply cannot join again.
- **Not built yet:** voice in communities hosted on another server (their voice channels are listed but cannot be joined), calls in
  direct messages with people on other servers, and a relay on the Compose or Helm install that works behind a router that does not loop traffic back (see above).
