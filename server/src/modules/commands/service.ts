import { prisma } from "../../db.js";
import { storedOptions, type CommandOption } from "../../lib/botCommands.js";
import { publicUser } from "../../lib/serialize.js";
import { isUserOnline, sendToUsers } from "../../ws/gateway.js";
import { isRedisEnabled, liveConnectionUserIds } from "../../ws/presenceFanout.js";
import type { BotCommand, User } from "../../generated/prisma/client.js";

// Slash commands (#132, phase 3b, docs/commands-3b-plan.md): what the routes share.

export const INTERACTION_LIMITS = {
  /** A bot must start answering within this long of the person running the command: the promise is 3 seconds, and 2 more absorb clocks and latency. */
  firstAnswerMs: 5000,
  /** A deferred interaction may be finished within this long of being run. */
  expiresMs: 15 * 60 * 1000,
  /** Interactions waiting for a bot's answer: past this the bot is too busy to be sent more. */
  pendingPerBot: 50,
  /** How long a finished interaction is kept before it is removed. */
  keepMs: 24 * 60 * 60 * 1000,
  /** How often finished ones are removed. */
  pruneEveryMs: 60 * 60 * 1000,
} as const;

export interface SerializedCommand {
  id: string;
  name: string;
  description: string;
  options: CommandOption[];
}

export function serializeCommand(command: Pick<BotCommand, "protocolId" | "name" | "description" | "options">): SerializedCommand {
  return { id: command.protocolId, name: command.name, description: command.description, options: storedOptions(command.options) };
}

/** Which of these accounts have a live socket on ANY replica (the fleet's connection keys with Redis, this process without it). */
export async function connectedAmong(userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  if (isRedisEnabled()) {
    const live = await liveConnectionUserIds();
    return new Set(userIds.filter((id) => live.has(id)));
  }
  return new Set(userIds.filter((id) => isUserOnline(id)));
}

/** Whether one bot has a live socket anywhere. */
export async function isConnected(userId: string): Promise<boolean> {
  return (await connectedAmong([userId])).has(userId);
}

/**
 * Tells the members of every community the bot is in (live only: a client that is not connected asks when it opens a community) that the bot's set
 * of commands changed, so a picker that is open shows the new set.
 */
export async function pushCommandsUpdated(bot: Pick<User, "id" | "protocolId">): Promise<void> {
  const members = await prisma.communityMember.findMany({
    where: { community: { members: { some: { userId: bot.id } } }, user: { isRemote: false } },
    select: { userId: true },
    distinct: ["userId"],
  });
  sendToUsers(
    members.map((m) => m.userId),
    { type: "commands:updated", botId: bot.protocolId }
  );
}

/** The bots a person may be offered commands of in a community: members of it that are live accounts. */
export function usableBotsIn(communityId: string) {
  return { isBot: true, isWebhook: false, isRemote: false, deletedAt: null, suspendedAt: null, communityMemberships: { some: { communityId } } } as const;
}

/** What the invoker sees of a bot, in a private reply and in the "thinking" notice. */
export const botView = (bot: User) => publicUser(bot);

/** Removes interactions that are over (a day old). Returns how many. */
export async function pruneInteractions(now: Date = new Date()): Promise<number> {
  const removed = await prisma.interaction.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - INTERACTION_LIMITS.keepMs) } } });
  return removed.count;
}

/** Removes finished interactions shortly after start and then every hour. */
export function startInteractionPruning(intervalMs: number = INTERACTION_LIMITS.pruneEveryMs): () => void {
  const run = () => {
    pruneInteractions().catch((err) => console.error("[commands] could not remove old interactions:", err));
  };
  const first = setTimeout(run, 60 * 1000);
  const timer = setInterval(run, intervalMs);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
