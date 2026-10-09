import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isPasswordBreached } from "./passwordBreachCheck.js";

function sha1(input: string): string {
  return createHash("sha1").update(input).digest("hex").toUpperCase();
}

describe("isPasswordBreached", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends only the first 5 hex characters of the SHA-1 hash - k-anonymity, never the password or full hash", async () => {
    const password = "some-test-password";
    const fullHash = sha1(password);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => "" });
    vi.stubGlobal("fetch", fetchMock);

    await isPasswordBreached(password);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestedUrl = fetchMock.mock.calls[0][0] as string;
    expect(requestedUrl).toBe(`https://api.pwnedpasswords.com/range/${fullHash.slice(0, 5)}`);
    expect(requestedUrl).not.toContain(password);
    expect(requestedUrl).not.toContain(fullHash.slice(5));
  });

  it("returns true when the hash's suffix appears in the returned range", async () => {
    const password = "some-test-password";
    const fullHash = sha1(password);
    const suffix = fullHash.slice(5);
    const responseBody = `AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:3\r\n${suffix}:42\r\nBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB:1`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: async () => responseBody }));

    expect(await isPasswordBreached(password)).toBe(true);
  });

  it("returns false when the hash's suffix is absent from the returned range", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:3\r\nBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB:1",
      })
    );

    expect(await isPasswordBreached("definitely-not-in-this-fake-list")).toBe(false);
  });

  it("fails open (false) on a non-OK response, instead of blocking registration", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, text: async () => "" }));
    expect(await isPasswordBreached("anything")).toBe(false);
  });

  it("fails open (false) on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    expect(await isPasswordBreached("anything")).toBe(false);
  });

  it("fails open (false) on a timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, options: { signal: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      })
    );
    // Real timers on purpose here (not vi.useFakeTimers()) - the module
    // under test schedules its own real setTimeout internally, which fake
    // timers would need manual advancing for; this just waits for real.
    expect(await isPasswordBreached("anything")).toBe(false);
  }, 10000);
});
