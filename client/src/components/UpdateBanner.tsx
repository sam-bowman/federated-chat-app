import { useState } from "react";
import { isDesktopApp } from "../lib/appearance";
import { installUpdate, useUpdater } from "../lib/updater";
import Button from "./Button";

/**
 * Shown once a new version has been downloaded in the background: it is installed only when the person says so, since
 * installing closes the app. "Later" hides it until the next time the app starts (Settings -> Updates still offers it).
 */
export default function UpdateBanner() {
  const { status } = useUpdater();
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  if (!isDesktopApp() || status.state !== "ready" || dismissedFor === status.version) return null;

  return (
    <div className="update-banner" role="status">
      <span>Version {status.version} is ready.</span>
      <Button type="button" size="sm" onClick={() => void installUpdate()}>
        Restart to update
      </Button>
      <Button type="button" size="sm" variant="secondary" onClick={() => setDismissedFor(status.version)}>
        Later
      </Button>
    </div>
  );
}
