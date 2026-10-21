// docs/api/openapi.yaml is the API reference (#61), and a reference nobody checks is wrong within a month. So this checks it against
// the server itself: every route the server has is in it and nothing else is, what it says about needing a sign-in is true, every
// reference in it resolves, and what real responses look like fits the schemas it gives them.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parse } from "yaml";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { config } from "../../src/config.js";
import { prisma } from "../../src/db.js";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { authHeader, registerUser } from "../helpers/factory.js";

beforeEach(resetDb);
afterAll(disconnectDb);

type Operation = {
  tags?: string[];
  summary?: string;
  description?: string;
  security?: unknown[];
  parameters?: { name: string; in: string; required?: boolean }[];
  requestBody?: unknown;
  responses?: Record<string, { description?: string; content?: Record<string, { schema?: unknown }> } | { $ref: string }>;
};
type Spec = {
  tags: { name: string }[];
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, unknown>; responses: Record<string, unknown> };
  security?: unknown[];
};
const METHODS = ["get", "post", "put", "patch", "delete"];

const spec = parse(readFileSync(resolve(import.meta.dirname, "../../../docs/api/openapi.yaml"), "utf8")) as Spec;
const operations = Object.entries(spec.paths).flatMap(([path, item]) =>
  METHODS.filter((m) => item[m]).map((method) => ({ method: method.toUpperCase(), path, op: item[method] }))
);
/** `/users/{id}/profile` -> `/users/{}/profile`, so the names given to parameters do not matter. */
const shape = (path: string) => path.replace(/\{[^}]+\}|:[A-Za-z]+/g, "{}").replace(/\/$/, "") || "/";

// --- the routes the server really has -----------------------------------------------------------------------------------
type Layer = { handle: { stack?: Layer[] }; route?: { path: string; methods: Record<string, boolean> }; regexp?: RegExp };
function mountOf(layer: Layer): string {
  const m = (layer.regexp?.source ?? "").match(/^\^\\\/(.*?)\\\/\?\(\?=\\\/\|\$\)$/);
  return m ? "/" + m[1].replace(/\\\//g, "/") : "";
}
function realRoutes(): { method: string; path: string }[] {
  const found: { method: string; path: string }[] = [];
  const walk = (stack: Layer[], prefix: string) => {
    for (const layer of stack) {
      if (layer.route) for (const method of Object.keys(layer.route.methods)) found.push({ method: method.toUpperCase(), path: prefix + layer.route.path });
      else if (layer.handle.stack) walk(layer.handle.stack, prefix + mountOf(layer));
    }
  };
  walk((app as unknown as { _router: { stack: Layer[] } })._router.stack, "");
  return found.filter((r) => r.path.startsWith("/api/v1/")).map((r) => ({ method: r.method, path: shape(r.path.slice("/api/v1".length)) }));
}

describe("the routes", () => {
  it("are all in the reference, and the reference has no others", () => {
    const real = new Set(realRoutes().map((r) => `${r.method} ${r.path}`));
    const documented = new Set(operations.map((o) => `${o.method} ${shape(o.path)}`));
    expect([...real].filter((r) => !documented.has(r)).sort(), "routes the reference does not mention").toEqual([]);
    expect([...documented].filter((r) => !real.has(r)).sort(), "operations the server does not have").toEqual([]);
    expect(real.size).toBeGreaterThan(70); // and the walk did find them
  });

  it("are each documented once", () => {
    const keys = operations.map((o) => `${o.method} ${shape(o.path)}`);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
  });
});

describe("what the reference says about signing in", () => {
  /** An address a request can be sent to: each parameter becomes a made-up id. */
  const concrete = (path: string) => path.replace(/\{[^}]+\}/g, "nosuchid");

  it.each(operations.map((o) => [`${o.method} ${o.path}`, o] as const))("%s is true", async (_name, { method, path, op }) => {
    const needsSignIn = (op.security ?? spec.security ?? []).length > 0;
    const send = api[method.toLowerCase() as "get"](`/api/v1${concrete(path)}`);
    const res = method === "GET" || method === "DELETE" ? await send : await send.send({});
    if (needsSignIn) {
      expect(res.status, "answers 401 without a token").toBe(401);
      expect(res.body.error).toBe("missing_token");
    } else {
      expect(res.body?.error, "does not ask for a token").not.toBe("missing_token");
    }
  });
});

describe("the document", () => {
  it("is a proper OpenAPI 3.1 document with a title, a version and every tag declared", () => {
    expect(String((spec as unknown as { openapi: string }).openapi)).toMatch(/^3\.1/);
    expect((spec as unknown as { info: { title: string; version: string } }).info.title).toBeTruthy();
    const declared = new Set(spec.tags.map((t) => t.name));
    for (const { method, path, op } of operations) for (const tag of op.tags ?? []) expect(declared.has(tag), `${method} ${path}: tag ${tag}`).toBe(true);
  });

  it("describes every operation: a summary, a tag, and the answers it can give", () => {
    for (const { method, path, op } of operations) {
      const where = `${method} ${path}`;
      expect(op.summary, `${where}: summary`).toBeTruthy();
      expect(op.tags?.length, `${where}: tag`).toBeGreaterThan(0);
      expect(Object.keys(op.responses ?? {}).length, `${where}: responses`).toBeGreaterThan(0);
    }
  });

  it("names every {parameter} in a path, once, as a path parameter", () => {
    for (const { method, path, op } of operations) {
      const inPath = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
      const declared = (op.parameters ?? []).filter((p) => p.in === "path").map((p) => p.name);
      expect(declared.sort(), `${method} ${path}`).toEqual(inPath.sort());
      for (const p of op.parameters ?? []) if (p.in === "path") expect(p.required, `${method} ${path}: ${p.name}`).toBe(true);
    }
  });

  it("only refers to things that exist", () => {
    const text = readFileSync(resolve(import.meta.dirname, "../../../docs/api/openapi.yaml"), "utf8");
    const refs = [...text.matchAll(/\$ref: "#\/components\/(schemas|responses)\/([A-Za-z]+)"/g)];
    expect(refs.length).toBeGreaterThan(50);
    for (const [, kind, name] of refs) {
      const group = kind === "schemas" ? spec.components.schemas : spec.components.responses;
      expect(name in group, `#/components/${kind}/${name}`).toBe(true);
    }
  });

  it("has no description cut short by a comma (in the compact { a: b, c: d } style a comma ends the text and the rest silently becomes a field)", () => {
    const strays: string[] = [];
    const walk = (value: unknown, path: string) => {
      if (Array.isArray(value)) return value.forEach((v, i) => walk(v, `${path}[${i}]`));
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        const here = `${path}.${key}`;
        // A property name is a word; a key with a space in it, or an empty value, is what a cut-short sentence leaves behind.
        if (!key.startsWith("/") && (/[\s.]/.test(key) || (child === null && !/\.(const|default|example)$/.test(here))) && !/\.responses\./.test(here)) strays.push(here);
        walk(child, here);
      }
    };
    walk(spec, "");
    expect(strays).toEqual([]);
  });

  it("is rendered, in docs/api/reference.md, exactly as the generator makes it", async () => {
    const { renderReference } = (await import("../../scripts/api-reference.mjs")) as { renderReference: (spec: unknown) => string };
    const committed = readFileSync(resolve(import.meta.dirname, "../../../docs/api/reference.md"), "utf8").split(String.fromCharCode(13)).join("");
    expect(committed, "run: npm run docs:api --workspace server").toBe(renderReference(spec));
  });

  it("has a heading for every operation that nothing else shares, so the links in the reference land", async () => {
    const { slug } = (await import("../../scripts/api-reference.mjs")) as { slug: (text: string) => string };
    const slugs = operations.map((o) => slug(`${o.method} ${o.path}`));
    expect(slugs.filter((s, i) => slugs.indexOf(s) !== i)).toEqual([]);
  });

  it("has no schema nobody uses", () => {
    const text = readFileSync(resolve(import.meta.dirname, "../../../docs/api/openapi.yaml"), "utf8");
    const unused = Object.keys(spec.components.schemas).filter((name) => !text.includes(`#/components/schemas/${name}"`));
    expect(unused).toEqual([]);
  });
});

// --- real answers fit the schemas ----------------------------------------------------------------------------------------
describe("real answers fit the schemas the reference gives them", () => {
  const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true });
  type Answer = { content?: Record<string, { schema?: unknown }> } | { $ref: string };
  const answerOf = (a: Answer) => ("$ref" in a ? (spec.components.responses[a.$ref.split("/").pop()!] as Answer) : a);

  const exercised = new Set<string>();

  /** Checks a response body against what the reference says that operation answers with at that status. */
  function fits(method: string, template: string, status: number, body: unknown) {
    exercised.add(`${method} ${shape(template)} ${status}`);
    const operation = operations.find((o) => o.method === method && shape(o.path) === shape(template));
    expect(operation, `${method} ${template} is documented`).toBeTruthy();
    const answer = operation!.op.responses?.[String(status)] as Answer | undefined;
    expect(answer, `${method} ${template} documents a ${status}`).toBeTruthy();
    const schema = (answerOf(answer!) as { content?: Record<string, { schema?: unknown }> }).content?.["application/json"]?.schema;
    if (!schema) return; // a 204, or an answer with no body to check
    // The schemas refer to "#/components/...", so they are compiled with the components beside them.
    const validate = ajv.compile({ ...(schema as object), components: spec.components });
    expect(validate(body), `${method} ${template} ${status}: ${JSON.stringify(validate.errors?.slice(0, 3))} in ${JSON.stringify(body).slice(0, 300)}`).toBe(true);
    // An answer that is an object of its own (`{ "user": ... }`) says exactly the keys the server sends, no fewer and no more.
    const own = schema as { type?: string; properties?: Record<string, unknown>; oneOf?: unknown };
    if (own.type === "object" && own.properties && !own.oneOf && body && typeof body === "object") {
      expect(Object.keys(body).sort(), `${method} ${template} ${status}: the keys`).toEqual(Object.keys(own.properties).sort());
    }
  }

  it("sign-up, sign-in, your account and your status", async () => {
    const signUp = await api.post("/api/v1/auth/register").send({ username: "alice", password: "Correct-Horse-Battery-Staple-1", displayName: "Alice" });
    fits("POST", "/auth/register", signUp.status, signUp.body);
    const login = await api.post("/api/v1/auth/login").send({ username: "alice", password: "Correct-Horse-Battery-Staple-1" });
    fits("POST", "/auth/login", login.status, login.body);
    const token = signUp.body.accessToken as string;
    const me = await api.get("/api/v1/users/me").set(authHeader(token));
    fits("GET", "/users/me", me.status, me.body);
    const changed = await api.patch("/api/v1/users/me").set(authHeader(token)).send({ bio: "hi", pronouns: "she/her" });
    fits("PATCH", "/users/me", changed.status, changed.body);
    const presence = await api.patch("/api/v1/users/me/presence").set(authHeader(token)).send({ status: "AWAY", customStatus: "out" });
    fits("PATCH", "/users/me/presence", presence.status, presence.body);
    const refreshed = await api.post("/api/v1/auth/refresh").send({ refreshToken: signUp.body.refreshToken });
    fits("POST", "/auth/refresh", refreshed.status, refreshed.body);
    const wrong = await api.post("/api/v1/auth/login").send({ username: "alice", password: "nope" });
    fits("POST", "/auth/login", wrong.status, wrong.body);
  });

  it("people, friends and blocking", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const carol = await registerUser("carol");
    const found = await api.get("/api/v1/users/search?q=bo").set(authHeader(alice.accessToken));
    fits("GET", "/users/search", found.status, found.body);
    const one = await api.get("/api/v1/users/bob").set(authHeader(alice.accessToken));
    fits("GET", "/users/{username}", one.status, one.body);
    const profile = await api.get(`/api/v1/users/${bob.user.id}/profile`).set(authHeader(alice.accessToken));
    fits("GET", "/users/{id}/profile", profile.status, profile.body);

    const sent = await api.post("/api/v1/friends/requests").set(authHeader(alice.accessToken)).send({ username: "bob", message: "hi" });
    fits("POST", "/friends/requests", sent.status, sent.body);
    const waiting = await api.get("/api/v1/friends/requests?direction=incoming").set(authHeader(bob.accessToken));
    fits("GET", "/friends/requests", waiting.status, waiting.body);
    const accepted = await api.post(`/api/v1/friends/requests/${sent.body.request.id}/accept`).set(authHeader(bob.accessToken));
    fits("POST", "/friends/requests/{id}/accept", accepted.status, accepted.body);
    const friends = await api.get("/api/v1/friends").set(authHeader(alice.accessToken));
    fits("GET", "/friends", friends.status, friends.body);
    await api.post("/api/v1/friends/blocks").set(authHeader(alice.accessToken)).send({ username: "carol" });
    const blocked = await api.get("/api/v1/friends/blocks").set(authHeader(alice.accessToken));
    fits("GET", "/friends/blocks", blocked.status, blocked.body);
    expect(carol).toBeTruthy();
  });

  it("chats and their messages", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const made = await api.post("/api/v1/conversations").set(authHeader(alice.accessToken)).send({ type: "DM", memberUsernames: ["bob"] });
    fits("POST", "/conversations", made.status, made.body);
    const again = await api.post("/api/v1/conversations").set(authHeader(alice.accessToken)).send({ type: "DM", memberUsernames: ["bob"] });
    fits("POST", "/conversations", again.status, again.body); // a direct chat that already exists: 200
    const id = made.body.conversation.id as string;
    const sent = await api.post(`/api/v1/conversations/${id}/messages`).set(authHeader(alice.accessToken)).send({ content: "hello :smile:" });
    fits("POST", "/conversations/{id}/messages", sent.status, sent.body);
    const list = await api.get(`/api/v1/conversations/${id}/messages`).set(authHeader(bob.accessToken));
    fits("GET", "/conversations/{id}/messages", list.status, list.body);
    const mine = await api.get("/api/v1/conversations").set(authHeader(bob.accessToken));
    fits("GET", "/conversations", mine.status, mine.body);
    const one = await api.get(`/api/v1/conversations/${id}`).set(authHeader(bob.accessToken));
    fits("GET", "/conversations/{id}", one.status, one.body);
    const edited = await api.patch(`/api/v1/messages/${sent.body.message.id}`).set(authHeader(alice.accessToken)).send({ content: "hello, edited" });
    fits("PATCH", "/messages/{id}", edited.status, edited.body);
    const reacted = await api.post(`/api/v1/messages/${sent.body.message.id}/reactions`).set(authHeader(bob.accessToken)).send({ emoji: "👍" });
    fits("POST", "/messages/{id}/reactions", reacted.status, reacted.body);
    const unreacted = await api.delete(`/api/v1/messages/${sent.body.message.id}/reactions/${encodeURIComponent("👍")}`).set(authHeader(bob.accessToken));
    fits("DELETE", "/messages/{id}/reactions/{emoji}", unreacted.status, unreacted.body);
    const emoticon = (await api.post("/api/v1/emoticons").set(authHeader(alice.accessToken)).send({ name: "Wave", trigger: ":wave:", imageUrl: "/uploads/w.png" })).body.emoticon;
    await api.post(`/api/v1/messages/${sent.body.message.id}/reactions`).set(authHeader(alice.accessToken)).send({ emoticonId: emoticon.id });
    const unemoticoned = await api.delete(`/api/v1/messages/${sent.body.message.id}/emoticon-reactions/${emoticon.id}`).set(authHeader(alice.accessToken));
    fits("DELETE", "/messages/{id}/emoticon-reactions/{emoticonId}", unemoticoned.status, unemoticoned.body);
    const calls = await api.get("/api/v1/conversations/voice").set(authHeader(bob.accessToken));
    fits("GET", "/conversations/voice", calls.status, calls.body);
  });

  it("communities, channels, roles, invites and bans", async () => {
    const alice = await registerUser("alice");
    const bob = await registerUser("bob");
    const created = await api.post("/api/v1/communities").set(authHeader(alice.accessToken)).send({ name: "Club", description: "d" });
    fits("POST", "/communities", created.status, created.body);
    const id = created.body.community.id as string;
    const mine = await api.get("/api/v1/communities").set(authHeader(alice.accessToken));
    fits("GET", "/communities", mine.status, mine.body);
    const one = await api.get(`/api/v1/communities/${id}`).set(authHeader(alice.accessToken));
    fits("GET", "/communities/{id}", one.status, one.body);
    const patched = await api.patch(`/api/v1/communities/${id}`).set(authHeader(alice.accessToken)).send({ name: "Club 2", iconText: "C2", iconColor: "#e8b84b", visibility: "INVITE_ONLY" });
    fits("PATCH", "/communities/{id}", patched.status, patched.body);

    const invite = await api.post(`/api/v1/communities/${id}/invites`).set(authHeader(alice.accessToken)).send({ expiresInSeconds: 3600, maxUses: 3 });
    fits("POST", "/communities/{id}/invites", invite.status, invite.body);
    const invites = await api.get(`/api/v1/communities/${id}/invites`).set(authHeader(alice.accessToken));
    fits("GET", "/communities/{id}/invites", invites.status, invites.body);
    const joined = await api.post(`/api/v1/communities/${id}/members`).set(authHeader(bob.accessToken)).send({ inviteCode: invite.body.invite.code });
    fits("POST", "/communities/{id}/members", joined.status, joined.body);

    const role = await api.post(`/api/v1/communities/${id}/roles`).set(authHeader(alice.accessToken)).send({ name: "Mods", color: "#336699", permissions: "48" });
    fits("POST", "/communities/{id}/roles", role.status, role.body);
    const roleChanged = await api.patch(`/api/v1/communities/${id}/roles/${role.body.role.id}`).set(authHeader(alice.accessToken)).send({ color: null });
    fits("PATCH", "/communities/{id}/roles/{roleId}", roleChanged.status, roleChanged.body);

    const channel = await api.post(`/api/v1/communities/${id}/channels`).set(authHeader(alice.accessToken)).send({ name: "random", topic: "anything" });
    fits("POST", "/communities/{id}/channels", channel.status, channel.body);
    const renamed = await api.patch(`/api/v1/communities/${id}/channels/${channel.body.channel.id}`).set(authHeader(alice.accessToken)).send({ topic: "" });
    fits("PATCH", "/communities/{id}/channels/{channelId}", renamed.status, renamed.body);
    const order = (await api.get(`/api/v1/communities/${id}`).set(authHeader(alice.accessToken))).body.community.channels.map((c: { id: string }) => c.id).reverse();
    const reordered = await api.put(`/api/v1/communities/${id}/channels/order`).set(authHeader(alice.accessToken)).send({ order });
    fits("PUT", "/communities/{id}/channels/order", reordered.status, reordered.body);

    const channelId = channel.body.channel.id as string;
    const sent = await api.post(`/api/v1/channels/${channelId}/messages`).set(authHeader(bob.accessToken)).send({ content: "in the channel" });
    fits("POST", "/channels/{id}/messages", sent.status, sent.body);
    const history = await api.get(`/api/v1/channels/${channelId}/messages`).set(authHeader(alice.accessToken));
    fits("GET", "/channels/{id}/messages", history.status, history.body);

    const ban = await api.post(`/api/v1/communities/${id}/bans`).set(authHeader(alice.accessToken)).send({ protocolId: bob.user.id, reason: "test" });
    expect(ban.status).toBe(204);
    const bans = await api.get(`/api/v1/communities/${id}/bans`).set(authHeader(alice.accessToken));
    fits("GET", "/communities/{id}/bans", bans.status, bans.body);
    const voice = await api.get(`/api/v1/communities/${id}/voice`).set(authHeader(alice.accessToken));
    fits("GET", "/communities/{id}/voice", voice.status, voice.body);
  });

  it("emoticons, uploads, notification choices and catching up", async () => {
    const alice = await registerUser("alice");
    const upload = await api.post("/api/v1/media/upload").set(authHeader(alice.accessToken)).attach("file", Buffer.from("89504e470d0a1a0a", "hex"), { filename: "a.png", contentType: "image/png" });
    fits("POST", "/media/upload", upload.status, upload.body);
    const emoticon = await api.post("/api/v1/emoticons").set(authHeader(alice.accessToken)).send({ name: "Wave", trigger: ":wave:", imageUrl: upload.body.url });
    fits("POST", "/emoticons", emoticon.status, emoticon.body);
    const all = await api.get("/api/v1/emoticons").set(authHeader(alice.accessToken));
    fits("GET", "/emoticons", all.status, all.body);
    const put = await api.put("/api/v1/notification-settings").set(authHeader(alice.accessToken)).send({ type: "GLOBAL", sound: false });
    fits("PUT", "/notification-settings", put.status, put.body);
    const settings = await api.get("/api/v1/notification-settings").set(authHeader(alice.accessToken));
    fits("GET", "/notification-settings", settings.status, settings.body);
    const sync = await api.get("/api/v1/sync").set(authHeader(alice.accessToken));
    fits("GET", "/sync", sync.status, sync.body);
  });

  it("two-factor setup and the errors every operation shares", async () => {
    const alice = await registerUser("alice");
    const setup = await api.post("/api/v1/auth/2fa/setup").set(authHeader(alice.accessToken)).send({ password: "Correct-Horse-Battery-Staple-1" });
    fits("POST", "/auth/2fa/setup", setup.status, setup.body);
    const missing = await api.get("/api/v1/users/me");
    fits("GET", "/users/me", missing.status, missing.body);
    const unknown = await api.get("/api/v1/communities/nosuchid").set(authHeader(alice.accessToken));
    fits("GET", "/communities/{id}", unknown.status, unknown.body);
  });

  it("more emoticon, role, two-factor and ownership answers", async () => {
    const alice = await registerUser("alice", { password: "Correct-Horse-Battery-Staple-1" });
    const bob = await registerUser("bob");
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    const up = await api.post("/api/v1/media/upload").set(authHeader(alice.accessToken)).attach("file", png, { filename: "a.png", contentType: "image/png" });
    const emoticon = await api.post("/api/v1/emoticons").set(authHeader(alice.accessToken)).send({ name: "Wave", trigger: ":wave:", imageUrl: up.body.url });
    const id = emoticon.body.emoticon.id as string;
    const patched = await api.patch(`/api/v1/emoticons/${id}`).set(authHeader(alice.accessToken)).send({ name: "Wave 2" });
    fits("PATCH", "/emoticons/{id}", patched.status, patched.body);
    const forked = await api.post(`/api/v1/emoticons/${id}/fork`).set(authHeader(bob.accessToken)).send({ name: "My wave", trigger: ":mywave:" });
    fits("POST", "/emoticons/{id}/fork", forked.status, forked.body);
    const synced = await api.post(`/api/v1/emoticons/${forked.body.emoticon.id}/sync`).set(authHeader(bob.accessToken));
    fits("POST", "/emoticons/{id}/sync", synced.status, synced.body);
    const saved = await api.post(`/api/v1/emoticons/${id}/save`).set(authHeader(bob.accessToken)).send({});
    fits("POST", "/emoticons/{id}/save", saved.status, saved.body);

    const club = (await api.post("/api/v1/communities").set(authHeader(alice.accessToken)).send({ name: "Club" })).body.community;
    await api.post(`/api/v1/communities/${club.id}/members`).set(authHeader(bob.accessToken));
    const moved = await api.put(`/api/v1/communities/${club.id}/owner`).set(authHeader(alice.accessToken)).send({ userId: bob.user.id, password: "Correct-Horse-Battery-Staple-1" });
    fits("PUT", "/communities/{id}/owner", moved.status, moved.body);

    const setup = await api.post("/api/v1/auth/2fa/setup").set(authHeader(alice.accessToken)).send({ password: "Correct-Horse-Battery-Staple-1" });
    const { generate } = await import("otplib");
    const verified = await api.post("/api/v1/auth/2fa/verify").set(authHeader(alice.accessToken)).send({ code: await generate({ secret: setup.body.secret }) });
    fits("POST", "/auth/2fa/verify", verified.status, verified.body);
    const challenge = await api.post("/api/v1/auth/login").send({ username: "alice", password: "Correct-Horse-Battery-Staple-1" });
    fits("POST", "/auth/login", challenge.status, challenge.body);
    const finished = await api.post("/api/v1/auth/2fa/login").send({ challengeToken: challenge.body.challengeToken, recoveryCode: verified.body.recoveryCodes[0] });
    fits("POST", "/auth/2fa/login", finished.status, finished.body);

    // The directory answers only on a server that publishes one.
    const before = config.directoryEnabled;
    try {
      const closed = await api.get("/api/v1/directory/communities").set(authHeader(alice.accessToken));
      fits("GET", "/directory/communities", closed.status, closed.body);
      config.directoryEnabled = true;
      await prisma.user.updateMany({ where: { username: "alice" }, data: { listedInDirectory: true } });
      await prisma.community.updateMany({ where: { protocolId: club.id }, data: { visibility: "PUBLIC" } });
      const directory = await api.get("/api/v1/directory/communities").set(authHeader(alice.accessToken));
      fits("GET", "/directory/communities", directory.status, directory.body);
      expect(directory.body.items.length, "communities: " + JSON.stringify(directory.body)).toBeGreaterThan(0);
      const people = await api.get("/api/v1/directory/people").set(authHeader(bob.accessToken)); // you are not listed to yourself
      fits("GET", "/directory/people", people.status, people.body);
      expect(people.body.items.length, "people: " + JSON.stringify(people.body)).toBeGreaterThan(0);
    } finally {
      config.directoryEnabled = before;
    }
    const token = await api.post(`/api/v1/channels/${club.channels[0].id}/voice-token`).set(authHeader(alice.accessToken));
    fits("POST", "/channels/{id}/voice-token", token.status, token.body);
  });

  it("covers every operation that answers with a body, or says why it does not", () => {
    // Operations that are left out on purpose: they need something a test cannot give (another server, a voice server), or
    // only differ from one that is covered by who may call them.
    const NOT_CHECKED = new Set([
      "POST /users/me/export 200", // a file, checked by accountExport.test.ts
      "POST /voice/webhook 200", // LiveKit's call, checked by voicePresence.test.ts
      "GET /conversations/voice 200", // covered above, with voice off
      "POST /conversations/{}/voice-token 200", // needs a voice server (voiceCalls.test.ts)
      "POST /channels/{}/voice-token 200",
      "GET /communities/{}/voice 200",
      "POST /auth/2fa/login 200", // see above
    ]);
    const missing: string[] = [];
    for (const { method, path, op } of operations) {
      for (const [status, answer] of Object.entries(op.responses ?? {})) {
        if (!status.startsWith("2")) continue;
        const resolved = "$ref" in answer ? undefined : answer;
        if (!resolved?.content?.["application/json"]?.schema) continue;
        const key = `${method} ${shape(path)} ${status}`;
        if (!exercised.has(key) && !NOT_CHECKED.has(key)) missing.push(key);
      }
    }
    expect(missing).toEqual([]);
  });
});
