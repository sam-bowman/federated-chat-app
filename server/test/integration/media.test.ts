import fs from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
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
