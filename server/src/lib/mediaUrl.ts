const ABSOLUTE_HTTP_URL = /^https?:\/\//i;

/**
 * Makes a possibly-relative media URL (an avatar/attachment/emoticon path
 * - see server/src/lib/storage/) absolute against `baseUrl`, unless it's
 * already absolute. A URL is relative only under the disk storage driver
 * (e.g. "/uploads/x.png", resolvable only against the server that stored
 * it); the S3 driver always returns an already-absolute bucket/CDN URL.
 * Both shapes can appear in the same deployment's data (e.g. after
 * switching drivers), so every call site that forwards a stored URL
 * elsewhere - to a browser via client/src/api/client.ts's own mediaUrl(),
 * or to a federation peer, who has no way to resolve a path relative to
 * *our* server - must go through this, not string-concatenate blindly.
 */
export function toAbsoluteMediaUrl(url: string, baseUrl: string): string {
  if (ABSOLUTE_HTTP_URL.test(url)) return url;
  return `${baseUrl}${url}`;
}
