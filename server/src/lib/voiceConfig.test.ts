import { describe, expect, it } from "vitest";
import { httpUrlFor, parseVoiceConfig } from "./voiceConfig.js";

const ALL = { LIVEKIT_URL: "wss://voice.example.com", LIVEKIT_API_KEY: "key", LIVEKIT_API_SECRET: "secret" };

describe("parseVoiceConfig", () => {
  it("is off when nothing is set, which is how every server has always behaved", () => {
    expect(parseVoiceConfig({})).toEqual({ enabled: false });
    expect(parseVoiceConfig({ LIVEKIT_URL: "", LIVEKIT_API_KEY: " ", LIVEKIT_API_SECRET: "" })).toEqual({ enabled: false });
  });

  it("is on when all three are set, asking LiveKit at the http form of the public address by default", () => {
    expect(parseVoiceConfig(ALL)).toEqual({
      enabled: true,
      url: "wss://voice.example.com",
      internalUrl: "https://voice.example.com",
      apiKey: "key",
      apiSecret: "secret",
    });
    expect(parseVoiceConfig({ ...ALL, LIVEKIT_URL: "ws://localhost:7880" })).toMatchObject({ internalUrl: "http://localhost:7880" });
  });

  it("takes a separate address to ask LiveKit at from inside the cluster", () => {
    expect(parseVoiceConfig({ ...ALL, LIVEKIT_INTERNAL_URL: "http://livekit:7880" })).toMatchObject({
      url: "wss://voice.example.com",
      internalUrl: "http://livekit:7880",
    });
  });

  it("ignores a trailing slash and spaces", () => {
    expect(parseVoiceConfig({ ...ALL, LIVEKIT_URL: " wss://voice.example.com/ ", LIVEKIT_INTERNAL_URL: "http://livekit:7880/" })).toMatchObject({
      url: "wss://voice.example.com",
      internalUrl: "http://livekit:7880",
    });
  });

  it("refuses to start with only some of them, saying which are missing, rather than showing voice channels nobody can join", () => {
    expect(() => parseVoiceConfig({ LIVEKIT_URL: ALL.LIVEKIT_URL })).toThrow(/LIVEKIT_API_KEY and LIVEKIT_API_SECRET are not set/);
    expect(() => parseVoiceConfig({ LIVEKIT_API_KEY: "k", LIVEKIT_API_SECRET: "s" })).toThrow(/LIVEKIT_URL is not set/);
    expect(() => parseVoiceConfig({ ...ALL, LIVEKIT_API_SECRET: "" })).toThrow(/LIVEKIT_API_SECRET is not set/);
  });

  it("refuses an internal address on its own", () => {
    expect(() => parseVoiceConfig({ LIVEKIT_INTERNAL_URL: "http://livekit:7880" })).toThrow(/LIVEKIT_INTERNAL_URL is set but/);
  });

  it("refuses an address the apps could not connect to", () => {
    for (const url of ["https://voice.example.com", "voice.example.com", "wss://voice.example.com/rtc", "wss://", "wss://a b"]) {
      expect(() => parseVoiceConfig({ ...ALL, LIVEKIT_URL: url }), url).toThrow(/LIVEKIT_URL/);
    }
    for (const url of ["wss://livekit:7880", "livekit:7880", "http://livekit:7880/twirp"]) {
      expect(() => parseVoiceConfig({ ...ALL, LIVEKIT_INTERNAL_URL: url }), url).toThrow(/LIVEKIT_INTERNAL_URL/);
    }
  });
});

describe("httpUrlFor", () => {
  it("turns a websocket address into the http one LiveKit's API answers at", () => {
    expect(httpUrlFor("wss://a.example")).toBe("https://a.example");
    expect(httpUrlFor("ws://a.example:7880")).toBe("http://a.example:7880");
    expect(httpUrlFor("WSS://a.example/")).toBe("https://a.example");
  });
});
