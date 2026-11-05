import type { NextFunction, Request, Response } from "express";
import { verifyAccessToken } from "../lib/auth.js";
import { authenticateBotToken } from "../lib/botAuth.js";
import { botTokenFromHeader } from "../lib/botToken.js";
import { botLimiter } from "./rateLimit.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
      username?: string;
      /** True when the request was made with a bot's token (`requireAuthOrBot`), never for a person. */
      isBot?: boolean;
    }
  }
}

/** Signed-in PEOPLE only. A bot's token is not accepted here, so every route that does not say otherwise refuses a bot (#132). */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "missing_token" });
  }
  try {
    const payload = verifyAccessToken(header.slice("Bearer ".length));
    req.userId = payload.sub;
    req.username = payload.username;
    next();
  } catch {
    return res.status(401).json({ error: "invalid_token" });
  }
}

/**
 * A person (as `requireAuth`) or a bot (`Authorization: Bot <token>`). Only the routes a bot is meant to use say this; everything else
 * stays on `requireAuth`, so a new route refuses bots until someone decides it should not. A bot's requests are counted per bot, on top of
 * the per-address limit every request is under, so one noisy bot cannot use up what another has.
 */
export async function requireAuthOrBot(req: Request, res: Response, next: NextFunction) {
  const token = botTokenFromHeader(req.headers.authorization);
  if (token === null) return requireAuth(req, res, next);
  return authenticateBot(token, req, res, next);
}

/**
 * BOTS ONLY (`Authorization: Bot <token>`): the calls that are a bot's own (registering its slash commands, answering an interaction), which a
 * person has no use for and so is refused here: no header is `missing_token`, a person's token `invalid_token`. Counted per bot like the rest.
 */
export async function requireBot(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = botTokenFromHeader(header);
  if (token === null) return res.status(401).json({ error: header ? "invalid_token" : "missing_token" });
  return authenticateBot(token, req, res, next);
}

async function authenticateBot(token: string, req: Request, res: Response, next: NextFunction) {
  const bot = await authenticateBotToken(token);
  if (!bot) return res.status(401).json({ error: "invalid_token" });
  req.userId = bot.id;
  req.username = bot.username;
  req.isBot = true;
  botLimiter(req, res, next);
}
