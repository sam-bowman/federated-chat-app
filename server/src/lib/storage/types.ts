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
  /**
   * Deletes a file this adapter stored, given the URL upload() returned. Resolves true if it was
   * removed, false if the URL isn't one of this adapter's (a remote server's file, an S3 URL under
   * the disk driver, anything that doesn't map cleanly to a single stored file) or the file was
   * already gone. Never touches anything outside the storage location, whatever the URL says.
   */
  delete(url: string): Promise<boolean>;
}
