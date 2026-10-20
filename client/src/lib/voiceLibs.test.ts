import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listAudioDevices, loadVoiceDevices, saveVoiceDevices } from "./voiceDevices";
import { mergeCommunityVoice, setChannelPeople } from "./voiceChannels";
import { DISCONNECT, callEndedMessage, joinFailureMessage, microphoneMessage } from "./voiceMessages";

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("the remembered microphone and speaker", () => {
  it("is the system's own choice until one is made", () => {
    expect(loadVoiceDevices()).toEqual({ input: null, output: null });
  });

  it("is kept for next time, and each can be changed on its own", () => {
    saveVoiceDevices({ input: "mic-1", output: null });
    expect(loadVoiceDevices()).toEqual({ input: "mic-1", output: null });
    saveVoiceDevices({ input: "mic-1", output: "speaker-2" });
    expect(loadVoiceDevices()).toEqual({ input: "mic-1", output: "speaker-2" });
  });

  it("forgets everything when both go back to the default, rather than keeping an empty record", () => {
    saveVoiceDevices({ input: "mic-1", output: "speaker-2" });
    saveVoiceDevices({ input: null, output: null });
    expect(localStorage.getItem("chat.voiceDevices")).toBeNull();
  });

  it("ignores what is not usable: nonsense, the wrong shape, an empty or enormous id", () => {
    for (const stored of ["not json", "null", "[]", '"text"', '{"input":5,"output":{}}', `{"input":"","output":"${"x".repeat(600)}"}`]) {
      localStorage.setItem("chat.voiceDevices", stored);
      expect(loadVoiceDevices(), stored).toEqual({ input: null, output: null });
    }
  });

  it("does not fail when the browser will not store anything", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
    expect(() => saveVoiceDevices({ input: "mic-1", output: null })).not.toThrow();
    vi.restoreAllMocks();
  });
});

describe("listAudioDevices", () => {
  const device = (kind: string, deviceId: string, label: string) => ({ kind, deviceId, label });
  const stub = (devices: object[] | (() => never)) => {
    vi.stubGlobal("navigator", {
      mediaDevices: { enumerateDevices: typeof devices === "function" ? devices : async () => devices },
    });
  };

  it("lists microphones and speakers separately, by the names the browser gives", async () => {
    stub([
      device("audioinput", "m1", "Headset"),
      device("audiooutput", "s1", "Speakers"),
      device("videoinput", "c1", "Camera"),
      device("audioinput", "m2", "USB mic"),
    ]);
    expect(await listAudioDevices()).toEqual({
      inputs: [{ id: "m1", label: "Headset" }, { id: "m2", label: "USB mic" }],
      outputs: [{ id: "s1", label: "Speakers" }],
    });
  });

  it("leaves out the 'default' and 'communications' entries, which only repeat a real device", async () => {
    stub([device("audioinput", "default", "Default - Headset"), device("audioinput", "communications", "Communications"), device("audioinput", "m1", "Headset")]);
    expect((await listAudioDevices()).inputs).toEqual([{ id: "m1", label: "Headset" }]);
  });

  it("calls an unnamed device by its kind and place, which is what the browser allows before the microphone has been allowed once", async () => {
    stub([device("audioinput", "m1", ""), device("audioinput", "m2", ""), device("audiooutput", "s1", "")]);
    const found = await listAudioDevices();
    expect(found.inputs.map((d) => d.label)).toEqual(["Microphone 1", "Microphone 2"]);
    expect(found.outputs.map((d) => d.label)).toEqual(["Speaker 1"]);
  });

  it("finds nothing, rather than failing, where the browser has no devices to ask about or refuses", async () => {
    vi.stubGlobal("navigator", {});
    expect(await listAudioDevices()).toEqual({ inputs: [], outputs: [] });
    stub(() => {
      throw new Error("denied");
    });
    expect(await listAudioDevices()).toEqual({ inputs: [], outputs: [] });
  });
});

describe("who is in each voice channel", () => {
  it("takes what a trustworthy answer says, for the channels it names", () => {
    const merged = mergeCommunityVoice({ a: ["1"], b: ["2"] }, { available: true, channels: { a: ["1", "3"], c: [] } });
    expect(merged).toEqual({ a: ["1", "3"], b: ["2"], c: [] });
  });

  it("changes nothing for an answer that says it cannot be trusted, which is not the same as nobody being there", () => {
    const before = { a: ["1"] };
    expect(mergeCommunityVoice(before, { available: false, channels: {} })).toBe(before);
    expect(mergeCommunityVoice(before, { available: false, channels: { a: [] } })).toBe(before);
  });

  it("replaces a channel's list with the whole new one from an event", () => {
    expect(setChannelPeople({ a: ["1", "2"] }, "a", ["2"])).toEqual({ a: ["2"] });
    expect(setChannelPeople({}, "a", ["1"])).toEqual({ a: ["1"] });
    expect(setChannelPeople({ a: ["1"] }, "a", [])).toEqual({ a: [] });
  });

  it("keeps the very same object when an event changes nothing, so nothing redraws", () => {
    const before = { a: ["1", "2"] };
    expect(setChannelPeople(before, "a", ["1", "2"])).toBe(before);
    expect(setChannelPeople(before, "a", ["2", "1"])).not.toBe(before);
  });
});

describe("what a person is told", () => {
  const apiError = (error: string) => ({ body: { error } });

  it("says why joining failed, in words", () => {
    expect(joinFailureMessage(apiError("forbidden"))).toMatch(/permission/);
    expect(joinFailureMessage(apiError("voice_not_enabled"))).toMatch(/isn't set up/);
    expect(joinFailureMessage(apiError("voice_not_available_for_remote_community"))).toMatch(/another server/);
    expect(joinFailureMessage(apiError("not_found"))).toMatch(/isn't there/);
    expect(joinFailureMessage(apiError("not_a_voice_channel"))).toMatch(/isn't there/);
    for (const other of [new Error("network"), apiError("something_else"), null, undefined, { body: null }]) {
      expect(joinFailureMessage(other), String(other)).toMatch(/Couldn't join/);
    }
  });

  it("says what is wrong with the microphone, and that listening still works", () => {
    for (const name of ["NotAllowedError", "SecurityError", "PermissionDeniedError"]) expect(microphoneMessage({ name })).toMatch(/blocked/);
    for (const name of ["NotFoundError", "OverconstrainedError", "DevicesNotFoundError"]) expect(microphoneMessage({ name })).toMatch(/No microphone/);
    for (const name of ["NotReadableError", "AbortError"]) expect(microphoneMessage({ name })).toMatch(/in use/);
    expect(microphoneMessage(new Error("odd"))).toMatch(/couldn't be used/);
    expect(microphoneMessage(null)).toMatch(/couldn't be used/);
    // The first three tell the person they can still listen.
    expect(microphoneMessage({ name: "NotAllowedError" })).toMatch(/listen/);
    expect(microphoneMessage({ name: "NotFoundError" })).toMatch(/listen/);
  });

  it("says why a call ended, and nothing at all when the person ended it themselves", () => {
    expect(callEndedMessage(DISCONNECT.CLIENT_INITIATED)).toBeNull();
    expect(callEndedMessage(DISCONNECT.PARTICIPANT_REMOVED)).toBe("You were removed from the call.");
    expect(callEndedMessage(DISCONNECT.ROOM_DELETED)).toBe("This voice channel was deleted.");
    expect(callEndedMessage(DISCONNECT.DUPLICATE_IDENTITY)).toMatch(/somewhere else/);
    expect(callEndedMessage(DISCONNECT.SERVER_SHUTDOWN)).toBe("The call was disconnected.");
    expect(callEndedMessage(undefined)).toBe("The call was disconnected.");
    expect(callEndedMessage(0)).toBe("The call was disconnected.");
  });

  it("uses the voice server's own numbers for the reasons", () => {
    // livekit's DisconnectReason: CLIENT_INITIATED = 1, DUPLICATE_IDENTITY = 2, SERVER_SHUTDOWN = 3, PARTICIPANT_REMOVED = 4, ROOM_DELETED = 5.
    expect(DISCONNECT).toEqual({ CLIENT_INITIATED: 1, DUPLICATE_IDENTITY: 2, SERVER_SHUTDOWN: 3, PARTICIPANT_REMOVED: 4, ROOM_DELETED: 5 });
  });
});
