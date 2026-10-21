import { config } from "../../config.js";
import { prisma } from "../../db.js";
import { LiveKitBackend, type VoiceBackend } from "../../lib/voiceBackend.js";
import { sendToUsers } from "../../ws/gateway.js";

/**
 * How long, and how often, the server looks again for a person who has joined but whose connection is not up yet. LiveKit does
 * not announce a connection coming up, and a person is listed only once it has. Mutable so a test can make it quick.
 */
export const voiceTiming = { pollMs: 1000, giveUpMs: 30_000 };

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
  if (!channel) return broadcastCallState(roomName);
  // Not a room of ours (or a text channel's name, or a community cached from another server): nothing to say.
  if (channel.type !== "VOICE" || channel.community.isRemote) return false;
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
 * The same for a call in a direct or group conversation (its room is named by the conversation's protocolId): the members are
 * told who is in it, and a member who is not in it sees that someone is calling. Only a conversation whose members are all on
 * this server has a room here.
 */
async function broadcastCallState(roomName: string): Promise<boolean> {
  const conversation = await prisma.conversation.findUnique({ where: { protocolId: roomName }, include: { members: { include: { user: true } } } });
  if (!conversation || conversation.members.some((m) => m.user.isRemote)) return false;
  const participants = (await voiceStateOf([conversation.protocolId]))[conversation.protocolId];
  if (participants === null) return false;
  sendToUsers(
    conversation.members.map((m) => m.userId),
    { type: "voice:participants", conversationId: conversation.protocolId, participants }
  );
  return true;
}

/** True when every member of the conversation has an account on this server, which is what a call in it needs. */
export async function isCallable(conversationId: string): Promise<boolean> {
  return (await prisma.conversationMember.count({ where: { conversationId, user: { isRemote: true } } })) === 0;
}

/**
 * Who is in a call right now, for each of a person's conversations that has one (by the conversation's protocolId). `null` when
 * LiveKit could not be asked, which is not the same as "no calls".
 */
export async function activeCallsOf(userId: string): Promise<Record<string, string[]> | null> {
  const backend = getVoiceBackend();
  if (!backend) return null;
  const conversations = await prisma.conversation.findMany({
    where: { members: { some: { userId } }, NOT: { members: { some: { user: { isRemote: true } } } } },
    select: { protocolId: true },
  });
  try {
    const live = await backend.listRooms(conversations.map((c) => c.protocolId));
    const state = await voiceStateOf(live);
    const calls: Record<string, string[]> = {};
    for (const [room, people] of Object.entries(state)) if (people && people.length > 0) calls[room] = people;
    return calls;
  } catch (err) {
    logFailure("listing the calls", err);
    return null;
  }
}

/** Takes a person out of a conversation's call: they left the conversation, and the call would otherwise go on. Best effort. */
export async function disconnectFromCall(conversationProtocolId: string, userProtocolId: string): Promise<void> {
  const backend = getVoiceBackend();
  if (!backend) return;
  try {
    await backend.removeParticipant(conversationProtocolId, userProtocolId);
  } catch (err) {
    logFailure("removing a person from a call", err);
  }
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

const watching = new Map<string, ReturnType<typeof setTimeout>>();
const watchKey = (room: string, identity: string) => `${room}:${identity}`;

/** Stops looking for this person (they left, their connection was given up on, or they are listed now). */
export function stopWatching(room: string, identity: string): void {
  const key = watchKey(room, identity);
  const timer = watching.get(key);
  if (timer) clearTimeout(timer);
  watching.delete(key);
}

/** Stops every look (tests, so one test's waiting does not run into the next). */
export function stopAllWatching(): void {
  for (const timer of watching.values()) clearTimeout(timer);
  watching.clear();
}

/**
 * A person who joined is not listed until their connection is up, and LiveKit does not say when it is, so look again, once a
 * second, until they appear in the room's list (then tell everyone) or the time is up (a connection that did not come up, say
 * because the audio ports are blocked: they are never shown, which is the truth). Publishing audio also lists them at once, through
 * the webhook for it, and a person who leaves or whose connection is abandoned stops the looking.
 */
export function watchUntilActive(room: string, identity: string): void {
  stopWatching(room, identity);
  const key = watchKey(room, identity);
  const deadline = Date.now() + voiceTiming.giveUpMs;
  const look = async () => {
    watching.delete(key);
    try {
      const listed = (await voiceStateOf([room]))[room];
      if (listed?.includes(identity)) {
        await broadcastVoiceState(room);
        return;
      }
    } catch (err) {
      logFailure("looking for a person to connect", err);
    }
    if (Date.now() < deadline) watching.set(key, setTimeout(() => void look(), voiceTiming.pollMs).unref());
  };
  watching.set(key, setTimeout(() => void look(), voiceTiming.pollMs).unref());
}
