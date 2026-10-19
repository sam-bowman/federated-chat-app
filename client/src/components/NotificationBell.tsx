import { useState } from "react";
import { useNotificationSettings } from "../context/NotificationSettingsContext";
import { isEnabled } from "../lib/notificationPrefs";
import Button from "./Button";
import NotificationSettingsModal, { type NotificationTarget } from "./NotificationSettingsModal";

/** The bell in a conversation's or channel's header: shows whether anything is on for it, and opens its notification settings. */
export default function NotificationBell({ target }: { target: NotificationTarget }) {
  const { prefs } = useNotificationSettings();
  const [open, setOpen] = useState(false);
  const place = target.kind === "conversation" ? { conversationId: target.id } : { channelId: target.id, communityId: target.communityId };
  const sound = isEnabled(prefs, "sound", place);
  const notify = isEnabled(prefs, "notify", place);
  const silent = !sound && !notify;

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        aria-haspopup="dialog"
        aria-label={`Sound and notifications${silent ? " (muted)" : ""}`}
        title={silent ? "Muted: no sound and no notifications" : `Sound ${sound ? "on" : "off"}, notifications ${notify ? "on" : "off"}`}
        onClick={() => setOpen(true)}
      >
        {silent ? "🔕" : "🔔"}
      </Button>
      {open && <NotificationSettingsModal target={target} onClose={() => setOpen(false)} />}
    </>
  );
}
