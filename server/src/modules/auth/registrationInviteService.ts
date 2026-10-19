import { Prisma, type RegistrationInvite, type User } from "@prisma/client";
import { prisma } from "../../db.js";
import {
  normalizeInviteCode,
  registrationInviteFailure,
  registrationInviteStatus,
  type RegistrationInviteFailure,
} from "../../lib/registrationInvites.js";

/** Why a registration invite did not work, thrown from inside the transaction that claims it. */
class RegistrationInviteRefused extends Error {
  readonly failure: RegistrationInviteFailure;
  constructor(failure: RegistrationInviteFailure) {
    super(failure);
    this.failure = failure;
  }
}

/** What a refused registration answers with: a taken username is a conflict, a code that does not work is forbidden. */
export function registrationRefusalStatus(error: RegistrationInviteFailure | "username_taken"): 403 | 409 {
  return error === "username_taken" ? 409 : 403;
}

export type InviteCheck = { ok: true; invite: RegistrationInvite } | { ok: false; error: RegistrationInviteFailure };

/**
 * Looks the code up and says whether it can be used right now. Nothing is used up here: the claim happens together with
 * making the account (`createAccount`), so a registration that fails afterwards (a taken username) does not spend it.
 * Asked BEFORE anything else about the request is judged, so without a good code nobody learns whether a username is
 * taken, or whether a password has been breached.
 */
export async function checkRegistrationInvite(rawCode: string | undefined): Promise<InviteCheck> {
  const code = rawCode === undefined ? "" : normalizeInviteCode(rawCode);
  if (code === "") return { ok: false, error: "registration_invite_required" };
  const invite = await prisma.registrationInvite.findUnique({ where: { code } });
  if (!invite) return { ok: false, error: "registration_invite_invalid" };
  const status = registrationInviteStatus(invite);
  if (status !== "active") return { ok: false, error: registrationInviteFailure(status) };
  return { ok: true, invite };
}

/**
 * Makes the account. With an invite, the use is claimed in the same transaction by a conditional update, so two people
 * racing for the last use cannot both get it, and an account that cannot be made leaves the use unspent.
 */
export async function createAccount(
  data: Prisma.UserUncheckedCreateInput,
  invite: RegistrationInvite | null
): Promise<{ ok: true; user: User } | { ok: false; error: RegistrationInviteFailure | "username_taken" }> {
  try {
    if (!invite) return { ok: true, user: await prisma.user.create({ data }) };
    const user = await prisma.$transaction(async (tx) => {
      const now = new Date();
      const claimed = await tx.registrationInvite.updateMany({
        where: {
          id: invite.id,
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          ...(invite.maxUses !== null ? { uses: { lt: invite.maxUses } } : {}),
        },
        data: { uses: { increment: 1 } },
      });
      if (claimed.count !== 1) {
        const fresh = await tx.registrationInvite.findUnique({ where: { id: invite.id } });
        const status = fresh ? registrationInviteStatus(fresh, now) : "revoked";
        throw new RegistrationInviteRefused(registrationInviteFailure(status === "active" ? "used_up" : status));
      }
      return tx.user.create({ data: { ...data, registrationInviteId: invite.id } });
    });
    return { ok: true, user };
  } catch (err) {
    if (err instanceof RegistrationInviteRefused) return { ok: false, error: err.failure };
    // Someone took the username between the check and now. The transaction is undone, so the code is not spent.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return { ok: false, error: "username_taken" };
    throw err;
  }
}
