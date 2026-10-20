import { config } from "../../config.js";
import { prisma } from "../../db.js";
import { LiveKitBackend, type VoiceBackend } from "../../lib/voiceBackend.js";
import { sendToUsers } from "../../ws/gateway.js";

let override: VoiceBackend | null | undefined;
let cached: { key: string; backend: VoiceBackend } | null = null;

/** Tests stand in a fake LiveKit with this (null: voice configured but unreachable is not modelled, use `undefined` to go back to the real one). */
export function setVoiceBackendForTests(backend: VoiceBackend | null | undefined): void {
  override = backend;
}

/** The LiveKit server to ask, or null when voice is off. */
export function getVoiceBackend(): VoiceBackend | null {
  if (override !== undefined) return config.voice.enabled ? override : null;
  const voice = config.voice;
  if (!voice.enabled) return null;
  const key = `${voice.internalUrl}|${voice.apiKey}|${voice.apiSecret}`;
  if (!cached || cached.key !== key) cached = { key, backend: new LiveKitBackend(voice) };
  return cached.backend;
}

/** What goes wrong talking to LiveKit never fails a request: the room is just not told or not tidied this time. */
function logFailure(what: string, err: unknown): void {
  console.error("[voice] %s failed:", what, err);
}

/** The people (local accounts of this server) who should hear about a community's voice channels. */
export async function localMemberIds(communityId: string): Promise<string[]> {
  const members = await prisma.communityMember.findMany({ where: { communityId, user: { isRemote: false } }, select: { userId: true } });
  return members.map((m) => m.userId);
}

/**
 * Who is in each of a community's voice channels now, by asking LiveKit (the truth: this server keeps no copy to go stale).
 * `null` for a channel whose room could not be read, so a caller can tell "empty" from "do not know".
 */
export async function voiceStateOf(channelProtocolIds: string[]): Promise<Record<string, string[] | null>> {
  const backend = getVoiceBackend();
  const out: Record<string, string[] | null> = {};
  await Promise.all(
    channelProtocolIds.map(async (id) => {
      try {
        out[id] = backend ? await backend.listParticipants(id) : null;
      } catch (err) {
        logFailure("listing a room", err);
        out[id] = null;
      }
    })
  );
  return out;
}

/**
 * Tells the community's members who is in a voice channel now. Called when LiveKit says someone joined or left. It sends
 * the whole list rather than "X joined", so a missed or reordered webhook cannot leave anyone's list wrong for long.
 * Nothing is stored: a client that connects later asks `GET /communities/:id/voice`.
 */
export async function broadcastVoiceState(roomName: string): Promise<boolean> {
  const channel = await prisma.channel.findUnique({ where: { protocolId: roomName }, include: { community: true } });
  // Not a room of ours (or a text channel's name, or a community cached from another server): nothing to say.
  if (!channel || channel.type !== "VOICE" || channel.community.isRemote) return false;
  const participants = (await voiceStateOf([channel.protocolId]))[channel.protocolId];
  if (participants === null) return false;
  sendToUsers(await localMemberIds(channel.communityId), {
    type: "voice:participants",
    communityId: channel.community.protocolId,
    channelId: channel.protocolId,
    participants,
  });
  return true;
}

/**
 * Takes a person out of every voice channel of a community: they were removed from it (kicked, banned, or left), and a
 * call already in progress would otherwise go on. Best effort, and the community's text side never waits on it failing.
 */
export async function disconnectFromVoice(communityId: string, userProtocolId: string): Promise<void> {
  const backend = getVoiceBackend();
  if (!backend) return;
  try {
    const channels = await prisma.channel.findMany({ where: { communityId, type: "VOICE" }, select: { protocolId: true } });
    // Every room is tried, whatever happens to the others.
    const results = await Promise.allSettled(channels.map((c) => backend.removeParticipant(c.protocolId, userProtocolId)));
    for (const result of results) if (result.status === "rejected") logFailure("removing a person from a room", result.reason);
  } catch (err) {
    logFailure("finding a community's voice channels", err);
  }
}

/** Closes the rooms of voice channels that were deleted (or of a deleted community), sending anyone in them out. */
export async function closeVoiceRooms(channelProtocolIds: string[]): Promise<void> {
  const backend = getVoiceBackend();
  if (!backend) return;
  await Promise.all(
    channelProtocolIds.map(async (id) => {
      try {
        await backend.deleteRoom(id);
      } catch (err) {
        logFailure("closing a room", err);
      }
    })
  );
}

/** The protocolIds of a community's voice channels, gathered before they are deleted along with it. */
export async function voiceChannelIdsOf(communityId: string): Promise<string[]> {
  const channels = await prisma.channel.findMany({ where: { communityId, type: "VOICE" }, select: { protocolId: true } });
  return channels.map((c) => c.protocolId);
}
