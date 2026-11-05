import { cleanLine } from "./linkPreview/embed.js";

// Who ran which slash command a bot's message answers (#132, phase 3b): kept on the message as a small snapshot, with the name as it was at that
// moment, so reading the message needs no join and a rename later does not rewrite history. It is only ever shown on the server that holds the
// community (other servers are not told), and it is removed from every message when the person's account is erased.
// Kept free of config.ts imports so it can be unit-tested on its own.

/** What is stored on `Message.interaction`. */
export interface StoredInteraction {
  /** The interaction's own id, so the client can tell which request this answers. */
  id: string;
  command: string;
  /** The protocol id of the person who ran it. */
  userId: string;
  /** What they were called then. */
  name: string;
}

/** What a message shows: the command, and who ran it. */
export interface InteractionRef {
  id: string;
  command: string;
  user: { id: string; name: string };
}

const COMMAND_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The value to store for a command run by this person. */
export function interactionSnapshot(input: { id: string; command: string; userId: string; name: string }): StoredInteraction {
  return { id: input.id, command: input.command, userId: input.userId, name: cleanLine(input.name, 64) ?? "Someone" };
}

/** Whatever was stored as the reference it is allowed to be, or null (not an object, a bad name or id). Never throws. */
export function parseInteractionRef(value: unknown): InteractionRef | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const { id, command, userId } = record;
  if (typeof id !== "string" || !ID.test(id)) return null;
  if (typeof command !== "string" || !COMMAND_NAME.test(command)) return null;
  if (typeof userId !== "string" || !ID.test(userId)) return null;
  const name = cleanLine(record.name, 64);
  if (name === null) return null;
  return { id, command, user: { id: userId, name } };
}
