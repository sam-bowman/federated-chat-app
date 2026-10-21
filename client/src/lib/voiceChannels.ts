import type { Community, CommunityVoice, PublicUser } from "../api/types";

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

/** A person in a call, who may not be in the cached member list yet (they joined the community after it was loaded: #220). */
export type VoicePerson = PublicUser & { unknown?: boolean };

/** Stands in for a person in a call whose details this device does not have (yet), so they are shown rather than left out. */
export function unknownPerson(id: string): VoicePerson {
  return {
    id,
    identity: id,
    username: "",
    displayName: "Someone",
    avatarUrl: null,
    bio: null,
    presence: { status: "OFFLINE", customStatus: null, lastSeenAt: null },
    unknown: true,
  };
}

/** The people in a call, in the order the server gave them: a stand-in for anyone not (yet) in `members`. */
export function peopleInCall(ids: readonly string[], members: ReadonlyMap<string, PublicUser>): VoicePerson[] {
  return ids.map((id) => members.get(id) ?? unknownPerson(id));
}

/**
 * The people in the voice channels of these communities that the community's cached member list does not have, as one sorted
 * text (so it can be compared). Empty when everyone is known.
 */
export function unknownVoiceMembers(people: VoicePeople, communities: readonly Pick<Community, "channels" | "members">[]): string {
  const unknown = new Set<string>();
  for (const community of communities) {
    const known = new Set(community.members.map((m) => m.id));
    for (const channel of community.channels) {
      if (channel.type !== "VOICE") continue;
      for (const id of people[channel.id] ?? []) if (!known.has(id)) unknown.add(id);
    }
  }
  return [...unknown].sort().join(",");
}
