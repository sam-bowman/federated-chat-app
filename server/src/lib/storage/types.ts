export interface UploadInput {
  buffer: Buffer;
  originalFilename: string;
  contentType: string;
}

export interface UploadResult {
  /**
   * Relative (disk driver, e.g. "/uploads/x.png") or absolute (s3 driver -
   * always a full https:// URL) - every call site that stores or forwards
   * this must handle both shapes via toAbsoluteMediaUrl()
   * (server/src/lib/mediaUrl.ts), not assume one or the other.
   */
  url: string;
}

export interface StorageAdapter {
  upload(input: UploadInput): Promise<UploadResult>;
}
