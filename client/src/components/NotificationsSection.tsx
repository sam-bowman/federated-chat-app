import { useEffect, useState } from "react";
import type { Community, Conversation } from "../api";
import { useOptionalAppData } from "../context/AppDataContext";
import { useAuth } from "../context/AuthContext";
import { useNotificationSettings, type NotificationChange } from "../context/NotificationSettingsContext";
import type { PrefsIndex } from "../lib/notificationPrefs";
import { playNotificationSound, unlockAudio } from "../lib/notificationSound";
import {
  notificationPermission,
  requestNotificationPermission,
  showSystemNotification,
  type NotificationPermissionState,
} from "../lib/systemNotification";
import Button from "./Button";

interface Row {
  key: string;
  label: string;
  sound: boolean | null;
  notify: boolean | null;
  type: "COMMUNITY" | "CHANNEL" | "CONVERSATION";
  id: string;
}

/** Every community, channel and conversation the person has made a choice for, named, so each can be put back to the default. */
function overrideRows(prefs: PrefsIndex, communities: Community[], conversations: Conversation[], selfId: string | undefined): Row[] {
  const rows: Row[] = [];
  for (const [id, choice] of prefs.communities) {
    const community = communities.find((c) => c.id === id);
    rows.push({ key: `COMMUNITY:${id}`, label: community ? `${community.name} (all of it)` : "A community you are no longer in", ...choice, type: "COMMUNITY", id });
  }
  for (const [id, choice] of prefs.channels) {
    let label = "A channel that is no longer there";
    for (const community of communities) {
      const channel = community.channels?.find((c) => c.id === id);
      if (channel) label = `#${channel.name} in ${community.name}`;
    }
    rows.push({ key: `CHANNEL:${id}`, label, ...choice, type: "CHANNEL", id });
  }
  for (const [id, choice] of prefs.conversations) {
    const conversation = conversations.find((c) => c.id === id);
    const other = conversation?.members.find((m) => m.id !== selfId);
    const label = !conversation ? "A conversation that is no longer there" : conversation.type === "DM" ? (other?.displayName ?? "A chat") : (conversation.title ?? "A group chat");
    rows.push({ key: `CONVERSATION:${id}`, label, ...choice, type: "CONVERSATION", id });
  }
  return rows;
}

const word = (value: boolean | null) => (value === null ? "default" : value ? "on" : "off");

/**
 * Settings -> Notifications: the sound and the system notification when a message arrives, for everything. Each community,
 * channel and conversation can have its own (the bell in its header), and the ones that do are listed here to be put back.
 * Kept on the server, so it follows the person to every device; whether this device may show system notifications is the
 * browser's or the operating system's permission, asked for here.
 */
export default function NotificationsSection() {
  const { prefs, update } = useNotificationSettings();
  const { user } = useAuth();
  const appData = useOptionalAppData();
  const [permission, setPermission] = useState<NotificationPermissionState | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void notificationPermission().then((state) => !cancelled && setPermission(state));
    return () => {
      cancelled = true;
    };
  }, []);

  const sound = prefs.global.sound ?? true;
  const notify = prefs.global.notify ?? true;
  const rows = overrideRows(prefs, appData?.communities ?? [], appData?.conversations ?? [], user?.id);

  async function allow() {
    setPermission(await requestNotificationPermission());
  }

  async function testSound() {
    unlockAudio();
    const played = await playNotificationSound({ force: true });
    setNote(played ? "Played." : "The browser has not allowed sound yet. Click anywhere on the page and try again.");
  }

  async function testNotification() {
    let state = permission;
    if (state !== "granted") state = await requestNotificationPermission();
    setPermission(state);
    const shown = state === "granted" && (await showSystemNotification({ title: "Notifications are on", body: "This is what a message will look like.", tag: "test" }));
    setNote(shown ? "Sent." : state === "denied" ? "Notifications are blocked: allow them for this site (or app) in its settings." : "Couldn't show one.");
  }

  return (
    <>
      <h3>Notifications</h3>
      <p className="hint">
        What you hear and see when a message arrives. You never get either for the conversation or channel you have open while the
        app has focus, or while your status is Do not disturb. Each community, channel and conversation can have its own choice
        (the bell in its header).
      </p>
      <label className="remember-option">
        <input type="checkbox" checked={sound} onChange={(e) => void update({ type: "GLOBAL", sound: e.target.checked })} />
        Play a sound when a message arrives
      </label>
      <label className="remember-option">
        <input type="checkbox" checked={notify} onChange={(e) => void update({ type: "GLOBAL", notify: e.target.checked })} />
        Show a system notification when a message arrives
      </label>

      {permission && (
        <p className="hint" role="status">
          {permission === "granted" && "System notifications are allowed on this device."}
          {permission === "default" && "System notifications are not allowed on this device yet."}
          {permission === "denied" && "System notifications are blocked on this device. Allow them for this site (or app) in its settings."}
          {permission === "unsupported" && "This browser cannot show system notifications."}
        </p>
      )}
      <div className="update-row">
        {permission === "default" && (
          <Button type="button" onClick={() => void allow()}>
            Allow system notifications
          </Button>
        )}
        <Button type="button" variant="secondary" onClick={() => void testSound()}>
          Play test sound
        </Button>
        <Button type="button" variant="secondary" onClick={() => void testNotification()}>
          Show test notification
        </Button>
      </div>
      {note && (
        <p className="hint" role="status" aria-live="polite">
          {note}
        </p>
      )}

      <h4 className="notification-heading">Places with their own choice</h4>
      {rows.length === 0 ? (
        <p className="hint">None. Use the bell in a conversation or channel to choose for just that one.</p>
      ) : (
        <ul className="notification-overrides">
          {rows.map((row) => (
            <li key={row.key}>
              <span className="notification-override-name">{row.label}</span>
              <span className="hint">{`Sound ${word(row.sound)} · Notifications ${word(row.notify)}`}</span>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                aria-label={`Put ${row.label} back to the default`}
                onClick={() => void update({ type: row.type, id: row.id, sound: null, notify: null } satisfies NotificationChange)}
              >
                Reset
              </Button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
