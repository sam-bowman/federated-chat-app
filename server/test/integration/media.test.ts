import fs from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { UPLOAD_CACHE_CONTROL } from "../../src/lib/storage/cacheControl.js";
import { config } from "../../src/config.js";
import { api } from "../helpers/app.js";
import { disconnectDb, resetDb } from "../helpers/db.js";
import { authHeader, registerUser } from "../helpers/factory.js";

beforeEach(resetDb);
afterAll(disconnectDb);

describe("POST /api/v1/media/upload", () => {
  it("rejects an unauthenticated upload", async () => {
    const res = await api.post("/api/v1/media/upload").attach("file", Buffer.from("hi"), "hi.txt");
    expect(res.status).toBe(401);
  });

  it("stores the file under the disk driver and returns a /uploads/<name> URL", async () => {
    const { accessToken } = await registerUser("uploader");
    const res = await api
      .post("/api/v1/media/upload")
      .set(authHeader(accessToken))
      .attach("file", Buffer.from("hello world"), { filename: "note.txt", contentType: "text/plain" });

    expect(res.status).toBe(201);
    expect(res.body.url).toMatch(/^\/uploads\/[0-9a-f-]{36}\.txt$/);
    expect(res.body.filename).toBe("note.txt");
    expect(res.body.contentType).toBe("text/plain");
    expect(res.body.size).toBe(11);

    // Confirms the route handler actually wired through to the storage
    // adapter (server/src/lib/storage/) rather than just echoing a made-up
    // URL - the file genuinely exists where the URL says it does.
    const diskPath = `${config.uploadsDir}/${res.body.url.replace("/uploads/", "")}`;
    expect(fs.readFileSync(diskPath, "utf8")).toBe("hello world");
  });

  it("rejects an unsupported content type", async () => {
    const { accessToken } = await registerUser("uploader2");
    const res = await api
      .post("/api/v1/media/upload")
      .set(authHeader(accessToken))
      .attach("file", Buffer.from("#!/bin/sh\necho hi"), { filename: "script.sh", contentType: "application/x-sh" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("upload_failed");
  });

  // Regression test: PATCH /users/me's avatarUrl used to require
  // z.string().url(), which rejects the relative "/uploads/x.png" URL
  // this very endpoint returns under the disk driver (the normal case) -
  // setting an avatar through the UI was broken end to end. See the fix
  // in server/src/modules/users/routes.ts.
  it("the returned URL is accepted by PATCH /users/me's avatarUrl", async () => {
    const { accessToken } = await registerUser("avatarsetter");
    const uploaded = await api
      .post("/api/v1/media/upload")
      .set(authHeader(accessToken))
      .attach("file", Buffer.from("fake-png-bytes"), { filename: "avatar.png", contentType: "image/png" });
    expect(uploaded.status).toBe(201);

    const updated = await api.patch("/api/v1/users/me").set(authHeader(accessToken)).send({ avatarUrl: uploaded.body.url });

    expect(updated.status).toBe(200);
    expect(updated.body.user.avatarUrl).toBe(uploaded.body.url);
  });
});

describe("serving an uploaded file (#238)", () => {
  async function upload(name = "pic.png") {
    const { accessToken } = await registerUser(`up${Math.random().toString(36).slice(2, 8)}`);
    const res = await api.post("/api/v1/media/upload").set(authHeader(accessToken)).attach("file", Buffer.from("not really a png"), { filename: name, contentType: "image/png" });
    expect(res.status).toBe(201);
    return res.body.url as string;
  }

  it("tells the browser it may keep the file for a year and never needs to ask again, since a file never changes under its name", async () => {
    const url = await upload();
    const res = await api.get(url);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(res.headers["cache-control"]).toBe(UPLOAD_CACHE_CONTROL);
  });

  it("still answers a browser that does ask with 304 and no body, so a forced reload costs almost nothing", async () => {
    const url = await upload();
    const first = await api.get(url);
    const etag = first.headers.etag as string;
    expect(etag).toBeTruthy();
    const again = await api.get(url).set("If-None-Match", etag);
    expect(again.status).toBe(304);
    expect(again.text ?? "").toBe("");
  });

  it("does not give a file that is not there the same header, so a name that appears later is not hidden by a cached 404", async () => {
    const res = await api.get("/uploads/00000000-0000-0000-0000-000000000000.png");
    expect(res.status).toBe(404);
    expect(String(res.headers["cache-control"] ?? "")).not.toContain("immutable");
  });

  it("does not give the API the header: only uploaded files are kept for a year", async () => {
    const { accessToken } = await registerUser("noimmutable");
    const res = await api.get("/api/v1/users/me").set(authHeader(accessToken));
    expect(res.status).toBe(200);
    expect(String(res.headers["cache-control"] ?? "")).not.toContain("immutable");
    expect(String((await api.get("/.well-known/communication-platform")).headers["cache-control"] ?? "")).not.toContain("immutable");
  });

  it("gives each upload a name of its own, so a changed picture is a new address and an old one never needs to be asked about", async () => {
    const [a, b] = [await upload(), await upload()];
    expect(a).not.toBe(b);
  });
});
