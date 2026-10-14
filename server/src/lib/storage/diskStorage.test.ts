import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiskStorageAdapter } from "./diskStorage.js";

describe("DiskStorageAdapter", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-disk-storage-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates uploadsDir if it doesn't exist yet", () => {
    const nested = path.join(tmpDir, "nested", "uploads");
    expect(fs.existsSync(nested)).toBe(false);
    new DiskStorageAdapter({ uploadsDir: nested });
    expect(fs.existsSync(nested)).toBe(true);
  });

  it("writes the file under uploadsDir and returns a /uploads/<name> URL", async () => {
    const adapter = new DiskStorageAdapter({ uploadsDir: tmpDir });
    const result = await adapter.upload({
      buffer: Buffer.from("hello world"),
      originalFilename: "photo.PNG",
      contentType: "image/png",
    });

    expect(result.url).toMatch(/^\/uploads\/[0-9a-f-]{36}\.PNG$/);
    const writtenPath = path.join(tmpDir, result.url.replace("/uploads/", ""));
    expect(fs.readFileSync(writtenPath, "utf8")).toBe("hello world");
  });

  it("generates a different random filename for each upload, even with the same original name", async () => {
    const adapter = new DiskStorageAdapter({ uploadsDir: tmpDir });
    const a = await adapter.upload({ buffer: Buffer.from("a"), originalFilename: "x.png", contentType: "image/png" });
    const b = await adapter.upload({ buffer: Buffer.from("b"), originalFilename: "x.png", contentType: "image/png" });
    expect(a.url).not.toBe(b.url);
  });

  it("truncates an unreasonably long extension to 16 characters", async () => {
    const adapter = new DiskStorageAdapter({ uploadsDir: tmpDir });
    const result = await adapter.upload({
      buffer: Buffer.from("x"),
      originalFilename: `file.${"a".repeat(50)}`,
      contentType: "text/plain",
    });
    const ext = result.url.split(".").slice(1).join(".");
    expect(ext.length).toBeLessThanOrEqual(16);
  });
});

describe("DiskStorageAdapter.delete", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-disk-delete-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("removes a file it uploaded, given the URL upload() returned", async () => {
    const adapter = new DiskStorageAdapter({ uploadsDir: tmpDir });
    const { url } = await adapter.upload({ buffer: Buffer.from("x"), originalFilename: "a.png", contentType: "image/png" });

    expect(await adapter.delete(url)).toBe(true);
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  it("returns false for a file that is already gone", async () => {
    const adapter = new DiskStorageAdapter({ uploadsDir: tmpDir });
    expect(await adapter.delete("/uploads/missing.png")).toBe(false);
  });

  // The URL is stored data that came from a user (an icon URL, a federated attachment), so it must never
  // be able to reach a file outside the uploads folder.
  it("refuses anything that is not a single file directly under /uploads/", async () => {
    const outside = path.join(path.dirname(tmpDir), "chat-disk-delete-outside.txt");
    fs.writeFileSync(outside, "keep me");
    const uploads = path.join(tmpDir, "uploads");
    const adapter = new DiskStorageAdapter({ uploadsDir: uploads });
    fs.writeFileSync(path.join(uploads, "keep.png"), "keep me too");
    const base = path.basename(outside);

    for (const url of [
      `/uploads/../${base}`,
      `/uploads/..%2F${base}`,
      `/uploads/..`,
      `/uploads/.`,
      `/uploads/nested/keep.png`,
      `/uploads/..\\${base}`,
      `/uploads/`,
      `uploads/keep.png`,
      `https://elsewhere.example/uploads/keep.png`,
      `https://my-bucket.s3.amazonaws.com/keep.png`,
      ``,
    ]) {
      expect(await adapter.delete(url), url).toBe(false);
    }
    expect(fs.readFileSync(outside, "utf8")).toBe("keep me");
    expect(fs.existsSync(path.join(uploads, "keep.png"))).toBe(true);
    fs.rmSync(outside);
  });
});
