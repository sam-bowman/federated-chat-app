import type { User } from "@prisma/client";
import { config } from "../../config.js";
import { prisma } from "../../db.js";
import { contactAllowedUnderLimit, needsSharedCommunity, type ContactFacts } from "../../lib/contactPolicy.js";
import { federationFetch } from "../../lib/federation/client.js";
import { findLocalUserByUsername } from "../../lib/users.js";

/** Who is asking to start something: a person we may or may not have a row for (a stranger on another server named only by handle). */
interface Sender {
  id: string | null;
  username: string;
  domain: string;
  isRemote: boolean;
}

/** How long to wait for a community's home server to say whether someone is in it, and how many such servers to ask at most. */
const HOST_ASK_TIMEOUT_MS = 3000;
const MAX_HOSTS_ASKED = 10;

/**
 * Whether the recipient and the sender are in a community together, for a community hosted on ANOTHER server. This server holds the
 * member list of a community it hosts, but of one hosted elsewhere it only knows its own members and the owner, so it asks that
 * community's home server, which is authoritative (and only answers a server that already has a member there). Any answer that is
 * not a clear yes (it is down, slow, refuses, or we may not talk to it) counts as no.
 */
async function sharesRemoteCommunity(recipientId: string, sender: Sender): Promise<boolean> {
  if (!config.federationEnabled) return false;
  const memberships = await prisma.communityMember.findMany({
    where: { userId: recipientId, community: { isRemote: true } },
    select: { community: { select: { protocolId: true, homeserverDomain: true } } },
    take: MAX_HOSTS_ASKED,
  });
  const answers = await Promise.all(
    memberships.map(async ({ community }) => {
      // (A server this one does not talk to is refused by federationFetch itself, and counts as no like any other failure.)
      try {
        const query = `username=${encodeURIComponent(sender.username)}&domain=${encodeURIComponent(sender.domain)}`;
        const res = await federationFetch(community.homeserverDomain, `/communities/${encodeURIComponent(community.protocolId)}/membership?${query}`, {
          method: "GET",
          timeoutMs: HOST_ASK_TIMEOUT_MS,
        });
        return ((await res.json()) as { member?: unknown }).member === true;
      } catch {
        return false;
      }
    })
  );
  return answers.some(Boolean);
}

/**
 * What the recipient's setting is judged against for one sender: where they are, whether they are friends, and (only when the
 * recipient's choice needs it, as it costs a question to other servers) whether a community is shared.
 */
export async function contactFacts(recipient: User, sender: Sender): Promise<ContactFacts> {
  const friendship = sender.id
    ? await prisma.friendship.findUnique({ where: { userId_friendId: { userId: recipient.id, friendId: sender.id } }, select: { id: true } })
    : null;
  let sharesCommunity = false;
  if (needsSharedCommunity(recipient.contactPolicy, config.contactPolicyLimit) && !friendship) {
    const here = sender.id
      ? await prisma.communityMember.findFirst({
          where: { userId: recipient.id, community: { members: { some: { userId: sender.id } } } },
          select: { id: true },
        })
      : null;
    sharesCommunity = here !== null || (await sharesRemoteCommunity(recipient.id, sender));
  }
  return { senderIsLocal: !sender.isRemote, isFriend: friendship !== null, sharesCommunity };
}

const senderOf = (user: User): Sender => ({ id: user.id, username: user.username, domain: user.homeserverDomain, isRemote: user.isRemote });

/** Whether `recipient` (a person on this server) accepts a friend request or conversation from `sender`, a person we have a row for. */
export async function canContact(recipient: User, sender: User): Promise<boolean> {
  if (recipient.id === sender.id) return true;
  return contactAllowedUnderLimit(recipient.contactPolicy, config.contactPolicyLimit, await contactFacts(recipient, senderOf(sender)));
}

/**
 * The same question for someone named only by where they are: another server asking "may this person write to yours?" before it
 * lets them try. A sender this server has no row for is not a friend and shares no community with anyone we hold a row for, but may
 * still be in one hosted elsewhere, which is asked about.
 */
export async function canContactIdentity(recipient: User, senderDomain: string, senderUsername: string): Promise<boolean> {
  const local = senderDomain.toLowerCase() === config.domain.toLowerCase();
  const row = local
    ? await findLocalUserByUsername(senderUsername)
    : await prisma.user.findFirst({
        where: { username: senderUsername, isRemote: true, homeserverDomain: { equals: senderDomain, mode: "insensitive" } },
      });
  if (row) return canContact(recipient, row);
  return contactAllowedUnderLimit(
    recipient.contactPolicy,
    config.contactPolicyLimit,
    await contactFacts(recipient, { id: null, username: senderUsername, domain: senderDomain, isRemote: !local })
  );
}
