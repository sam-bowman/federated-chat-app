# Administering a server: the admin command

> Part of the [deployment guides](README.md).

A homeserver operator can list and manage the **accounts and communities on their own server** from the command line, without
writing SQL: see who is there, suspend an account, reset a password, turn off 2FA for someone locked out, and delete a community.

It is **metadata only**: no messages, no direct messages, no channels, no files, and never a password hash, a 2FA secret, a
recovery code or a token. It only touches accounts and communities that live on **this** server: a cached copy of someone from
another server, or of another server's community, is theirs and is refused.

## How it proves you may

It does not. You run it **where the server runs** (inside the container, the pod, or beside the binary) and it talks to the database
with the `DATABASE_URL` the server already holds. There is no network port, no token to leak and nothing to expose through an
ingress: the authority is "you can run commands on the server and read its secrets", which is already what protects the database
and the signing keys. (A browser admin page is a separate piece of work, [#206](https://github.com/sam-bowman/federated-chat-app/issues/206).)

## Running it

| Deployment | Command |
|---|---|
| Docker Compose | `docker compose -f docker-compose.selfhost.yml exec server node dist/adminCli.js users list` |
| Kubernetes | `kubectl exec -n <namespace> deploy/<release>-federated-chat-app-server -- node dist/adminCli.js users list` |
| Native binary | `./my-chat-server-linux-x64 admin users list` (from the folder with its `.env`) |
| `npm run dev` from a checkout | `npm run admin --workspace server -- users list` |

Anything that asks a question (a confirmation, a new password) needs a **terminal**: add `-it` to `kubectl exec` and `docker exec`
(`docker compose exec` has one by default). Without one it refuses, rather than guessing, unless you pass `--yes` to a command that
only needs a confirmation. A password is never taken from the command line.

Exit codes: `0` done, `1` it could not (no such account, or you said no), `2` used wrongly or nothing to ask on.

## Commands

### Accounts

| Command | What it does |
|---|---|
| `users list [--search <text>] [--suspended] [--json]` | Username, name, created, last seen, 2FA on or off, suspended, communities owned and joined. |
| `users show <username> [--json]` | One account: the above plus the communities it owns, how many sessions it has, and the note on the registration invite it joined with. |
| `users suspend <username> [--yes]` | Stops it signing in or refreshing a session, and **ends its sessions**. Asks first. |
| `users unsuspend <username>` | Lets it sign in again (it signs in afresh: the old sessions stay ended). |
| `users reset-password <username>` | Asks for the new password twice (hidden, held to the same rules as signing up) and **ends every session**. |
| `users disable-2fa <username> [--yes]` | Turns 2FA off and deletes its recovery codes, for someone who lost their authenticator. Asks first. Their sessions are left alone. |
| `users delete <username> [--now] [--yes]` | Asks for the account to be deleted, **as the person could**: their sessions end and, after the grace period (14 days unless `ACCOUNT_DELETION_GRACE_DAYS` says otherwise), it is erased unless they sign in first. `--now` erases it at once. Refused while they own a community (it names them). Asks first. See [Deleting accounts](account-deletion.md). |
| `users cancel-deletion <username>` | Takes a pending deletion back, without waiting for the person to sign in. |
| `users make-admin <username>` | Lets them use the [admin page](admin-ui.md). **Only this command can**: nothing in the API sets it. The page also needs them to have two-factor sign-in on, which the command says if they have not. |
| `users remove-admin <username>` | Takes that away. |

A suspended account that tries to sign in with the right password is told `account_suspended`; with the wrong one it gets the same
answer as any account, so nobody learns an account is suspended without knowing the password.
**One limit to know about:** an access token the person already holds stays valid until it expires, **at most 15 minutes**; what
suspending stops at once is signing in and refreshing.

### Communities

| Command | What it does |
|---|---|
| `communities list [--json]` | Id, name, hosted here or a cached copy of another server's, owner, members, channels, who can join, created. |
| `communities show <id> [--json]` | One community: members here and on other servers (and which), text and voice channels, who can join. |
| `communities delete <id> [--yes]` | Deletes it **exactly as its owner deleting it would** (the same code): the channels, messages, roles and memberships go, its voice rooms are closed, its members are told, other servers are told to drop their copy, and files nothing else uses are removed. Asks first, saying what goes. |

The id is the one `communities list` shows (the same as in the address bar).

### Output

A readable table by default, or `--json` for scripts. `--json` has the same fields and the same limits: nothing secret is in it.

## Notes

- **Everything the command changes is written to the [audit log](audit-log.md)** as "the operator (command line)": suspending, resetting a password, turning off 2FA, deleting and cancelling, making an admin, deleting a community. A repeat that changes nothing, a refusal, and a question answered no are not recorded.

- **Members are told live only if the server has Redis** (or the member reloads): the command runs in its own process, so without
  `REDIS_URL` it cannot reach a running server's open connections. The notice is recorded either way, and a client that reconnects
  gets it.
- Deleting an **account** is `users delete`: [what it removes and leaves](account-deletion.md). `--now` cannot be undone, and your
  backups still hold the account until you delete them. The command waits (up to 20 seconds) for other servers to be told before it ends.
- Registration invite codes have their own command: [Invite-only registration](invite-only.md).
- Not in the command: handing a community to another member (the [admin page](admin-ui.md#communities) does it; the owner can do it in the app).

## How thoroughly it was checked

Run for real against a PostgreSQL database in the test suite (every command, including an account that owns a community, a cached
copy of another server's account and community, and a confirmation answered no or not askable), with mutation checks that each
safety rule (local accounts only, sessions ended, nothing asked without a terminal, no secret in the output, no deletion of a cached
community) fails a test when removed. Run from the **real Windows native binary** (`admin`, and the server still starting
without it). **Not run:** in the Docker image or on a Kubernetes cluster (the command is the same file the image already
ships), and on Linux or macOS.
