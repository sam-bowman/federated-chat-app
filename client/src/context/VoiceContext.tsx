import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { RemoteAudioTrack, Room, Track } from "livekit-client";
import * as api from "../api";
import type { Community } from "../api";
import { getHomeServer } from "../api/client";
import { fetchServerInfo } from "../api/discovery";
import { domainOf } from "../lib/permissions";
import { callEndedMessage, joinFailureMessage, microphoneMessage } from "../lib/voiceMessages";
import { listAudioDevices, loadVoiceDevices, saveVoiceDevices, type AudioDevice, type VoiceDevicePrefs } from "../lib/voiceDevices";
import { mergeCommunityVoice, setChannelPeople, unknownVoiceMembers, type VoicePeople } from "../lib/voiceChannels";
import { canCallConversation, conversationName, incomingCalls, mergeCalls, type IncomingCall } from "../lib/voiceCalls";
import { MicrophoneLevel } from "../lib/micLevel";
import type { StatEntry } from "../lib/callQuality";
import { loadVoiceAudio, playbackVolume, saveVoiceAudio, withPerson, clampPercent, type PersonVolume, type VoiceAudioPrefs } from "../lib/voiceAudio";
import { useAppData } from "./AppDataContext";
import { useAuth } from "./AuthContext";
import { useWs } from "./WsContext";

// Voice channels (#53). The audio goes between this device and a LiveKit server (never through ours): this module asks our
// server for a pass to one channel's room, connects, plays what others say, and sends the microphone. It also keeps the lists of
// who is in each voice channel, which come from our server (told by LiveKit) whether or not this person is in a call.
//
// One call at a time. Livekit-client is large, so it is only loaded when someone first joins a call.

export interface VoiceSession {
  /** A voice channel of a community, or the call in a direct or group conversation. */
  kind: "channel" | "conversation";
  /** The room: the channel's id, or the conversation's id. */
  channelId: string;
  communityId: string;
  /** The channel's name, or who the call is with. */
  channelName: string;
  /** Empty for a call in a conversation. */
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
  /** Starts or joins the call in a direct or group conversation. */
  joinCall: (conversationId: string) => Promise<void>;
  /** The server has voice, so calls in conversations are offered at all. */
  callsOffered: boolean;
  /** Calls can be made right now (the voice server answered); false means it is not known to work, so the button is off. */
  callsAvailable: boolean;
  /** Calls others are in that this person could answer, and which of them have only just started (those ring). */
  incoming: IncomingCall[];
  ringing: ReadonlySet<string>;
  /** Puts an incoming call away (it comes back only as a new call, once the current one has ended). */
  dismissCall: (conversationId: string) => void;
  leave: () => void;
  setMuted: (muted: boolean) => Promise<void>;
  setDeafened: (deafened: boolean) => void;
  /** Lets the browser play call audio after it refused to (it wanted a click). */
  allowAudio: () => Promise<void>;
  devices: { inputs: AudioDevice[]; outputs: AudioDevice[]; prefs: VoiceDevicePrefs };
  refreshDevices: () => Promise<void>;
  chooseInput: (id: string | null) => Promise<void>;
  chooseOutput: (id: string | null) => Promise<void>;
  /** How voice sounds, remembered on this device: see lib/voiceAudio.ts. */
  audio: VoiceAudioPrefs;
  /** How loud the microphone is for everyone (0-200), changed live in a call. */
  setInputVolume: (percent: number) => void;
  /** The browser's own echo cancellation, noise suppression and automatic gain; changed live in a call. */
  setProcessing: (key: "echoCancellation" | "noiseSuppression" | "autoGainControl", on: boolean) => Promise<void>;
  /** How loud everyone is for this person only (0-200). */
  setOutputVolume: (percent: number) => void;
  /** One person's volume and mute for this person only, by identity (@user:domain). */
  setPerson: (identity: string, change: Partial<PersonVolume>) => void;
  /** Puts everyone back to 100% and unmuted. */
  resetPeople: () => void;
  /** The connection statistics of the call right now, raw (see lib/callQuality.ts), or null when not in a call. */
  sampleCallStats: () => Promise<CallStatsSample | null>;
}

/** What the browser says about the call's connections: the one the microphone goes out on, and one per person being heard. */
export interface CallStatsSample {
  sent: StatEntry[] | null;
  received: StatEntry[][];
}

const VoiceContext = createContext<VoiceContextValue | null>(null);

const NONE: ReadonlySet<string> = new Set();

/** livekit's name for the microphone as a source of audio, without loading the library to read it. */
const MICROPHONE = "microphone" as Track.Source;

/** True for a community whose home server is not this person's own: its voice rooms are not on a server they can ask. */
function hostedElsewhere(community: Community, selfIdentity: string): boolean {
  return community.homeserverDomain.toLowerCase() !== domainOf(selfIdentity);
}

export function VoiceProvider({ children }: { children: ReactNode }) {
  const { subscribe } = useWs();
  const { communities, conversations, refreshCommunities } = useAppData();
  const { user } = useAuth();

  const [people, setPeople] = useState<VoicePeople>({});
  const [callsOffered, setCallsOffered] = useState(false);
  const [callsAvailable, setCallsAvailable] = useState(false);
  const [ringing, setRinging] = useState<ReadonlySet<string>>(NONE);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(NONE);
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

  const [audio, setAudio] = useState<VoiceAudioPrefs>(loadVoiceAudio);

  const roomRef = useRef<Room | null>(null);
  /** What plays each person (by their id here), so their volume can be changed while they talk. */
  const remoteTracks = useRef(new Map<string, RemoteAudioTrack>());
  /** The gain and limiter on the microphone being sent, once there is one. */
  const microphone = useRef<MicrophoneLevel | null>(null);
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
  const conversationsRef = useRef(conversations);
  const peopleRef = useRef(people);
  const userRef = useRef(user);
  const refreshCommunitiesRef = useRef(refreshCommunities);
  /** The people we last asked the server about because the member list did not have them (see below). */
  const askedAbout = useRef("");
  const audioRef = useRef(audio);
  useEffect(() => {
    prefsRef.current = devices.prefs;
    communitiesRef.current = communities;
    conversationsRef.current = conversations;
    peopleRef.current = people;
    userRef.current = user;
    refreshCommunitiesRef.current = refreshCommunities;
    audioRef.current = audio;
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

  // Someone in a voice channel who is not in the community's cached member list joined after it was loaded (nothing used to tell
  // this device when people join): fetch the communities again, once for each new set of such people (#220).
  const unknownMembers = useMemo(() => unknownVoiceMembers(people, communities), [people, communities]);
  useEffect(() => {
    if (!unknownMembers) {
      askedAbout.current = "";
      return;
    }
    if (unknownMembers === askedAbout.current) return;
    askedAbout.current = unknownMembers;
    void Promise.resolve(refreshCommunitiesRef.current?.()).catch(() => undefined);
  }, [unknownMembers]);

  // --- who is in each call in a conversation ---------------------------------------------------------------------------
  // The conversations a call could be in, by id (comma-joined so it only changes when the set does).
  const callableIds = useMemo(
    () => (user ? conversations.filter((c) => canCallConversation(c, user.identity)).map((c) => c.id).sort().join(",") : ""),
    [conversations, user]
  );

  // Whether this server has voice at all, from its discovery document (the same place the "new voice channel" choice asks).
  useEffect(() => {
    const origin = getHomeServer()?.origin;
    if (!origin) return;
    let current = true;
    fetchServerInfo(origin)
      .then((info) => current && setCallsOffered(info.voiceEnabled === true))
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [user?.id]);

  const refreshCalls = useCallback(async (ids: string[]) => {
    try {
      const answer = await api.getConversationCalls();
      setCallsAvailable(answer.available);
      setPeople((prev) => mergeCalls(prev, answer, ids));
    } catch {
      // Not known right now: what was shown stays.
    }
  }, []);

  useEffect(() => {
    if (callableIds) void refreshCalls(callableIds.split(","));
  }, [callableIds, refreshCalls]);

  useEffect(() => {
    const unsubs = [
      subscribe("voice:participants", (event: { channelId?: string; conversationId?: string; participants: string[] }) => {
        const id = event.channelId ?? event.conversationId;
        if (!id) return;
        // A call in a conversation has just started when it had nobody and now has someone who is not this person: it rings.
        if (
          event.conversationId &&
          (peopleRef.current[id]?.length ?? 0) === 0 &&
          event.participants.length > 0 &&
          !event.participants.includes(userRef.current?.id ?? "")
        ) {
          setRinging((prev) => new Set(prev).add(id));
        }
        setPeople((prev) => setChannelPeople(prev, id, event.participants));
      }),
      subscribe("ws:open", () => {
        if (voiceCommunityIds) void refreshPeople(voiceCommunityIds.split(","));
        if (callableIds) void refreshCalls(callableIds.split(","));
      }),
    ];
    return () => unsubs.forEach((u) => u());
  }, [subscribe, voiceCommunityIds, refreshPeople, callableIds, refreshCalls]);

  // A call that has ended, or that this person is now in, no longer rings or waits to be put away.
  useEffect(() => {
    const over = (id: string) => (people[id]?.length ?? 0) === 0 || people[id].includes(user?.id ?? "");
    const drop = (prev: ReadonlySet<string>) => {
      const stale = [...prev].filter(over);
      if (stale.length === 0) return prev;
      const next = new Set(prev);
      stale.forEach((id) => next.delete(id));
      return next;
    };
    setRinging(drop);
    setDismissed(drop);
  }, [people, user?.id]);

  const dismissCall = useCallback((conversationId: string) => {
    setDismissed((prev) => new Set(prev).add(conversationId));
    setRinging((prev) => {
      if (!prev.has(conversationId)) return prev;
      const next = new Set(prev);
      next.delete(conversationId);
      return next;
    });
  }, []);

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
  /** A person's identity (@user:domain), which is what their volume is remembered by, from their id in the call. */
  const identityOf = useCallback((personId: string): string => {
    for (const community of communitiesRef.current) {
      const member = community.members.find((m) => m.id === personId);
      if (member) return member.identity;
    }
    for (const conversation of conversationsRef.current) {
      const member = conversation.members.find((m) => m.id === personId);
      if (member) return member.identity;
    }
    return personId;
  }, []);

  /** Sets what each person in the call is played at: the master volume times theirs, nothing if muted for this person or deafened. */
  const applyOutput = useCallback(() => {
    remoteTracks.current.forEach((track, personId) => {
      track.setVolume(playbackVolume(audioRef.current, identityOf(personId), deafenedRef.current));
    });
  }, [identityOf]);

  const applyDeafened = useCallback(
    (deafened: boolean) => {
      deafenedRef.current = deafened;
      applyOutput();
    },
    [applyOutput]
  );

  const clearCall = useCallback(() => {
    audioElements.current.forEach((el) => el.remove());
    audioElements.current.clear();
    remoteTracks.current.clear();
    microphone.current = null;
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

  /**
   * Puts the gain and limiter on the microphone being sent, once there is one (it is made when the microphone is first turned on,
   * which can be after joining if it was blocked at first). The microphone still works without them: its volume is just not
   * adjustable.
   */
  async function putGainOnMicrophone(room: Room): Promise<void> {
    const track = room.localParticipant.getTrackPublication(MICROPHONE)?.audioTrack;
    if (!track || microphone.current) return;
    try {
      const processor = new MicrophoneLevel(audioRef.current.inputVolume);
      await track.setProcessor(processor);
      microphone.current = processor;
    } catch (err) {
      console.error("[voice] could not put a volume control on the microphone:", err);
    }
  }

  const begin = useCallback(
    async (channel: { kind: "channel" | "conversation"; id: string; communityId: string; name: string; communityName: string }) => {
      // Already in this call (or joining it): clicking it again does nothing.
      if (sessionChannel.current === channel.id) return;
      leave();
      const mine = ++joinNumber.current;
      setNotice(null);

      sessionChannel.current = channel.id;
      setSession({
        kind: channel.kind,
        channelId: channel.id,
        communityId: channel.communityId,
        channelName: channel.name,
        communityName: channel.communityName,
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
        pass = channel.kind === "conversation" ? await api.getConversationVoiceToken(channel.id) : await api.getVoiceToken(channel.id);
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
      const chosen = audioRef.current;
      const room = new livekit.Room({
        audioCaptureDefaults: {
          deviceId: prefs.input ?? undefined,
          echoCancellation: chosen.echoCancellation,
          noiseSuppression: chosen.noiseSuppression,
          autoGainControl: chosen.autoGainControl,
        },
        audioOutput: { deviceId: prefs.output ?? undefined },
        // Playback goes through the browser's audio engine, which is what lets one person be turned UP past what an audio element
        // allows (a volume of 2 is twice as loud): every volume here, deafening included, is a gain, not a muted element.
        webAudioMix: true,
      });
      roomRef.current = room;

      room.on(livekit.RoomEvent.TrackSubscribed, (track, _publication, participant) => {
        if (track.kind !== livekit.Track.Kind.Audio) return;
        const element = track.attach();
        hostElement().appendChild(element);
        audioElements.current.add(element);
        const audioTrack = track as RemoteAudioTrack;
        remoteTracks.current.set(participant.identity, audioTrack);
        // At once, so someone who joins while this person is deafened, or turned down, is not heard for a moment first.
        audioTrack.setVolume(playbackVolume(audioRef.current, identityOf(participant.identity), deafenedRef.current));
      });
      room.on(livekit.RoomEvent.TrackUnsubscribed, (track, _publication, participant) => {
        if (remoteTracks.current.get(participant.identity) === track) remoteTracks.current.delete(participant.identity);
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
        await putGainOnMicrophone(room);
      } catch (err) {
        // The call goes on: the person can listen.
        setSession((s) => (s && joinNumber.current === mine ? { ...s, muted: true, micProblem: microphoneMessage(err) } : s));
      }
      void refreshDevices();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [leave, clearCall, refreshDevices, identityOf]
  );

  const join = useCallback(
    (channel: { id: string; communityId: string }) => {
      const community = communitiesRef.current.find((c) => c.id === channel.communityId);
      const found = community?.channels.find((c) => c.id === channel.id);
      return begin({ kind: "channel", id: channel.id, communityId: channel.communityId, name: found?.name ?? "voice", communityName: community?.name ?? "" });
    },
    [begin]
  );

  const joinCall = useCallback(
    (conversationId: string) => {
      const conversation = conversationsRef.current.find((c) => c.id === conversationId);
      return begin({ kind: "conversation", id: conversationId, communityId: "", name: conversationName(conversation, userRef.current?.id ?? ""), communityName: "" });
    },
    [begin]
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
        if (!muted) await putGainOnMicrophone(room);
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

  // --- how voice sounds (remembered on this device; applied to the call as it changes) -----------------------------------
  const changeAudio = useCallback((change: (prev: VoiceAudioPrefs) => VoiceAudioPrefs) => {
    const next = change(audioRef.current);
    audioRef.current = next;
    saveVoiceAudio(next);
    setAudio(next);
  }, []);

  const setInputVolume = useCallback(
    (percent: number) => {
      const value = clampPercent(percent);
      changeAudio((prev) => ({ ...prev, inputVolume: value }));
      microphone.current?.setPercent(value);
    },
    [changeAudio]
  );

  const setProcessing = useCallback(
    async (key: "echoCancellation" | "noiseSuppression" | "autoGainControl", on: boolean) => {
      changeAudio((prev) => ({ ...prev, [key]: on }));
      // The microphone already open is opened again with the new choice (the volume control stays on it).
      const track = roomRef.current?.localParticipant.getTrackPublication(MICROPHONE)?.audioTrack;
      const chosen = audioRef.current;
      if (track) {
        await track
          .restartTrack({
            deviceId: prefsRef.current.input ?? undefined,
            echoCancellation: chosen.echoCancellation,
            noiseSuppression: chosen.noiseSuppression,
            autoGainControl: chosen.autoGainControl,
          })
          .catch(() => undefined);
      }
    },
    [changeAudio]
  );

  const setOutputVolume = useCallback(
    (percent: number) => {
      changeAudio((prev) => ({ ...prev, outputVolume: clampPercent(percent) }));
      applyOutput();
    },
    [changeAudio, applyOutput]
  );

  const setPerson = useCallback(
    (identity: string, change: Partial<PersonVolume>) => {
      changeAudio((prev) => withPerson(prev, identity, change));
      applyOutput();
    },
    [changeAudio, applyOutput]
  );

  const resetPeople = useCallback(() => {
    changeAudio((prev) => ({ ...prev, people: {} }));
    applyOutput();
  }, [changeAudio, applyOutput]);

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

  const incoming = useMemo(
    () => (user ? incomingCalls(conversations, people, user.id, user.identity, session?.channelId ?? null, dismissed) : []),
    [conversations, people, user, session?.channelId, dismissed]
  );

  const sampleCallStats = useCallback(async (): Promise<CallStatsSample | null> => {
    const room = roomRef.current;
    if (!room) return null;
    const entries = (report: RTCStatsReport | undefined): StatEntry[] | null => (report ? ([...report.values()] as StatEntry[]) : null);
    const microphone = room.localParticipant.getTrackPublication(MICROPHONE)?.audioTrack;
    const sent = microphone ? entries(await microphone.getRTCStatsReport().catch(() => undefined)) : null;
    const received = (await Promise.all([...remoteTracks.current.values()].map((track) => track.getRTCStatsReport().catch(() => undefined))))
      .map(entries)
      .filter((e): e is StatEntry[] => e !== null);
    // Both directions travel the same way: with no microphone going out, what is coming in says how the connection is.
    return { sent: sent ?? received[0] ?? null, received };
  }, []);

  const value: VoiceContextValue = {
    people,
    voiceAvailable,
    session,
    speaking,
    micOff,
    notice,
    dismissNotice: () => setNotice(null),
    join,
    joinCall,
    callsOffered,
    callsAvailable,
    incoming,
    ringing,
    dismissCall,
    leave,
    setMuted,
    setDeafened,
    allowAudio,
    devices,
    refreshDevices,
    chooseInput,
    chooseOutput,
    audio,
    setInputVolume,
    setProcessing,
    setOutputVolume,
    setPerson,
    resetPeople,
    sampleCallStats,
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
  joinCall: async () => undefined,
  callsOffered: false,
  callsAvailable: false,
  incoming: [],
  ringing: NONE,
  dismissCall: () => undefined,
  leave: () => undefined,
  setMuted: async () => undefined,
  setDeafened: () => undefined,
  allowAudio: async () => undefined,
  devices: { inputs: [], outputs: [], prefs: { input: null, output: null } },
  refreshDevices: async () => undefined,
  chooseInput: async () => undefined,
  chooseOutput: async () => undefined,
  audio: { inputVolume: 100, echoCancellation: true, noiseSuppression: true, autoGainControl: true, outputVolume: 100, people: {} },
  setInputVolume: () => undefined,
  setProcessing: async () => undefined,
  setOutputVolume: () => undefined,
  setPerson: () => undefined,
  resetPeople: () => undefined,
  sampleCallStats: async () => null,
};

export function useVoice(): VoiceContextValue {
  return useContext(VoiceContext) ?? NO_VOICE;
}
