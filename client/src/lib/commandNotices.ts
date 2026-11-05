// What a person is shown after running a slash command, until the answer arrives (#132, phase 3b): the bot has been sent the command ("waiting"), said it
// is thinking ("thinking"), did not answer in time ("failed"), or answered in a way only they can see ("private"). A public answer is an ordinary message in
// the channel, and clears the notice. All of this lives in the page and is gone when the channel is left or the page reloaded; none of it is stored.
// Pure, so it is unit tested; the timers that move a notice to "failed" are in useCommandNotices.

/** The server holds a bot's first answer to 5 seconds. Waiting a little longer than that, counted from when the answer to the run arrived (which is after the server started counting), means "didn't respond" is only said once it is true. */
export const DIDNT_RESPOND_MS = 5500;
/** A deferred interaction may be finished within 15 minutes of being run. */
export const THINKING_MS = 15 * 60 * 1000;

export interface NoticeBase {
  interactionId: string;
  channelId: string;
  botName: string;
  commandName: string;
}

export type Notice =
  | (NoticeBase & { kind: "waiting" | "thinking" | "failed" })
  | (NoticeBase & { kind: "private"; content: string; richEmbeds: unknown });

export type NoticeAction =
  | { type: "sent"; notice: NoticeBase }
  | { type: "deferred"; interactionId: string }
  | { type: "response"; notice: NoticeBase; content: string; richEmbeds: unknown }
  | { type: "answered"; interactionId: string }
  | { type: "giveUp"; interactionId: string }
  | { type: "dismiss"; interactionId: string }
  | { type: "leave"; channelId: string };

export function noticesReducer(state: Notice[], action: NoticeAction): Notice[] {
  switch (action.type) {
    case "sent":
      return state.some((n) => n.interactionId === action.notice.interactionId) ? state : [...state, { ...action.notice, kind: "waiting" }];
    case "deferred":
      // Only a notice that is still waiting: a private reply or a failure that got here first stays as it is.
      return state.map((n) => (n.interactionId === action.interactionId && n.kind === "waiting" ? { ...n, kind: "thinking" } : n));
    case "response": {
      const replacement: Notice = { ...action.notice, kind: "private", content: action.content, richEmbeds: action.richEmbeds };
      return state.some((n) => n.interactionId === action.notice.interactionId)
        ? state.map((n) => (n.interactionId === action.notice.interactionId ? replacement : n))
        : [...state, replacement];
    }
    case "answered":
      return state.filter((n) => n.interactionId !== action.interactionId);
    case "giveUp":
      return state.map((n) => (n.interactionId === action.interactionId && (n.kind === "waiting" || n.kind === "thinking") ? { ...n, kind: "failed" } : n));
    case "dismiss":
      return state.filter((n) => n.interactionId !== action.interactionId);
    case "leave":
      return state.filter((n) => n.channelId === action.channelId);
  }
}

/** The words for a notice that is not a private reply. */
export function noticeText(notice: Notice): string {
  switch (notice.kind) {
    case "waiting":
      return `Waiting for ${notice.botName}…`;
    case "thinking":
      return `${notice.botName} is thinking…`;
    case "failed":
      return `${notice.botName} didn't respond to /${notice.commandName}.`;
    case "private":
      return `Only you can see this · ${notice.botName} · /${notice.commandName}`;
  }
}
