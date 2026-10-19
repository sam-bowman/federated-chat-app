import { useEffect, useState, useSyncExternalStore } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { isDesktopApp } from "./appearance";

// Updates for the desktop app (#48), over Tauri's updater plugin. The release workflow signs each release's installers
// and publishes `latest.json`; the app trusts only a download whose signature matches the public key in tauri.conf.json.
//
// Two ways in, and they are separate things:
//   - automatic (a setting, ON unless the person turns it off): a check shortly after the app starts and every few hours,
//     and a new version is downloaded in the background. It is NEVER installed without being asked: installing quits the
//     app (on Windows the installer closes it), so the person decides when with "Restart to update".
//   - manual ("Check for updates" in Settings): works whether or not automatic updates are on.
//
// The state lives here, outside React, so the Settings page and the banner in the app see the same thing.

const AUTO_KEY = "chat.autoUpdate";
/** Wait a little after start, so checking does not compete with signing in and loading the first screen. */
export const FIRST_CHECK_DELAY_MS = 15_000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Turning automatic updates on checks soon, since the person is looking at the setting. */
export const ENABLED_CHECK_DELAY_MS = 2_000;

export type UpdaterStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "up-to-date"; checkedAt: number }
  | { state: "available"; version: string; notes: string | null }
  | { state: "downloading"; version: string; percent: number | null }
  | { state: "ready"; version: string }
  | { state: "installing"; version: string }
  | { state: "error"; message: string };

interface Snapshot {
  status: UpdaterStatus;
  auto: boolean;
}

/** Whether the app checks for updates by itself. On unless the person turned it off. */
export function isAutoUpdateEnabled(): boolean {
  try {
    return localStorage.getItem(AUTO_KEY) !== "false";
  } catch {
    return true;
  }
}

let snapshot: Snapshot = { status: { state: "idle" }, auto: isAutoUpdateEnabled() };
const listeners = new Set<() => void>();
/** The update found by the last check: it holds a resource on the Rust side until it is installed or closed. */
let current: Update | null = null;
let firstTimer: ReturnType<typeof setTimeout> | undefined;
let intervalTimer: ReturnType<typeof setInterval> | undefined;

function publish(patch: Partial<Snapshot>) {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

function setStatus(status: UpdaterStatus) {
  publish({ status });
}

export function getUpdaterSnapshot(): Snapshot {
  return snapshot;
}

export function subscribeUpdater(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The version of the installed desktop app: the one the updater compares with the update server's, which is the
 * installer's (tauri.conf.json), so it is asked of the app and not read from the web client's own package.
 */
export function useAppVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    if (!isDesktopApp()) return;
    let cancelled = false;
    import("@tauri-apps/api/app")
      .then(({ getVersion }) => getVersion())
      .then((v) => !cancelled && setVersion(v))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return version;
}

/** The updater's state and the automatic setting, for a component. */
export function useUpdater(): Snapshot {
  return useSyncExternalStore(subscribeUpdater, getUpdaterSnapshot);
}

/** Text from the plugin or the network, kept short: it is only ever shown, as text. */
function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return text.trim().slice(0, 200) || "unknown error";
}

function release(update: Update | null) {
  update?.close().catch(() => {});
}

const busy = () => ["checking", "downloading", "ready", "installing"].includes(snapshot.status.state);

/**
 * Asks the update server whether there is a newer version. `automatic` is the scheduled check: with the setting on, an update
 * it finds is also downloaded; without it (the person's own button), the update is only reported and they choose.
 * Does nothing outside the desktop app, and while another step is in progress.
 */
export async function checkForUpdate({ automatic = false }: { automatic?: boolean } = {}): Promise<void> {
  if (!isDesktopApp() || busy()) return;
  setStatus({ state: "checking" });
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    release(current);
    current = update;
    if (!update) {
      setStatus({ state: "up-to-date", checkedAt: Date.now() });
      return;
    }
    setStatus({ state: "available", version: update.version, notes: update.body?.slice(0, 500) ?? null });
    if (automatic && snapshot.auto) await downloadUpdate();
  } catch (error) {
    setStatus({ state: "error", message: describe(error) });
  }
}

/** Downloads the update that was found, reporting progress. It is not installed: that is `installUpdate`. */
export async function downloadUpdate(): Promise<void> {
  const update = current;
  const status = snapshot.status;
  if (!update || status.state !== "available") return;
  let total: number | null = null;
  let received = 0;
  setStatus({ state: "downloading", version: status.version, percent: null });
  try {
    await update.download((event) => {
      if (event.event === "Started") total = event.data.contentLength ?? null;
      else if (event.event === "Progress") {
        received += event.data.chunkLength;
        setStatus({ state: "downloading", version: status.version, percent: total ? Math.min(100, Math.round((received / total) * 100)) : null });
      }
    });
    setStatus({ state: "ready", version: status.version });
  } catch (error) {
    setStatus({ state: "error", message: describe(error) });
  }
}

/** Installs the downloaded update and restarts the app. On Windows the installer closes the app itself. */
export async function installUpdate(): Promise<void> {
  const update = current;
  const status = snapshot.status;
  if (!update || status.state !== "ready") return;
  setStatus({ state: "installing", version: status.version });
  try {
    await update.install();
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (error) {
    setStatus({ state: "error", message: describe(error) });
  }
}

/** The person's "update now": download the update that was found (if it is not already) and restart into it. */
export async function updateNow(): Promise<void> {
  if (snapshot.status.state === "available") await downloadUpdate();
  if (snapshot.status.state === "ready") await installUpdate();
}

function stopAutoUpdates() {
  clearTimeout(firstTimer);
  clearInterval(intervalTimer);
  firstTimer = undefined;
  intervalTimer = undefined;
}

/**
 * Starts the scheduled checks if automatic updates are on (and this is the desktop app): one after `delayMs`, then every
 * few hours. Safe to call again: it replaces what was scheduled.
 */
export function startAutoUpdates(delayMs: number = FIRST_CHECK_DELAY_MS): void {
  stopAutoUpdates();
  if (!isDesktopApp() || !snapshot.auto) return;
  firstTimer = setTimeout(() => {
    void checkForUpdate({ automatic: true });
    intervalTimer = setInterval(() => void checkForUpdate({ automatic: true }), CHECK_INTERVAL_MS);
  }, delayMs);
}

/** The "update automatically" setting: remembered on this device, and takes effect at once. */
export function setAutoUpdateEnabled(enabled: boolean): void {
  try {
    if (enabled) localStorage.removeItem(AUTO_KEY);
    else localStorage.setItem(AUTO_KEY, "false");
  } catch {
    // The setting still applies for this session; it just is not remembered.
  }
  publish({ auto: enabled });
  if (enabled) startAutoUpdates(ENABLED_CHECK_DELAY_MS);
  else stopAutoUpdates();
}

/** Back to a clean start (tests only). */
export function resetUpdaterForTests(): void {
  stopAutoUpdates();
  release(current);
  current = null;
  snapshot = { status: { state: "idle" }, auto: isAutoUpdateEnabled() };
  for (const listener of listeners) listener();
}
