import { isDesktopApp } from "../lib/appearance";
import { checkForUpdate, installUpdate, setAutoUpdateEnabled, updateNow, useAppVersion, useUpdater } from "../lib/updater";
import Button from "./Button";

/**
 * Settings -> Updates, in the desktop app only (a web page is updated by the server it comes from). Automatic updates are on
 * unless turned off here; either way "Check for updates" works. A new version is only ever installed when the person asks,
 * because installing closes the app.
 */
export default function UpdatesSection() {
  const { status, auto } = useUpdater();
  const version = useAppVersion();
  if (!isDesktopApp()) return null;

  const working = status.state === "checking" || status.state === "downloading" || status.state === "installing";

  return (
    <>
      <h3>Updates</h3>
      <label className="remember-option">
        <input type="checkbox" checked={auto} onChange={(e) => setAutoUpdateEnabled(e.target.checked)} />
        Update automatically
      </label>
      <p className="hint">
        {auto
          ? "Checks when the app starts and every few hours, and downloads a new version in the background. It is installed only when you choose to restart."
          : "The app does not check by itself. Use Check for updates when you want to."}
      </p>

      <div className="update-row">
        <Button type="button" variant="secondary" disabled={working || status.state === "ready"} onClick={() => void checkForUpdate()}>
          Check for updates
        </Button>
        {status.state === "available" && (
          <Button type="button" onClick={() => void updateNow()}>
            Update to v{status.version}
          </Button>
        )}
        {status.state === "ready" && (
          <Button type="button" onClick={() => void installUpdate()}>
            Restart to update to v{status.version}
          </Button>
        )}
      </div>

      <p className="hint" role="status" aria-live="polite">
        {status.state === "idle" && (version ? `You have v${version}.` : "")}
        {status.state === "checking" && "Checking for updates…"}
        {status.state === "up-to-date" && `You are up to date${version ? ` (v${version})` : ""}.`}
        {status.state === "available" && `Version ${status.version} is available.`}
        {status.state === "downloading" &&
          `Downloading version ${status.version}${status.percent === null ? "…" : `: ${status.percent}%`}`}
        {status.state === "ready" && `Version ${status.version} is downloaded and ready. Restart the app to use it.`}
        {status.state === "installing" && `Installing version ${status.version}…`}
        {status.state === "error" && `Couldn't update: ${status.message}`}
      </p>
      {status.state === "available" && status.notes && <p className="hint update-notes">{status.notes}</p>}
    </>
  );
}
