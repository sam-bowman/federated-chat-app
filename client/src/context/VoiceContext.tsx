import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Room } from "livekit-client";
import * as api from "../api";
import type { Community } from "../api";
import { domainOf } from "../lib/permissions";
import { callEndedMessage, joinFailureMessage, microphoneMessage } from "../lib/voiceMessages";
import { listAudioDevices, loadVoiceDevices, saveVoiceDevices, type AudioDevice, type VoiceDevicePrefs } from "../lib/voiceDevices";
import { mergeCommunityVoice, setChannelPeople, type VoicePeople } from "../lib/voiceChannels";
import { useAppData } from "./AppDataContext";
import { useAuth } from "./AuthContext";
import { useWs } from "./WsContext";

// Voice channels (#53). The audio goes between this device and a LiveKit server (never through ours): this module asks our
// server for a pass to one channel's room, connects, plays what others say, and sends the microphone. It also keeps the lists of
// who is in each voice channel, which come from our server (told by LiveKit) whether or not this person is in a call.
//
// One call at a time. Livekit-client is large, so it is only loaded when someone first joins a call.

export interface VoiceSession {
  channelId: string;
  communityId: string;
  channelName: string;
  communityName: string;
  status: "connecting" | "connected" | "reconnecting";
  /** The microphone is off (by choice, by deafening, or because it could not be used). */
  muted: boolean;
  /** Nobody else is played. */
  deafened: boolean;
  /** Why the microphone is not working, if it is not: shown to the person, who can still listen. */
  micProblem: string | null;
  /** The browser is not letting call audio play yet (it wants a click). */
  audioBlocked: boolean;
}

interface VoiceContextValue {
  /** Who is in each voice channel, by channel id (people's ids). */
  people: VoicePeople;
  /** False where voice cannot be used in this community (no voice server, or it lives on another server). */
  voiceAvailable: (communityId: string) => boolean;
  session: VoiceSession | null;
  /** In the call this person is in: who is speaking now, and who has their microphone off (by id). */
  speaking: ReadonlySet<string>;
  micOff: ReadonlySet<string>;
  /** Why the last call ended, or could not start; null once dismissed or a new call starts. */
  notice: string | null;
  dismissNotice: () => void;
  join: (channel: { id: string; communityId: string }) => Promise<void>;
  leave: () => void;
  setMuted: (muted: boolean) => Promise<void>;
  setDeafened: (deafened: boolean) => void;
  /** Lets the browser play call audio after it refused to (it wanted a click). */
  allowAudio: () => Promise<void>;
  devices: { inputs: AudioDevice[]; outputs: AudioDevice[]; prefs: VoiceDevicePrefs };
  refreshDevices: () => Promise<void>;
  chooseInput: (id: string | null) => Promise<void>;
  chooseOutput: (id: string | null) => Promise<void>;
}

const VoiceContext = createContext<VoiceContextValue | null>(null);

const NONE: ReadonlySet<string> = new Set();

/** True for a community whose home server is not this person's own: its voice rooms are not on a server they can ask. */
function hostedElsewhere(community: Community, selfIdentity: string): boolean {
  return community.homeserverDomain.toLowerCase() !== domainOf(selfIdentity);
}

export function VoiceProvider({ children }: { children: ReactNode }) {
  const { subscribe } = useWs();
  const { communities } = useAppData();
  const { user } = useAuth();

  const [people, setPeople] = useState<VoicePeople>({});
  const [availability, setAvailability] = useState<Record<string, boolean>>({});
  const [session, setSession] = useState<VoiceSession | null>(null);
  const [speaking, setSpeaking] = useState<ReadonlySet<string>>(NONE);
  const [micOff, setMicOff] = useState<ReadonlySet<string>>(NONE);
  const [notice, setNotice] = useState<string | null>(null);
  const [devices, setDevices] = useState<{ inputs: AudioDevice[]; outputs: AudioDevice[]; prefs: VoiceDevicePrefs }>(() => ({
    inputs: [],
    outputs: [],
    prefs: loadVoiceDevices(),
  }));

  const roomRef = useRef<Room | null>(null);
  const audioElements = useRef(new Set<HTMLMediaElement>());
  const audioHost = useRef<HTMLDivElement | null>(null);
  const deafenedRef = useRef(false);
  /** Whether the microphone was off before deafening, which un-deafening puts back. */
  const mutedBeforeDeafen = useRef(false);
  /** Each join gets a number, so a join that was overtaken (by a leave or another join) can tell and stop. */
  const joinNumber = useRef(0);
  /** The channel the current call is in, readable inside `join` without it depending on `session`. */
  const sessionChannel = useRef<string | null>(null);
  // What the callbacks below read when they run, kept current after each render (they are not recreated for every change).
  const prefsRef = useRef(devices.prefs);
  const communitiesRef = useRef(communities);
  useEffect(() => {
    prefsRef.current = devices.prefs;
    communitiesRef.current = communities;
  });

  // --- who is in each voice channel -----------------------------------------------------------------------------------
  // Asked for the communities that have a voice channel on this person's own server, when they appear or change and again
  // whenever the connection to our server comes back (events missed in between are not replayed).
  const voiceCommunityIds = useMemo(
    () =>
      user
        ? communities
            .filter((c) => !hostedElsewhere(c, user.identity) && c.channels.some((ch) => ch.type === "VOICE"))
            .map((c) => c.id)
            .sort()
            .join(",")
        : "",
    [communities, user]
  );

  const refreshPeople = useCallback(async (communityIds: string[]) => {
    await Promise.all(
      communityIds.map(async (id) => {
        try {
          const answer = await api.getCommunityVoice(id);
          setAvailability((prev) => (prev[id] === answer.available ? prev : { ...prev, [id]: answer.available }));
          setPeople((prev) => mergeCommunityVoice(prev, answer));
        } catch {
          // Not known right now: what was shown stays.
        }
      })
    );
  }, []);

  useEffect(() => {
    if (voiceCommunityIds) void refreshPeople(voiceCommunityIds.split(","));
  }, [voiceCommunityIds, refreshPeople]);

  useEffect(() => {
    const unsubs = [
      subscribe("voice:participants", (event: { channelId: string; participants: string[] }) => {
        setPeople((prev) => setChannelPeople(prev, event.channelId, event.participants));
      }),
      subscribe("ws:open", () => {
        if (voiceCommunityIds) void refreshPeople(voiceCommunityIds.split(","));
      }),
    ];
    return () => unsubs.forEach((u) => u());
  }, [subscribe, voiceCommunityIds, refreshPeople]);

  const voiceAvailable = useCallback(
    (communityId: string) => {
      const community = communitiesRef.current.find((c) => c.id === communityId);
      if (!community || !user || hostedElsewhere(community, user.identity)) return false;
      // Not asked yet counts as available (a community with no voice channel is never asked): the answer to the first request
      // decides, and a server with no voice says so then.
      return availability[communityId] !== false;
    },
    [availability, user]
  );

  // --- the call --------------------------------------------------------------------------------------------------------
  const applyDeafened = useCallback((deafened: boolean) => {
    deafenedRef.current = deafened;
    audioElements.current.forEach((el) => {
      el.muted = deafened;
    });
  }, []);

  const clearCall = useCallback(() => {
    audioElements.current.forEach((el) => el.remove());
    audioElements.current.clear();
    deafenedRef.current = false;
    mutedBeforeDeafen.current = false;
    setSpeaking(NONE);
    setMicOff(NONE);
  }, []);

  const hostElement = () => {
    if (!audioHost.current) {
      const host = document.createElement("div");
      host.setAttribute("aria-hidden", "true");
      host.style.display = "none";
      document.body.appendChild(host);
      audioHost.current = host;
    }
    return audioHost.current;
  };

  const leave = useCallback(() => {
    joinNumber.current++;
    const room = roomRef.current;
    roomRef.current = null;
    sessionChannel.current = null;
    room?.disconnect();
    clearCall();
    setSession(null);
  }, [clearCall]);

  const refreshDevices = useCallback(async () => {
    const found = await listAudioDevices();
    setDevices((prev) => ({ ...prev, ...found }));
  }, []);

  const join = useCallback(
    async (channel: { id: string; communityId: string }) => {
      // Already in this call (or joining it): clicking it again does nothing.
      if (sessionChannel.current === channel.id) return;
      leave();
      const mine = ++joinNumber.current;
      setNotice(null);

      const community = communitiesRef.current.find((c) => c.id === channel.communityId);
      const found = community?.channels.find((c) => c.id === channel.id);
      sessionChannel.current = channel.id;
      setSession({
        channelId: channel.id,
        communityId: channel.communityId,
        channelName: found?.name ?? "voice",
        communityName: community?.name ?? "",
        status: "connecting",
        muted: false,
        deafened: false,
        micProblem: null,
        audioBlocked: false,
      });

      const abandon = (message: string | null) => {
        if (joinNumber.current !== mine) return;
        sessionChannel.current = null;
        roomRef.current?.disconnect();
        roomRef.current = null;
        clearCall();
        setSession(null);
        if (message) setNotice(message);
      };

      let pass: api.VoiceToken;
      try {
        pass = await api.getVoiceToken(channel.id);
      } catch (err) {
        return abandon(joinFailureMessage(err));
      }
      if (joinNumber.current !== mine) return;

      let livekit: typeof import("livekit-client");
      try {
        livekit = await import("livekit-client");
      } catch {
        return abandon("Couldn't load voice. Check your connection and try again.");
      }
      if (joinNumber.current !== mine) return;

      const prefs = prefsRef.current;
      const room = new livekit.Room({
        audioCaptureDefaults: {
          deviceId: prefs.input ?? undefined,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        audioOutput: { deviceId: prefs.output ?? undefined },
      });
      roomRef.current = room;

      room.on(livekit.RoomEvent.TrackSubscribed, (track) => {
        if (track.kind !== livekit.Track.Kind.Audio) return;
        const element = track.attach();
        element.muted = deafenedRef.current;
        hostElement().appendChild(element);
        audioElements.current.add(element);
      });
      room.on(livekit.RoomEvent.TrackUnsubscribed, (track) => {
        track.detach().forEach((element) => {
          audioElements.current.delete(element);
          element.remove();
        });
      });
      room.on(livekit.RoomEvent.ActiveSpeakersChanged, (speakers) => setSpeaking(new Set(speakers.map((s) => s.identity))));
      const trackMutedChanged = (publication: { kind: string; isMuted: boolean }, participant: { identity: string; isLocal: boolean }) => {
        if (participant.isLocal || publication.kind !== "audio") return;
        setMicOff((prev) => {
          const next = new Set(prev);
          if (publication.isMuted) next.add(participant.identity);
          else next.delete(participant.identity);
          return next;
        });
      };
      room.on(livekit.RoomEvent.TrackMuted, trackMutedChanged);
      room.on(livekit.RoomEvent.TrackUnmuted, trackMutedChanged);
      room.on(livekit.RoomEvent.ParticipantDisconnected, (participant) =>
        setMicOff((prev) => {
          if (!prev.has(participant.identity)) return prev;
          const next = new Set(prev);
          next.delete(participant.identity);
          return next;
        })
      );
      room.on(livekit.RoomEvent.Reconnecting, () => setSession((s) => (s && roomRef.current === room ? { ...s, status: "reconnecting" } : s)));
      room.on(livekit.RoomEvent.Reconnected, () => setSession((s) => (s && roomRef.current === room ? { ...s, status: "connected" } : s)));
      room.on(livekit.RoomEvent.AudioPlaybackStatusChanged, () =>
        setSession((s) => (s && roomRef.current === room ? { ...s, audioBlocked: !room.canPlaybackAudio } : s))
      );
      room.on(livekit.RoomEvent.MediaDevicesError, (error) =>
        setSession((s) => (s && roomRef.current === room ? { ...s, muted: true, micProblem: microphoneMessage(error) } : s))
      );
      room.on(livekit.RoomEvent.Disconnected, (reason) => {
        // Only the call that is current: an old room finishing its goodbye after another was joined is not news.
        if (roomRef.current !== room) return;
        roomRef.current = null;
        sessionChannel.current = null;
        clearCall();
        setSession(null);
        const message = callEndedMessage(reason as number | undefined);
        if (message) setNotice(message);
      });

      try {
        await room.connect(pass.url, pass.token);
      } catch {
        return abandon("Couldn't connect to the voice server. Try again.");
      }
      if (joinNumber.current !== mine) {
        room.disconnect();
        return;
      }
      setSession((s) => (s ? { ...s, status: "connected", audioBlocked: !room.canPlaybackAudio } : s));
      // Anyone already in the room with their microphone off.
      setMicOff(
        new Set(
          [...room.remoteParticipants.values()].filter((p) => p.getTrackPublications().some((t) => t.kind === "audio" && t.isMuted)).map((p) => p.identity)
        )
      );

      try {
        await room.localParticipant.setMicrophoneEnabled(true);
      } catch (err) {
        // The call goes on: the person can listen.
        setSession((s) => (s && joinNumber.current === mine ? { ...s, muted: true, micProblem: microphoneMessage(err) } : s));
      }
      void refreshDevices();
    },
    [leave, clearCall, refreshDevices]
  );

  const setMuted = useCallback(
    async (muted: boolean) => {
      const room = roomRef.current;
      if (!room) return;
      // Turning the microphone on while deafened ends the deafening: you cannot talk to people you have chosen not to hear.
      if (!muted && deafenedRef.current) {
        applyDeafened(false);
        setSession((s) => (s ? { ...s, deafened: false } : s));
      }
      try {
        await room.localParticipant.setMicrophoneEnabled(!muted);
        setSession((s) => (s ? { ...s, muted, micProblem: muted ? s.micProblem : null } : s));
      } catch (err) {
        setSession((s) => (s ? { ...s, muted: true, micProblem: microphoneMessage(err) } : s));
      }
    },
    [applyDeafened]
  );

  const setDeafened = useCallback(
    (deafened: boolean) => {
      const room = roomRef.current;
      if (!room || deafenedRef.current === deafened) return;
      applyDeafened(deafened);
      if (deafened) {
        // Deafening also turns the microphone off; un-deafening puts it back as it was.
        mutedBeforeDeafen.current = !room.localParticipant.isMicrophoneEnabled;
        void room.localParticipant.setMicrophoneEnabled(false).catch(() => undefined);
        setSession((s) => (s ? { ...s, deafened: true, muted: true } : s));
      } else {
        const wasMuted = mutedBeforeDeafen.current;
        if (!wasMuted) void room.localParticipant.setMicrophoneEnabled(true).catch(() => undefined);
        setSession((s) => (s ? { ...s, deafened: false, muted: wasMuted } : s));
      }
    },
    [applyDeafened]
  );

  const allowAudio = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    await room.startAudio();
    setSession((s) => (s ? { ...s, audioBlocked: !room.canPlaybackAudio } : s));
  }, []);

  const chooseInput = useCallback(async (id: string | null) => {
    const prefs = { ...prefsRef.current, input: id };
    saveVoiceDevices(prefs);
    setDevices((prev) => ({ ...prev, prefs }));
    const room = roomRef.current;
    // No choice is "the system default", which is also how to go back to it.
    if (room) await room.switchActiveDevice("audioinput", id ?? "default").catch(() => undefined);
  }, []);

  const chooseOutput = useCallback(async (id: string | null) => {
    const prefs = { ...prefsRef.current, output: id };
    saveVoiceDevices(prefs);
    setDevices((prev) => ({ ...prev, prefs }));
    const room = roomRef.current;
    if (room) await room.switchActiveDevice("audiooutput", id ?? "default").catch(() => undefined);
  }, []);

  // A microphone or speaker plugged in or out.
  useEffect(() => {
    const media = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    if (!media?.addEventListener) return;
    const changed = () => void refreshDevices();
    media.addEventListener("devicechange", changed);
    return () => media.removeEventListener("devicechange", changed);
  }, [refreshDevices]);

  // Signing out, or leaving the app, ends the call.
  useEffect(
    () => () => {
      joinNumber.current++;
      roomRef.current?.disconnect();
      roomRef.current = null;
      audioElements.current.forEach((el) => el.remove());
      audioHost.current?.remove();
    },
    []
  );

  const value: VoiceContextValue = {
    people,
    voiceAvailable,
    session,
    speaking,
    micOff,
    notice,
    dismissNotice: () => setNotice(null),
    join,
    leave,
    setMuted,
    setDeafened,
    allowAudio,
    devices,
    refreshDevices,
    chooseInput,
    chooseOutput,
  };
  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>;
}

/** The voice state. Outside the provider (a page rendered on its own, a test) there is no voice: nobody is in any channel. */
const NO_VOICE: VoiceContextValue = {
  people: {},
  voiceAvailable: () => false,
  session: null,
  speaking: NONE,
  micOff: NONE,
  notice: null,
  dismissNotice: () => undefined,
  join: async () => undefined,
  leave: () => undefined,
  setMuted: async () => undefined,
  setDeafened: () => undefined,
  allowAudio: async () => undefined,
  devices: { inputs: [], outputs: [], prefs: { input: null, output: null } },
  refreshDevices: async () => undefined,
  chooseInput: async () => undefined,
  chooseOutput: async () => undefined,
};

export function useVoice(): VoiceContextValue {
  return useContext(VoiceContext) ?? NO_VOICE;
}
