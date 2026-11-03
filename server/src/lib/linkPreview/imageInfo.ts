// What a picture is, read from its first bytes (#244). A link preview's picture comes from a stranger's web server, so nothing it says about
// the file is believed: not the content type it answers with, not the name. The bytes are looked at here, and only four kinds are accepted
// (PNG, JPEG, GIF, WebP: no SVG, which can carry script), with their size read from the file's own header. The size matters as much as the
// kind: a small file can describe a huge bitmap, and the browser would have to make room for every pixel of it.
//
// This does NOT decode or re-encode the picture. A file that starts like a PNG and is then garbage passes here and is shown as a broken
// picture by the browser, which is all it can do with it (the copy is served with the type found here and `nosniff`, so it is never taken
// for anything else). A picture also keeps whatever metadata it carries: it is the linked site's own picture, not a photo of the reader's.
// Kept free of config.ts imports so it can be unit-tested on its own.

export type ImageKind = "png" | "jpeg" | "gif" | "webp";

export interface ImageInfo {
  kind: ImageKind;
  width: number;
  height: number;
  contentType: string;
  /** The extension a stored copy is given, from the kind found here and never from the address. */
  extension: string;
}

/** What one picture may be. 2 MiB and 4096 pixels a side are far more than a card shows. */
export const IMAGE_LIMITS = { maxBytes: 2 * 1024 * 1024, maxSide: 4096, maxPixels: 16_000_000 } as const;

const KINDS: Record<ImageKind, { contentType: string; extension: string }> = {
  png: { contentType: "image/png", extension: "png" },
  jpeg: { contentType: "image/jpeg", extension: "jpg" },
  gif: { contentType: "image/gif", extension: "gif" },
  webp: { contentType: "image/webp", extension: "webp" },
};

function info(kind: ImageKind, width: number, height: number): ImageInfo {
  return { kind, width, height, ...KINDS[kind] };
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readPng(b: Buffer): ImageInfo | null {
  // The signature, then the first chunk, which must be IHDR (13 bytes long) holding the size.
  if (b.length < 24 || !b.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (b.readUInt32BE(8) !== 13 || b.toString("latin1", 12, 16) !== "IHDR") return null;
  return info("png", b.readUInt32BE(16), b.readUInt32BE(20));
}

function readGif(b: Buffer): ImageInfo | null {
  if (b.length < 10) return null;
  const head = b.toString("latin1", 0, 6);
  if (head !== "GIF87a" && head !== "GIF89a") return null;
  return info("gif", b.readUInt16LE(6), b.readUInt16LE(8));
}

// A JPEG is a run of segments, each `FF <marker> <length> ...`; the size is in the first "start of frame" one.
const START_OF_FRAME = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function readJpeg(b: Buffer): ImageInfo | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null;
  let at = 2;
  // Every step moves forward by at least two bytes, so this ends within the length of the buffer.
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1];
    if (marker === 0xff) {
      at += 1; // padding before a marker
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end of image / start of the data, with no frame seen
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2; // markers with no length
      continue;
    }
    const length = b.readUInt16BE(at + 2);
    if (length < 2) return null;
    if (START_OF_FRAME.has(marker)) {
      if (at + 9 > b.length) return null;
      return info("jpeg", b.readUInt16BE(at + 7), b.readUInt16BE(at + 5));
    }
    at += 2 + length;
  }
  return null;
}

function readWebp(b: Buffer): ImageInfo | null {
  if (b.length < 30 || b.toString("latin1", 0, 4) !== "RIFF" || b.toString("latin1", 8, 12) !== "WEBP") return null;
  const chunk = b.toString("latin1", 12, 16);
  const data = 20;
  if (chunk === "VP8 ") {
    // Lossy: a 3-byte frame tag, the start code 9D 01 2A, then the size (14 bits each, little endian).
    if (b[data + 3] !== 0x9d || b[data + 4] !== 0x01 || b[data + 5] !== 0x2a) return null;
    return info("webp", b.readUInt16LE(data + 6) & 0x3fff, b.readUInt16LE(data + 8) & 0x3fff);
  }
  if (chunk === "VP8L") {
    // Lossless: a signature byte, then width-1 and height-1 in 14 bits each.
    if (b[data] !== 0x2f) return null;
    const bits = b.readUInt32LE(data + 1);
    return info("webp", (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (chunk === "VP8X") {
    // Extended: the canvas size, minus one, in 24 bits each.
    return info("webp", b.readUIntLE(data + 4, 3) + 1, b.readUIntLE(data + 7, 3) + 1);
  }
  return null;
}

/** The kind and size of a picture from its first bytes, or null if it is not one of the four kinds. No limit is applied here. */
export function readImageInfo(bytes: Buffer): ImageInfo | null {
  return readPng(bytes) ?? readJpeg(bytes) ?? readGif(bytes) ?? readWebp(bytes);
}

export type ImageCheck = { ok: true; info: ImageInfo } | { ok: false; reason: "not_image" | "too_large" | "too_many_pixels" };

/** Whether these bytes are a picture this server will keep: one of the four kinds, not too big in bytes, not too big in pixels. */
export function checkImage(bytes: Buffer): ImageCheck {
  if (bytes.length > IMAGE_LIMITS.maxBytes) return { ok: false, reason: "too_large" };
  const found = readImageInfo(bytes);
  if (!found || found.width < 1 || found.height < 1) return { ok: false, reason: "not_image" };
  if (found.width > IMAGE_LIMITS.maxSide || found.height > IMAGE_LIMITS.maxSide || found.width * found.height > IMAGE_LIMITS.maxPixels) {
    return { ok: false, reason: "too_many_pixels" };
  }
  return { ok: true, info: found };
}
