import { Prisma, type Community, type Invite, type User } from "../../generated/prisma/client.js";
import { prisma } from "../../db.js";
import { notifyLocalMembersOfUpdate } from "./notifyMembers.js";
import { config } from "../../config.js";
import { acceptsOtherServers, effectiveVisibility, joinsWithoutInvite } from "../../lib/communityVisibility.js";
import { publicUser } from "../../lib/serialize.js";
import {
  generateInviteCode,
  inviteFailureCode,
  inviteJoinReference,
  inviteStatus,
  normalizeInviteCode,
} from "../../lib/invites.js";

/**
 * The database side of invites (the rules and formats are in lib/invites.ts). Everything here runs on the community's
 * HOME server: it alone knows the invites and is the one that checks them when someone joins, whichever server that
 * person is on.
 */

export interface NewInvite {
  communityId: string;
  createdById: string;
  /** Seconds from now, or null/undefined for never. */
  expiresInSeconds?: number | null;
  /** How many people may join with it, or null/undefined for any number. */
  maxUses?: number | null;
  /** Made for a card sent in a conversation, not in the Invite dialog (see Invite.viaCard). */
  viaCard?: boolean;
}

/** Creates an invite with a fresh code, trying again in the (astronomically unlikely) case of a code already taken. */
export async function createInvite(input: NewInvite): Promise<Invite> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await prisma.invite.create({
        data: {
          code: generateInviteCode(),
          communityId: input.communityId,
          createdById: input.createdById,
          expiresAt: input.expiresInSeconds ? new Date(Date.now() + input.expiresInSeconds * 1000) : null,
          maxUses: input.maxUses ?? null,
          viaCard: input.viaCard ?? false,
        },
      });
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
    }
  }
  throw new Error("could not generate a unique invite code");
}

/** An invite as the API shows it to someone allowed to see it (the code and who made it included). */
export function serializeInvite(invite: Invite & { createdBy: User }, community: Pick<Community, "protocolId" | "homeserverDomain">) {
  return {
    id: invite.id,
    code: invite.code,
    // Everything a person needs to paste into "Join by ID": the community, its server, and this invite.
    reference: inviteJoinReference(community, invite.code),
    expiresAt: invite.expiresAt,
    maxUses: invite.maxUses,
    uses: invite.uses,
    revokedAt: invite.revokedAt,
    viaCard: invite.viaCard,
    status: inviteStatus(invite),
    createdAt: invite.createdAt,
    createdBy: publicUser(invite.createdBy),
  };
}

export type JoinResult = { ok: true } | { ok: false; status: number; error: string };

/** Thrown inside the join transaction so that using up an invite and adding the member succeed or fail together. */
class InviteRefused extends Error {
  constructor(public error: string) {
    super(error);
  }
}

/**
 * Adds `userId` (a local person, or the cached stand-in for one on another server) to a community that lives on this
 * server, if the rules allow it. The one place joining is decided, for a local join and for one proxied from another
 * server alike:
 *  - someone banned is refused;
 *  - someone already in is fine, and does not use up an invite;
 *  - with an invite code, the invite must be this community's, not revoked, not expired and not used up (each its own
 *    error, so a card can say which), and joining uses one of its uses;
 *  - without a code, the community must let anyone join (not INVITE_ONLY);
 *  - a LOCAL_ONLY community takes nobody from another server, with or without a code, and says so as it would for an id
 *    nobody has (404), so it cannot even be confirmed to be there. Someone from another server who is already in stays in.
 * A code given when it is not needed (a community that is open) must still be good: a stale card says so.
 */
export async function joinLocalCommunity(
  community: Pick<Community, "id" | "visibility">,
  joiner: { id: string; isRemote: boolean },
  code: string | null | undefined
): Promise<JoinResult> {
  const userId = joiner.id;
  // What is in force, which is the community's setting held to the server's limit on how exposed one may be.
  const visibility = effectiveVisibility(community.visibility, config.communityVisibilityLimit);
  const existing = await prisma.communityMember.findUnique({ where: { communityId_userId: { communityId: community.id, userId } } });
  if (joiner.isRemote && !acceptsOtherServers(visibility) && !existing) return { ok: false, status: 404, error: "not_found" };

  const banned = await prisma.communityBan.findUnique({ where: { communityId_userId: { communityId: community.id, userId } } });
  if (banned) return { ok: false, status: 403, error: "banned" };

  if (existing) return { ok: true };

  let invite: Invite | null = null;
  if (code) {
    invite = await prisma.invite.findUnique({ where: { code: normalizeInviteCode(code) } });
    // Not found, or a real code for another community: the same answer, so a code cannot be used to probe other communities.
    if (!invite || invite.communityId !== community.id) return { ok: false, status: 403, error: "invite_invalid" };
    const status = inviteStatus(invite);
    if (status !== "active") return { ok: false, status: 403, error: inviteFailureCode(status) };
  } else if (!joinsWithoutInvite(visibility)) {
    return { ok: false, status: 403, error: "invite_required" };
  }

  const everyoneRole = await prisma.role.findFirst({ where: { communityId: community.id, isDefault: true } });
  try {
    await prisma.$transaction(async (tx) => {
      if (invite) {
        // Claimed with a conditional update, so two people racing for the last use cannot both get it.
        const now = new Date();
        const claimed = await tx.invite.updateMany({
          where: {
            id: invite.id,
            revokedAt: null,
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
            ...(invite.maxUses !== null ? { uses: { lt: invite.maxUses } } : {}),
          },
          data: { uses: { increment: 1 } },
        });
        if (claimed.count !== 1) {
          const fresh = await tx.invite.findUnique({ where: { id: invite.id } });
          const status = fresh ? inviteStatus(fresh, now) : "revoked";
          throw new InviteRefused(inviteFailureCode(status === "active" ? "used_up" : status));
        }
      }
      const member = await tx.communityMember.upsert({
        where: { communityId_userId: { communityId: community.id, userId } },
        create: { communityId: community.id, userId },
        update: {},
      });
      if (everyoneRole) {
        await tx.memberRole.upsert({
          where: { memberId_roleId: { memberId: member.id, roleId: everyoneRole.id } },
          create: { memberId: member.id, roleId: everyoneRole.id },
          update: {},
        });
      }
    });
  } catch (err) {
    if (err instanceof InviteRefused) return { ok: false, status: 403, error: err.error };
    throw err;
  }
  // The people already in it have a member list that does not have this person (#220).
  await notifyLocalMembersOfUpdate(community.id);
  return { ok: true };
}
