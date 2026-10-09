import { describe, expect, it } from "vitest";
import { toAbsoluteMediaUrl } from "./mediaUrl.js";

describe("toAbsoluteMediaUrl", () => {
  it("prefixes a relative path with baseUrl", () => {
    expect(toAbsoluteMediaUrl("/uploads/abc.png", "https://chat.example.com")).toBe(
      "https://chat.example.com/uploads/abc.png"
    );
  });

  it("leaves an already-absolute http URL unchanged", () => {
    expect(toAbsoluteMediaUrl("http://peer.example.com/uploads/abc.png", "https://chat.example.com")).toBe(
      "http://peer.example.com/uploads/abc.png"
    );
  });

  it("leaves an already-absolute https URL (e.g. an S3 bucket URL) unchanged", () => {
    const s3Url = "https://my-bucket.s3.us-east-1.amazonaws.com/abc.png";
    expect(toAbsoluteMediaUrl(s3Url, "https://chat.example.com")).toBe(s3Url);
  });

  // Regression-relevant: naively string-concatenating baseUrl onto an
  // already-absolute URL (what the federation attachment relay used to do
  // before this helper existed) would produce exactly this kind of
  // double-prefixed garbage once the S3 driver's URLs started flowing
  // through the same code path as the disk driver's relative ones.
  it("does not double-prefix an absolute URL", () => {
    const s3Url = "https://my-bucket.s3.us-east-1.amazonaws.com/abc.png";
    const result = toAbsoluteMediaUrl(s3Url, "https://chat.example.com");
    expect(result).not.toContain("https://chat.example.comhttps://");
    expect(result).toBe(s3Url);
  });
});
