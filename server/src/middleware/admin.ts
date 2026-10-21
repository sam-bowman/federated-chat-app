import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { verifyAccessToken } from "../lib/auth.js";
import { isValidSudoToken } from "../lib/adminSudo.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by requireAdmin: whether the admin has two-factor sign-in on, which the rest of the admin API needs. */
      adminTwoFactor?: boolean;
    }
  }
}

/**
 * Lets only an admin through, and says NOTHING to anyone else (#206): a missing or wrong token, an ordinary account, an account that was
 * erased or is suspended, and a server with the admin page switched off all get the exact answer a path that does not exist gets (404
 * `not_found`, the same body as app.ts's catch-all), so nobody can tell the admin API is there. Without an admin (none is made until the
 * operator's command makes one) the whole API is therefore invisible.
 *
 * It looks the person up every time rather than trusting the token: an access token lives 15 minutes, and taking admin away, suspending or
 * erasing an account must end its admin access at once, not when the token runs out.
 */
export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const notFound = () => res.status(404).json({ error: "not_found" });
  if (!config.adminEnabled) return notFound();

  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return notFound();
  let userId: string;
  try {
    userId = verifyAccessToken(header.slice("Bearer ".length)).sub;
  } catch {
    return notFound();
  }
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { isAdmin: true, isRemote: true, suspendedAt: true, deletedAt: true, totpEnabled: true },
  });
  if (!user || !user.isAdmin || user.isRemote || user.suspendedAt || user.deletedAt) return notFound();

  req.userId = userId;
  req.adminTwoFactor = user.totpEnabled;
  next();
}

/**
 * An admin's account can do more than anyone's, so it is held to more: the rest of the admin API wants two-factor sign-in to be on. Said
 * plainly (it is only ever reached by someone who IS an admin, so there is nothing to hide): `/admin/me` still answers, so the page can
 * tell them what to do.
 */
export function requireAdminTwoFactor(req: Request, res: Response, next: NextFunction) {
  if (!req.adminTwoFactor) return res.status(403).json({ error: "admin_requires_two_factor" });
  next();
}

/**
 * Destructive admin actions (#206) need "sudo mode": a token from POST /admin/sudo, made after the password and a code from the authenticator
 * were checked within the last ten minutes, sent in the X-Admin-Sudo header. A stolen admin session alone cannot do them. It names the admin it
 * was made for, so another admin's token is no good, and the admin's own request has already passed requireAdmin (so this is only ever reached by
 * someone who is one: there is nothing to hide, and it says plainly what is missing).
 */
export function requireSudo(req: Request, res: Response, next: NextFunction) {
  const token = req.headers["x-admin-sudo"];
  if (!isValidSudoToken(config.jwtAccessSecret, typeof token === "string" ? token : undefined, req.userId!)) {
    return res.status(403).json({ error: "sudo_required" });
  }
  next();
}
