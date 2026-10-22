import type { PrismaClient } from "@prisma/client";
import { normalizeInviteCode, parseCreateArgs, registrationInviteStatus } from "../lib/registrationInvites.js";
import { createRegistrationInvites, revokeRegistrationInvite } from "../modules/admin/registrationInvites.js";

/** Where the command writes, so a test can read it. */
export interface Output {
  log(line: string): void;
  error(line: string): void;
}

/** What the command needs to know about the server it is run on (the same environment the server reads). */
export interface ServerSettings {
  registrationEnabled: boolean;
  registrationInviteOnly: boolean;
}

export const USAGE = `Registration invites: codes that let people make an account on this server when it is invite-only
(REGISTRATION_INVITE_ONLY=true).

  create [--uses <n|unlimited>] [--days <n|never>] [--note <text>] [--count <n>]
      Make one or more codes. Default: one use, expires in 7 days.
  list [--all]
      Show the codes that can still be used (--all: also the revoked, expired and used up).
  revoke <code>
      Stop a code from being used. Accounts already made with it stay.

Run it where the server runs, so it reads the same environment:
  docker compose exec server node dist/registrationInvitesCli.js create
  kubectl exec -n <namespace> deploy/<release>-federated-chat-app-server -- node dist/registrationInvitesCli.js create --note "Alex"
  npm run registration-invites --workspace server -- create`;

function day(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function describeLimits(maxUses: number | null, expiresAt: Date | null): string {
  const uses = maxUses === null ? "any number of uses" : maxUses === 1 ? "one use" : `${maxUses} uses`;
  return `${uses}, ${expiresAt ? `expires ${day(expiresAt)}` : "never expires"}`;
}

async function create(args: string[], db: PrismaClient, out: Output, settings: ServerSettings): Promise<number> {
  const parsed = parseCreateArgs(args);
  if (!parsed.ok) {
    out.error(parsed.message);
    return 2;
  }
  const { maxUses, note, count } = parsed.options;
  // The same code the admin page runs, so the two cannot differ in what they make or record (this one is recorded as the command).
  const invites = await createRegistrationInvites(parsed.options, undefined, db);
  const expiresAt = invites[0].expiresAt;
  const made = invites.map((invite) => invite.code);
  out.log(`Made ${count === 1 ? "1 registration invite" : `${count} registration invites`} (${describeLimits(maxUses, expiresAt)}${note ? `, note: ${note}` : ""}):`);
  out.log("");
  for (const code of made) out.log(`  ${code}`);
  out.log("");
  out.log("Give a code to the person: they enter it on the register screen.");
  if (!settings.registrationEnabled) {
    out.log("Note: registration is OFF on this server (REGISTRATION_ENABLED=false), so nobody can use these yet.");
  } else if (!settings.registrationInviteOnly) {
    out.log("Note: this server is not invite-only (REGISTRATION_INVITE_ONLY is not true), so a code is not asked for yet.");
  }
  return 0;
}

async function list(args: string[], db: PrismaClient, out: Output): Promise<number> {
  const unknown = args.find((a) => a !== "--all");
  if (unknown !== undefined) {
    out.error(`Unknown option "${unknown}".`);
    return 2;
  }
  const all = args.includes("--all");
  const invites = await db.registrationInvite.findMany({
    orderBy: { createdAt: "asc" },
    include: { users: { select: { username: true }, orderBy: { createdAt: "asc" } } },
  });
  const shown = invites.filter((invite) => all || registrationInviteStatus(invite) === "active");
  if (shown.length === 0) {
    out.log(all ? "There are no registration invites." : "There are no registration invites that can still be used. (--all shows the others.)");
    return 0;
  }
  for (const invite of shown) {
    const status = registrationInviteStatus(invite);
    const uses = invite.maxUses === null ? `${invite.uses} used` : `${invite.uses}/${invite.maxUses} used`;
    const expires = invite.expiresAt ? `expires ${day(invite.expiresAt)}` : "never expires";
    const joined = invite.users.length > 0 ? `  joined: ${invite.users.map((u) => u.username).join(", ")}` : "";
    const note = invite.note ? `  note: ${invite.note}` : "";
    out.log(`${invite.code}  ${status.padEnd(7)}  ${uses}, ${expires}${note}${joined}`);
  }
  return 0;
}

async function revoke(args: string[], db: PrismaClient, out: Output): Promise<number> {
  if (args.length !== 1) {
    out.error("revoke needs exactly one code.");
    return 2;
  }
  const code = normalizeInviteCode(args[0]);
  const result = await revokeRegistrationInvite({ code }, undefined, db);
  if (!result.ok) {
    out.error(`There is no registration invite ${code}.`);
    return 1;
  }
  if (!result.changed) {
    out.log(`${code} was already revoked.`);
    return 0;
  }
  out.log(`Revoked ${code}. People who already made an account with it keep theirs.`);
  return 0;
}

/** Runs the command and returns its exit code (0 done, 1 something asked for is not there, 2 the command was misused). */
export async function runRegistrationInvitesCli(argv: string[], db: PrismaClient, out: Output, settings: ServerSettings): Promise<number> {
  const [command, ...args] = argv;
  switch (command) {
    case "create":
      return create(args, db, out, settings);
    case "list":
      return list(args, db, out);
    case "revoke":
      return revoke(args, db, out);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      out.log(USAGE);
      return command === undefined ? 2 : 0;
    default:
      out.error(`Unknown command "${command}".`);
      out.error("");
      out.error(USAGE);
      return 2;
  }
}
