import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIN_GAP_MS, installAudioUnlock, playNotificationSound, resetNotificationSoundForTests, unlockAudio } from "./notificationSound";

// A fake audio engine that records what was played, with a state the test can set (browsers start it "suspended" until the
// person has clicked or pressed a key).
class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  static initialState: "suspended" | "running" = "running";
  static resumeLeaves: "running" | "suspended" = "running";
  state: "suspended" | "running" = FakeAudioContext.initialState;
  currentTime = 10;
  destination = {};
  oscillators: { frequency: { value: number }; started: number | null; stopped: number | null; type: string }[] = [];
  resume = vi.fn(async () => {
    this.state = FakeAudioContext.resumeLeaves;
  });
  constructor() {
    FakeAudioContext.instances.push(this);
  }
  createOscillator() {
    const osc = {
      type: "",
      frequency: { value: 0 },
      started: null as number | null,
      stopped: null as number | null,
      connect: (node: unknown) => node,
      start: (t: number) => (osc.started = t),
      stop: (t: number) => (osc.stopped = t),
    };
    this.oscillators.push(osc);
    return osc;
  }
  createGain() {
    const gain = { gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: (node: unknown) => node };
    return gain;
  }
}

const win = window as unknown as { AudioContext?: unknown };

beforeEach(() => {
  FakeAudioContext.instances = [];
  FakeAudioContext.initialState = "running";
  FakeAudioContext.resumeLeaves = "running";
  win.AudioContext = FakeAudioContext;
  resetNotificationSoundForTests();
});

afterEach(() => {
  delete win.AudioContext;
});

describe("playNotificationSound", () => {
  it("plays a short two-note chime and says so", async () => {
    expect(await playNotificationSound({ now: 5000 })).toBe(true);
    const audio = FakeAudioContext.instances[0];
    expect(audio.oscillators).toHaveLength(2);
    expect(audio.oscillators.map((o) => o.frequency.value)).toEqual([880, 1318.5]);
    expect(audio.oscillators.every((o) => o.type === "sine")).toBe(true);
    // Both notes start and stop on the audio clock, and the whole thing is well under a second.
    const end = Math.max(...audio.oscillators.map((o) => o.stopped!));
    expect(audio.oscillators.every((o) => o.started! >= audio.currentTime)).toBe(true);
    expect(end - audio.currentTime).toBeLessThan(1);
  });

  it("makes one sound for a burst of messages, and another once the gap has passed", async () => {
    expect(await playNotificationSound({ now: 10_000 })).toBe(true);
    expect(await playNotificationSound({ now: 10_000 + MIN_GAP_MS - 1 })).toBe(false);
    expect(FakeAudioContext.instances[0].oscillators).toHaveLength(2);
    expect(await playNotificationSound({ now: 10_000 + MIN_GAP_MS })).toBe(true);
    expect(FakeAudioContext.instances[0].oscillators).toHaveLength(4);
  });

  it("plays when forced even right after another, without holding back the next real one", async () => {
    expect(await playNotificationSound({ now: 10_000 })).toBe(true);
    expect(await playNotificationSound({ now: 10_100, force: true })).toBe(true);
    // The forced play did not move the gap: a real message at the same moment is judged against the first.
    expect(await playNotificationSound({ now: 10_000 + MIN_GAP_MS })).toBe(true);
  });

  it("uses one audio engine for every sound", async () => {
    await playNotificationSound({ now: 10_000 });
    await playNotificationSound({ now: 20_000 });
    expect(FakeAudioContext.instances).toHaveLength(1);
  });

  it("wakes a suspended audio engine first, and plays if the browser let it wake", async () => {
    FakeAudioContext.initialState = "suspended";
    expect(await playNotificationSound({ now: 5000 })).toBe(true);
    expect(FakeAudioContext.instances[0].resume).toHaveBeenCalled();
  });

  it("stays silent, and does not count as played, if the browser will not allow sound yet", async () => {
    FakeAudioContext.initialState = "suspended";
    FakeAudioContext.resumeLeaves = "suspended";
    expect(await playNotificationSound({ now: 5000 })).toBe(false);
    expect(FakeAudioContext.instances[0].oscillators).toHaveLength(0);
    // Not held back by that failed try: once the person has clicked, the very next message plays.
    FakeAudioContext.instances[0].state = "running";
    expect(await playNotificationSound({ now: 5001 })).toBe(true);
  });

  it("is silent, not an error, where there is no audio engine at all", async () => {
    delete win.AudioContext;
    expect(await playNotificationSound({ now: 5000 })).toBe(false);
  });

  it("is silent if the audio engine cannot be made", async () => {
    win.AudioContext = class {
      constructor() {
        throw new Error("blocked");
      }
    };
    expect(await playNotificationSound({ now: 5000 })).toBe(false);
  });
});

describe("waking the audio engine", () => {
  it("does it on the first click or key press, and only once", () => {
    FakeAudioContext.initialState = "suspended";
    const remove = installAudioUnlock();
    expect(FakeAudioContext.instances).toHaveLength(0);

    window.dispatchEvent(new Event("pointerdown"));
    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(FakeAudioContext.instances[0].resume).toHaveBeenCalledTimes(1);

    // Once is enough: later clicks and keys are not listened to (the engine going back to sleep is not woken again by them).
    FakeAudioContext.instances[0].state = "suspended";
    window.dispatchEvent(new Event("keydown"));
    window.dispatchEvent(new Event("pointerdown"));
    expect(FakeAudioContext.instances[0].resume).toHaveBeenCalledTimes(1);
    remove();
  });

  it("can be switched off before anything happens", () => {
    const remove = installAudioUnlock();
    remove();
    window.dispatchEvent(new Event("pointerdown"));
    expect(FakeAudioContext.instances).toHaveLength(0);
  });

  it("does nothing for an engine that is already awake, and does not throw without one", () => {
    unlockAudio();
    expect(FakeAudioContext.instances[0].resume).not.toHaveBeenCalled();
    delete win.AudioContext;
    resetNotificationSoundForTests();
    expect(() => unlockAudio()).not.toThrow();
  });
});
