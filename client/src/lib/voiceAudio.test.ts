import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_AUDIO,
  clampPercent,
  isDefaultPerson,
  loadVoiceAudio,
  personOf,
  playbackVolume,
  saveVoiceAudio,
  withPerson,
  type VoiceAudioPrefs,
} from "./voiceAudio";

const prefs = (change: Partial<VoiceAudioPrefs> = {}): VoiceAudioPrefs => ({ ...DEFAULT_AUDIO, people: {}, ...change });

beforeEach(() => localStorage.clear());

describe("a percentage", () => {
  it("is whole and kept between 0 and 200", () => {
    expect(clampPercent(150)).toBe(150);
    expect(clampPercent(0)).toBe(0);
    expect(clampPercent(200)).toBe(200);
    expect(clampPercent(201)).toBe(200);
    expect(clampPercent(-1)).toBe(0);
    expect(clampPercent(99.6)).toBe(100);
  });

  it("is 100% for anything that is not a number", () => {
    for (const bad of ["150", null, undefined, NaN, Infinity, {}, [], true]) expect(clampPercent(bad), String(bad)).toBe(100);
  });
});

describe("what is remembered", () => {
  it("is 100% everywhere and the browser's processing on until something is chosen, and then nothing is stored", () => {
    expect(loadVoiceAudio()).toEqual(DEFAULT_AUDIO);
    saveVoiceAudio(prefs());
    expect(localStorage.getItem("chat.voiceAudio")).toBeNull();
  });

  it("is kept, each part on its own", () => {
    const chosen = prefs({ inputVolume: 150, autoGainControl: false, outputVolume: 80, people: { "@a:x.example": { volume: 160, muted: true } } });
    saveVoiceAudio(chosen);
    expect(loadVoiceAudio()).toEqual(chosen);
    saveVoiceAudio(prefs({ echoCancellation: false }));
    expect(loadVoiceAudio()).toEqual(prefs({ echoCancellation: false }));
  });

  it("forgets everything again when it is all put back", () => {
    saveVoiceAudio(prefs({ inputVolume: 150 }));
    saveVoiceAudio(prefs());
    expect(localStorage.getItem("chat.voiceAudio")).toBeNull();
  });

  it("ignores what is nonsense, part by part", () => {
    localStorage.setItem("chat.voiceAudio", JSON.stringify({ inputVolume: "loud", echoCancellation: "yes", outputVolume: 9999, noiseSuppression: false, people: [1, 2] }));
    expect(loadVoiceAudio()).toEqual(prefs({ outputVolume: 200, noiseSuppression: false }));
    for (const stored of ["not json", "null", "[]", '"text"', "5"]) {
      localStorage.setItem("chat.voiceAudio", stored);
      expect(loadVoiceAudio(), stored).toEqual(DEFAULT_AUDIO);
    }
  });

  it("drops a person with nothing set, an entry of the wrong shape and a name that is too long, and clamps the rest", () => {
    localStorage.setItem(
      "chat.voiceAudio",
      JSON.stringify({
        people: {
          "@plain:x.example": { volume: 100, muted: false },
          "@loud:x.example": { volume: 900, muted: false },
          "@silent:x.example": { volume: 100, muted: true },
          "@bad:x.example": "loud",
          "@null:x.example": null,
          ["@" + "a".repeat(400)]: { volume: 150, muted: false },
        },
      })
    );
    expect(loadVoiceAudio().people).toEqual({ "@loud:x.example": { volume: 200, muted: false }, "@silent:x.example": { volume: 100, muted: true } });
  });

  it("does not take a person named like an object's own property for something else", () => {
    localStorage.setItem("chat.voiceAudio", JSON.stringify({ people: JSON.parse('{"__proto__":{"volume":150,"muted":false},"constructor":{"volume":50,"muted":false}}') }));
    const loaded = loadVoiceAudio();
    expect(Object.keys(loaded.people)).toEqual(["constructor"]);
    expect(personOf(loaded, "toString")).toEqual({ volume: 100, muted: false });
    expect(personOf(loaded, "__proto__")).toEqual({ volume: 100, muted: false });
  });

  it("does not fail when the browser will not store it", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
    expect(() => saveVoiceAudio(prefs({ inputVolume: 150 }))).not.toThrow();
    vi.restoreAllMocks();
  });
});

describe("one person's volume", () => {
  it("is 100% and not muted for someone nothing was set for", () => {
    expect(personOf(prefs(), "@a:x.example")).toEqual({ volume: 100, muted: false });
  });

  it("changes the volume and the mute on their own", () => {
    const louder = withPerson(prefs(), "@a:x.example", { volume: 150 });
    expect(personOf(louder, "@a:x.example")).toEqual({ volume: 150, muted: false });
    const muted = withPerson(louder, "@a:x.example", { muted: true });
    expect(personOf(muted, "@a:x.example")).toEqual({ volume: 150, muted: true });
  });

  it("keeps a volume between 0 and 200, and leaves others and everything else alone", () => {
    const base = prefs({ inputVolume: 130, people: { "@b:x.example": { volume: 50, muted: false } } });
    const next = withPerson(base, "@a:x.example", { volume: 999 });
    expect(personOf(next, "@a:x.example").volume).toBe(200);
    expect(personOf(next, "@b:x.example")).toEqual({ volume: 50, muted: false });
    expect(next.inputVolume).toBe(130);
    expect(base.people).toEqual({ "@b:x.example": { volume: 50, muted: false } });
  });

  it("forgets a person put back to 100% and unmuted", () => {
    const set = withPerson(prefs(), "@a:x.example", { volume: 150, muted: true });
    expect(withPerson(set, "@a:x.example", { volume: 100 }).people).toHaveProperty("@a:x.example");
    expect(withPerson(withPerson(set, "@a:x.example", { volume: 100 }), "@a:x.example", { muted: false }).people).toEqual({});
  });

  it("knows what counts as nothing set", () => {
    expect(isDefaultPerson({ volume: 100, muted: false })).toBe(true);
    expect(isDefaultPerson({ volume: 101, muted: false })).toBe(false);
    expect(isDefaultPerson({ volume: 100, muted: true })).toBe(false);
  });
});

describe("how loud someone is played", () => {
  it("is as it comes at the defaults", () => {
    expect(playbackVolume(prefs(), "@a:x.example", false)).toBe(1);
  });

  it("is the master volume times theirs, which can be more than 1", () => {
    expect(playbackVolume(prefs({ outputVolume: 50 }), "@a:x.example", false)).toBe(0.5);
    const loud = withPerson(prefs({ outputVolume: 200 }), "@a:x.example", { volume: 150 });
    expect(playbackVolume(loud, "@a:x.example", false)).toBe(3);
  });

  it("is nothing for someone muted for this person, and for everyone when this person is deafened", () => {
    const muted = withPerson(prefs(), "@a:x.example", { volume: 150, muted: true });
    expect(playbackVolume(muted, "@a:x.example", false)).toBe(0);
    expect(playbackVolume(muted, "@b:x.example", false)).toBe(1);
    expect(playbackVolume(prefs(), "@b:x.example", true)).toBe(0);
  });
});
