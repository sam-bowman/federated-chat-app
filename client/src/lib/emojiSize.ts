// How big emoji and custom emoticons are drawn in messages (#285): "large" (the default) or "normal", which is what they were before.
// Kept on this device, like the UI scale. The sizes themselves are CSS custom properties in index.css; this only sets
// `data-emoji-size` on <html>, and only for "normal": the default needs no attribute, so a first paint is already right for most people.
import { useSyncExternalStore } from "react";

export type EmojiSize = "large" | "normal";

export const EMOJI_SIZE_KEY = "chat.emojiSize";
export const DEFAULT_EMOJI_SIZE: EmojiSize = "large";

export function parseEmojiSize(raw: unknown): EmojiSize {
  return raw === "normal" ? "normal" : DEFAULT_EMOJI_SIZE;
}

function load(): EmojiSize {
  try {
    return parseEmojiSize(window.localStorage.getItem(EMOJI_SIZE_KEY));
  } catch {
    return DEFAULT_EMOJI_SIZE;
  }
}

export function applyEmojiSize(size: EmojiSize): void {
  const root = document.documentElement;
  if (size === "normal") root.dataset.emojiSize = "normal";
  else delete root.dataset.emojiSize;
}

let current: EmojiSize = DEFAULT_EMOJI_SIZE;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getEmojiSize(): EmojiSize {
  return current;
}

export function setEmojiSize(size: EmojiSize): void {
  current = size;
  try {
    // The default is stored as "no choice", so a later change of the default reaches everyone who never chose.
    if (size === DEFAULT_EMOJI_SIZE) window.localStorage.removeItem(EMOJI_SIZE_KEY);
    else window.localStorage.setItem(EMOJI_SIZE_KEY, size);
  } catch {
    /* storage is blocked: the choice lasts until the page is closed */
  }
  applyEmojiSize(size);
  listeners.forEach((listener) => listener());
}

export function useEmojiSize(): [EmojiSize, (size: EmojiSize) => void] {
  return [useSyncExternalStore(subscribe, getEmojiSize), setEmojiSize];
}

/** Applies the stored choice at startup and follows a change made in another tab or window. */
export function startEmojiSize(): void {
  current = load();
  applyEmojiSize(current);
  window.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== EMOJI_SIZE_KEY) return;
    current = load();
    applyEmojiSize(current);
    listeners.forEach((listener) => listener());
  });
}
