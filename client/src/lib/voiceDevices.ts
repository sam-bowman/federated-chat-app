// Which microphone and speaker to use for voice, remembered on this device (the devices are this computer's: another one
// has others). `null` is "the system's default", which is also what is used when a remembered device is no longer plugged in.

const KEY = "chat.voiceDevices";

export interface VoiceDevicePrefs {
  input: string | null;
  output: string | null;
}

export const NO_DEVICES: VoiceDevicePrefs = { input: null, output: null };

const deviceId = (value: unknown): string | null => (typeof value === "string" && value !== "" && value.length <= 512 ? value : null);

export function loadVoiceDevices(): VoiceDevicePrefs {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "null") as Record<string, unknown> | null;
    if (typeof stored !== "object" || stored === null) return { ...NO_DEVICES };
    return { input: deviceId(stored.input), output: deviceId(stored.output) };
  } catch {
    return { ...NO_DEVICES };
  }
}

export function saveVoiceDevices(prefs: VoiceDevicePrefs): void {
  try {
    if (prefs.input === null && prefs.output === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify({ input: prefs.input, output: prefs.output }));
  } catch {
    // Not remembered; it still applies for this call.
  }
}

export interface AudioDevice {
  id: string;
  label: string;
}

/**
 * The microphones and speakers this device has. The browser only shows names after the person has allowed the microphone once,
 * so a device without one is called by its kind and number. "default" and "communications" entries (which duplicate a real
 * one) are left out: not choosing is how to get the default.
 */
export async function listAudioDevices(): Promise<{ inputs: AudioDevice[]; outputs: AudioDevice[] }> {
  try {
    const all = (await navigator.mediaDevices?.enumerateDevices?.()) ?? [];
    const pick = (kind: MediaDeviceKind, fallback: string): AudioDevice[] =>
      all
        .filter((d) => d.kind === kind && d.deviceId !== "default" && d.deviceId !== "communications")
        .map((d, index) => ({ id: d.deviceId, label: d.label || `${fallback} ${index + 1}` }));
    return { inputs: pick("audioinput", "Microphone"), outputs: pick("audiooutput", "Speaker") };
  } catch {
    return { inputs: [], outputs: [] };
  }
}
