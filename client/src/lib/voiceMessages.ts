// What a person is told when a call cannot start, cannot use the microphone, or ends. Plain words, never an error code.

/** A DisconnectReason from the voice server (livekit's own numbering). */
export const DISCONNECT = {
  CLIENT_INITIATED: 1,
  DUPLICATE_IDENTITY: 2,
  SERVER_SHUTDOWN: 3,
  PARTICIPANT_REMOVED: 4,
  ROOM_DELETED: 5,
} as const;

const code = (err: unknown): string | undefined => {
  const body = (err as { body?: unknown } | null)?.body as { error?: unknown } | null | undefined;
  return typeof body?.error === "string" ? body.error : undefined;
};

/** Why asking to join a voice channel failed. */
export function joinFailureMessage(err: unknown): string {
  switch (code(err)) {
    case "forbidden":
      return "You don't have permission to join voice channels here.";
    case "voice_not_enabled":
      return "Voice isn't set up on this server.";
    case "voice_not_available_for_remote_community":
      return "Voice channels can't be joined from another server yet.";
    case "not_found":
    case "not_a_voice_channel":
      return "That voice channel isn't there any more.";
    default:
      return "Couldn't join the voice channel. Try again.";
  }
}

/** Why the microphone could not be used. The call still works: the person can listen. */
export function microphoneMessage(err: unknown): string {
  const name = (err as { name?: unknown } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") {
    return "Your microphone is blocked, so you can listen but others can't hear you. Allow the microphone for this site (or app) to talk.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") {
    return "No microphone was found, so you can listen but others can't hear you.";
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return "Your microphone is in use by something else, so others can't hear you.";
  }
  return "The microphone couldn't be used, so others can't hear you.";
}

/** Why a call ended, or null when the person ended it themselves. */
export function callEndedMessage(reason: number | undefined): string | null {
  switch (reason) {
    case DISCONNECT.CLIENT_INITIATED:
      return null;
    case DISCONNECT.PARTICIPANT_REMOVED:
      return "You were removed from the call.";
    case DISCONNECT.ROOM_DELETED:
      return "This voice channel was deleted.";
    case DISCONNECT.DUPLICATE_IDENTITY:
      return "You joined this call from somewhere else, so it ended here.";
    default:
      return "The call was disconnected.";
  }
}
