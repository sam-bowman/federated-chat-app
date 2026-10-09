import crypto from "node:crypto";
import path from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { StorageAdapter, UploadInput, UploadResult } from "./types.js";

export interface S3StorageOptions {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** No trailing slash, e.g. "https://my-bucket.s3.us-east-1.amazonaws.com". */
  publicUrlBase: string;
  /** Only for a non-AWS S3-compatible endpoint (MinIO, R2, Spaces, ...). */
  endpoint?: string;
  forcePathStyle?: boolean;
}

/**
 * Uploads to an S3-compatible bucket (AWS S3, MinIO, Cloudflare R2,
 * DigitalOcean Spaces, ...) instead of local disk - the right choice once
 * there's more than one server replica, since a bucket (unlike each
 * replica's own local disk) is shared storage every replica sees the same
 * way. See config.ts's `s3` block for what each option is read from; all
 * of them are required when STORAGE_DRIVER=s3 except endpoint/
 * forcePathStyle (only needed for a non-AWS provider).
 *
 * Returns a public, permanent URL built from publicUrlBase - not a
 * pre-signed, expiring one. This project stores media URLs once and
 * reuses them indefinitely (avatarUrl, Attachment.url, Emoticon.imageUrl
 * - see schema.prisma), the same way the disk driver always has; a
 * signed URL that expires would silently break old messages/avatars days
 * or weeks later. The bucket (or a CDN in front of it) needs to actually
 * allow public reads for this to work - that's on the operator to
 * configure, same as publicUrlBase pointing at the right place.
 */
export class S3StorageAdapter implements StorageAdapter {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicUrlBase: string;

  constructor(options: S3StorageOptions) {
    this.bucket = options.bucket;
    this.publicUrlBase = options.publicUrlBase;
    this.client = new S3Client({
      region: options.region,
      endpoint: options.endpoint,
      forcePathStyle: options.forcePathStyle,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    });
  }

  async upload(input: UploadInput): Promise<UploadResult> {
    const ext = path.extname(input.originalFilename).slice(0, 16);
    const key = `${crypto.randomUUID()}${ext}`;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: input.buffer,
        ContentType: input.contentType,
      })
    );
    return { url: `${this.publicUrlBase}/${key}` };
  }
}
