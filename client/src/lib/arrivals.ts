import type { Message } from "../api";

/**
 * The messages of a freshly loaded page of history plus the ones that arrived live while it was loading.
 *
 * A live `message:created` can land between the server answering the history request and the page showing the answer; the
 * answer then replaces the list and the live message is gone until a reload, though the server has it. Whatever the history
 * already holds wins (it is the server's copy, edits included); the rest are appended in the order they arrived.
 */
export function withArrivals(page: Message[], arrived: Message[]): Message[] {
  if (arrived.length === 0) return page;
  const loaded = new Set(page.map((m) => m.id));
  return [...page, ...arrived.filter((m) => !loaded.has(m.id))];
}
