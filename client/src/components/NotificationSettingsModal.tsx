import { useNotificationSettings } from "../context/NotificationSettingsContext";
import { isEnabled, ownChoice, type Kind } from "../lib/notificationPrefs";
import Modal from "./Modal";
import NotificationChoice from "./NotificationChoice";

export type NotificationTarget =
  | { kind: "conversation"; id: string; name: string }
  | { kind: "channel"; id: string; name: string; communityId: string; communityName: string };

/**
 * The sound and the system notification for one conversation, or for a channel and (separately) its whole community. Each is
 * "Default", which follows the level above (a channel follows its community, which follows Settings -> Notifications), or a
 * choice of its own. The most specific choice wins.
 */
export default function NotificationSettingsModal({ target, onClose }: { target: NotificationTarget; onClose: () => void }) {
  const { prefs, update } = useNotificationSettings();

  const place = target.kind === "conversation" ? { conversationId: target.id } : { channelId: target.id, communityId: target.communityId };
  // What "Default" means for a place: what the levels above it say. (A place that has no choice of its own is looked up by an id
  // nothing is stored under, so only the levels above can answer.)
  const aboveChannel = (kind: Kind) => (target.kind === "channel" ? isEnabled(prefs, kind, { channelId: "no such channel", communityId: target.communityId }) : true);
  const aboveConversation = (kind: Kind) => isEnabled(prefs, kind, { conversationId: "no such conversation" });
  const aboveCommunity = (kind: Kind) => isEnabled(prefs, kind, { channelId: "no such channel" });

  return (
    <Modal title={`Notifications for ${target.kind === "channel" ? `#${target.name}` : target.name}`} onClose={onClose} width={440}>
      {target.kind === "conversation" ? (
        <>
          <NotificationChoice
            label="Sound"
            value={ownChoice(prefs, "sound", { type: "CONVERSATION", id: target.id })}
            inherited={aboveConversation("sound")}
            onChange={(sound) => void update({ type: "CONVERSATION", id: target.id, sound })}
          />
          <NotificationChoice
            label="System notification"
            value={ownChoice(prefs, "notify", { type: "CONVERSATION", id: target.id })}
            inherited={aboveConversation("notify")}
            onChange={(notify) => void update({ type: "CONVERSATION", id: target.id, notify })}
          />
        </>
      ) : (
        <>
          <h2 className="notification-heading">This channel</h2>
          <NotificationChoice
            label="Sound"
            value={ownChoice(prefs, "sound", { type: "CHANNEL", id: target.id })}
            inherited={aboveChannel("sound")}
            onChange={(sound) => void update({ type: "CHANNEL", id: target.id, sound })}
          />
          <NotificationChoice
            label="System notification"
            value={ownChoice(prefs, "notify", { type: "CHANNEL", id: target.id })}
            inherited={aboveChannel("notify")}
            onChange={(notify) => void update({ type: "CHANNEL", id: target.id, notify })}
          />
          <h2 className="notification-heading">{`All of ${target.communityName}`}</h2>
          <NotificationChoice
            label="Sound"
            value={ownChoice(prefs, "sound", { type: "COMMUNITY", id: target.communityId })}
            inherited={aboveCommunity("sound")}
            onChange={(sound) => void update({ type: "COMMUNITY", id: target.communityId, sound })}
          />
          <NotificationChoice
            label="System notification"
            value={ownChoice(prefs, "notify", { type: "COMMUNITY", id: target.communityId })}
            inherited={aboveCommunity("notify")}
            onChange={(notify) => void update({ type: "COMMUNITY", id: target.communityId, notify })}
          />
        </>
      )}
      <p className="hint">
        Default follows the level above it: a channel follows its community, and a community or conversation follows Settings
        {" -> "}Notifications. A choice made for a channel beats the community&apos;s. You never get either for the
        {target.kind === "conversation" ? " conversation" : " channel"} you have open while the app has focus, or while your status is Do not disturb.
      </p>
      <p className="hint" aria-live="polite">
        {isEnabled(prefs, "sound", place) ? "Sound: on." : "Sound: off."} {isEnabled(prefs, "notify", place) ? "Notifications: on." : "Notifications: off."}
      </p>
    </Modal>
  );
}
