import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const plugin = vi.hoisted(() => ({ check: vi.fn() }));
const processPlugin = vi.hoisted(() => ({ relaunch: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => plugin);
vi.mock("@tauri-apps/plugin-process", () => processPlugin);

import {
  CHECK_INTERVAL_MS,
  ENABLED_CHECK_DELAY_MS,
  FIRST_CHECK_DELAY_MS,
  checkForUpdate,
  downloadUpdate,
  getUpdaterSnapshot,
  installUpdate,
  isAutoUpdateEnabled,
  resetUpdaterForTests,
  setAutoUpdateEnabled,
  startAutoUpdates,
  updateNow,
} from "./updater";

type DownloadEvent = { event: "Started"; data: { contentLength?: number } } | { event: "Progress"; data: { chunkLength: number } } | { event: "Finished" };

/** What the plugin's `check()` resolves with when there is a newer version. */
function fakeUpdate(version = "0.16.0", options: { events?: DownloadEvent[]; downloadError?: Error; installError?: Error } = {}) {
  return {
    version,
    currentVersion: "0.15.0",
    body: "Notes for " + version,
    close: vi.fn().mockResolvedValue(undefined),
    download: vi.fn(async (onEvent?: (e: DownloadEvent) => void) => {
      if (options.downloadError) throw options.downloadError;
      for (const e of options.events ?? [{ event: "Started", data: { contentLength: 100 } }, { event: "Progress", data: { chunkLength: 40 } }, { event: "Progress", data: { chunkLength: 60 } }, { event: "Finished" }]) onEvent?.(e);
    }),
    install: vi.fn(async () => {
      if (options.installError) throw options.installError;
    }),
  };
}

const status = () => getUpdaterSnapshot().status;

beforeEach(() => {
  localStorage.clear();
  (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
  plugin.check.mockReset();
  processPlugin.relaunch.mockReset().mockResolvedValue(undefined);
  resetUpdaterForTests();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  resetUpdaterForTests();
  delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
  localStorage.clear();
});

describe("the automatic setting", () => {
  it("is on by default, and turning it off is remembered", () => {
    expect(isAutoUpdateEnabled()).toBe(true);
    setAutoUpdateEnabled(false);
    expect(isAutoUpdateEnabled()).toBe(false);
    expect(localStorage.getItem("chat.autoUpdate")).toBe("false");
    expect(getUpdaterSnapshot().auto).toBe(false);

    setAutoUpdateEnabled(true);
    expect(isAutoUpdateEnabled()).toBe(true);
    expect(getUpdaterSnapshot().auto).toBe(true);
  });

  it("reads a hand-edited or missing value as on, and survives storage that throws", () => {
    localStorage.setItem("chat.autoUpdate", "banana");
    expect(isAutoUpdateEnabled()).toBe(true);
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(isAutoUpdateEnabled()).toBe(true);
    get.mockRestore();
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(() => setAutoUpdateEnabled(false)).not.toThrow();
    expect(getUpdaterSnapshot().auto).toBe(false);
    set.mockRestore();
  });
});

describe("checking", () => {
  it("says you are up to date when the server has nothing newer", async () => {
    plugin.check.mockResolvedValue(null);
    await checkForUpdate();
    expect(status()).toMatchObject({ state: "up-to-date" });
  });

  it("reports a newer version with its notes, and does not download it for a manual check", async () => {
    const update = fakeUpdate();
    plugin.check.mockResolvedValue(update);
    await checkForUpdate();
    expect(status()).toEqual({ state: "available", version: "0.16.0", notes: "Notes for 0.16.0" });
    expect(update.download).not.toHaveBeenCalled();
  });

  it("works whether or not automatic updates are on", async () => {
    setAutoUpdateEnabled(false);
    plugin.check.mockResolvedValue(fakeUpdate());
    await checkForUpdate();
    expect(status().state).toBe("available");
  });

  it("shows a failure as text and can be tried again", async () => {
    plugin.check.mockRejectedValueOnce(new Error("could not fetch a valid release JSON from the remote"));
    await checkForUpdate();
    expect(status()).toEqual({ state: "error", message: "could not fetch a valid release JSON from the remote" });

    plugin.check.mockResolvedValue(null);
    await checkForUpdate();
    expect(status().state).toBe("up-to-date");
  });

  it("copes with an error that is only a string, or nothing at all, and keeps the message short", async () => {
    plugin.check.mockRejectedValueOnce("offline");
    await checkForUpdate();
    expect(status()).toEqual({ state: "error", message: "offline" });
    plugin.check.mockRejectedValueOnce(undefined);
    await checkForUpdate();
    expect(status()).toEqual({ state: "error", message: "unknown error" });
    plugin.check.mockRejectedValueOnce(new Error("x".repeat(1000)));
    await checkForUpdate();
    expect((status() as { message: string }).message).toHaveLength(200);
  });

  it("does nothing in a browser, where there is no updater", async () => {
    delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
    await checkForUpdate();
    expect(plugin.check).not.toHaveBeenCalled();
    expect(status()).toEqual({ state: "idle" });
  });

  it("does not start a second check while one is running, or while an update is downloading or waiting", async () => {
    let resolve!: (value: null) => void;
    plugin.check.mockReturnValue(new Promise((r) => (resolve = r)));
    const first = checkForUpdate();
    await vi.waitFor(() => expect(plugin.check).toHaveBeenCalledTimes(1));
    await checkForUpdate();
    expect(plugin.check).toHaveBeenCalledTimes(1);
    resolve(null);
    await first;

    plugin.check.mockResolvedValue(fakeUpdate());
    await checkForUpdate({ automatic: true });
    expect(status().state).toBe("ready");
    plugin.check.mockClear();
    await checkForUpdate({ automatic: true });
    expect(plugin.check).not.toHaveBeenCalled();
  });

  it("lets go of the previous update when a later check finds another", async () => {
    const first = fakeUpdate("0.16.0");
    plugin.check.mockResolvedValue(first);
    await checkForUpdate();
    plugin.check.mockResolvedValue(fakeUpdate("0.17.0"));
    await checkForUpdate();
    expect(first.close).toHaveBeenCalled();
    expect(status()).toMatchObject({ state: "available", version: "0.17.0" });
  });

  it("keeps long release notes to a short length", async () => {
    const update = fakeUpdate();
    update.body = "n".repeat(5000);
    plugin.check.mockResolvedValue(update);
    await checkForUpdate();
    expect((status() as { notes: string }).notes).toHaveLength(500);
  });
});

describe("the scheduled check", () => {
  it("downloads a new version in the background when automatic updates are on, and stops there", async () => {
    const update = fakeUpdate();
    plugin.check.mockResolvedValue(update);
    await checkForUpdate({ automatic: true });

    expect(update.download).toHaveBeenCalledOnce();
    expect(status()).toEqual({ state: "ready", version: "0.16.0" });
    // Installing closes the app, so it waits for the person.
    expect(update.install).not.toHaveBeenCalled();
    expect(processPlugin.relaunch).not.toHaveBeenCalled();
  });

  it("only reports the new version when automatic updates were switched off", async () => {
    setAutoUpdateEnabled(false);
    const update = fakeUpdate();
    plugin.check.mockResolvedValue(update);
    await checkForUpdate({ automatic: true });
    expect(update.download).not.toHaveBeenCalled();
    expect(status().state).toBe("available");
  });

  it("checks once after the first delay and then every few hours", async () => {
    plugin.check.mockResolvedValue(null);
    startAutoUpdates();
    expect(plugin.check).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS - 1);
    expect(plugin.check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(plugin.check).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(plugin.check).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(plugin.check).toHaveBeenCalledTimes(3);
  });

  it("does not schedule anything when automatic updates are off, or in a browser", async () => {
    plugin.check.mockResolvedValue(null);
    setAutoUpdateEnabled(false);
    startAutoUpdates();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
    expect(plugin.check).not.toHaveBeenCalled();

    setAutoUpdateEnabled(true);
    resetUpdaterForTests();
    delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
    startAutoUpdates();
    // Not even a timer is left running in a browser.
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
    expect(plugin.check).not.toHaveBeenCalled();
  });

  it("stops when the person turns automatic updates off, including the repeating check", async () => {
    plugin.check.mockResolvedValue(null);
    startAutoUpdates();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    expect(plugin.check).toHaveBeenCalledTimes(1);

    setAutoUpdateEnabled(false);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 3);
    expect(plugin.check).toHaveBeenCalledTimes(1);
  });

  it("checks soon after it is turned back on", async () => {
    plugin.check.mockResolvedValue(null);
    setAutoUpdateEnabled(false);
    setAutoUpdateEnabled(true);
    await vi.advanceTimersByTimeAsync(ENABLED_CHECK_DELAY_MS);
    expect(plugin.check).toHaveBeenCalledTimes(1);
  });

  it("starting twice does not double the checks", async () => {
    plugin.check.mockResolvedValue(null);
    startAutoUpdates();
    startAutoUpdates();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    expect(plugin.check).toHaveBeenCalledTimes(1);
  });

  it("a failed scheduled check is only a status, not an exception, and the next one still runs", async () => {
    plugin.check.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(null);
    startAutoUpdates();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    expect(status()).toEqual({ state: "error", message: "offline" });
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(status().state).toBe("up-to-date");
  });
});

describe("downloading and installing", () => {
  it("reports progress as a percentage of what the server said the size is", async () => {
    const seen: unknown[] = [];
    const update = fakeUpdate();
    plugin.check.mockResolvedValue(update);
    await checkForUpdate();
    const original = update.download.getMockImplementation()!;
    update.download.mockImplementation(async (cb) => {
      await original((e) => {
        cb?.(e);
        seen.push(status());
      });
    });

    await downloadUpdate();

    const percents = (seen as { state: string; percent: number | null }[]).filter((s) => s.state === "downloading").map((s) => s.percent);
    // Unknown until the first chunk, then 40 of 100 bytes, then all of it.
    expect([...new Set(percents)]).toEqual([null, 40, 100]);
    expect(status()).toEqual({ state: "ready", version: "0.16.0" });
  });

  it("shows no percentage when the size is not known", async () => {
    plugin.check.mockResolvedValue(fakeUpdate("0.16.0", { events: [{ event: "Started", data: {} }, { event: "Progress", data: { chunkLength: 10 } }, { event: "Finished" }] }));
    await checkForUpdate();
    const states: { state: string; percent?: number | null }[] = [];
    const { subscribeUpdater } = await import("./updater");
    const off = subscribeUpdater(() => states.push(status() as { state: string; percent?: number | null }));
    await downloadUpdate();
    off();
    const downloading = states.filter((st) => st.state === "downloading");
    expect(downloading.length).toBeGreaterThan(1);
    // Not a made-up percentage at any point: the size was never announced.
    expect(downloading.every((st) => st.percent === null)).toBe(true);
  });

  it("never shows more than 100%, even if the server sent more bytes than it announced", async () => {
    plugin.check.mockResolvedValue(
      fakeUpdate("0.16.0", { events: [{ event: "Started", data: { contentLength: 100 } }, { event: "Progress", data: { chunkLength: 90 } }, { event: "Progress", data: { chunkLength: 90 } }, { event: "Finished" }] })
    );
    await checkForUpdate();
    const percents: (number | null)[] = [];
    const { subscribeUpdater } = await import("./updater");
    const off = subscribeUpdater(() => {
      const st = status();
      if (st.state === "downloading") percents.push(st.percent);
    });
    await downloadUpdate();
    off();
    expect(Math.max(...(percents.filter((p) => p !== null) as number[]))).toBe(100);
  });

  it("downloads only an update that was found and not yet downloaded", async () => {
    const update = fakeUpdate();
    plugin.check.mockResolvedValue(update);
    await downloadUpdate(); // nothing found yet
    expect(update.download).not.toHaveBeenCalled();

    await checkForUpdate({ automatic: true }); // downloaded: it is ready now
    expect(update.download).toHaveBeenCalledOnce();
    await downloadUpdate();
    expect(update.download).toHaveBeenCalledOnce();
    expect(status().state).toBe("ready");
  });

  it("a download that fails is a status, and the update can be tried again from a new check", async () => {
    plugin.check.mockResolvedValue(fakeUpdate("0.16.0", { downloadError: new Error("network dropped") }));
    await checkForUpdate();
    await downloadUpdate();
    expect(status()).toEqual({ state: "error", message: "network dropped" });
  });

  it("installs the downloaded update and then restarts the app", async () => {
    const update = fakeUpdate();
    plugin.check.mockResolvedValue(update);
    await checkForUpdate({ automatic: true });

    await installUpdate();

    expect(update.install).toHaveBeenCalledOnce();
    expect(processPlugin.relaunch).toHaveBeenCalledOnce();
    expect(update.install.mock.invocationCallOrder[0]).toBeLessThan(processPlugin.relaunch.mock.invocationCallOrder[0]);
    expect(status()).toEqual({ state: "installing", version: "0.16.0" });
  });

  it("will not install something that has not been downloaded", async () => {
    const update = fakeUpdate();
    plugin.check.mockResolvedValue(update);
    await checkForUpdate();
    await installUpdate();
    expect(update.install).not.toHaveBeenCalled();
    expect(status().state).toBe("available");
  });

  it("an install that fails is a status and the app is not restarted", async () => {
    plugin.check.mockResolvedValue(fakeUpdate("0.16.0", { installError: new Error("signature mismatch") }));
    await checkForUpdate({ automatic: true });
    await installUpdate();
    expect(status()).toEqual({ state: "error", message: "signature mismatch" });
    expect(processPlugin.relaunch).not.toHaveBeenCalled();
  });

  it("'update now' downloads what was found and restarts into it, in one go", async () => {
    setAutoUpdateEnabled(false);
    const update = fakeUpdate();
    plugin.check.mockResolvedValue(update);
    await checkForUpdate();
    expect(status().state).toBe("available");

    await updateNow();

    expect(update.download).toHaveBeenCalledOnce();
    expect(update.install).toHaveBeenCalledOnce();
    expect(processPlugin.relaunch).toHaveBeenCalledOnce();
  });

  it("'update now' on one that is already downloaded does not download it again", async () => {
    const update = fakeUpdate();
    plugin.check.mockResolvedValue(update);
    await checkForUpdate({ automatic: true });
    await updateNow();
    expect(update.download).toHaveBeenCalledOnce();
    expect(update.install).toHaveBeenCalledOnce();
  });
});
