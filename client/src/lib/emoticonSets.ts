import type { Emoticon } from "../api";

/** What GET /emoticons returns: the three places a person's usable emoticons come from. */
export interface EmoticonSets {
  personal: Emoticon[];
  saved: Emoticon[];
  community: Emoticon[];
}

export const NO_EMOTICONS: EmoticonSets = { personal: [], saved: [], community: [] };

/**
 * Keeps only the emoticons that will actually render when the person uses them. A message's `:trigger:`
 * resolves through the sender's set, where a community's emoticon wins over a saved one, which wins over
 * a personal one (`getAccessibleEmoticons` on the server adds them in that order, later replacing
 * earlier), so a trigger that three emoticons share shows only the last. Offering the shadowed ones would
 * insert text that sends as somebody else's image, or as plain `:text:`.
 */
export function renderableSets(sets: EmoticonSets): EmoticonSets {
  const winner = new Map<string, Emoticon>();
  for (const list of [sets.personal, sets.saved, sets.community]) for (const e of list) winner.set(e.trigger, e);
  const keep = (list: Emoticon[]) => list.filter((e) => winner.get(e.trigger) === e);
  return { personal: keep(sets.personal), saved: keep(sets.saved), community: keep(sets.community) };
}

export function allEmoticons(sets: EmoticonSets): Emoticon[] {
  return [...sets.personal, ...sets.saved, ...sets.community];
}

export function hasEmoticons(sets: EmoticonSets): boolean {
  return sets.personal.length + sets.saved.length + sets.community.length > 0;
}

/** The text between the colons: ":party:" -> "party". */
const bare = (trigger: string) => trigger.replace(/^:|:$/g, "");

/**
 * Emoticons whose trigger or name matches every word of `query`, best first: a trigger that starts
 * with it, then one that contains it, then a match in the name only.
 */
export function searchEmoticons(list: Emoticon[], query: string): Emoticon[] {
  const words = query.toLowerCase().replace(/:/g, " ").split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const full = words.join(" ");
  const scored: { emoticon: Emoticon; score: number }[] = [];
  for (const emoticon of list) {
    const trigger = bare(emoticon.trigger).toLowerCase();
    const name = emoticon.name.toLowerCase();
    if (!words.every((w) => trigger.includes(w) || name.includes(w))) continue;
    scored.push({ emoticon, score: trigger.startsWith(full) ? 0 : trigger.includes(full) ? 1 : 2 });
  }
  return scored.sort((a, b) => a.score - b.score).map((s) => s.emoticon);
}
