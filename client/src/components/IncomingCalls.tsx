import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useNotificationSettings } from "../context/NotificationSettingsContext";
import { useVoice } from "../context/VoiceContext";
import { isAppFocused } from "../lib/activeChat";
import { playRingTone, RING_EVERY_MS } from "../lib/notificationSound";
import { showSystemNotification } from "../lib/systemNotification";
import { conversationName, decideRing } from "../lib/voiceCalls";
import Button from "./Button";

/** A call that nobody answers stops ringing after this long (its banner stays until it ends or is put away). */
const RING_FOR_MS = 60_000;

/**
 * Somebody has started a call in one of your conversations and you are not in it: a banner to join it or put it away, and, for a call
 * that has only just started, a ring and a system notification (unless you are on Do not disturb or have turned that conversation's
 * sound or notifications off). Rendered once, over everything.
 */
export default function IncomingCalls() {
  const voice = useVoice();
  const { user } = useAuth();
  const { prefs } = useNotificationSettings();
  const navigate = useNavigate();
  const status = user?.presence?.status;

  const ringsFor = voice.incoming.filter((c) => voice.ringing.has(c.conversation.id));
  const soundIds = ringsFor.filter((c) => decideRing(status, prefs, c.conversation.id).sound).map((c) => c.conversation.id).join(",");
  const notifyIds = ringsFor.filter((c) => decideRing(status, prefs, c.conversation.id).notify).map((c) => c.conversation.id);
  const notifyKey = notifyIds.join(",");

  // The ring: once now, then again until it is answered, put away, ended, or has gone on for a minute.
  useEffect(() => {
    if (!soundIds) return;
    void playRingTone();
    const every = setInterval(() => void playRingTone(), RING_EVERY_MS);
    const stop = setTimeout(() => clearInterval(every), RING_FOR_MS);
    return () => {
      clearInterval(every);
      clearTimeout(stop);
    };
  }, [soundIds]);

  // One system notification per call, and only when the app is not in front (when it is, the banner is the notice).
  const told = useRef(new Set<string>());
  const latest = useRef({ incoming: voice.incoming, navigate, selfId: user?.id ?? "" });
  useEffect(() => {
    latest.current = { incoming: voice.incoming, navigate, selfId: user?.id ?? "" };
  });
  useEffect(() => {
    const ids = notifyKey ? notifyKey.split(",") : [];
    for (const id of [...told.current]) if (!ids.includes(id) && !voice.ringing.has(id)) told.current.delete(id);
    for (const id of ids) {
      if (told.current.has(id) || isAppFocused()) continue;
      told.current.add(id);
      const call = latest.current.incoming.find((c) => c.conversation.id === id);
      if (!call) continue;
      void showSystemNotification({
        title: `${call.callers.join(", ")} ${call.callers.length === 1 && call.conversation.type === "DM" ? "is calling" : "started a call"}`,
        body: call.conversation.type === "GROUP" ? (call.conversation.title ?? "Group chat") : "Voice call",
        tag: `call:${id}`,
        onClick: () => {
          window.focus();
          latest.current.navigate(`/dm/${id}`);
        },
      });
    }
  }, [notifyKey, voice.ringing]);

  if (voice.incoming.length === 0) return null;
  return (
    <div className="incoming-calls" role="region" aria-label="Incoming calls">
      {voice.incoming.map(({ conversation, callers }) => {
        const name = conversationName(conversation, user?.id ?? "");
        const who = callers.join(", ");
        const text = conversation.type === "DM" ? `${who} is calling you` : `${who} ${callers.length === 1 ? "is" : "are"} in a call in ${name}`;
        return (
          <div key={conversation.id} className="incoming-call" role="status">
            <span className="incoming-call-text">📞 {text}</span>
            <span className="incoming-call-buttons">
              <Button
                size="sm"
                aria-label={`Join the call in ${name}`}
                onClick={() => {
                  navigate(`/dm/${conversation.id}`);
                  void voice.joinCall(conversation.id);
                }}
              >
                Join
              </Button>
              <Button variant="secondary" size="sm" aria-label={`Dismiss the call in ${name}`} onClick={() => voice.dismissCall(conversation.id)}>
                Dismiss
              </Button>
            </span>
          </div>
        );
      })}
    </div>
  );
}
