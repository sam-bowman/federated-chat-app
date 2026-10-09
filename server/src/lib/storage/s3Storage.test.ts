import { afterEach, describe, expect, it, vi } from "vitest";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { S3StorageAdapter } from "./s3Storage.js";

const sendMock = vi.fn();
const constructorCalls: unknown[] = [];

vi.mock("@aws-sdk/client-s3", async () => {
  const actual = await vi.importActual<typeof import("@aws-sdk/client-s3")>("@aws-sdk/client-s3");
  class FakeS3Client {
    send = sendMock;
    constructor(clientConfig: unknown) {
      constructorCalls.push(clientConfig);
    }
  }
  return { ...actual, S3Client: FakeS3Client };
});

afterEach(() => {
  vi.clearAllMocks();
  constructorCalls.length = 0;
});

describe("S3StorageAdapter", () => {
  it("constructs the S3 client with the given region/credentials/endpoint", () => {
    new S3StorageAdapter({
      bucket: "my-bucket",
      region: "us-east-1",
      accessKeyId: "AKIA...",
      secretAccessKey: "secret",
      publicUrlBase: "https://my-bucket.s3.us-east-1.amazonaws.com",
      endpoint: "https://s3.example-compatible.net",
      forcePathStyle: true,
    });

    expect(constructorCalls).toHaveLength(1);
    expect(constructorCalls[0]).toEqual(
      expect.objectContaining({
        region: "us-east-1",
        endpoint: "https://s3.example-compatible.net",
        forcePathStyle: true,
        credentials: { accessKeyId: "AKIA...", secretAccessKey: "secret" },
      })
    );
  });

  it("PUTs the file to the configured bucket under a random key, preserving the extension", async () => {
    sendMock.mockResolvedValue({});
    const adapter = new S3StorageAdapter({
      bucket: "my-bucket",
      region: "us-east-1",
      accessKeyId: "AKIA...",
      secretAccessKey: "secret",
      publicUrlBase: "https://my-bucket.s3.us-east-1.amazonaws.com",
    });

    const buffer = Buffer.from("hello world");
    const result = await adapter.upload({
      buffer,
      originalFilename: "photo.png",
      contentType: "image/png",
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    const command = sendMock.mock.calls[0][0] as PutObjectCommand;
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input.Bucket).toBe("my-bucket");
    expect(command.input.Body).toBe(buffer);
    expect(command.input.ContentType).toBe("image/png");
    expect(command.input.Key).toMatch(/^[0-9a-f-]{36}\.png$/);

    // Returned URL is publicUrlBase + the same random key that was PUT -
    // not a pre-signed/expiring URL (see the class's own doc comment for
    // why that matters: stored media URLs are reused indefinitely).
    expect(result.url).toBe(`https://my-bucket.s3.us-east-1.amazonaws.com/${command.input.Key}`);
  });

  it("generates a different random key for each upload, even with the same original filename", async () => {
    sendMock.mockResolvedValue({});
    const adapter = new S3StorageAdapter({
      bucket: "my-bucket",
      region: "us-east-1",
      accessKeyId: "AKIA...",
      secretAccessKey: "secret",
      publicUrlBase: "https://my-bucket.s3.us-east-1.amazonaws.com",
    });

    const a = await adapter.upload({ buffer: Buffer.from("a"), originalFilename: "x.png", contentType: "image/png" });
    const b = await adapter.upload({ buffer: Buffer.from("b"), originalFilename: "x.png", contentType: "image/png" });
    expect(a.url).not.toBe(b.url);
  });
});
