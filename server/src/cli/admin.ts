import { config } from "../config.js";
import { passwordSchema } from "../lib/passwordPolicy.js";
import {
  cancelUserDeletion,
  deleteCommunityByOperator,
  deleteUser,
  disableTwoFactor,
  getCommunity,
  getUser,
  listCommunities,
  listUsers,
  resetPassword,
  suspendUser,
  unsuspendUser,
  type CommunityDetail,
  type CommunitySummary,
  type UserDetail,
  type UserSummary,
} from "../modules/admin/service.js";

/** Where the command writes, so a test can read it. */
export interface Output {
  log(line: string): void;
  error(line: string): void;
}

/** What needs a person at a keyboard. A test supplies answers. */
export interface AdminIo {
  /** False when input is not a terminal (a pipe, a cron job, `kubectl exec` without -it): nothing can be asked. */
  interactive: boolean;
  confirm(question: string): Promise<boolean>;
  /** Reads a secret without showing it. */
  secret(prompt: string): Promise<string>;
}

export const USAGE = `Server administration: the people and communities on THIS server. Metadata only: no messages, no direct
messages, no channels, no files, and never a password hash, a 2FA secret or a token.

  users list [--search <text>] [--suspended] [--json]
  users show <username> [--json]
  users suspend <username> [--yes]      Cannot sign in or refresh; their sessions end.
  users unsuspend <username>
  users reset-password <username>       Asks for the new password (never on the command line); ends their sessions.
  users disable-2fa <username> [--yes]  For someone locked out of their account.
  users delete <username> [--now] [--yes]
                                        Asks for the account to be deleted, as the person could: their sessions end and, after the
                                        grace period (14 days unless ACCOUNT_DELETION_GRACE_DAYS says otherwise), it is erased unless
                                        they sign in first. --now erases it at once. Refused while they own a community.
  users cancel-deletion <username>      Takes a pending deletion back.
  communities list [--json]
  communities show <id> [--json]
  communities delete <id> [--yes]       The same as the owner deleting it: members are told, other servers drop their copy.

Only accounts and communities on this server. Anything that asks first needs a terminal, or --yes.

Run it where the server runs, so it reads the same environment:
  docker compose exec server node dist/adminCli.js users list
  kubectl exec -n <namespace> deploy/<release>-federated-chat-app-server -- node dist/adminCli.js users list
  ./my-chat-server admin users list        (the native binary)
  npm run admin --workspace server -- users list`;

// --- output ------------------------------------------------------------------------------------------------------------

const day = (date: Date | null) => (date ? date.toISOString().slice(0, 10) : "never");
const when = (date: Date | null) => (date ? date.toISOString().replace("T", " ").slice(0, 16) + " UTC" : "never");

/** A readable table: columns padded to their widest entry. */
export function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

function userRow(u: UserSummary): string[] {
  return [u.username, u.displayName, day(u.createdAt), day(u.lastSeenAt), u.twoFactor ? "on" : "off", u.suspended ? "SUSPENDED" : u.deletionPending ? "DELETING" : "", String(u.communitiesOwned), String(u.communitiesJoined)];
}

function describeUser(u: UserDetail): string {
  const lines = [
    `${u.identity}  (${u.displayName})`,
    `  created:         ${when(u.createdAt)}`,
    `  last seen:       ${when(u.lastSeenAt)}`,
    `  two-factor:      ${u.twoFactor ? "on" : "off"}`,
    `  suspended:       ${u.suspendedAt ? `yes, since ${when(u.suspendedAt)}` : "no"}`,
    `  deletion:        ${u.deletionScheduledFor ? `asked for ${when(u.deletionRequestedAt)}; erased ${when(u.deletionScheduledFor)} unless they sign in first` : "not asked for"}`,
    `  sessions:        ${u.activeSessions} that can be refreshed`,
    `  communities:     owns ${u.communitiesOwned}, in ${u.communitiesJoined}`,
  ];
  for (const c of u.ownedCommunities) lines.push(`    owns ${c.name}  (${c.id})`);
  if (u.registrationInviteNote) lines.push(`  joined with an invite noted: ${u.registrationInviteNote}`);
  return lines.join("\n");
}

function communityRow(c: CommunitySummary): string[] {
  return [c.id, c.name, c.hosting === "here" ? "here" : `cached from ${c.hostedBy}`, c.owner, String(c.members), String(c.channels), c.visibility, day(c.createdAt)];
}

function describeCommunity(c: CommunityDetail): string {
  const lines = [
    `${c.name}  (${c.id})`,
    `  hosted:       ${c.hosting === "here" ? "here" : `on ${c.hostedBy} (a cached copy: not ours to manage)`}`,
    `  owner:        ${c.owner}`,
    `  members:      ${c.members} (${c.localMembers} here, ${c.remoteMembers} on other servers${c.remoteDomains.length ? `: ${c.remoteDomains.join(", ")}` : ""})`,
    `  channels:     ${c.channels} (${c.textChannels} text, ${c.voiceChannels} voice)`,
    `  who can join: ${c.visibility}`,
    `  created:      ${when(c.createdAt)}`,
  ];
  if (c.description) lines.push(`  description:  ${c.description}`);
  return lines.join("\n");
}

// --- arguments ---------------------------------------------------------------------------------------------------------

interface Parsed {
  positional: string[];
  flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set(["search"]);

function parseArgs(args: string[]): Parsed | { error: string } {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (VALUE_FLAGS.has(name)) {
      const value = args[++i];
      if (value === undefined || value.startsWith("--")) return { error: `--${name} needs a value` };
      flags.set(name, value);
    } else {
      flags.set(name, true);
    }
  }
  return { positional, flags };
}

function unknownFlags(parsed: Parsed, allowed: string[]): string | null {
  const bad = [...parsed.flags.keys()].find((f) => !allowed.includes(f));
  return bad ? `Unknown option --${bad}.` : null;
}

// --- commands ----------------------------------------------------------------------------------------------------------

/** Asks before something that cannot be undone. Without a terminal it refuses rather than guessing, unless --yes was given. */
async function approved(parsed: Parsed, io: AdminIo, out: Output, question: string): Promise<boolean | "refused"> {
  if (parsed.flags.has("yes")) return true;
  if (!io.interactive) {
    out.error("This asks for confirmation and there is no terminal to ask on. Run it with a terminal (-it), or add --yes.");
    return "refused";
  }
  return io.confirm(question);
}

const graceText = () => {
  const days = config.accountDeletionGraceDays;
  return days === 0 ? "the next hour" : `${days} day${days === 1 ? "" : "s"}`;
};

const ownsCommunities = (out: Output, username: string, communities: { id: string; name: string }[]) => {
  out.error(`${username} still owns ${communities.length === 1 ? "a community" : `${communities.length} communities`}, which would be left without an owner:`);
  for (const c of communities) out.error(`  ${c.name}  (${c.id})`);
  out.error("They transfer them to someone else first, or you delete them with: communities delete <id>");
  return 1;
};

const noUser = (out: Output, username: string) => {
  out.error(`There is no account called "${username}" on this server (only accounts here can be managed).`);
  return 1;
};

async function usersCommand(sub: string | undefined, rest: string[], io: AdminIo, out: Output): Promise<number> {
  const parsed = parseArgs(rest);
  if ("error" in parsed) return fail(out, parsed.error);
  const username = parsed.positional[0];

  switch (sub) {
    case "list": {
      const bad = unknownFlags(parsed, ["search", "suspended", "json"]);
      if (bad || parsed.positional.length > 0) return fail(out, bad ?? "users list takes no arguments.");
      const users = await listUsers({ search: parsed.flags.get("search") as string | undefined, suspendedOnly: parsed.flags.has("suspended") });
      if (parsed.flags.has("json")) out.log(json(users));
      else if (users.length === 0) out.log("No accounts match.");
      else {
        out.log(renderTable(["USERNAME", "NAME", "CREATED", "LAST SEEN", "2FA", "", "OWNS", "IN"], users.map(userRow)));
        out.log(`\n${users.length} account${users.length === 1 ? "" : "s"}.`);
      }
      return 0;
    }
    case "show": {
      const bad = unknownFlags(parsed, ["json"]);
      if (bad || !username) return fail(out, bad ?? "users show needs a username.");
      const user = await getUser(username);
      if (!user) return noUser(out, username);
      out.log(parsed.flags.has("json") ? json(user) : describeUser(user));
      return 0;
    }
    case "suspend": {
      const bad = unknownFlags(parsed, ["yes"]);
      if (bad || !username) return fail(out, bad ?? "users suspend needs a username.");
      if (!(await getUser(username))) return noUser(out, username);
      const ok = await approved(parsed, io, out, `Suspend ${username}? They will be signed out and unable to sign in.`);
      if (ok === "refused") return 2;
      if (!ok) return cancelled(out);
      const result = await suspendUser(username);
      if (!result.ok) return noUser(out, username);
      out.log(
        result.changed
          ? `Suspended ${username}. ${result.sessionsEnded} session${result.sessionsEnded === 1 ? "" : "s"} ended; anyone already holding an access token loses it within 15 minutes.`
          : `${username} was already suspended (${result.sessionsEnded} session${result.sessionsEnded === 1 ? "" : "s"} ended).`
      );
      return 0;
    }
    case "unsuspend": {
      const bad = unknownFlags(parsed, []);
      if (bad || !username) return fail(out, bad ?? "users unsuspend needs a username.");
      const result = await unsuspendUser(username);
      if (!result.ok) return noUser(out, username);
      out.log(result.changed ? `Unsuspended ${username}. They can sign in again.` : `${username} was not suspended.`);
      return 0;
    }
    case "reset-password": {
      const bad = unknownFlags(parsed, []);
      if (bad || !username) return fail(out, bad ?? "users reset-password needs a username.");
      if (!io.interactive) {
        out.error("The new password is asked for on a terminal and never taken from the command line. Run it with a terminal (-it).");
        return 2;
      }
      if (!(await getUser(username))) return noUser(out, username);
      const first = await io.secret(`New password for ${username}: `);
      const policy = passwordSchema.safeParse(first);
      if (!policy.success) {
        out.error(policy.error.issues[0]?.message ?? "That password is not allowed.");
        return 2;
      }
      if ((await io.secret("Again: ")) !== first) {
        out.error("The two passwords were not the same. Nothing was changed.");
        return 2;
      }
      const result = await resetPassword(username, first);
      if (!result.ok) return noUser(out, username);
      out.log(`Changed ${username}'s password. ${result.sessionsEnded} session${result.sessionsEnded === 1 ? "" : "s"} ended: they sign in again with the new one.`);
      return 0;
    }
    case "disable-2fa": {
      const bad = unknownFlags(parsed, ["yes"]);
      if (bad || !username) return fail(out, bad ?? "users disable-2fa needs a username.");
      const user = await getUser(username);
      if (!user) return noUser(out, username);
      if (!user.twoFactor) {
        out.log(`${username} does not have two-factor sign-in on.`);
        return 0;
      }
      const ok = await approved(parsed, io, out, `Turn off two-factor sign-in for ${username}? Only do this once you are sure it is them.`);
      if (ok === "refused") return 2;
      if (!ok) return cancelled(out);
      const result = await disableTwoFactor(username);
      if (!result.ok) return noUser(out, username);
      out.log(`Turned off two-factor sign-in for ${username}. Their recovery codes are gone; they can set it up again in Settings.`);
      return 0;
    }
    case "delete": {
      const bad = unknownFlags(parsed, ["yes", "now"]);
      if (bad || !username) return fail(out, bad ?? "users delete needs a username.");
      const user = await getUser(username);
      if (!user) return noUser(out, username);
      if (user.ownedCommunities.length > 0) return ownsCommunities(out, username, user.ownedCommunities);
      const now = parsed.flags.has("now");
      const ok = await approved(
        parsed,
        io,
        out,
        now
          ? `Erase ${username} NOW? Their messages, friendships, memberships and files are removed for good, other servers are told, and the name can never be registered again. There is no way back.`
          : `Delete ${username}? They are signed out, and the account is erased in ${graceText()} unless they sign in before then.`
      );
      if (ok === "refused") return 2;
      if (!ok) return cancelled(out);
      const result = await deleteUser(username, { now });
      if (!result.ok) return result.error === "owns_communities" ? ownsCommunities(out, username, result.communities) : noUser(out, username);
      out.log(
        result.mode === "erased"
          ? `Erased ${username}. Their messages, friendships, memberships and sessions are gone, and other servers have been told. Backups you took before this still hold their data until you delete them.`
          : `${result.alreadyRequested ? `${username} had already asked to be deleted.` : `Asked for ${username} to be deleted.`} Their sessions are ended; the account is erased on ${when(result.scheduledFor)} unless they sign in first (or you run: users cancel-deletion ${username}).`
      );
      return 0;
    }
    case "cancel-deletion": {
      const bad = unknownFlags(parsed, []);
      if (bad || !username) return fail(out, bad ?? "users cancel-deletion needs a username.");
      const result = await cancelUserDeletion(username);
      if (!result.ok) return noUser(out, username);
      out.log(result.changed ? `Cancelled the deletion of ${username}. They can sign in again as before.` : `${username} had not asked to be deleted.`);
      return 0;
    }
    default:
      return fail(out, sub ? `Unknown command: users ${sub}` : "users needs a command.");
  }
}

async function communitiesCommand(sub: string | undefined, rest: string[], io: AdminIo, out: Output): Promise<number> {
  const parsed = parseArgs(rest);
  if ("error" in parsed) return fail(out, parsed.error);
  const id = parsed.positional[0];

  switch (sub) {
    case "list": {
      const bad = unknownFlags(parsed, ["json"]);
      if (bad || parsed.positional.length > 0) return fail(out, bad ?? "communities list takes no arguments.");
      const communities = await listCommunities();
      if (parsed.flags.has("json")) out.log(json(communities));
      else if (communities.length === 0) out.log("There are no communities.");
      else {
        out.log(renderTable(["ID", "NAME", "HOSTED", "OWNER", "MEMBERS", "CHANNELS", "JOIN", "CREATED"], communities.map(communityRow)));
        out.log(`\n${communities.length} communit${communities.length === 1 ? "y" : "ies"}.`);
      }
      return 0;
    }
    case "show": {
      const bad = unknownFlags(parsed, ["json"]);
      if (bad || !id) return fail(out, bad ?? "communities show needs an id.");
      const community = await getCommunity(id);
      if (!community) return noCommunity(out, id);
      out.log(parsed.flags.has("json") ? json(community) : describeCommunity(community));
      return 0;
    }
    case "delete": {
      const bad = unknownFlags(parsed, ["yes"]);
      if (bad || !id) return fail(out, bad ?? "communities delete needs an id.");
      const community = await getCommunity(id);
      if (!community) return noCommunity(out, id);
      if (community.hosting !== "here") {
        out.error(`${community.name} is a copy of a community on ${community.hostedBy}: it is theirs to delete, not this server's.`);
        return 1;
      }
      const ok = await approved(
        parsed,
        io,
        out,
        `Delete "${community.name}"? Its ${community.channels} channels, all their messages and its ${community.members} memberships are removed for good, and its members are told.`
      );
      if (ok === "refused") return 2;
      if (!ok) return cancelled(out);
      const result = await deleteCommunityByOperator(id);
      if (!result.ok) return result.error === "no_such_community" ? noCommunity(out, id) : fail(out, "That community is not hosted here.");
      out.log(`Deleted "${community.name}".`);
      return 0;
    }
    default:
      return fail(out, sub ? `Unknown command: communities ${sub}` : "communities needs a command.");
  }
}

function noCommunity(out: Output, id: string): number {
  out.error(`There is no community with the id "${id}" (list them with: communities list).`);
  return 1;
}

function cancelled(out: Output): number {
  out.log("Cancelled. Nothing was changed.");
  return 1;
}

function fail(out: Output, message: string): number {
  out.error(message);
  out.error("Run it with no arguments for the list of commands.");
  return 2;
}

/** Runs one admin command. Returns the exit code: 0 done, 1 could not (nothing matched, or cancelled), 2 used wrongly. */
export async function runAdminCli(args: string[], out: Output, io: AdminIo): Promise<number> {
  const [group, sub, ...rest] = args;
  if (!group || group === "help" || group === "--help" || group === "-h") {
    out.log(USAGE);
    return group ? 0 : 2;
  }
  if (group === "users") return usersCommand(sub, rest, io, out);
  if (group === "communities") return communitiesCommand(sub, rest, io, out);
  return fail(out, `Unknown command: ${group}`);
}
