import { useCallback, useEffect, useReducer, useRef } from "react";
import type { Message, PublicUser } from "../api";
import { useWs } from "../context/WsContext";
import { DIDNT_RESPOND_MS, THINKING_MS, noticesReducer, type Notice, type NoticeBase } from "./commandNotices";

/**
 * What the person sees after running a slash command until it is answered (lib/commandNotices.ts), for the channel being looked at: the live events that
 * move a notice (`interaction:update` "thinking", `interaction:response` a private reply, an ordinary `message:created` that answers it) and the timers
 * that turn a silence into "didn't respond". Nothing is stored; leaving the channel drops the other channels' notices.
 */
export function useCommandNotices(channelId: string | undefined) {
  const { subscribe } = useWs();
  const [all, dispatch] = useReducer(noticesReducer, [] as Notice[]);

  useEffect(() => {
    if (channelId) dispatch({ type: "leave", channelId });
  }, [channelId]);

  useEffect(() => {
    const unsubs = [
      subscribe("interaction:update", (payload: { interactionId: string; state?: string }) => {
        if (payload.state === "deferred") dispatch({ type: "deferred", interactionId: payload.interactionId });
      }),
      subscribe("interaction:response", (payload: { interactionId: string; channelId: string; commandName: string; bot: Pick<PublicUser, "displayName">; content: string; richEmbeds?: unknown }) => {
        dispatch({
          type: "response",
          notice: { interactionId: payload.interactionId, channelId: payload.channelId, botName: payload.bot.displayName, commandName: payload.commandName },
          content: payload.content,
          richEmbeds: payload.richEmbeds ?? [],
        });
      }),
      // A public answer is an ordinary message that says which command it answers.
      subscribe("message:created", (payload: { message: Message }) => {
        const id = payload.message?.interaction?.id;
        if (id) dispatch({ type: "answered", interactionId: id });
      }),
    ];
    return () => unsubs.forEach((u) => u());
  }, [subscribe]);

  // One timer for each notice that is waiting or thinking: when it runs out without an answer, the notice says so.
  const timers = useRef(new Map<string, { kind: string; handle: ReturnType<typeof setTimeout> }>());
  useEffect(() => {
    const live = new Set<string>();
    for (const notice of all) {
      if (notice.kind !== "waiting" && notice.kind !== "thinking") continue;
      live.add(notice.interactionId);
      const existing = timers.current.get(notice.interactionId);
      if (existing?.kind === notice.kind) continue;
      if (existing) clearTimeout(existing.handle);
      const handle = setTimeout(() => dispatch({ type: "giveUp", interactionId: notice.interactionId }), notice.kind === "waiting" ? DIDNT_RESPOND_MS : THINKING_MS);
      timers.current.set(notice.interactionId, { kind: notice.kind, handle });
    }
    for (const [id, timer] of timers.current) {
      if (!live.has(id)) {
        clearTimeout(timer.handle);
        timers.current.delete(id);
      }
    }
  }, [all]);
  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const timer of map.values()) clearTimeout(timer.handle);
      map.clear();
    };
  }, []);

  const add = useCallback((notice: NoticeBase) => dispatch({ type: "sent", notice }), []);
  const dismiss = useCallback((interactionId: string) => dispatch({ type: "dismiss", interactionId }), []);
  return { notices: all.filter((n) => n.channelId === channelId), add, dismiss };
}
