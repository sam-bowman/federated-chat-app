import type { VoiceBackend } from "../../src/lib/voiceBackend.js";

/** A LiveKit that is a map of rooms to who is in them, and remembers what it was told to do. */
export class FakeVoice implements VoiceBackend {
  rooms = new Map<string, string[]>();
  removed: string[] = [];
  deleted: string[] = [];
  failing = false;
  /** People who are in the room but whose connection is not up yet (LiveKit says JOINING or JOINED, not ACTIVE): not listed. */
  connecting = new Set<string>();
  async listRooms(names: string[]) {
    if (this.failing) throw new Error("livekit is down");
    return names.filter((n) => (this.rooms.get(n) ?? []).length > 0);
  }
  async listParticipants(room: string) {
    if (this.failing) throw new Error("livekit is down");
    return (this.rooms.get(room) ?? []).filter((id) => !this.connecting.has(id));
  }
  async removeParticipant(room: string, identity: string) {
    if (this.failing) throw new Error("livekit is down");
    this.removed.push(`${room}:${identity}`);
    this.rooms.set(room, (this.rooms.get(room) ?? []).filter((id) => id !== identity));
  }
  async deleteRoom(room: string) {
    if (this.failing) throw new Error("livekit is down");
    this.deleted.push(room);
    this.rooms.delete(room);
  }
}
