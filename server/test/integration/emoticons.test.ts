// First coverage for the emoticons module. Focus is the fork/sync flow (Save
// is covered at the level needed to pin its interaction with forking).
//
// There is deliberately no API for an owner to edit an emoticon yet, so tests
// that need "the original changed upstream" update the row directly.
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
