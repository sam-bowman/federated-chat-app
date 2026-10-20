import { randomBytes } from "node:crypto";
import { TokenVerifier } from "livekit-server-sdk";
import { describe, expect, it } from "vitest";
import { VOICE_TOKEN_TTL_SECONDS, createVoiceToken } from "./voiceToken.js";

// Made up for each run: a literal that long looks like a leaked key to the secret scanner.
const secret = () => randomBytes(24).toString("hex");
const input = { apiKey: "api-key", apiSecret: secret(), room: "CHANNELID01", identity: "USERID01", name: "Alice" };

describe("createVoiceToken", () => {
  it("is signed with the shared secret, so LiveKit accepts it and nothing else does", async () => {
    const jwt = await createVoiceToken(input);
    const claims = await new TokenVerifier(input.apiKey, input.apiSecret).verify(jwt);
    expect(claims.sub).toBe("USERID01");
    expect(claims.iss).toBe("api-key");
    await expect(new TokenVerifier(input.apiKey, secret()).verify(jwt)).rejects.toThrow();
  });

  it("names the person and the room, and lets them join only that room", async () => {
    const claims = await new TokenVerifier(input.apiKey, input.apiSecret).verify(await createVoiceToken(input));
    expect(claims.name).toBe("Alice");
    expect(claims.video).toMatchObject({ roomJoin: true, room: "CHANNELID01" });
    // Not an admin of anything, and not allowed to create or list rooms.
    expect(claims.video?.roomAdmin).toBeFalsy();
    expect(claims.video?.roomCreate).toBeFalsy();
    expect(claims.video?.roomList).toBeFalsy();
  });

  it("lets them listen and talk with a microphone, and publish nothing else", async () => {
    const claims = await new TokenVerifier(input.apiKey, input.apiSecret).verify(await createVoiceToken(input));
    expect(claims.video).toMatchObject({ canSubscribe: true, canPublish: true, canPublishData: false });
    expect(claims.video?.canPublishSources).toEqual(["microphone"]);
  });

  it("is only good for a few minutes to start a connection", async () => {
    const claims = await new TokenVerifier(input.apiKey, input.apiSecret).verify(await createVoiceToken(input));
    expect(VOICE_TOKEN_TTL_SECONDS).toBe(600);
    expect(claims.exp! - claims.nbf!).toBe(VOICE_TOKEN_TTL_SECONDS);
  });
});
