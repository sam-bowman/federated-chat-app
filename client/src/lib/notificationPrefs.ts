import type { NotificationSetting, NotificationTargetType } from "../api";

// What a person wants to hear (a sound) and see (a system notification) when a message arrives. Each is chosen separately, for
// everything and for one community, channel or conversation. The MOST SPECIFIC choice wins, and where none was made the next
// level up decides, and with nothing chosen anywhere both are on.

export type Kind = "sound" | "notify";

/** Where a message is: a conversation (a DM or a group), or a channel (which belongs to a community, when that is known). */
export type Place = { conversationId: string } | { channelId: string; communityId?: string | null };

/** Everything the person has chosen, by place. */
export interface PrefsIndex {
  global: Pick<NotificationSetting, "sound" | "notify">;
  communities: Map<string, Pick<NotificationSetting, "sound" | "notify">>;
  channels: Map<string, Pick<NotificationSetting, "sound" | "notify">>;
  conversations: Map<string, Pick<NotificationSetting, "sound" | "notify">>;
}

export const NO_CHOICE = { sound: null, notify: null } as const;

export function emptyPrefs(): PrefsIndex {
  return { global: { ...NO_CHOICE }, communities: new Map(), channels: new Map(), conversations: new Map() };
}

/** Indexes what the server sent. Anything that is not a well-formed setting is ignored. */
export function indexPrefs(settings: NotificationSetting[]): PrefsIndex {
  const prefs = emptyPrefs();
  for (const setting of settings) {
    const choice = { sound: setting.sound ?? null, notify: setting.notify ?? null };
    if (setting.type === "GLOBAL") prefs.global = choice;
    else if (setting.id) mapFor(prefs, setting.type)?.set(setting.id, choice);
  }
  return prefs;
}

function mapFor(prefs: PrefsIndex, type: NotificationTargetType) {
  return type === "COMMUNITY" ? prefs.communities : type === "CHANNEL" ? prefs.channels : type === "CONVERSATION" ? prefs.conversations : null;
}

/** Puts one setting (as the server returns it) into the index, replacing what was there; no choice left removes it. */
export function withSetting(prefs: PrefsIndex, setting: NotificationSetting): PrefsIndex {
  const next: PrefsIndex = {
    global: prefs.global,
    communities: new Map(prefs.communities),
    channels: new Map(prefs.channels),
    conversations: new Map(prefs.conversations),
  };
  const choice = { sound: setting.sound ?? null, notify: setting.notify ?? null };
  if (setting.type === "GLOBAL") {
    next.global = choice;
  } else if (setting.id) {
    const map = mapFor(next, setting.type)!;
    if (choice.sound === null && choice.notify === null) map.delete(setting.id);
    else map.set(setting.id, choice);
  }
  return next;
}

/** The levels that can decide for a place, most specific first. */
function levels(prefs: PrefsIndex, place: Place): (Pick<NotificationSetting, "sound" | "notify"> | undefined)[] {
  if ("conversationId" in place) return [prefs.conversations.get(place.conversationId), prefs.global];
  return [prefs.channels.get(place.channelId), place.communityId ? prefs.communities.get(place.communityId) : undefined, prefs.global];
}

/** Whether to alert for a message at `place`, in the way `kind` says: the most specific choice made, else on. */
export function isEnabled(prefs: PrefsIndex, kind: Kind, place: Place): boolean {
  for (const level of levels(prefs, place)) {
    const choice = level?.[kind];
    if (choice !== null && choice !== undefined) return choice;
  }
  return true;
}

/** Whether this place has a choice of its own for `kind` (as opposed to following the level above). */
export function ownChoice(prefs: PrefsIndex, kind: Kind, target: { type: Exclude<NotificationTargetType, "GLOBAL">; id: string }): boolean | null {
  const map = target.type === "COMMUNITY" ? prefs.communities : target.type === "CHANNEL" ? prefs.channels : prefs.conversations;
  return map.get(target.id)?.[kind] ?? null;
}

/** What a change to one place leaves in the index, before the server has answered: the choices named replace the old ones. */
export function withChange(
  prefs: PrefsIndex,
  change: { type: NotificationTargetType; id?: string; sound?: boolean | null; notify?: boolean | null }
): PrefsIndex {
  const current =
    change.type === "GLOBAL" ? prefs.global : (mapFor(prefs, change.type)?.get(change.id ?? "") ?? { ...NO_CHOICE });
  return withSetting(prefs, {
    type: change.type,
    id: change.type === "GLOBAL" ? null : (change.id ?? null),
    sound: change.sound === undefined ? current.sound : change.sound,
    notify: change.notify === undefined ? current.notify : change.notify,
  });
}
