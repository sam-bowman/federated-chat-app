import { prisma } from "../db.js";
import { config } from "../config.js";
import { hashBotToken, looksLikeBotToken } from "./botToken.js";

// Who a bot token belongs to (#132), asked of the database every time (the REST middleware on each request, the websocket when it
// connects and again every heartbeat), never remembered, so regenerating a token, deleting the bot, suspending it or switching bots off
// takes effect at once for requests and within one heartbeat for a connection that is already open.

export interface AuthenticatedBot {
  /** The database id (what `req.userId` holds for a person too). */
  id: string;
  username: string;
  /** The hash the token was found by: a connection keeps it so it can be checked again later. */
  tokenHash: string;
}

/** The bot a token belongs to, or null for anything that is not a working token (wrong shape, unknown, revoked, suspended, erased, bots off). */
export async function authenticateBotToken(token: string): Promise<AuthenticatedBot | null> {
  if (!config.botsEnabled || !looksLikeBotToken(token)) return null;
  const tokenHash = hashBotToken(token);
  const bot = await prisma.user.findUnique({
    where: { botTokenHash: tokenHash },
    select: { id: true, username: true, isBot: true, isRemote: true, suspendedAt: true, deletedAt: true },
  });
  if (!bot || !bot.isBot || bot.isRemote || bot.suspendedAt || bot.deletedAt) return null;
  return { id: bot.id, username: bot.username, tokenHash };
}

/** Of these token hashes, the ones that still belong to a working bot. */
export async function stillWorkingTokenHashes(hashes: string[]): Promise<Set<string>> {
  if (!config.botsEnabled || hashes.length === 0) return new Set();
  const rows = await prisma.user.findMany({
    where: { botTokenHash: { in: hashes }, isBot: true, isRemote: false, suspendedAt: null, deletedAt: null },
    select: { botTokenHash: true },
  });
  return new Set(rows.map((r) => r.botTokenHash).filter((h): h is string => h !== null));
}
