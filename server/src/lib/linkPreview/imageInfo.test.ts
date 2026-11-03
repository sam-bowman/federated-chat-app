import { describe, expect, it } from "vitest";
import { IMAGE_LIMITS, checkImage, readImageInfo } from "./imageInfo.js";

// Real files' first bytes, made by hand: only the header is read, so a header and a little more is a whole test case.
function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}
function gif(width: number, height: number, version = "GIF89a"): Buffer {
  const b = Buffer.alloc(20);
  b.write(version, 0, "latin1");
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return b;
}
function jpeg(width: number, height: number, { before = [] as Buffer[] } = {}): Buffer {
  const sof = Buffer.alloc(19);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), ...before, sof, Buffer.alloc(8)]);
}
function segment(marker: number, length: number): Buffer {
  const b = Buffer.alloc(Math.max(4, 2 + length)); // a segment that lies about its length can be shorter than it says
  b[0] = 0xff;
  b[1] = marker;
  b.writeUInt16BE(length, 2);
  return b;
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

describe("readImageInfo", () => {
  it("reads the size of a PNG", () => {
    expect(readImageInfo(png(640, 480))).toMatchObject({ kind: "png", width: 640, height: 480, contentType: "image/png", extension: "png" });
  });
  it("reads the size of a GIF (both versions)", () => {
    expect(readImageInfo(gif(320, 200))).toMatchObject({ kind: "gif", width: 320, height: 200, contentType: "image/gif" });
    expect(readImageInfo(gif(1, 2, "GIF87a"))).toMatchObject({ kind: "gif", width: 1, height: 2 });
  });
  it("reads the size of a JPEG, past other segments", () => {
    expect(readImageInfo(jpeg(1200, 800))).toMatchObject({ kind: "jpeg", width: 1200, height: 800, contentType: "image/jpeg", extension: "jpg" });
    expect(readImageInfo(jpeg(10, 20, { before: [segment(0xe0, 16), segment(0xdb, 67), Buffer.from([0xff, 0xff])] }))).toMatchObject({ width: 10, height: 20 });
  });
  it("reads the size of each kind of WebP", () => {
    expect(readImageInfo(webp("VP8 ", 100, 50))).toMatchObject({ kind: "webp", width: 100, height: 50, contentType: "image/webp" });
    expect(readImageInfo(webp("VP8L", 777, 333))).toMatchObject({ kind: "webp", width: 777, height: 333 });
    expect(readImageInfo(webp("VP8X", 4000, 3000))).toMatchObject({ kind: "webp", width: 4000, height: 3000 });
  });

  it("is not fooled by something else", () => {
    for (const bytes of [
      Buffer.from("<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'><script>alert(1)</script></svg>"),
      Buffer.from("<!doctype html><title>not a picture</title>"),
      Buffer.from("MZ\x90\x00 an executable"),
      Buffer.alloc(0),
      Buffer.alloc(3, 0xff),
    ]) {
      expect(readImageInfo(bytes)).toBeNull();
    }
  });
  it("does not read past the end of a cut-off file", () => {
    for (const whole of [png(1, 1), gif(1, 1), jpeg(1, 1), webp("VP8 ", 1, 1), webp("VP8L", 1, 1), webp("VP8X", 1, 1)]) {
      for (let cut = 0; cut < whole.length; cut++) expect(() => readImageInfo(whole.subarray(0, cut))).not.toThrow();
    }
  });
  it("gives up on a JPEG with no frame, or a segment that lies about its length, without looping", () => {
    expect(readImageInfo(Buffer.concat([Buffer.from([0xff, 0xd8]), segment(0xe0, 2), Buffer.from([0xff, 0xd9, 0, 0])]))).toBeNull();
    expect(readImageInfo(Buffer.concat([Buffer.from([0xff, 0xd8]), segment(0xe0, 0), Buffer.alloc(10)]))).toBeNull();
    const padding = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(200_000, 0xff)]);
    const started = Date.now();
    expect(readImageInfo(padding)).toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
  });
  it("needs the PNG header chunk to be IHDR, and the WebP start code to be there", () => {
    const wrong = png(10, 10);
    wrong.write("IDAT", 12, "latin1");
    expect(readImageInfo(wrong)).toBeNull();
    const noStartCode = webp("VP8 ", 10, 10);
    noStartCode[23] = 0;
    expect(readImageInfo(noStartCode)).toBeNull();
  });
});

describe("checkImage", () => {
  it("accepts a picture inside every limit", () => {
    const result = checkImage(png(1200, 630));
    expect(result.ok).toBe(true);
    expect(result.ok && result.info.kind).toBe("png");
  });
  it("refuses what is not one of the four kinds", () => {
    expect(checkImage(Buffer.from("<svg></svg>"))).toEqual({ ok: false, reason: "not_image" });
  });
  it("refuses a picture of no size", () => {
    expect(checkImage(png(0, 10))).toEqual({ ok: false, reason: "not_image" });
    expect(checkImage(gif(10, 0))).toEqual({ ok: false, reason: "not_image" });
  });
  it("refuses one that is too big in BYTES", () => {
    const big = Buffer.concat([png(10, 10), Buffer.alloc(IMAGE_LIMITS.maxBytes)]);
    expect(checkImage(big)).toEqual({ ok: false, reason: "too_large" });
  });
  it("refuses a small file that describes a huge bitmap: too long a side, or too many pixels in all", () => {
    expect(checkImage(png(IMAGE_LIMITS.maxSide + 1, 10))).toEqual({ ok: false, reason: "too_many_pixels" });
    expect(checkImage(png(10, 100_000))).toEqual({ ok: false, reason: "too_many_pixels" });
    expect(checkImage(png(4096, 4096))).toEqual({ ok: false, reason: "too_many_pixels" }); // 16.7 million
    expect(checkImage(png(4000, 4000)).ok).toBe(true); // exactly 16 million
    expect(checkImage(webp("VP8X", 16_000_000, 1))).toEqual({ ok: false, reason: "too_many_pixels" });
  });
});
