import type { CommunityVoice } from "../api/types";

/** Who is in each voice channel, by the channel's id (people's ids, the same as `PublicUser.id`). */
export type VoicePeople = Readonly<Record<string, readonly string[]>>;

/**
 * What the list for a community says, folded into what was known. A list that says it cannot be trusted
 * (`available: false`) changes nothing: it is "I do not know", not "nobody is there", and showing every channel empty because
 * the voice server blinked would be wrong. A channel the answer leaves out keeps what it had for the same reason.
 */
export function mergeCommunityVoice(prev: VoicePeople, answer: CommunityVoice): VoicePeople {
  if (!answer.available) return prev;
  return { ...prev, ...answer.channels };
}

/** The same, for one channel, from the `voice:participants` event: always the whole list, so it replaces what was there. */
export function setChannelPeople(prev: VoicePeople, channelId: string, people: readonly string[]): VoicePeople {
  const known = prev[channelId];
  if (known && known.length === people.length && known.every((id, i) => id === people[i])) return prev;
  return { ...prev, [channelId]: people };
}
