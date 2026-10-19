import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import type { Community, Conversation, Message } from "../api";
import { useAppData } from "../context/AppDataContext";
import { useAuth } from "../context/AuthContext";
import { useNotificationSettings } from "../context/NotificationSettingsContext";
import { useWs } from "../context/WsContext";
import { getActiveChat, isAppFocused } from "../lib/activeChat";
import { decideAlert } from "../lib/notificationDecision";
import type { Place } from "../lib/notificationPrefs";
import { installAudioUnlock, playNotificationSound } from "../lib/notificationSound";
import { showSystemNotification } from "../lib/systemNotification";

const MAX_BODY = 140;

function preview(message: Message): string {
  const text = message.invite ? "sent a community invitation" : (message.content ?? "").trim() || (message.attachments.length > 0 ? "sent an attachment" : "sent a message");
  return text.length > MAX_BODY ? `${text.slice(0, MAX_BODY - 1)}…` : text;
}

interface Where {
  place: Place;
  title: string;
  path: string;
}

/** Where a new message is, in words and as an address. A channel's community is found from the communities this person is in. */
function whereIs(payload: { conversationId?: string; channelId?: string }, message: Message, conversations: Conversation[], communities: Community[]): Where | null {
  const sender = message.sender.displayName;
  if (payload.conversationId) {
    const conversation = conversations.find((c) => c.id === payload.conversationId);
    const title = conversation?.type === "GROUP" && conversation.title ? `${sender} in ${conversation.title}` : sender;
    return { place: { conversationId: payload.conversationId }, title, path: `/dm/${payload.conversationId}` };
  }
  if (payload.channelId) {
    for (const community of communities) {
      const channel = community.channels?.find((c) => c.id === payload.channelId);
      if (channel) {
        return {
          place: { channelId: channel.id, communityId: community.id },
          title: `${sender} in #${channel.name} (${community.name})`,
          path: `/communities/${community.id}/${channel.id}`,
        };
      }
    }
    // A channel that is not in the list yet (just created): it can still make a sound, under the global choice.
    return { place: { channelId: payload.channelId }, title: sender, path: "/" };
  }
  return null;
}

/**
 * Makes the sound and shows the system notification when a message arrives (renders nothing). Which of the two, if either, is
 * decided by `decideAlert`: never for your own messages or while you are on Do not disturb, never for the conversation or channel
 * you have open while the app has focus, and otherwise by what the person chose for that place. The latest of everything is read
 * from refs, so the one subscription never goes stale.
 */
export default function MessageNotifier() {
  const { subscribe } = useWs();
  const { user } = useAuth();
  const { conversations, communities } = useAppData();
  const { prefs } = useNotificationSettings();
  const navigate = useNavigate();
  const latest = useRef({ user, conversations, communities, prefs, navigate });
  useEffect(() => {
    latest.current = { user, conversations, communities, prefs, navigate };
  });

  useEffect(() => installAudioUnlock(), []);

  useEffect(
    () =>
      subscribe("message:created", (payload: { message?: Message; conversationId?: string; channelId?: string }) => {
        const { user, conversations, communities, prefs, navigate } = latest.current;
        if (!user || !payload?.message) return;
        const where = whereIs(payload, payload.message, conversations, communities);
        if (!where) return;

        const decision = decideAlert({
          message: payload.message,
          selfId: user.id,
          selfStatus: user.presence?.status,
          place: where.place,
          active: getActiveChat(),
          focused: isAppFocused(),
          prefs,
        });
        if (decision.sound) void playNotificationSound();
        if (decision.notify) {
          void showSystemNotification({
            title: where.title,
            body: preview(payload.message),
            tag: "conversationId" in where.place ? `c:${where.place.conversationId}` : `h:${where.place.channelId}`,
            onClick: () => {
              window.focus();
              navigate(where.path);
            },
          });
        }
      }),
    [subscribe]
  );

  return null;
}
