// Voice chat is carried by a LiveKit server (https://livekit.io), which this server never talks audio with: it only decides who
// may join (by minting a short-lived token the client hands to LiveKit) and, later, asks LiveKit who is in a room.
//
// Three settings say where LiveKit is and how to speak to it, and they only mean anything together, so the rule is
// all-or-nothing: none set means voice is off (how every server has always behaved), all set means on, and SOME set is a
// mistake that refuses startup, since a half-configured voice server would show voice channels nobody can join.
//
// Kept free of config.ts imports so it can be unit-tested on its own.

export interface VoiceSettings {
  /** The address CLIENTS connect to (ws:// or wss://), the one in the token response. */
  url: string;
  /** The same server as THIS server reaches it (http:// or https://), for asking who is in a room. Defaults to `url` as http(s). */
  internalUrl: string;
  apiKey: string;
  apiSecret: string;
}

export type VoiceConfig = { enabled: false } | ({ enabled: true } & VoiceSettings);

const WS_URL = /^(wss?):\/\/[^\s/?#]+(:\d+)?\/?$/i;
const HTTP_URL = /^(https?):\/\/[^\s/?#]+(:\d+)?\/?$/i;

/** `wss://voice.example.com` -> `https://voice.example.com`, which is where the LiveKit API answers. */
export function httpUrlFor(wsUrl: string): string {
  return wsUrl.replace(/^(wss?):/i, (_, scheme: string) => (scheme.toLowerCase() === "wss" ? "https:" : "http:")).replace(/\/$/, "");
}

/**
 * Reads LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET and (optionally) LIVEKIT_INTERNAL_URL. None of the first three set
 * means voice is off; all three means on; anything in between throws, saying which are missing.
 */
export function parseVoiceConfig(env: Record<string, string | undefined>): VoiceConfig {
  const read = (name: string) => (env[name] ?? "").trim();
  const url = read("LIVEKIT_URL");
  const apiKey = read("LIVEKIT_API_KEY");
  const apiSecret = read("LIVEKIT_API_SECRET");
  const internal = read("LIVEKIT_INTERNAL_URL");

  const given = [url, apiKey, apiSecret].filter((v) => v !== "").length;
  if (given === 0) {
    if (internal !== "") throw new Error("LIVEKIT_INTERNAL_URL is set but LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET are not: voice needs all of them, or none.");
    return { enabled: false };
  }
  if (given < 3) {
    const missing = [["LIVEKIT_URL", url], ["LIVEKIT_API_KEY", apiKey], ["LIVEKIT_API_SECRET", apiSecret]].filter(([, v]) => v === "").map(([n]) => n);
    throw new Error(`Voice needs LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET together, and ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not set. Set all three to turn voice on, or none to leave it off.`);
  }
  if (!WS_URL.test(url)) {
    throw new Error(`LIVEKIT_URL is "${url}", which is not a ws:// or wss:// address with no path (for example wss://voice.example.com). It is the address the apps connect to.`);
  }
  if (internal !== "" && !HTTP_URL.test(internal)) {
    throw new Error(`LIVEKIT_INTERNAL_URL is "${internal}", which is not an http:// or https:// address with no path (for example http://livekit:7880). It is where this server asks LiveKit who is in a room.`);
  }
  return { enabled: true, url: url.replace(/\/$/, ""), internalUrl: (internal !== "" ? internal : httpUrlFor(url)).replace(/\/$/, ""), apiKey, apiSecret };
}
