// What a person chooses about how voice sounds, remembered on this device (the devices and the room are this computer's):
//
//  - what THEY send: how loud their microphone is (0-200%, applied before it is encoded so everyone hears it), and the browser's own
//    echo cancellation, noise suppression and automatic gain;
//  - what THEY hear: a master volume, and a volume and a mute for each person, which are never sent to anyone: they change
//    nothing for the other person or for other listeners.
//
// A person is remembered by their full identity (@user:domain), not by an id that means something only on this server, so it
// keeps working for people on other servers once voice reaches them (#55).

const KEY = "chat.voiceAudio";

export const MIN_PERCENT = 0;
export const MAX_PERCENT = 200;
export const DEFAULT_PERCENT = 100;

export interface PersonVolume {
  /** 0-200, 100 is as it comes. */
  volume: number;
  /** Silenced for this person only. */
  muted: boolean;
}

export interface VoiceAudioPrefs {
  /** What is sent: 0-200. */
  inputVolume: number;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  /** What is heard, for everyone: 0-200. */
  outputVolume: number;
  /** By identity (@user:domain). A person with nothing here is at 100% and not muted. */
  people: Record<string, PersonVolume>;
}

export const DEFAULT_AUDIO: VoiceAudioPrefs = {
  inputVolume: DEFAULT_PERCENT,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  outputVolume: DEFAULT_PERCENT,
  people: {},
};

/** A percentage kept inside 0-200 and whole (a slider or a stored value can be anything). */
export function clampPercent(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : DEFAULT_PERCENT;
  return Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, n));
}

const flag = (value: unknown, fallback: boolean): boolean => (typeof value === "boolean" ? value : fallback);
// Plain `identity in object` would answer true for "__proto__" or "toString".
const hasOwn = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);

export function loadVoiceAudio(): VoiceAudioPrefs {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "null") as Record<string, unknown> | null;
    if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return { ...DEFAULT_AUDIO, people: {} };
    const people: Record<string, PersonVolume> = {};
    const raw = stored.people;
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      for (const [identity, entry] of Object.entries(raw)) {
        if (identity === "__proto__" || identity.length > 320) continue;
        const e = entry as Record<string, unknown> | null;
        if (typeof e !== "object" || e === null) continue;
        const person = { volume: clampPercent(e.volume), muted: e.muted === true };
        if (!isDefaultPerson(person)) people[identity] = person;
      }
    }
    return {
      inputVolume: hasOwn(stored, "inputVolume") ? clampPercent(stored.inputVolume) : DEFAULT_AUDIO.inputVolume,
      echoCancellation: flag(stored.echoCancellation, DEFAULT_AUDIO.echoCancellation),
      noiseSuppression: flag(stored.noiseSuppression, DEFAULT_AUDIO.noiseSuppression),
      autoGainControl: flag(stored.autoGainControl, DEFAULT_AUDIO.autoGainControl),
      outputVolume: hasOwn(stored, "outputVolume") ? clampPercent(stored.outputVolume) : DEFAULT_AUDIO.outputVolume,
      people,
    };
  } catch {
    return { ...DEFAULT_AUDIO, people: {} };
  }
}

export function isDefaultPerson(person: PersonVolume): boolean {
  return person.volume === DEFAULT_PERCENT && !person.muted;
}

function isDefault(prefs: VoiceAudioPrefs): boolean {
  return (
    prefs.inputVolume === DEFAULT_AUDIO.inputVolume &&
    prefs.echoCancellation === DEFAULT_AUDIO.echoCancellation &&
    prefs.noiseSuppression === DEFAULT_AUDIO.noiseSuppression &&
    prefs.autoGainControl === DEFAULT_AUDIO.autoGainControl &&
    prefs.outputVolume === DEFAULT_AUDIO.outputVolume &&
    Object.keys(prefs.people).length === 0
  );
}

export function saveVoiceAudio(prefs: VoiceAudioPrefs): void {
  try {
    // Nothing chosen is nothing kept: defaults are 100% everywhere and nothing is boosted until someone chooses it.
    if (isDefault(prefs)) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Not remembered; it still applies for this visit.
  }
}

/** A person's setting, or the default for someone with none. */
export function personOf(prefs: VoiceAudioPrefs, identity: string): PersonVolume {
  return hasOwn(prefs.people, identity) ? prefs.people[identity] : { volume: DEFAULT_PERCENT, muted: false };
}

/** Changes one person's setting. A person put back to 100% and not muted is forgotten, not kept as a record of nothing. */
export function withPerson(prefs: VoiceAudioPrefs, identity: string, change: Partial<PersonVolume>): VoiceAudioPrefs {
  const current = personOf(prefs, identity);
  const next = {
    volume: change.volume === undefined ? current.volume : clampPercent(change.volume),
    muted: change.muted === undefined ? current.muted : change.muted,
  };
  const people = { ...prefs.people };
  if (isDefaultPerson(next)) delete people[identity];
  else people[identity] = next;
  return { ...prefs, people };
}

/**
 * The volume a person's audio is played at (1 is as it comes, 2 is double): the master volume times theirs, nothing when they are
 * muted for this person or when this person has deafened themselves.
 */
export function playbackVolume(prefs: VoiceAudioPrefs, identity: string, deafened: boolean): number {
  if (deafened) return 0;
  const person = personOf(prefs, identity);
  if (person.muted) return 0;
  return (prefs.outputVolume / 100) * (person.volume / 100);
}
