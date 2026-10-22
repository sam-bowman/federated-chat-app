# Invite-only registration

> Part of the [deployment guides](README.md).

By default anyone who can reach your server can make an account on it
(`REGISTRATION_ENABLED=true`). Setting **`REGISTRATION_INVITE_ONLY=true`** makes the register
screen ask for an **invite code** as well, so only people you gave a code to can join. It is
the usual setting for a server run for friends, family or a club.

It is about **making an account**, nothing else: people who already have one sign in as
before, community invites (the codes that bring someone into a community) are a separate
thing, and it has no effect on federation. To close registration completely, set
`REGISTRATION_ENABLED=false` instead; that wins over invite-only.

## Turning it on

Read once, at startup: change it and restart the server.

| How you run it | What to set |
|---|---|
| Docker Compose (`docker-compose.selfhost.yml`) | `REGISTRATION_INVITE_ONLY=true` in your `.env.selfhost` |
| Kubernetes (Helm) | `server.registrationInviteOnly: true` in your values |
| Native binary or `npm run dev` | `REGISTRATION_INVITE_ONLY=true` in the server's `.env` |

The value must be `true`/`false` (also `1`/`0`, `yes`/`no`, `on`/`off`). Anything else, a
typo such as `ture`, stops the server at startup and says so: a server meant to be
invite-only must not quietly end up open.

When it is on, the server logs `Registration is invite-only` at startup, and its
discovery document says so (`registration.inviteOnly`), which is how the client knows to ask
for the code.

## Making codes

An admin can make, copy and revoke them on the **Invites** page of the [admin page](admin-ui.md#invites) (it asks the admin to confirm it is them first). Or you make them with a small command on the server. It talks to the database directly with
the same settings the server uses, so there is no password or token to manage, and no way to
make a code from outside: being able to run a command where the server runs is the
permission.

| How you run it | Command |
|---|---|
| Docker Compose | `docker compose -f docker-compose.selfhost.yml exec server node dist/registrationInvitesCli.js create` |
| Kubernetes | `kubectl exec -n <namespace> deploy/<release>-federated-chat-app-server -- node dist/registrationInvitesCli.js create` |
| `npm run dev` from a checkout | `npm run registration-invites --workspace server -- create` |

(The Kubernetes deployment is named after your release; `kubectl get deploy -n <namespace>`
shows it.) Every example below is shown as `create`, `list` and `revoke`; add whichever of the
lines above matches how you run the server in front of them.

### `create`

```
create [--uses <n|unlimited>] [--days <n|never>] [--note <text>] [--count <n>]
```

With no options it makes **one code that works once and expires in a week**:

```
Made 1 registration invite (one use, expires 2026-10-26):

  K7M2QXR9TB

Give a code to the person: they enter it on the register screen.
```

- `--uses 5` lets five people use it; `--uses unlimited` any number.
- `--days 30` expires it in 30 days; `--days never` keeps it for ever.
- `--note "Alex from work"` is a reminder for you, shown by `list`. The person never sees it.
- `--count 10` makes ten different codes at once (up to 50).

A mistyped option is refused rather than ignored, so `--day 1` cannot quietly leave the
default week in place.

### `list`

```
list [--all]
```

Shows the codes that can still be used, how many times each has been used, when it
expires, its note, and **who made an account with it**. `--all` also shows the revoked,
expired and used-up ones.

### `revoke`

```
revoke <code>
```

Stops a code from working at once. People who already made an account with it keep it.

## What people see

On the register screen there is an **Invite code** box; nothing is needed to sign in. You
can send a link instead of a bare code: `https://<your client address>/register?invite=K7M2QXR9TB`
fills the box in (the desktop app needs the code typed in, after choosing the server).

If a code does not work the screen says why: not a code that exists, expired, revoked, or
already used. Codes are 10 characters without look-alikes (no `0`/`O`, `1`/`I`/`L`) and can
be typed in lower case.

## Things worth knowing

- **A code is spent only when the account is made.** A registration that fails (a username
  that is taken, a weak password) leaves it for the next try, and two people racing for the
  last use of a code cannot both get it.
- **The code is checked before anything else**, so someone without one cannot use the
  register screen to find out which usernames are taken.
- **Codes are guessable only by trying.** They have 50 bits of randomness and registration
  is already rate limited (10 attempts per 15 minutes per address, see
  [Security](../security.md#rate-limiting)). Set `TRUST_PROXY` correctly behind a proxy or
  everyone shares one limit.
- **Codes are secrets until used.** Anyone who has one can use it, so send each to the
  person it is for, and prefer the default (one use, a week) to `--uses unlimited --days
  never`, which is a standing open door.
- **The page and the command are the same thing.** They share one set of rules, so a code
  made on one is listed and revoked on the other, and both record it in the
  [audit log](audit-log.md) (the entry names the invite by an id and the last four
  characters of the code, never the code).
