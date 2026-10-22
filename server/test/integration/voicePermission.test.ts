// Taking away CONNECT_VOICE ends the calls of the people who no longer have it (#245). The permission is checked when someone joins (to mint their
// token), so before this a person already in a room stayed in it for as long as they liked, whatever their roles became. LiveKit is stood in for by
// a fake that remembers who is in which room and who it was told to remove.
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../../src/config.js";
import { prisma } from "../../src/db.js";
import { Permission } from "../../src/lib/permissions.js";
import { setVoiceBackendForTests } from "../../src/modules/voice/service.js";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { authHeader, registerUser } from "../helpers/factory.js";
import { FakeVoice } from "../helpers/voice.js";

beforeEach(resetDb);
afterAll(disconnectDb);

const PASSWORD = "Correct-Horse-Battery-Staple-1";
const original = config.voice;
let voice: FakeVoice;
beforeEach(() => {
  voice = new FakeVoice();
  config.voice = { enabled: true, url: "wss://voice.test", internalUrl: "https://voice.test", apiKey: "test-key", apiSecret: randomBytes(24).toString("hex") };
  setVoiceBackendForTests(voice);
});
afterEach(() => {
  config.voice = original;
  setVoiceBackendForTests(undefined);
});

type Registered = Awaited<ReturnType<typeof registerUser>>;
type Community = { id: string; roles: { id: string; isDefault: boolean }[]; channels: { id: string }[] };
const bits = (...b: bigint[]) => b.reduce((a, x) => a | x, 0n).toString();
const SPEAK = Permission.CONNECT_VOICE;
const CHAT = Permission.SEND_MESSAGES | Permission.REACT;

async function createCommunity(owner: Registered, name = "Voice Club"): Promise<Community> {
  const res = await api.post("/api/v1/communities").set(authHeader(owner.accessToken)).send({ name });
  expect(res.status).toBe(201);
  return res.body.community;
}
const join = async (community: { id: string }, user: Registered) =>
  expect((await api.post(`/api/v1/communities/${community.id}/members`).set(authHeader(user.accessToken))).status).toBe(201);
async function voiceChannel(owner: Registered, community: { id: string }, name: string) {
  const res = await api.post(`/api/v1/communities/${community.id}/channels`).set(authHeader(owner.accessToken)).send({ name, type: "VOICE" });
  expect(res.status).toBe(201);
  return res.body.channel as { id: string };
}
const patchRole = (as: Registered, community: { id: string }, roleId: string, body: object) =>
  api.patch(`/api/v1/communities/${community.id}/roles/${roleId}`).set(authHeader(as.accessToken)).send(body);
const deleteRole = (as: Registered, community: { id: string }, roleId: string) => api.delete(`/api/v1/communities/${community.id}/roles/${roleId}`).set(authHeader(as.accessToken));
const createRole = async (as: Registered, community: { id: string }, name: string, permissions: string) => {
  const res = await api.post(`/api/v1/communities/${community.id}/roles`).set(authHeader(as.accessToken)).send({ name, permissions });
  expect(res.status).toBe(201);
  return res.body.role as { id: string };
};
const assign = (as: Registered, community: { id: string }, user: Registered, roleId: string) =>
  api.post(`/api/v1/communities/${community.id}/members/${user.user.id}/roles/${roleId}`).set(authHeader(as.accessToken));
const unassign = (as: Registered, community: { id: string }, user: Registered, roleId: string) =>
  api.delete(`/api/v1/communities/${community.id}/members/${user.user.id}/roles/${roleId}`).set(authHeader(as.accessToken));

/** A community with an owner and two members, two voice channels, and everyone in both rooms. */
async function setup() {
  const owner = await registerUser("olive");
  const max = await registerUser("max");
  const nina = await registerUser("nina");
  const community = await createCommunity(owner);
  await join(community, max);
  await join(community, nina);
  const lounge = await voiceChannel(owner, community, "Lounge");
  const second = await voiceChannel(owner, community, "Second");
  const everyone = community.roles.find((r) => r.isDefault)!;
  const putEveryoneIn = () => {
    for (const room of [lounge, second]) voice.rooms.set(room.id, [owner.user.id, max.user.id, nina.user.id]);
  };
  putEveryoneIn();
  return { owner, max, nina, community, lounge, second, everyone, putEveryoneIn };
}
const removedFrom = (rooms: { id: string }[], user: Registered) => rooms.map((r) => `${r.id}:${user.user.id}`);

describe("a role loses CONNECT_VOICE", () => {
  it("ends the call of everyone who only had it through that role, in every voice channel, and leaves the owner and the other community alone", async () => {
    const { owner, max, nina, community, lounge, second, everyone } = await setup();
    const other = await createCommunity(owner, "Other");
    const elsewhere = await voiceChannel(owner, other, "Elsewhere");
    voice.rooms.set(elsewhere.id, [max.user.id]);

    const res = await patchRole(owner, community, everyone.id, { permissions: bits(CHAT) });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    expect(voice.removed.sort()).toEqual([...removedFrom([lounge, second], max), ...removedFrom([lounge, second], nina)].sort());
    expect(voice.rooms.get(lounge.id)).toEqual([owner.user.id]); // the owner holds every permission
    expect(voice.rooms.get(second.id)).toEqual([owner.user.id]);
    expect(voice.rooms.get(elsewhere.id)).toEqual([max.user.id]); // another community's room is not this one's business
  });

  it("leaves in the call someone who still has it through another role", async () => {
    const { owner, max, nina, community, lounge, second, everyone } = await setup();
    const speakers = await createRole(owner, community, "Speakers", bits(SPEAK));
    expect((await assign(owner, community, max, speakers.id)).status).toBe(204);

    expect((await patchRole(owner, community, everyone.id, { permissions: bits(CHAT) })).status).toBe(200);

    expect(voice.removed.sort()).toEqual(removedFrom([lounge, second], nina).sort());
    expect(voice.rooms.get(lounge.id)).toEqual([owner.user.id, max.user.id]);
  });

  it("ends the call of someone who had it through a role that no longer gives it", async () => {
    const { owner, max, nina, community, lounge, second, everyone } = await setup();
    const speakers = await createRole(owner, community, "Speakers", bits(SPEAK));
    expect((await patchRole(owner, community, everyone.id, { permissions: bits(CHAT) })).status).toBe(200); // everyone out, then Speakers let back in
    voice.removed.length = 0;
    expect((await assign(owner, community, max, speakers.id)).status).toBe(204);
    voice.rooms.set(lounge.id, [owner.user.id, max.user.id, nina.user.id]);
    voice.rooms.set(second.id, [max.user.id]);

    expect((await patchRole(owner, community, speakers.id, { permissions: bits(CHAT) })).status).toBe(200);

    // Max lost it with the role, and nina never had it back: both are out, of every voice channel of the community (the removal is asked of each).
    expect(voice.removed.sort()).toEqual([...removedFrom([lounge, second], max), ...removedFrom([lounge, second], nina)].sort());
    expect(voice.rooms.get(lounge.id)).toEqual([owner.user.id]);
    expect(voice.rooms.get(second.id)).toEqual([]);
  });

  it("does not even ask the voice server when what changed is not a permission (a colour, a name)", async () => {
    const { owner, community, lounge, second } = await setup();
    const speakers = await createRole(owner, community, "Speakers", bits(SPEAK));
    voice.listed = 0;
    expect((await patchRole(owner, community, speakers.id, { name: "Talkers", color: "#ff8800" })).status).toBe(200);
    expect(voice.listed).toBe(0);
    expect(voice.removed).toEqual([]);
    expect(voice.rooms.get(lounge.id)).toHaveLength(3);
    expect(voice.rooms.get(second.id)).toHaveLength(3);
  });

  it("removes nobody when the permissions still include CONNECT_VOICE, but does look (it is a permission that changed)", async () => {
    const { owner, community, everyone, lounge } = await setup();
    voice.listed = 0;
    expect((await patchRole(owner, community, everyone.id, { permissions: bits(CHAT, SPEAK, Permission.CREATE_INVITE) })).status).toBe(200);
    expect(voice.listed).toBeGreaterThan(0);
    expect(voice.removed).toEqual([]);
    expect(voice.rooms.get(lounge.id)).toHaveLength(3);
  });
});

describe("a role is deleted or taken from someone", () => {
  it("deleting the role that gave it ends the call of those who had it only through it", async () => {
    const { owner, max, nina, community, lounge, second, everyone } = await setup();
    const speakers = await createRole(owner, community, "Speakers", bits(SPEAK));
    expect((await patchRole(owner, community, everyone.id, { permissions: bits(CHAT) })).status).toBe(200);
    expect((await assign(owner, community, max, speakers.id)).status).toBe(204);
    voice.rooms.set(lounge.id, [owner.user.id, max.user.id, nina.user.id]);
    voice.rooms.set(second.id, [owner.user.id]);
    voice.removed.length = 0;

    expect((await deleteRole(owner, community, speakers.id)).status).toBe(204);

    // Max had it only through the deleted role. Nina has it through nothing (she was let in while everyone was refused, as a test would
    // never do): whoever is found in a room without the permission is taken out, whatever change it was that made it look.
    expect(voice.removed.sort()).toEqual([...removedFrom([lounge, second], max), ...removedFrom([lounge, second], nina)].sort());
    expect(voice.rooms.get(lounge.id)).toEqual([owner.user.id]);
  });

  it("taking the role from a person ends their call and nobody else's", async () => {
    const { owner, max, nina, community, lounge, second, everyone } = await setup();
    const speakers = await createRole(owner, community, "Speakers", bits(SPEAK));
    expect((await patchRole(owner, community, everyone.id, { permissions: bits(CHAT) })).status).toBe(200);
    for (const who of [max, nina]) expect((await assign(owner, community, who, speakers.id)).status).toBe(204);
    voice.rooms.set(lounge.id, [owner.user.id, max.user.id, nina.user.id]);
    voice.rooms.set(second.id, [max.user.id]);
    voice.removed.length = 0;

    expect((await unassign(owner, community, max, speakers.id)).status).toBe(204);

    expect(voice.removed.sort()).toEqual(removedFrom([lounge, second], max).sort());
    expect(voice.rooms.get(lounge.id)).toEqual([owner.user.id, nina.user.id]);
  });

  it("taking away a role they do not need for it changes nothing", async () => {
    const { owner, max, community, lounge } = await setup();
    const badge = await createRole(owner, community, "Badge", bits(Permission.REACT));
    expect((await assign(owner, community, max, badge.id)).status).toBe(204);
    expect((await unassign(owner, community, max, badge.id)).status).toBe(204);
    expect(voice.removed).toEqual([]);
    expect(voice.rooms.get(lounge.id)).toContain(max.user.id);
  });

  it("giving someone a role never ends anyone's call", async () => {
    const { owner, max, community, lounge } = await setup();
    const speakers = await createRole(owner, community, "Speakers", bits(SPEAK));
    voice.listed = 0;
    expect((await assign(owner, community, max, speakers.id)).status).toBe(204);
    expect(voice.listed).toBe(0); // adding to what someone may do cannot end a call: the voice server is not even asked
    expect(voice.removed).toEqual([]);
    expect(voice.rooms.get(lounge.id)).toContain(max.user.id);
  });
});

describe("the community changes hands", () => {
  it("ends the call of the old owner if what their roles give them does not include it, and not the new owner's", async () => {
    const { owner, max, community, lounge, second, everyone } = await setup();
    expect((await patchRole(owner, community, everyone.id, { permissions: bits(CHAT) })).status).toBe(200);
    voice.removed.length = 0;
    voice.rooms.set(lounge.id, [owner.user.id, max.user.id]);
    voice.rooms.set(second.id, [owner.user.id]);

    const res = await api.put(`/api/v1/communities/${community.id}/owner`).set(authHeader(owner.accessToken)).send({ userId: max.user.id, password: PASSWORD });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    expect(voice.removed.sort()).toEqual(removedFrom([lounge, second], owner).sort());
    expect(voice.rooms.get(lounge.id)).toEqual([max.user.id]);
  });

  it("leaves the old owner in the call when they are still allowed to be", async () => {
    const { owner, max, community, lounge } = await setup();
    const res = await api.put(`/api/v1/communities/${community.id}/owner`).set(authHeader(owner.accessToken)).send({ userId: max.user.id, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(voice.removed).toEqual([]);
    expect(voice.rooms.get(lounge.id)).toContain(owner.user.id);
  });
});

describe("what it must not break", () => {
  it("still changes the role when the voice server cannot be reached", async () => {
    const { owner, community, everyone } = await setup();
    voice.failing = true;
    const res = await patchRole(owner, community, everyone.id, { permissions: bits(CHAT) });
    expect(res.status).toBe(200);
    expect((await prisma.role.findUniqueOrThrow({ where: { id: everyone.id } })).permissions).toBe(CHAT);
  });

  it("asks nothing of the voice server on a server without voice", async () => {
    const { owner, community, everyone } = await setup();
    config.voice = { enabled: false };
    setVoiceBackendForTests(undefined);
    const res = await patchRole(owner, community, everyone.id, { permissions: bits(CHAT) });
    expect(res.status).toBe(200);
    expect(voice.removed).toEqual([]);
  });

  it("asks nothing of the voice server for a community with no voice channel", async () => {
    const owner = await registerUser("olive");
    const max = await registerUser("max");
    const community = await createCommunity(owner);
    await join(community, max);
    const res = await patchRole(owner, community, community.roles.find((r) => r.isDefault)!.id, { permissions: bits(CHAT) });
    expect(res.status).toBe(200);
    expect(voice.removed).toEqual([]);
  });

  it("takes out someone in a room who is not a person of this community at all", async () => {
    const { owner, community, lounge, everyone } = await setup();
    voice.rooms.set(lounge.id, ["a-stranger-the-voice-server-has"]);
    expect((await patchRole(owner, community, everyone.id, { permissions: bits(CHAT) })).status).toBe(200);
    expect(voice.removed).toContain(`${lounge.id}:a-stranger-the-voice-server-has`);
  });

  it("only looks in this community's voice channels: a person in another community's room, or in a text channel's name, is not its business", async () => {
    const { owner, community, everyone } = await setup();
    const zed = await registerUser("zed");
    const other = await createCommunity(owner, "Other");
    const elsewhere = await voiceChannel(owner, other, "Elsewhere");
    voice.rooms.set(elsewhere.id, [zed.user.id]);
    voice.rooms.set(community.channels[0]!.id, [zed.user.id]); // a text channel: no room is ever made for it

    expect((await patchRole(owner, community, everyone.id, { permissions: bits(CHAT) })).status).toBe(200);

    expect(voice.removed.filter((r) => r.endsWith(`:${zed.user.id}`))).toEqual([]);
  });

  it("takes out an account that is in a room without being a member of the community (it left, or never joined)", async () => {
    const { owner, community, lounge, second, everyone } = await setup();
    const zed = await registerUser("zed");
    voice.rooms.set(lounge.id, [owner.user.id, zed.user.id]);

    expect((await patchRole(owner, community, everyone.id, { permissions: bits(CHAT) })).status).toBe(200);

    expect(voice.removed).toEqual(expect.arrayContaining(removedFrom([lounge, second], zed)));
    expect(voice.rooms.get(lounge.id)).toEqual([owner.user.id]);
  });

  it("still changes the role when the database fails while the calls are being looked at", async () => {
    const { owner, community, everyone } = await setup();
    const failure = vi.spyOn(prisma.user, "findMany").mockRejectedValueOnce(new Error("database went away"));
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const res = await patchRole(owner, community, everyone.id, { permissions: bits(CHAT) });
      expect(res.status).toBe(200);
      expect(failure).toHaveBeenCalled();
    } finally {
      failure.mockRestore();
      quiet.mockRestore();
    }
    expect((await prisma.role.findUniqueOrThrow({ where: { id: everyone.id } })).permissions).toBe(CHAT);
  });

  it("does not let the join be what it was before: a person who has lost it cannot get a new token either", async () => {
    const { owner, max, community, lounge, everyone } = await setup();
    expect((await patchRole(owner, community, everyone.id, { permissions: bits(CHAT) })).status).toBe(200);
    const token = await api.post(`/api/v1/channels/${lounge.id}/voice-token`).set(authHeader(max.accessToken));
    expect(token.status).toBe(403);
  });
});
