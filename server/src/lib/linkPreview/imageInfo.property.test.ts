// Property tests (fast-check) for the picture header reader (#325, #244). imageInfo.test.ts has the hand-made cases; these ask "for ANY bytes" and
// "for ANY picture header in the allowed ranges", which is where a file nobody thought to write would show up: this code reads a stranger's
// bytes and must never throw, never read past the end, and never say a file is bigger or smaller than its header does. A failure prints the
// seed and the smallest input that broke it; write that input down as an ordinary case in imageInfo.test.ts as well.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { IMAGE_LIMITS, checkImage, readImageInfo } from "./imageInfo.js";

const bytes = (max: number) => fc.uint8Array({ maxLength: max }).map((u) => Buffer.from(u));

// The four headers, built from a size, the way a real file starts. Only the header matters to the reader.
function png(width: number, height: number, tail: Buffer): Buffer {
  const b = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return Buffer.concat([b, tail]);
}
function gif(width: number, height: number, version: string, tail: Buffer): Buffer {
  const b = Buffer.alloc(10);
  b.write(version, 0, "latin1");
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return Buffer.concat([b, tail]);
}
const SOF = [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf];
function jpeg(width: number, height: number, sof: number, before: { marker: number; payload: Uint8Array }[]): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  for (const { marker, payload } of before) {
    const head = Buffer.from([0xff, marker, 0, 0]);
    head.writeUInt16BE(payload.length + 2, 2);
    parts.push(head, Buffer.from(payload));
  }
  const frame = Buffer.alloc(19);
  frame[0] = 0xff;
  frame[1] = sof;
  frame.writeUInt16BE(17, 2);
  frame[4] = 8;
  frame.writeUInt16BE(height, 5);
  frame.writeUInt16BE(width, 7);
  parts.push(frame, Buffer.alloc(8));
  return Buffer.concat(parts);
}
function webp(chunk: "VP8 " | "VP8L" | "VP8X", width: number, height: number): Buffer {
  const b = Buffer.alloc(40);
  b.write("RIFF", 0, "latin1");
  b.writeUInt32LE(32, 4);
  b.write("WEBP", 8, "latin1");
  b.write(chunk, 12, "latin1");
  b.writeUInt32LE(20, 16);
  if (chunk === "VP8 ") {
    b[23] = 0x9d;
    b[24] = 0x01;
    b[25] = 0x2a;
    b.writeUInt16LE(width, 26);
    b.writeUInt16LE(height, 28);
  } else if (chunk === "VP8L") {
    b[20] = 0x2f;
    b.writeUInt32LE((width - 1) | ((height - 1) << 14), 21);
  } else {
    b.writeUIntLE(width - 1, 24, 3);
    b.writeUIntLE(height - 1, 27, 3);
  }
  return b;
}

// Bytes that START like a picture and then go wrong in any way, so the parsers get past their first check.
const SIGNATURES = [
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]),
  Buffer.from("GIF89a", "latin1"),
  Buffer.from("GIF87a", "latin1"),
  Buffer.from([0xff, 0xd8, 0xff]),
  Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]),
  Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8L")]),
  Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8X")]),
];
const startsLikeAPicture = fc.tuple(fc.constantFrom(...SIGNATURES), bytes(64)).map(([signature, rest]) => Buffer.concat([signature, rest]));
const anyBytes = fc.oneof(bytes(80), startsLikeAPicture);

describe("readImageInfo and checkImage, for any bytes", () => {
  it("never throw, whatever the file is", () => {
    fc.assert(
      fc.property(anyBytes, (file) => {
        readImageInfo(file);
        checkImage(file);
      }),
      { numRuns: 1000 }
    );
  });

  it("never throw on a file cut off at any point", () => {
    fc.assert(
      fc.property(startsLikeAPicture, fc.nat(), (file, cut) => {
        const part = file.subarray(0, cut % (file.length + 1));
        readImageInfo(part);
        checkImage(part);
      }),
      { numRuns: 500 }
    );
  });

  it("say a kind and a size that agree, and only one of the four kinds", () => {
    fc.assert(
      fc.property(anyBytes, (file) => {
        const info = readImageInfo(file);
        if (info === null) return;
        expect(["png", "jpeg", "gif", "webp"]).toContain(info.kind);
        expect(Number.isInteger(info.width) && Number.isInteger(info.height)).toBe(true);
        expect(info.width).toBeGreaterThanOrEqual(0);
        expect(info.height).toBeGreaterThanOrEqual(0);
        expect(info.contentType).toBe(`image/${info.kind === "jpeg" ? "jpeg" : info.kind}`);
        expect(info.extension).toBe(info.kind === "jpeg" ? "jpg" : info.kind);
      }),
      { numRuns: 1000 }
    );
  });

  it("only accept a picture inside every limit: the bytes, the sides and the pixels", () => {
    fc.assert(
      fc.property(anyBytes, (file) => {
        const checked = checkImage(file);
        if (!checked.ok) return;
        expect(file.length).toBeLessThanOrEqual(IMAGE_LIMITS.maxBytes);
        expect(checked.info.width).toBeGreaterThanOrEqual(1);
        expect(checked.info.height).toBeGreaterThanOrEqual(1);
        expect(checked.info.width).toBeLessThanOrEqual(IMAGE_LIMITS.maxSide);
        expect(checked.info.height).toBeLessThanOrEqual(IMAGE_LIMITS.maxSide);
        expect(checked.info.width * checked.info.height).toBeLessThanOrEqual(IMAGE_LIMITS.maxPixels);
        expect(checked.info).toEqual(readImageInfo(file));
      }),
      { numRuns: 1000 }
    );
  });
});

describe("readImageInfo, for any header in the allowed ranges", () => {
  it("gives back exactly the size a PNG header holds, whatever follows", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffffff }), fc.integer({ min: 0, max: 0xffffffff }), bytes(40), (w, h, tail) => {
        expect(readImageInfo(png(w, h, tail))).toMatchObject({ kind: "png", width: w, height: h });
      }),
      { numRuns: 500 }
    );
  });

  it("gives back exactly the size a GIF header holds (both versions)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 65535 }), fc.integer({ min: 0, max: 65535 }), fc.constantFrom("GIF87a", "GIF89a"), bytes(40), (w, h, version, tail) => {
        expect(readImageInfo(gif(w, h, version, tail))).toMatchObject({ kind: "gif", width: w, height: h });
      }),
      { numRuns: 500 }
    );
  });

  it("finds the frame of a JPEG after any run of other segments", () => {
    const segment = fc.record({ marker: fc.constantFrom(0xe0, 0xe1, 0xe2, 0xdb, 0xc4, 0xfe, 0xdd), payload: fc.uint8Array({ maxLength: 300 }) });
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 65535 }), fc.integer({ min: 0, max: 65535 }), fc.constantFrom(...SOF), fc.array(segment, { maxLength: 8 }), (w, h, sof, before) => {
        expect(readImageInfo(jpeg(w, h, sof, before))).toMatchObject({ kind: "jpeg", width: w, height: h });
      }),
      { numRuns: 500 }
    );
  });

  it("gives back exactly the size of a WebP of each kind", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 16383 }), fc.integer({ min: 1, max: 16383 }), (w, h) => {
        expect(readImageInfo(webp("VP8 ", w, h))).toMatchObject({ kind: "webp", width: w, height: h });
        expect(readImageInfo(webp("VP8L", w, h))).toMatchObject({ kind: "webp", width: w, height: h });
      }),
      { numRuns: 500 }
    );
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 0x1000000 }), fc.integer({ min: 1, max: 0x1000000 }), (w, h) => {
        expect(readImageInfo(webp("VP8X", w, h))).toMatchObject({ kind: "webp", width: w, height: h });
      }),
      { numRuns: 500 }
    );
  });

  it("decides exactly at the pixel limit: a header one pixel over is refused, and one at it is accepted", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: IMAGE_LIMITS.maxSide }), fc.integer({ min: -2, max: 2 }), (w, nudge) => {
        // The tallest picture that is allowed at this width, and a little either side of it.
        const h = Math.floor(IMAGE_LIMITS.maxPixels / w) + nudge;
        if (h < 1) return;
        const inside = h <= IMAGE_LIMITS.maxSide && w * h <= IMAGE_LIMITS.maxPixels;
        expect(checkImage(png(w, h, Buffer.alloc(8))).ok, `${w} x ${h}`).toBe(inside);
      }),
      { numRuns: 1000 }
    );
  });

  it("is not a PNG unless its first chunk is a 13-byte IHDR, whatever else is right", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 8, maxLength: 8 }), bytes(24), (chunkHead, rest) => {
        const head = Buffer.from(chunkHead);
        fc.pre(!(head.readUInt32BE(0) === 13 && head.toString("latin1", 4, 8) === "IHDR"));
        const file = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), head, rest, Buffer.alloc(16)]);
        expect(readImageInfo(file)).toBeNull();
      }),
      { numRuns: 500 }
    );
  });

  it("refuses, by size, every header that describes a bitmap beyond the limits, and accepts every one inside", () => {
    const side = fc.integer({ min: 1, max: 20000 });
    fc.assert(
      fc.property(side, side, (w, h) => {
        const inside = w <= IMAGE_LIMITS.maxSide && h <= IMAGE_LIMITS.maxSide && w * h <= IMAGE_LIMITS.maxPixels;
        expect(checkImage(png(w, h, Buffer.alloc(8))).ok).toBe(inside);
      }),
      { numRuns: 1000 }
    );
  });
});
