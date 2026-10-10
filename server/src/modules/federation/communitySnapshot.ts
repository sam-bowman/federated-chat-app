import { prisma } from "../../db.js";
import { ensureRemoteUser } from "./remoteUsers.js";

export interface CommunitySnapshotMember {
  protocolId: string;
  username: string;
  domain: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface CommunitySnapshotChannel {
  protocolId: string;
  name: string;
  topic: string | null;
  position: number;
  type: "TEXT";
}

export interface CommunitySnapshot {
  protocolId: string;
  name: string;
  description: string | null;
  iconUrl: string | null;
  owner: CommunitySnapshotMember;
  channels: CommunitySnapshotChannel[];
}

/**
 * Builds the wire shape returned by GET /federation/v1/communities/{id} -
 * used both when a remote member first joins and when their server
 * refetches after an "updated" resync ping. Only ever called by the home
 * server (the one actually authoritative for this data) - see
 * federation/routes.ts.
 */
export async function buildCommunitySnapshot(communityId: string): Promise<CommunitySnapshot> {
  const community = await prisma.community.findUniqueOrThrow({
    where: { id: communityId },
    include: { owner: true, channels: { orderBy: { position: "asc" } } },
  });
  return {
    protocolId: community.protocolId,
    name: community.name,
    description: community.description,
    iconUrl: community.iconUrl,
    owner: {
      protocolId: community.owner.protocolId,
      username: community.owner.username,
      domain: community.owner.homeserverDomain,
      displayName: community.owner.displayName,
      avatarUrl: community.owner.avatarUrl,
    },
    channels: community.channels.map((c) => ({
      protocolId: c.protocolId,
      name: c.name,
      topic: c.topic,
      position: c.position,
      type: c.type,
    })),
  };
}

/**
 * Upserts a local cache of a REMOTE community from a snapshot - the owner
 * as a remote-stub User, the Community row itself (isRemote: true), and
 * Channel stub rows (metadata only, no messages - history isn't
 * backfilled, same choice DM federation made for a freshly-created
 * conversation). Drops any locally-cached channel no longer present in the
 * snapshot, so the cache doesn't accumulate channels deleted on the home
 * server.
 *
 * Known limitation: this tracks our own cached copy only, not a full
 * per-member roster - if more than one of our local users independently
 * joins the same remote community, a kick/ban removing only one of them
 * isn't individually detected (an "updated" ping's resync only drops the
 * whole local cache once NO local user on our domain remains a member, per
 * GET /federation/v1/communities/{id}'s own membership gate).
 */
export async function applyCommunitySnapshot(snapshot: CommunitySnapshot, domain: string) {
  const owner = await ensureRemoteUser({
    protocolId: snapshot.owner.protocolId,
    username: snapshot.owner.username,
    domain: snapshot.owner.domain,
    displayName: snapshot.owner.displayName,
    avatarUrl: snapshot.owner.avatarUrl,
  });

  const community = await prisma.community.upsert({
    where: { protocolId: snapshot.protocolId },
    create: {
      protocolId: snapshot.protocolId,
      name: snapshot.name,
      description: snapshot.description,
      iconUrl: snapshot.iconUrl,
      ownerId: owner.id,
      homeserverDomain: domain,
      isRemote: true,
    },
    update: {
      name: snapshot.name,
      description: snapshot.description,
      iconUrl: snapshot.iconUrl,
      ownerId: owner.id,
    },
  });

  for (const ch of snapshot.channels) {
    await prisma.channel.upsert({
      where: { protocolId: ch.protocolId },
      create: {
        protocolId: ch.protocolId,
        communityId: community.id,
        name: ch.name,
        topic: ch.topic,
        position: ch.position,
        type: ch.type,
      },
      update: { name: ch.name, topic: ch.topic, position: ch.position, type: ch.type },
    });
  }
  await prisma.channel.deleteMany({
    where: { communityId: community.id, protocolId: { notIn: snapshot.channels.map((c) => c.protocolId) } },
  });

  return community;
}
