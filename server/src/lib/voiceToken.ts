import { AccessToken, TrackSource } from "livekit-server-sdk";

/** How long a token is good for to START a connection. Once connected, LiveKit keeps the session going by itself. */
export const VOICE_TOKEN_TTL_SECONDS = 10 * 60;

export interface VoiceTokenInput {
  apiKey: string;
  apiSecret: string;
  /** The channel's protocolId: one LiveKit room per voice channel. */
  room: string;
  /** The person's protocolId, which is how the apps tell who is who. */
  identity: string;
  /** What others see in the room before the app has looked them up. */
  name: string;
}

/**
 * A LiveKit access token for one person in one room. It lets them listen, and talk with a microphone; it does not let them
 * publish anything else (video, screen, data), so a modified app cannot send more than a voice channel is for.
 */
export async function createVoiceToken(input: VoiceTokenInput): Promise<string> {
  const token = new AccessToken(input.apiKey, input.apiSecret, {
    identity: input.identity,
    name: input.name,
    ttl: VOICE_TOKEN_TTL_SECONDS,
  });
  token.addGrant({
    roomJoin: true,
    room: input.room,
    canSubscribe: true,
    canPublish: true,
    canPublishData: false,
    canPublishSources: [TrackSource.MICROPHONE],
  });
  return token.toJwt();
}
