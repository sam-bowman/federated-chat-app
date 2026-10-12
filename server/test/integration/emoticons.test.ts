// Coverage for the emoticons module: fork, sync, edit (Save is covered at the
// level needed to pin its interaction with forking). Most sync tests simulate
// "the original changed upstream" by updating the row directly, since that
// isolates sync's own behaviour; the edit tests below drive the real PATCH
// endpoint, including one end-to-end edit -> sync.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { api } from "../helpers/app.js";
import { authHeader, registerUser } from "../helpers/factory.js";
import { disconnectDb, resetDb } from "../helpers/db.js";

beforeEach(resetDb);
afterAll(disconnectDb);

async function createEmoticon(
  token: string,
  overrides: { name?: string; trigger?: string; imageUrl?: string; allowSave?: boolean; allowFork?: boolean } = {}
) {
  const res = await api
    .post("/api/v1/emoticons")
    .set(authHeader(token))
    .send({ name: "Frog", trigger: ":frog:", imageUrl: "/uploads/frog-v1.png", ...overrides });
  expect(res.status).toBe(201);
  return res.body.emoticon as { id: string; name: string; trigger: string; imageUrl: string };
}

const fork = (token: string, id: string, body: object) =>
  api.post(`/api/v1/emoticons/${id}/fork`).set(authHeader(token)).send(body);

const sync = (token: string, id: string) => api.post(`/api/v1/emoticons/${id}/sync`).set(authHeader(token));

describe("fork", () => {
  it("creates an independent copy that doesn't change when the original does", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const original = await createEmoticon(alice.accessToken);

    const res = await fork(bob.accessToken, original.id, { name: "My frog", trigger: ":myfrog:" });

    expect(res.status).toBe(201);
    expect(res.body.emoticon.id).not.toBe(original.id);
    expect(res.body.emoticon.trigger).toBe(":myfrog:");
    expect(res.body.emoticon.imageUrl).toBe("/uploads/frog-v1.png"); // copied from the original by default
    expect(res.body.emoticon.parent).toMatchObject({ id: original.id, name: "Frog", trigger: ":frog:" });

    await prisma.emoticon.update({ where: { protocolId: original.id }, data: { imageUrl: "/uploads/frog-v2.png" } });

    const list = await api.get("/api/v1/emoticons").set(authHeader(bob.accessToken));
    const mine = list.body.personal.find((e: { id: string }) => e.id === res.body.emoticon.id);
    expect(mine.imageUrl).toBe("/uploads/frog-v1.png");
  });

  it("lets the forker supply their own starting image", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const original = await createEmoticon(alice.accessToken);

    const res = await fork(bob.accessToken, original.id, {
      name: "Blue frog",
      trigger: ":bluefrog:",
      imageUrl: "/uploads/blue.png",
    });

    expect(res.status).toBe(201);
    expect(res.body.emoticon.imageUrl).toBe("/uploads/blue.png");
  });

  it("is refused when the original has forking turned off", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const original = await createEmoticon(alice.accessToken, { allowFork: false });

    const res = await fork(bob.accessToken, original.id, { name: "x", trigger: ":x:" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forking_not_allowed");
  });

  // Regression: POST /:id/fork used to have no trigger-uniqueness check at all
  // (unlike /save), so a fork could silently shadow one of the user's own
  // triggers once it had a UI to do it from.
  it("rejects a trigger the user already uses for one of their own emoticons", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const original = await createEmoticon(alice.accessToken);
    await createEmoticon(bob.accessToken, { name: "Mine", trigger: ":taken:" });

    const res = await fork(bob.accessToken, original.id, { name: "Fork", trigger: ":taken:" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("trigger_already_in_use");
  });

  it("rejects a trigger that clashes with an emoticon the user has saved - including the original itself", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const original = await createEmoticon(alice.accessToken);
    await api.post(`/api/v1/emoticons/${original.id}/save`).set(authHeader(bob.accessToken)).send({});

    // Forking something you've saved under its own trigger would leave two
    // emoticons resolving to :frog: - the fork must pick a new trigger.
    const clash = await fork(bob.accessToken, original.id, { name: "Fork", trigger: ":frog:" });
    expect(clash.status).toBe(409);

    const ok = await fork(bob.accessToken, original.id, { name: "Fork", trigger: ":frog2:" });
    expect(ok.status).toBe(201);
  });

  it("404s for an unknown emoticon and 400s for a malformed trigger", async () => {
    const alice = await registerUser("alice");
    const original = await createEmoticon(alice.accessToken);

    expect((await fork(alice.accessToken, "NOSUCHEMOTICON", { name: "x", trigger: ":x:" })).status).toBe(404);
    expect((await fork(alice.accessToken, original.id, { name: "x", trigger: "nocolons" })).status).toBe(400);
  });
});

describe("sync", () => {
  async function forkedByBob() {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const original = await createEmoticon(alice.accessToken);
    const forked = (await fork(bob.accessToken, original.id, { name: "My frog", trigger: ":myfrog:" })).body.emoticon;
    return { alice, bob, original, forked };
  }

  it("pulls the original's current image, but never the fork's own name or trigger", async () => {
    const { bob, original, forked } = await forkedByBob();
    await prisma.emoticon.update({
      where: { protocolId: original.id },
      data: { name: "Frog Deluxe", imageUrl: "/uploads/frog-v2.png" },
    });

    const res = await sync(bob.accessToken, forked.id);

    expect(res.status).toBe(200);
    expect(res.body.emoticon).toMatchObject({
      id: forked.id,
      imageUrl: "/uploads/frog-v2.png",
      name: "My frog", // chosen by the forker - not overwritten by the original's rename
      trigger: ":myfrog:",
    });
    // ...though the attribution line still shows the original as it is now
    expect(res.body.emoticon.parent).toMatchObject({ id: original.id, name: "Frog Deluxe" });
  });

  it("is a harmless no-op when the original hasn't changed", async () => {
    const { bob, forked } = await forkedByBob();

    const res = await sync(bob.accessToken, forked.id);

    expect(res.status).toBe(200);
    expect(res.body.emoticon).toMatchObject({ name: "My frog", imageUrl: "/uploads/frog-v1.png" });
  });

  it("leaves the fork's own allow* flags alone", async () => {
    const { bob, original, forked } = await forkedByBob();
    await prisma.emoticon.update({ where: { protocolId: forked.id }, data: { allowSave: false, allowFork: false } });
    await prisma.emoticon.update({ where: { protocolId: original.id }, data: { imageUrl: "/uploads/frog-v2.png" } });

    const res = await sync(bob.accessToken, forked.id);

    expect(res.body.emoticon).toMatchObject({ allowSave: false, allowFork: false });
  });

  it("still works after the original turns forking off - that gates new forks, not existing ones", async () => {
    const { bob, original, forked } = await forkedByBob();
    await prisma.emoticon.update({
      where: { protocolId: original.id },
      data: { allowFork: false, imageUrl: "/uploads/frog-v2.png" },
    });

    const res = await sync(bob.accessToken, forked.id);

    expect(res.status).toBe(200);
    expect(res.body.emoticon.imageUrl).toBe("/uploads/frog-v2.png");
  });

  it("is refused for anyone but the fork's owner", async () => {
    const { alice, forked } = await forkedByBob();

    const res = await sync(alice.accessToken, forked.id);

    expect(res.status).toBe(403);
  });

  it("404s for an emoticon that isn't a fork", async () => {
    const alice = await registerUser("alice");
    const original = await createEmoticon(alice.accessToken);

    const res = await sync(alice.accessToken, original.id);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_a_fork");
  });

  it("404s once the original has been deleted, and the fork itself survives", async () => {
    const { alice, bob, original, forked } = await forkedByBob();
    expect((await api.delete(`/api/v1/emoticons/${original.id}`).set(authHeader(alice.accessToken))).status).toBe(204);

    const res = await sync(bob.accessToken, forked.id);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_a_fork");

    const list = await api.get("/api/v1/emoticons").set(authHeader(bob.accessToken));
    expect(list.body.personal.map((e: { id: string }) => e.id)).toContain(forked.id);
  });

  it("404s for an unknown id", async () => {
    const alice = await registerUser("alice");
    expect((await sync(alice.accessToken, "NOSUCHEMOTICON")).status).toBe(404);
  });
});

describe("edit", () => {
  const edit = (token: string, id: string, body: object) =>
    api.patch(`/api/v1/emoticons/${id}`).set(authHeader(token)).send(body);

  it("lets the creator rename it, replace its image, or both, leaving the trigger alone", async () => {
    const alice = await registerUser("alice");
    const e = await createEmoticon(alice.accessToken);

    const renamed = await edit(alice.accessToken, e.id, { name: "Big Frog" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.emoticon).toMatchObject({ name: "Big Frog", imageUrl: "/uploads/frog-v1.png", trigger: ":frog:" });

    const reimaged = await edit(alice.accessToken, e.id, { imageUrl: "/uploads/frog-v2.png" });
    expect(reimaged.body.emoticon).toMatchObject({ name: "Big Frog", imageUrl: "/uploads/frog-v2.png" });

    const both = await edit(alice.accessToken, e.id, { name: "Frog 3", imageUrl: "/uploads/frog-v3.png" });
    expect(both.body.emoticon).toMatchObject({ name: "Frog 3", imageUrl: "/uploads/frog-v3.png", trigger: ":frog:" });
  });

  it("ignores an attempt to change the trigger", async () => {
    const alice = await registerUser("alice");
    const e = await createEmoticon(alice.accessToken);

    const res = await edit(alice.accessToken, e.id, { name: "Renamed", trigger: ":hacked:" });

    expect(res.status).toBe(200);
    expect(res.body.emoticon).toMatchObject({ name: "Renamed", trigger: ":frog:" });
  });

  it("rejects an empty or invalid update", async () => {
    const alice = await registerUser("alice");
    const e = await createEmoticon(alice.accessToken);

    expect((await edit(alice.accessToken, e.id, {})).status).toBe(400);
    expect((await edit(alice.accessToken, e.id, { name: "" })).status).toBe(400);
    expect((await edit(alice.accessToken, e.id, { name: "x".repeat(41) })).status).toBe(400);
    expect((await edit(alice.accessToken, e.id, { imageUrl: "" })).status).toBe(400);
  });

  it("is refused for anyone but the creator, and 404s for an unknown id", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const e = await createEmoticon(alice.accessToken);

    expect((await edit(bob.accessToken, e.id, { name: "Stolen" })).status).toBe(403);
    expect((await edit(alice.accessToken, "NOSUCHEMOTICON", { name: "x" })).status).toBe(404);

    const list = await api.get("/api/v1/emoticons").set(authHeader(alice.accessToken));
    expect(list.body.personal[0].name).toBe("Frog");
  });

  it("shows up immediately for people who saved it, but not for forks until they sync", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const carol = await registerUser("carol");
    const original = await createEmoticon(alice.accessToken);
    await api.post(`/api/v1/emoticons/${original.id}/save`).set(authHeader(bob.accessToken)).send({});
    const forked = (await fork(carol.accessToken, original.id, { name: "Carol's", trigger: ":cfrog:" })).body.emoticon;

    await edit(alice.accessToken, original.id, { imageUrl: "/uploads/frog-v2.png" });

    const bobsList = await api.get("/api/v1/emoticons").set(authHeader(bob.accessToken));
    expect(bobsList.body.saved[0].imageUrl).toBe("/uploads/frog-v2.png"); // a save mirrors the original live

    const carolsBefore = await api.get("/api/v1/emoticons").set(authHeader(carol.accessToken));
    expect(carolsBefore.body.personal[0].imageUrl).toBe("/uploads/frog-v1.png"); // a fork stays put...

    const synced = await sync(carol.accessToken, forked.id); // ...until its owner syncs
    expect(synced.body.emoticon).toMatchObject({ imageUrl: "/uploads/frog-v2.png", name: "Carol's", trigger: ":cfrog:" });
  });

  it("lets a fork's owner customise their own copy, and a later sync deliberately replaces the image", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const original = await createEmoticon(alice.accessToken);
    const forked = (await fork(bob.accessToken, original.id, { name: "Mine", trigger: ":mine:" })).body.emoticon;

    const custom = await edit(bob.accessToken, forked.id, { imageUrl: "/uploads/bobs-own.png", name: "Mine v2" });
    expect(custom.status).toBe(200);
    expect(custom.body.emoticon).toMatchObject({ imageUrl: "/uploads/bobs-own.png", name: "Mine v2" });
    expect(custom.body.emoticon.parent).toMatchObject({ id: original.id }); // still a fork of the original

    // Sync is an explicit "take the original's image" action, so it overwrites the customised one.
    const synced = await sync(bob.accessToken, forked.id);
    expect(synced.body.emoticon).toMatchObject({ imageUrl: "/uploads/frog-v1.png", name: "Mine v2" });
  });
});

describe("edit: who may save or fork it", () => {
  const edit = (token: string, id: string, body: object) =>
    api.patch(`/api/v1/emoticons/${id}`).set(authHeader(token)).send(body);
  const save = (token: string, id: string) =>
    api.post(`/api/v1/emoticons/${id}/save`).set(authHeader(token)).send({});

  it("lets the creator turn saving and forking off and on, on their own, without touching the rest", async () => {
    const alice = await registerUser("alice");
    const e = await createEmoticon(alice.accessToken);

    const off = await edit(alice.accessToken, e.id, { allowSave: false });
    expect(off.status).toBe(200); // a flags-only update is a valid update
    expect(off.body.emoticon).toMatchObject({ allowSave: false, allowFork: true, name: "Frog", imageUrl: "/uploads/frog-v1.png" });

    const both = await edit(alice.accessToken, e.id, { allowFork: false });
    expect(both.body.emoticon).toMatchObject({ allowSave: false, allowFork: false });

    const back = await edit(alice.accessToken, e.id, { allowSave: true, allowFork: true });
    expect(back.body.emoticon).toMatchObject({ allowSave: true, allowFork: true });
  });

  it("makes the Save and Fork endpoints start refusing new people once switched off", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const e = await createEmoticon(alice.accessToken);
    await edit(alice.accessToken, e.id, { allowSave: false, allowFork: false });

    const saved = await save(bob.accessToken, e.id);
    expect(saved.status).toBe(403);
    expect(saved.body.error).toBe("saving_not_allowed");

    const forked = await fork(bob.accessToken, e.id, { name: "x", trigger: ":x:" });
    expect(forked.status).toBe(403);
    expect(forked.body.error).toBe("forking_not_allowed");

    await edit(alice.accessToken, e.id, { allowSave: true, allowFork: true });
    expect((await save(bob.accessToken, e.id)).status).toBe(204);
  });

  it("only stops new saves and forks - existing ones keep working", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const carol = await registerUser("carol");
    const e = await createEmoticon(alice.accessToken);
    await save(bob.accessToken, e.id);
    const forked = (await fork(carol.accessToken, e.id, { name: "Carol's", trigger: ":cfrog:" })).body.emoticon;

    await edit(alice.accessToken, e.id, { allowSave: false, allowFork: false });

    const bobsList = await api.get("/api/v1/emoticons").set(authHeader(bob.accessToken));
    expect(bobsList.body.saved.map((s: { trigger: string }) => s.trigger)).toEqual([":frog:"]);
    expect((await sync(carol.accessToken, forked.id)).status).toBe(200);
  });

  it("rejects non-boolean flag values and still refuses non-creators", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const e = await createEmoticon(alice.accessToken);

    expect((await edit(alice.accessToken, e.id, { allowSave: "no" })).status).toBe(400);
    expect((await edit(alice.accessToken, e.id, { allowFork: 0 })).status).toBe(400);
    expect((await edit(bob.accessToken, e.id, { allowSave: false })).status).toBe(403);

    const list = await api.get("/api/v1/emoticons").set(authHeader(alice.accessToken));
    expect(list.body.personal[0]).toMatchObject({ allowSave: true, allowFork: true });
  });
});

describe("emoticon list", () => {
  it("includes the parent summary on the user's own forks only, not on plain or saved emoticons", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const original = await createEmoticon(alice.accessToken);
    await fork(bob.accessToken, original.id, { name: "My frog", trigger: ":myfrog:" });
    await createEmoticon(bob.accessToken, { name: "Plain", trigger: ":plain:" });
    await api.post(`/api/v1/emoticons/${original.id}/save`).set(authHeader(bob.accessToken)).send({ trigger: ":saved:" });

    const { body } = await api.get("/api/v1/emoticons").set(authHeader(bob.accessToken));

    const forked = body.personal.find((e: { trigger: string }) => e.trigger === ":myfrog:");
    const plain = body.personal.find((e: { trigger: string }) => e.trigger === ":plain:");
    expect(forked.parent).toMatchObject({ id: original.id, name: "Frog", creator: { username: "alice" } });
    expect(plain.parent).toBeNull();
    expect(body.saved[0].parent).toBeUndefined(); // not loaded for saves, and not claimed as null
  });
});

describe("save (baseline)", () => {
  it("saves under the original's trigger, or an override, and refuses when saving is off", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const open = await createEmoticon(alice.accessToken);
    const locked = await createEmoticon(alice.accessToken, { name: "Locked", trigger: ":locked:", allowSave: false });

    expect((await api.post(`/api/v1/emoticons/${open.id}/save`).set(authHeader(bob.accessToken)).send({})).status).toBe(204);
    expect(
      (await api.post(`/api/v1/emoticons/${locked.id}/save`).set(authHeader(bob.accessToken)).send({})).status
    ).toBe(403);

    const list = await api.get("/api/v1/emoticons").set(authHeader(bob.accessToken));
    expect(list.body.saved.map((e: { trigger: string }) => e.trigger)).toEqual([":frog:"]);
  });
});
