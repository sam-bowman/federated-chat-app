import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceProvider, useVoice } from "./VoiceContext";

// --- a fake voice server (livekit-client) that the test drives by hand
const fake = vi.hoisted(() => {
  class FakeParticipant {
    identity: string;
    isLocal: boolean;
    muted: boolean;
    constructor(identity: string, isLocal = false, muted = false) {
      this.identity = identity;
      this.isLocal = isLocal;
      this.muted = muted;
    }
    getTrackPublications() {
      return [{ kind: "audio", isMuted: this.muted }];
    }
  }
  class FakeRoom {
    static instances: FakeRoom[] = [];
    handlers = new Map<string, ((...args: any[]) => void)[]>();
    options: any;
    connect = vi.fn(async (_url: string, _token: string) => {
      if (fake.connectError) throw fake.connectError;
      fake.whenConnected?.(this);
    });
    disconnect = vi.fn(() => undefined);
    startAudio = vi.fn(async () => {
      this.canPlaybackAudio = true;
    });
    switchActiveDevice = vi.fn(async () => true);
    canPlaybackAudio = true;
    remoteParticipants = new Map<string, FakeParticipant>();
    microphoneOn = false;
    localParticipant = {
      get isMicrophoneEnabled() {
        return room.microphoneOn;
      },
      setMicrophoneEnabled: vi.fn(async (on: boolean) => {
        if (on && fake.micError) throw fake.micError;
        room.microphoneOn = on;
      }),
    };
    constructor(options: any) {
      this.options = options;
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      room = this;
      FakeRoom.instances.push(this);
    }
    on(event: string, handler: (...args: any[]) => void) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
      return this;
    }
    emit(event: string, ...args: any[]) {
      this.handlers.get(event)?.forEach((h) => h(...args));
    }
  }
  let room: FakeRoom;
  const fake = {
    Room: FakeRoom,
    Participant: FakeParticipant,
    connectError: null as Error | null,
    micError: null as (Error & { name: string }) | null,
    /** Runs as the connection completes, to put people in the room before the app looks. */
    whenConnected: null as ((room: FakeRoom) => void) | null,
  };
  return fake;
});

vi.mock("livekit-client", () => ({
  Room: fake.Room,
  Track: { Kind: { Audio: "audio", Video: "video" } },
  RoomEvent: {
    TrackSubscribed: "trackSubscribed",
    TrackUnsubscribed: "trackUnsubscribed",
    ActiveSpeakersChanged: "activeSpeakersChanged",
    TrackMuted: "trackMuted",
    TrackUnmuted: "trackUnmuted",
    ParticipantDisconnected: "participantDisconnected",
    Reconnecting: "reconnecting",
    Reconnected: "reconnected",
    AudioPlaybackStatusChanged: "audioPlaybackChanged",
    MediaDevicesError: "mediaDevicesError",
    Disconnected: "disconnected",
  },
}));

const apiMock = vi.hoisted(() => ({
  getVoiceToken: vi.fn(),
  getCommunityVoice: vi.fn(),
}));
vi.mock("../api", () => apiMock);

const ws = vi.hoisted(() => ({ handlers: new Map<string, ((payload: any) => void)[]>() }));
vi.mock("./WsContext", () => ({
  useWs: () => ({
    subscribe: (type: string, fn: (payload: any) => void) => {
      ws.handlers.set(type, [...(ws.handlers.get(type) ?? []), fn]);
      return () => ws.handlers.set(type, (ws.handlers.get(type) ?? []).filter((h) => h !== fn));
    },
  }),
}));
const send = (type: string, payload: object = {}) => act(() => void ws.handlers.get(type)?.forEach((h) => h(payload)));

const me = { id: "ME", identity: "@me:chat.example" };
vi.mock("./AuthContext", () => ({ useAuth: () => ({ user: me }) }));

const data = vi.hoisted(() => ({ communities: [] as any[] }));
vi.mock("./AppDataContext", () => ({ useAppData: () => ({ communities: data.communities }) }));

const community = (id: string, channels: object[], homeserverDomain = "chat.example") => ({
  id,
  name: `Community ${id}`,
  homeserverDomain,
  channels,
  members: [],
});
const voiceChannel = (id: string, name = id) => ({ id, name, type: "VOICE" });
const textChannel = (id: string) => ({ id, name: id, type: "TEXT" });
const pass = { url: "wss://voice.test", token: "TOKEN", room: "V1", identity: "ME", expiresInSeconds: 600 };

const render = () => renderHook(() => useVoice(), { wrapper: VoiceProvider });
const lastRoom = () => fake.Room.instances[fake.Room.instances.length - 1];

beforeEach(() => {
  localStorage.clear();
  ws.handlers.clear();
  fake.Room.instances.length = 0;
  fake.connectError = null;
  fake.micError = null;
  fake.whenConnected = null;
  apiMock.getVoiceToken.mockReset().mockResolvedValue(pass);
  apiMock.getCommunityVoice.mockReset().mockResolvedValue({ available: true, channels: {} });
  data.communities = [community("C1", [textChannel("T1"), voiceChannel("V1", "Lounge"), voiceChannel("V2", "Quiet")])];
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

/** Joins V1 and waits until the call is up. */
async function inCall() {
  const view = render();
  await act(async () => {
    await view.result.current.join({ id: "V1", communityId: "C1" });
  });
  return view;
}

describe("who is in each voice channel", () => {
  it("asks for the communities that have a voice channel on this person's server, and shows what comes back", async () => {
    data.communities = [
      community("C1", [textChannel("T1"), voiceChannel("V1")]),
      community("C2", [textChannel("T2")]), // no voice channel: not asked
      community("C3", [voiceChannel("V3")], "far.example"), // another server's: not asked
    ];
    apiMock.getCommunityVoice.mockResolvedValue({ available: true, channels: { V1: ["A", "B"] } });
    const { result } = render();

    await waitFor(() => expect(result.current.people).toEqual({ V1: ["A", "B"] }));
    expect(apiMock.getCommunityVoice.mock.calls.map((c) => c[0])).toEqual(["C1"]);
  });

  it("is told of every change, as the whole list", async () => {
    const { result } = render();
    await waitFor(() => expect(apiMock.getCommunityVoice).toHaveBeenCalled());
    await send("voice:participants", { channelId: "V1", participants: ["A"] });
    expect(result.current.people.V1).toEqual(["A"]);
    await send("voice:participants", { channelId: "V1", participants: ["B", "A"] });
    expect(result.current.people.V1).toEqual(["B", "A"]);
    await send("voice:participants", { channelId: "V1", participants: [] });
    expect(result.current.people.V1).toEqual([]);
  });

  it("asks again when the connection to the server comes back, since what happened meanwhile is not replayed", async () => {
    render();
    await waitFor(() => expect(apiMock.getCommunityVoice).toHaveBeenCalledTimes(1));
    await send("ws:open");
    await waitFor(() => expect(apiMock.getCommunityVoice).toHaveBeenCalledTimes(2));
  });

  it("keeps what it showed when it cannot find out, or is told not to trust the answer", async () => {
    apiMock.getCommunityVoice.mockResolvedValueOnce({ available: true, channels: { V1: ["A"] } });
    const { result } = render();
    await waitFor(() => expect(result.current.people).toEqual({ V1: ["A"] }));

    apiMock.getCommunityVoice.mockRejectedValueOnce(new Error("offline"));
    await send("ws:open");
    await waitFor(() => expect(apiMock.getCommunityVoice).toHaveBeenCalledTimes(2));
    expect(result.current.people).toEqual({ V1: ["A"] });

    apiMock.getCommunityVoice.mockResolvedValueOnce({ available: false, channels: {} });
    await send("ws:open");
    await waitFor(() => expect(apiMock.getCommunityVoice).toHaveBeenCalledTimes(3));
    expect(result.current.people).toEqual({ V1: ["A"] });
  });

  it("says voice is available unless the server said it is not, or the community is on another server", async () => {
    data.communities = [community("C1", [voiceChannel("V1")]), community("C2", [textChannel("T2")]), community("C3", [voiceChannel("V3")], "far.example")];
    const { result } = render();
    await waitFor(() => expect(apiMock.getCommunityVoice).toHaveBeenCalled());
    expect(result.current.voiceAvailable("C1")).toBe(true);
    expect(result.current.voiceAvailable("C2")).toBe(true); // never asked: the server's first answer decides
    expect(result.current.voiceAvailable("C3")).toBe(false);
    expect(result.current.voiceAvailable("NOPE")).toBe(false);

    apiMock.getCommunityVoice.mockResolvedValue({ available: false, channels: {} });
    await send("ws:open");
    await waitFor(() => expect(result.current.voiceAvailable("C1")).toBe(false));
  });
});

describe("joining a call", () => {
  it("asks for a pass to that channel, connects with it, and turns the microphone on", async () => {
    const { result } = await inCall();
    expect(apiMock.getVoiceToken).toHaveBeenCalledWith("V1");
    expect(lastRoom().connect).toHaveBeenCalledWith("wss://voice.test", "TOKEN");
    expect(lastRoom().localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);
    expect(result.current.session).toMatchObject({
      channelId: "V1",
      communityId: "C1",
      channelName: "Lounge",
      communityName: "Community C1",
      status: "connected",
      muted: false,
      deafened: false,
      micProblem: null,
    });
    expect(result.current.notice).toBeNull();
  });

  it("shows it is connecting while it connects", async () => {
    let finish: () => void = () => undefined;
    apiMock.getVoiceToken.mockReturnValue(new Promise((resolve) => (finish = () => resolve(pass))));
    const { result } = render();
    act(() => void result.current.join({ id: "V1", communityId: "C1" }));
    expect(result.current.session).toMatchObject({ channelId: "V1", status: "connecting" });
    await act(async () => finish());
    await waitFor(() => expect(result.current.session?.status).toBe("connected"));
  });

  it("asks the browser for echo cancellation, noise suppression and automatic gain, and for the remembered devices", async () => {
    localStorage.setItem("chat.voiceDevices", JSON.stringify({ input: "mic-9", output: "spk-3" }));
    await inCall();
    expect(lastRoom().options.audioCaptureDefaults).toEqual({ deviceId: "mic-9", echoCancellation: true, noiseSuppression: true, autoGainControl: true });
    expect(lastRoom().options.audioOutput).toEqual({ deviceId: "spk-3" });
  });

  it("uses the system defaults when no device was chosen", async () => {
    await inCall();
    expect(lastRoom().options.audioCaptureDefaults.deviceId).toBeUndefined();
    expect(lastRoom().options.audioOutput.deviceId).toBeUndefined();
  });

  it("says why when the server will not give a pass, and does not connect", async () => {
    apiMock.getVoiceToken.mockRejectedValue({ body: { error: "forbidden" } });
    const { result } = render();
    await act(async () => {
      await result.current.join({ id: "V1", communityId: "C1" });
    });
    expect(result.current.session).toBeNull();
    expect(result.current.notice).toMatch(/permission/);
    expect(fake.Room.instances).toHaveLength(0);
  });

  it("says so when the voice server cannot be reached, and leaves nothing open", async () => {
    fake.connectError = new Error("no route");
    const { result } = render();
    await act(async () => {
      await result.current.join({ id: "V1", communityId: "C1" });
    });
    expect(result.current.session).toBeNull();
    expect(result.current.notice).toMatch(/Couldn't connect/);
    expect(lastRoom().disconnect).toHaveBeenCalled();
  });

  it("stays in the call, listening, when the microphone cannot be used, and says why", async () => {
    fake.micError = Object.assign(new Error("denied"), { name: "NotAllowedError" });
    const { result } = await inCall();
    expect(result.current.session).toMatchObject({ status: "connected", muted: true });
    expect(result.current.session?.micProblem).toMatch(/blocked/);
    expect(result.current.notice).toBeNull();
  });

  it("does nothing when pressed again for the call already joined", async () => {
    const { result } = await inCall();
    await act(async () => {
      await result.current.join({ id: "V1", communityId: "C1" });
    });
    expect(apiMock.getVoiceToken).toHaveBeenCalledTimes(1);
    expect(fake.Room.instances).toHaveLength(1);
  });

  it("leaves the first call when another is joined: one call at a time", async () => {
    const { result } = await inCall();
    const first = lastRoom();
    await act(async () => {
      await result.current.join({ id: "V2", communityId: "C1" });
    });
    expect(first.disconnect).toHaveBeenCalled();
    expect(fake.Room.instances).toHaveLength(2);
    expect(result.current.session).toMatchObject({ channelId: "V2", channelName: "Quiet", status: "connected" });
    // The first room finishing its goodbye now is not news about the second call.
    act(() => first.emit("disconnected", 1));
    expect(result.current.session?.channelId).toBe("V2");
  });

  it("does not connect when the person left before the pass arrived", async () => {
    let arrive: (value: typeof pass) => void = () => undefined;
    apiMock.getVoiceToken.mockReturnValue(new Promise((resolve) => (arrive = resolve)));
    const { result } = render();
    act(() => void result.current.join({ id: "V1", communityId: "C1" }));
    act(() => result.current.leave());
    await act(async () => arrive(pass));
    expect(fake.Room.instances).toHaveLength(0);
    expect(result.current.session).toBeNull();
  });

  it("starts clean after a notice: a new call clears the last one's", async () => {
    apiMock.getVoiceToken.mockRejectedValueOnce({ body: { error: "forbidden" } });
    const { result } = render();
    await act(async () => {
      await result.current.join({ id: "V1", communityId: "C1" });
    });
    expect(result.current.notice).not.toBeNull();
    await act(async () => {
      await result.current.join({ id: "V1", communityId: "C1" });
    });
    expect(result.current.notice).toBeNull();
    expect(result.current.session?.status).toBe("connected");
  });

  it("lets the notice be dismissed", async () => {
    apiMock.getVoiceToken.mockRejectedValue({ body: { error: "forbidden" } });
    const { result } = render();
    await act(async () => {
      await result.current.join({ id: "V1", communityId: "C1" });
    });
    act(() => result.current.dismissNotice());
    expect(result.current.notice).toBeNull();
  });
});

describe("leaving, and being put out", () => {
  it("ends the call quietly when the person leaves", async () => {
    const { result } = await inCall();
    const room = lastRoom();
    act(() => result.current.leave());
    expect(room.disconnect).toHaveBeenCalled();
    expect(result.current.session).toBeNull();
    expect(result.current.notice).toBeNull();
    expect(document.querySelectorAll("audio")).toHaveLength(0);
  });

  it("says so when the server ends it: removed from the community, the channel deleted, joined from somewhere else", async () => {
    for (const [reason, words] of [[4, /removed/], [5, /deleted/], [2, /somewhere else/], [3, /disconnected/]] as const) {
      const { result } = await inCall();
      act(() => lastRoom().emit("disconnected", reason));
      expect(result.current.session).toBeNull();
      expect(result.current.notice, String(reason)).toMatch(words);
      cleanup();
    }
  });

  it("says nothing when the end is the person's own", async () => {
    const { result } = await inCall();
    act(() => lastRoom().emit("disconnected", 1));
    expect(result.current.session).toBeNull();
    expect(result.current.notice).toBeNull();
  });

  it("ends the call when the app goes away (signing out)", async () => {
    const { unmount } = await inCall();
    const room = lastRoom();
    unmount();
    expect(room.disconnect).toHaveBeenCalled();
  });
});

describe("the microphone", () => {
  it("is turned off and on from the call", async () => {
    const { result } = await inCall();
    await act(async () => result.current.setMuted(true));
    expect(lastRoom().localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(false);
    expect(result.current.session?.muted).toBe(true);
    await act(async () => result.current.setMuted(false));
    expect(lastRoom().localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(true);
    expect(result.current.session?.muted).toBe(false);
  });

  it("stays off and says why when it cannot be turned on again", async () => {
    const { result } = await inCall();
    await act(async () => result.current.setMuted(true));
    fake.micError = Object.assign(new Error("busy"), { name: "NotReadableError" });
    await act(async () => result.current.setMuted(false));
    expect(result.current.session).toMatchObject({ muted: true });
    expect(result.current.session?.micProblem).toMatch(/in use/);
  });

  it("forgets an old problem once the microphone works", async () => {
    fake.micError = Object.assign(new Error("denied"), { name: "NotAllowedError" });
    const { result } = await inCall();
    expect(result.current.session?.micProblem).not.toBeNull();
    fake.micError = null;
    await act(async () => result.current.setMuted(false));
    expect(result.current.session).toMatchObject({ muted: false, micProblem: null });
  });

  it("is ignored with no call", async () => {
    const { result } = render();
    await act(async () => result.current.setMuted(true));
    expect(result.current.session).toBeNull();
  });
});

describe("deafening", () => {
  const playing = () => [...document.querySelectorAll("audio")] as HTMLAudioElement[];
  const subscribe = (room: ReturnType<typeof lastRoom>) => {
    const element = document.createElement("audio");
    const track = { kind: "audio", attach: vi.fn(() => element), detach: vi.fn(() => [element]) };
    act(() => room.emit("trackSubscribed", track));
    return { track, element };
  };

  it("plays other people's audio from the call, out of sight", async () => {
    await inCall();
    const { element } = subscribe(lastRoom());
    expect(element.isConnected).toBe(true);
    expect(element.muted).toBe(false);
    expect(element.parentElement?.getAttribute("aria-hidden")).toBe("true");
  });

  it("ignores a track that is not audio", async () => {
    await inCall();
    const track = { kind: "video", attach: vi.fn(), detach: vi.fn() };
    act(() => lastRoom().emit("trackSubscribed", track));
    expect(track.attach).not.toHaveBeenCalled();
  });

  it("removes a person's audio when they stop sending it", async () => {
    await inCall();
    const { track, element } = subscribe(lastRoom());
    act(() => lastRoom().emit("trackUnsubscribed", track));
    expect(element.isConnected).toBe(false);
  });

  it("silences everyone and turns the microphone off, and puts the microphone back as it was", async () => {
    const { result } = await inCall();
    const { element } = subscribe(lastRoom());
    act(() => result.current.setDeafened(true));
    expect(element.muted).toBe(true);
    expect(result.current.session).toMatchObject({ deafened: true, muted: true });
    expect(lastRoom().localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(false);

    act(() => result.current.setDeafened(false));
    expect(element.muted).toBe(false);
    expect(result.current.session).toMatchObject({ deafened: false, muted: false });
    expect(lastRoom().localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(true);
  });

  it("leaves the microphone off after un-deafening when it was off before", async () => {
    const { result } = await inCall();
    await act(async () => result.current.setMuted(true));
    act(() => result.current.setDeafened(true));
    act(() => result.current.setDeafened(false));
    expect(result.current.session).toMatchObject({ deafened: false, muted: true });
    expect(lastRoom().localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(false);
  });

  it("silences people who join the call while deafened", async () => {
    const { result } = await inCall();
    act(() => result.current.setDeafened(true));
    const { element } = subscribe(lastRoom());
    expect(element.muted).toBe(true);
  });

  it("ends the deafening when the person turns their microphone on, since you cannot talk to people you chose not to hear", async () => {
    const { result } = await inCall();
    const { element } = subscribe(lastRoom());
    act(() => result.current.setDeafened(true));
    await act(async () => result.current.setMuted(false));
    expect(result.current.session).toMatchObject({ deafened: false, muted: false });
    expect(element.muted).toBe(false);
  });

  it("is forgotten between calls", async () => {
    const { result } = await inCall();
    act(() => result.current.setDeafened(true));
    act(() => result.current.leave());
    await act(async () => {
      await result.current.join({ id: "V1", communityId: "C1" });
    });
    const { element } = subscribe(lastRoom());
    expect(element.muted).toBe(false);
    expect(result.current.session?.deafened).toBe(false);
    expect(playing()).toHaveLength(1);
  });
});

describe("what is going on in the call", () => {
  it("says who is speaking", async () => {
    const { result } = await inCall();
    act(() => lastRoom().emit("activeSpeakersChanged", [{ identity: "A" }, { identity: "B" }]));
    expect([...result.current.speaking].sort()).toEqual(["A", "B"]);
    act(() => lastRoom().emit("activeSpeakersChanged", []));
    expect(result.current.speaking.size).toBe(0);
  });

  it("says who has their microphone off, from what others do and from who was already in the call", async () => {
    // Someone already in the room with their microphone off when this person joins.
    fake.whenConnected = (room) => {
      room.remoteParticipants.set("EARLY", new fake.Participant("EARLY", false, true));
      room.remoteParticipants.set("LOUD", new fake.Participant("LOUD", false, false));
    };
    const view = await inCall();
    expect([...view.result.current.micOff]).toEqual(["EARLY"]);

    const audio = (muted: boolean) => ({ kind: "audio", isMuted: muted });
    act(() => lastRoom().emit("trackMuted", audio(true), { identity: "LOUD", isLocal: false }));
    expect([...view.result.current.micOff].sort()).toEqual(["EARLY", "LOUD"]);
    act(() => lastRoom().emit("trackUnmuted", audio(false), { identity: "EARLY", isLocal: false }));
    expect([...view.result.current.micOff]).toEqual(["LOUD"]);
    // Not about this person's own microphone, and not about something other than audio.
    act(() => lastRoom().emit("trackMuted", audio(true), { identity: "ME", isLocal: true }));
    act(() => lastRoom().emit("trackMuted", { kind: "video", isMuted: true }, { identity: "CAM", isLocal: false }));
    expect([...view.result.current.micOff]).toEqual(["LOUD"]);
    // Gone from the call: gone from the list.
    act(() => lastRoom().emit("participantDisconnected", { identity: "LOUD" }));
    expect(view.result.current.micOff.size).toBe(0);
  });

  it("shows when the connection to the call drops and comes back", async () => {
    const { result } = await inCall();
    act(() => lastRoom().emit("reconnecting"));
    expect(result.current.session?.status).toBe("reconnecting");
    act(() => lastRoom().emit("reconnected"));
    expect(result.current.session?.status).toBe("connected");
  });

  it("asks for a click when the browser will not play audio by itself, and plays once it has one", async () => {
    const { result } = await inCall();
    lastRoom().canPlaybackAudio = false;
    act(() => lastRoom().emit("audioPlaybackChanged"));
    expect(result.current.session?.audioBlocked).toBe(true);
    await act(async () => result.current.allowAudio());
    expect(lastRoom().startAudio).toHaveBeenCalled();
    expect(result.current.session?.audioBlocked).toBe(false);
  });

  it("turns the microphone off and says why when the browser reports a problem with it", async () => {
    const { result } = await inCall();
    act(() => lastRoom().emit("mediaDevicesError", Object.assign(new Error("gone"), { name: "NotFoundError" })));
    expect(result.current.session).toMatchObject({ muted: true });
    expect(result.current.session?.micProblem).toMatch(/No microphone/);
  });

  it("clears who is speaking and who is muted when the call ends", async () => {
    const { result } = await inCall();
    act(() => lastRoom().emit("activeSpeakersChanged", [{ identity: "A" }]));
    act(() => result.current.leave());
    expect(result.current.speaking.size).toBe(0);
    expect(result.current.micOff.size).toBe(0);
  });
});

describe("choosing a microphone and a speaker", () => {
  it("switches the device in the call, and remembers it for the next one", async () => {
    const { result } = await inCall();
    await act(async () => result.current.chooseInput("mic-2"));
    expect(lastRoom().switchActiveDevice).toHaveBeenLastCalledWith("audioinput", "mic-2");
    await act(async () => result.current.chooseOutput("spk-2"));
    expect(lastRoom().switchActiveDevice).toHaveBeenLastCalledWith("audiooutput", "spk-2");
    expect(JSON.parse(localStorage.getItem("chat.voiceDevices")!)).toEqual({ input: "mic-2", output: "spk-2" });
    expect(result.current.devices.prefs).toEqual({ input: "mic-2", output: "spk-2" });
  });

  it("goes back to the system's own with no choice, in the call and for the next one", async () => {
    localStorage.setItem("chat.voiceDevices", JSON.stringify({ input: "mic-2", output: "spk-2" }));
    const { result } = await inCall();
    await act(async () => result.current.chooseInput(null));
    expect(lastRoom().switchActiveDevice).toHaveBeenLastCalledWith("audioinput", "default");
    await act(async () => result.current.chooseOutput(null));
    expect(lastRoom().switchActiveDevice).toHaveBeenLastCalledWith("audiooutput", "default");
    expect(localStorage.getItem("chat.voiceDevices")).toBeNull();
  });

  it("is remembered with no call going, for the next one", async () => {
    const { result } = render();
    await act(async () => result.current.chooseInput("mic-5"));
    expect(JSON.parse(localStorage.getItem("chat.voiceDevices")!)).toEqual({ input: "mic-5", output: null });
    await act(async () => {
      await result.current.join({ id: "V1", communityId: "C1" });
    });
    expect(lastRoom().options.audioCaptureDefaults.deviceId).toBe("mic-5");
  });

  it("does not let a failing switch break the call", async () => {
    const { result } = await inCall();
    lastRoom().switchActiveDevice.mockRejectedValueOnce(new Error("gone"));
    await act(async () => result.current.chooseInput("mic-2"));
    expect(result.current.session?.status).toBe("connected");
  });

  it("lists the devices this computer has", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: async () => [
          { kind: "audioinput", deviceId: "m1", label: "Headset" },
          { kind: "audiooutput", deviceId: "s1", label: "Speakers" },
        ],
      },
    });
    const { result } = render();
    await act(async () => result.current.refreshDevices());
    expect(result.current.devices.inputs).toEqual([{ id: "m1", label: "Headset" }]);
    expect(result.current.devices.outputs).toEqual([{ id: "s1", label: "Speakers" }]);
    vi.unstubAllGlobals();
  });
});

describe("outside the app's provider", () => {
  it("is a world with no voice, rather than an error, so a page rendered on its own works", () => {
    const { result } = renderHook(() => useVoice());
    expect(result.current.session).toBeNull();
    expect(result.current.people).toEqual({});
    expect(result.current.voiceAvailable("C1")).toBe(false);
  });
});
