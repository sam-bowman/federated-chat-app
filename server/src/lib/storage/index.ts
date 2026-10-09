import { config } from "../../config.js";
import { DiskStorageAdapter } from "./diskStorage.js";
import { S3StorageAdapter } from "./s3Storage.js";
import type { StorageAdapter, UploadInput, UploadResult } from "./types.js";

export type { UploadInput, UploadResult };

let adapter: StorageAdapter | undefined;

// The only place that reads config.* for storage - diskStorage.ts/
// s3Storage.ts take their settings via constructor options instead of
// importing config.js themselves, so they (and their tests) have no
// dependency on the rest of config.ts's module-level validation (notably
// DATABASE_URL, which isn't set in the unit-test environment - see
// test/setupEnv.ts vs. the plain unit-test vitest.config.ts).
function getAdapter(): StorageAdapter {
  if (!adapter) {
    adapter =
      config.storageDriver === "s3"
        ? new S3StorageAdapter({
            bucket: config.s3.bucket!,
            region: config.s3.region!,
            accessKeyId: config.s3.accessKeyId!,
            secretAccessKey: config.s3.secretAccessKey!,
            publicUrlBase: config.s3.publicUrlBase!,
            endpoint: config.s3.endpoint,
            forcePathStyle: config.s3.forcePathStyle,
          })
        : new DiskStorageAdapter({ uploadsDir: config.uploadsDir });
  }
  return adapter;
}

/** Test-only: forces the next getAdapter()-backed call to re-read config. */
export function resetStorageAdapterForTests() {
  adapter = undefined;
}

export function uploadFile(input: UploadInput): Promise<UploadResult> {
  return getAdapter().upload(input);
}
