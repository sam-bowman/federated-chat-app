import { ParticipantInfo_State, RoomServiceClient, WebhookReceiver } from "livekit-server-sdk";

/**
 * What this server asks the LiveKit server (the audio itself never comes through here): who is in a room, and to remove
 * someone or close a room. Behind an interface so the rest of the server is tested without a LiveKit, and so another
 * media server could stand in for it.
 *
 * Kept free of config.ts imports so it can be unit-tested on its own.
 */
export interface VoiceBackend {
  /** Which of these rooms exist now (a room with nobody in it does not). */
  listRooms(names: string[]): Promise<string[]>;
  /**
   * The identities (people's protocolIds) in the room now whose connection is UP. Someone who has asked to join but whose audio
   * connection is not established yet is not counted: they may never get one. A room that does not exist has nobody in it.
   */
  listParticipants(room: string): Promise<string[]>;
  /** Takes someone out of the room. Fine if they are not in it. */
  removeParticipant(room: string, identity: string): Promise<void>;
  /** Closes the room, sending everyone in it out. Fine if there is no such room. */
  deleteRoom(room: string): Promise<void>;
}

/** The part of the LiveKit SDK's client this uses, so a test can stand in for it. */
export interface RoomService {
  listRooms(names?: string[]): Promise<{ name: string }[]>;
  listParticipants(room: string): Promise<{ identity: string; state?: number }[]>;
  removeParticipant(room: string, identity: string): Promise<unknown>;
  deleteRoom(room: string): Promise<unknown>;
}

export interface LiveKitSettings {
  internalUrl: string;
  apiKey: string;
  apiSecret: string;
}

/** LiveKit answers a room or person that is not there with a "not found" error, which for these three calls means "already so". */
export function isNotFound(err: unknown): boolean {
  const e = err as { code?: unknown; status?: unknown } | null;
  return e?.code === "not_found" || e?.status === 404;
}

export class LiveKitBackend implements VoiceBackend {
  private readonly rooms: RoomService;

  constructor(settings: LiveKitSettings, rooms?: RoomService) {
    this.rooms = rooms ?? new RoomServiceClient(settings.internalUrl, settings.apiKey, settings.apiSecret);
  }

  async listRooms(names: string[]): Promise<string[]> {
    // An empty list to LiveKit means "every room", which is not what an empty question means.
    if (names.length === 0) return [];
    return (await this.rooms.listRooms(names)).map((r) => r.name);
  }

  async listParticipants(room: string): Promise<string[]> {
    try {
      // Only ACTIVE: LiveKit lists a person from the moment it accepts their request to join (JOINING, JOINED), before any audio
      // path exists, and a person whose audio ports are blocked stays that way until it gives up.
      return (await this.rooms.listParticipants(room)).filter((p) => p.state === ParticipantInfo_State.ACTIVE).map((p) => p.identity);
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
  }

  async removeParticipant(room: string, identity: string): Promise<void> {
    try {
      await this.rooms.removeParticipant(room, identity);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  async deleteRoom(room: string): Promise<void> {
    try {
      await this.rooms.deleteRoom(room);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
}

/** Checks that a webhook really came from the LiveKit server (a JWT signed with the shared secret over the exact body) and reads it. */
export function createWebhookReceiver(settings: Pick<LiveKitSettings, "apiKey" | "apiSecret">): WebhookReceiver {
  return new WebhookReceiver(settings.apiKey, settings.apiSecret);
}
