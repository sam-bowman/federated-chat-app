import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { StorageAdapter, UploadInput, UploadResult } from "./types.js";

export interface DiskStorageOptions {
  uploadsDir: string;
}

/**
 * Writes straight to uploadsDir, served statically at /uploads (see
 * app.ts) - the only driver before S3 support existed, and still the
 * default: correct for a single replica, where local disk is exactly as
 * durable as the server process itself. Not safe to use with more than
 * one server replica (each would only see its own uploads) - see
 * server/src/lib/storage/s3Storage.ts for that case.
 */
export class DiskStorageAdapter implements StorageAdapter {
  private readonly uploadsDir: string;

  constructor(options: DiskStorageOptions) {
    this.uploadsDir = options.uploadsDir;
    fs.mkdirSync(this.uploadsDir, { recursive: true });
  }

  async upload(input: UploadInput): Promise<UploadResult> {
    const ext = path.extname(input.originalFilename).slice(0, 16);
    const filename = `${crypto.randomUUID()}${ext}`;
    await fs.promises.writeFile(path.join(this.uploadsDir, filename), input.buffer);
    return { url: `/uploads/${filename}` };
  }
}
