import { describe, expect, it, vi } from "vitest";
import { LiveKitBackend, isNotFound, type RoomService } from "./voiceBackend.js";

const settings = { internalUrl: "http://livekit:7880", apiKey: "k", apiSecret: "s" };
const notFound = () => Object.assign(new Error("requested room does not exist"), { code: "not_found", status: 404 });

function fakeRooms(overrides: Partial<RoomService> = {}): RoomService & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    listRooms: vi.fn(async (names?: string[]) => {
      calls.push(`rooms ${(names ?? []).join(",")}`);
      return (names ?? []).filter((n) => n !== "EMPTY").map((name) => ({ name }));
    }),
    listParticipants: vi.fn(async (room: string) => {
      calls.push(`list ${room}`);
      return [{ identity: "A", state: 2 }, { identity: "B", state: 2 }];
    }),
    removeParticipant: vi.fn(async (room: string, identity: string) => {
      calls.push(`remove ${room} ${identity}`);
    }),
    deleteRoom: vi.fn(async (room: string) => {
      calls.push(`delete ${room}`);
    }),
    ...overrides,
  };
}

describe("isNotFound", () => {
  it("recognises LiveKit's answer for a room or person that is not there", () => {
    expect(isNotFound(notFound())).toBe(true);
    expect(isNotFound({ status: 404 })).toBe(true);
    expect(isNotFound({ code: "not_found" })).toBe(true);
  });

  it("is not fooled by other failures", () => {
    for (const err of [new Error("boom"), { code: "unavailable", status: 503 }, { status: 500 }, null, undefined, "not_found"]) {
      expect(isNotFound(err), String(err)).toBe(false);
    }
  });
});

describe("LiveKitBackend: who is in a room", () => {
  const STATES = { JOINING: 0, JOINED: 1, ACTIVE: 2, DISCONNECTED: 3 };
  const withStates = (...states: [string, number | undefined][]) =>
    fakeRooms({ listParticipants: async () => states.map(([identity, state]) => ({ identity, state })) });

  it("counts only the people whose connection is up (ACTIVE), not those still connecting, who may never connect (#220)", async () => {
    const backend = new LiveKitBackend(
      settings,
      withStates(["joining", STATES.JOINING], ["joined", STATES.JOINED], ["active", STATES.ACTIVE], ["gone", STATES.DISCONNECTED])
    );
    expect(await backend.listParticipants("ROOM1")).toEqual(["active"]);
  });

  it("keeps everyone who is active, in the order given", async () => {
    const backend = new LiveKitBackend(settings, withStates(["b", STATES.ACTIVE], ["a", STATES.ACTIVE]));
    expect(await backend.listParticipants("ROOM1")).toEqual(["b", "a"]);
  });

  it("does not guess when a state is missing: a person with no state is not shown as connected", async () => {
    const backend = new LiveKitBackend(settings, withStates(["x", undefined]));
    expect(await backend.listParticipants("ROOM1")).toEqual([]);
  });
});

describe("LiveKitBackend", () => {
  it("says which of some rooms exist", async () => {
    const rooms = fakeRooms();
    expect(await new LiveKitBackend(settings, rooms).listRooms(["ONE", "EMPTY", "TWO"])).toEqual(["ONE", "TWO"]);
  });

  it("does not ask LiveKit about no rooms, because an empty list means every room to it", async () => {
    const rooms = fakeRooms();
    expect(await new LiveKitBackend(settings, rooms).listRooms([])).toEqual([]);
    expect(rooms.calls).toEqual([]);
  });

  it("lists the identities in a room", async () => {
    const rooms = fakeRooms();
    expect(await new LiveKitBackend(settings, rooms).listParticipants("ROOM1")).toEqual(["A", "B"]);
    expect(rooms.calls).toEqual(["list ROOM1"]);
  });

  it("says nobody is in a room that does not exist", async () => {
    const backend = new LiveKitBackend(settings, fakeRooms({ listParticipants: async () => Promise.reject(notFound()) }));
    expect(await backend.listParticipants("GONE")).toEqual([]);
  });

  it("does not hide a real failure as an empty room, which would tell everyone the channel was empty", async () => {
    const backend = new LiveKitBackend(settings, fakeRooms({ listParticipants: async () => Promise.reject(new Error("connection refused")) }));
    await expect(backend.listParticipants("ROOM1")).rejects.toThrow("connection refused");
  });

  it("removes a person from a room, and takes it as done when they were not in it", async () => {
    const rooms = fakeRooms();
    await new LiveKitBackend(settings, rooms).removeParticipant("ROOM1", "A");
    expect(rooms.calls).toEqual(["remove ROOM1 A"]);

    const absent = new LiveKitBackend(settings, fakeRooms({ removeParticipant: async () => Promise.reject(notFound()) }));
    await expect(absent.removeParticipant("ROOM1", "A")).resolves.toBeUndefined();
    const broken = new LiveKitBackend(settings, fakeRooms({ removeParticipant: async () => Promise.reject(new Error("boom")) }));
    await expect(broken.removeParticipant("ROOM1", "A")).rejects.toThrow("boom");
  });

  it("closes a room, and takes it as done when there was none", async () => {
    const rooms = fakeRooms();
    await new LiveKitBackend(settings, rooms).deleteRoom("ROOM1");
    expect(rooms.calls).toEqual(["delete ROOM1"]);

    const absent = new LiveKitBackend(settings, fakeRooms({ deleteRoom: async () => Promise.reject(notFound()) }));
    await expect(absent.deleteRoom("ROOM1")).resolves.toBeUndefined();
    const broken = new LiveKitBackend(settings, fakeRooms({ deleteRoom: async () => Promise.reject(new Error("boom")) }));
    await expect(broken.deleteRoom("ROOM1")).rejects.toThrow("boom");
  });
});
