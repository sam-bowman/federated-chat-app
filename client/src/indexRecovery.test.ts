import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import html from "../index.html?raw";

// index.html carries a small inline script that reloads the page when a hashed file under
// /assets/ fails to load, which is what a browser meets mid-rollout when the pod that answers
// has a different build (nginx answers 404 for it). It is plain script in the HTML, not a
// module, so it is tested by running the real text from index.html against fakes.
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];

type Listener = (event: unknown) => void;

function run(options: { storageThrows?: boolean } = {}) {
  const listeners = new Map<string, Listener[]>();
  const fakeWindow = {
    addEventListener: (type: string, listener: Listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
  };
  const store = new Map<string, string>();
  const sessionStorage = {
    getItem: (key: string) => {
      if (options.storageThrows) throw new Error("storage blocked");
      return store.get(key) ?? null;
    },
    setItem: (key: string, value: string) => void store.set(key, value),
  };
  const location = { reload: vi.fn() };
  new Function("window", "sessionStorage", "location", script as string)(fakeWindow, sessionStorage, location);

  const fire = (type: string, event: unknown = {}) => listeners.get(type)?.forEach((listener) => listener(event));
  const failedLoad = (tagName: string, url: string) =>
    fire("error", { target: { tagName, src: tagName === "SCRIPT" ? url : undefined, href: tagName === "LINK" ? url : undefined } });
  return { location, fire, failedLoad };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("index.html recovery script", () => {
  it("is in index.html", () => {
    expect(script).toContain("location.reload()");
  });

  it("reloads when a script under /assets/ fails to load", () => {
    const { location, failedLoad } = run();

    failedLoad("SCRIPT", "https://chat.example/assets/index-DhQTljMZ.js");

    expect(location.reload).toHaveBeenCalledOnce();
  });

  it("reloads when the stylesheet under /assets/ fails to load", () => {
    const { location, failedLoad } = run();

    failedLoad("LINK", "https://chat.example/assets/index-XMv-4Lv3.css");

    expect(location.reload).toHaveBeenCalledOnce();
  });

  it("reloads when a lazily loaded chunk fails (Vite's preload error)", () => {
    const { location, fire } = run();

    fire("vite:preloadError");

    expect(location.reload).toHaveBeenCalledOnce();
  });

  it.each([
    ["a script that is not under /assets/", "SCRIPT", "https://chat.example/env-config.js"],
    ["an image", "IMG", "https://chat.example/assets/logo.png"],
  ])("ignores a failed load of %s", (_name, tagName, url) => {
    const { location, failedLoad } = run();

    failedLoad(tagName, url);

    expect(location.reload).not.toHaveBeenCalled();
  });

  it("ignores an ordinary error with no element behind it", () => {
    const { location, fire } = run();

    fire("error", { target: null });
    fire("error", { target: {} });

    expect(location.reload).not.toHaveBeenCalled();
  });

  // A file that is really missing must not turn into a reload loop.
  it("stops after 5 reloads in a minute, and allows more once the minute has passed", () => {
    const { location, failedLoad } = run();
    const fail = () => failedLoad("SCRIPT", "https://chat.example/assets/index-gone.js");

    for (let i = 0; i < 8; i++) fail();
    expect(location.reload).toHaveBeenCalledTimes(5);

    vi.advanceTimersByTime(61_000);
    fail();
    expect(location.reload).toHaveBeenCalledTimes(6);
  });

  it("does nothing, and does not throw, when session storage is unavailable", () => {
    const { location, failedLoad } = run({ storageThrows: true });

    expect(() => failedLoad("SCRIPT", "https://chat.example/assets/index-x.js")).not.toThrow();
    expect(location.reload).not.toHaveBeenCalled();
  });
});
