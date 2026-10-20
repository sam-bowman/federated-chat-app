// The short sound that plays when a message arrives. It is made here with the browser's audio engine (two soft notes), so there
// is no audio file to ship, license or fetch, and it works the same offline and in the desktop app.
//
// Browsers do not let a page make sound until the person has interacted with it (clicked or pressed a key), so the audio engine is
// created and woken on the first such interaction (`installAudioUnlock`). A message that arrives before that is silent rather than
// an error. And a burst of messages makes ONE sound, not a stutter.

/** At most one sound in this long. */
export const MIN_GAP_MS = 1200;

const NOTES = [
  { frequency: 880, start: 0, length: 0.14 },
  { frequency: 1318.5, start: 0.11, length: 0.22 },
];
const PEAK_GAIN = 0.12;

type AudioContextClass = typeof AudioContext;

let context: AudioContext | null = null;
let lastPlayed = -Infinity;

function audioContextClass(): AudioContextClass | null {
  if (typeof window === "undefined") return null;
  return window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextClass }).webkitAudioContext ?? null;
}

function getContext(): AudioContext | null {
  if (context) return context;
  const Context = audioContextClass();
  if (!Context) return null;
  try {
    context = new Context();
  } catch {
    return null;
  }
  return context;
}

/** Creates the audio engine and wakes it. Safe to call again; only does anything useful from a click or key press. */
export function unlockAudio(): void {
  const audio = getContext();
  if (audio && audio.state === "suspended") void audio.resume().catch(() => {});
}

/** Wakes the audio engine on the first click or key press, which is when the browser allows it. Returns how to stop listening. */
export function installAudioUnlock(): () => void {
  const events = ["pointerdown", "keydown"] as const;
  const handler = () => {
    unlockAudio();
    remove();
  };
  const remove = () => events.forEach((e) => window.removeEventListener(e, handler, true));
  events.forEach((e) => window.addEventListener(e, handler, true));
  return remove;
}

/**
 * Plays the sound. Resolves true if it played, false if it was too soon after the last, or the browser will not allow it yet.
 * `force` is for the person's own "test sound" button: it plays even right after another, and does not count towards the gap.
 */
export async function playNotificationSound({ now = Date.now(), force = false }: { now?: number; force?: boolean } = {}): Promise<boolean> {
  if (!force && now - lastPlayed < MIN_GAP_MS) return false;
  const audio = getContext();
  if (!audio) return false;
  if (audio.state === "suspended") await audio.resume().catch(() => {});
  if (audio.state !== "running") return false;

  if (!force) lastPlayed = now;
  const t0 = audio.currentTime;
  for (const note of NOTES) {
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = note.frequency;
    // A quick rise and a smooth fall, so it is a soft chime and not a click.
    gain.gain.setValueAtTime(0.0001, t0 + note.start);
    gain.gain.exponentialRampToValueAtTime(PEAK_GAIN, t0 + note.start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + note.start + note.length);
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start(t0 + note.start);
    oscillator.stop(t0 + note.start + note.length + 0.02);
  }
  return true;
}

/** One ring of a call: a longer, rising pair of notes than the message chime, so the two are never confused. Played again until answered. */
const RING_NOTES = [
  { frequency: 660, start: 0, length: 0.32 },
  { frequency: 880, start: 0.38, length: 0.45 },
];

/** How often a call that nobody has answered rings again. */
export const RING_EVERY_MS = 2600;

/** Plays one ring. Resolves false if the browser will not allow sound yet (nobody has clicked in the page). */
export async function playRingTone(): Promise<boolean> {
  const audio = getContext();
  if (!audio) return false;
  if (audio.state === "suspended") await audio.resume().catch(() => {});
  if (audio.state !== "running") return false;
  const t0 = audio.currentTime;
  for (const note of RING_NOTES) {
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = note.frequency;
    gain.gain.setValueAtTime(0.0001, t0 + note.start);
    gain.gain.exponentialRampToValueAtTime(PEAK_GAIN * 1.4, t0 + note.start + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + note.start + note.length);
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start(t0 + note.start);
    oscillator.stop(t0 + note.start + note.length + 0.02);
  }
  return true;
}

/** Back to a clean start (tests only). */
export function resetNotificationSoundForTests(): void {
  context = null;
  lastPlayed = -Infinity;
}
