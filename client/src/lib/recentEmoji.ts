// The emoji this device picked most recently, shown first in the picker. Plain localStorage, and
// every read tolerates a missing, corrupt or hand-edited value (it is a convenience, never an error).
export const RECENT_EMOJI_KEY = "chat.recentEmoji";
export const MAX_RECENT_EMOJI = 24;

export function getRecentEmoji(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_EMOJI_KEY) ?? "null");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string" && v.length > 0 && v.length <= 32).slice(0, MAX_RECENT_EMOJI);
  } catch {
    return [];
  }
}

/** Puts `emoji` first, drops any earlier copy, and keeps the list to MAX_RECENT_EMOJI. */
export function rememberEmoji(emoji: string) {
  try {
    const next = [emoji, ...getRecentEmoji().filter((e) => e !== emoji)].slice(0, MAX_RECENT_EMOJI);
    localStorage.setItem(RECENT_EMOJI_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
}
