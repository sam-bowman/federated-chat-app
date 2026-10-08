import { afterEach, describe, expect, it, vi } from "vitest";
import { lookup } from "node:dns/promises";
import { assertPublicHost, isPrivateAddress, SsrfBlockedError } from "./ssrfGuard.js";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isPrivateAddress - IPv4", () => {
  it.each([
    ["10.0.0.1", true],
    ["10.255.255.255", true],
    ["9.255.255.255", false],
    ["11.0.0.0", false],
    // 172.16.0.0/12 boundary - exactly the case a naive "starts with 172.1" check would get wrong.
    ["172.15.255.255", false],
    ["172.16.0.0", true],
    ["172.31.255.255", true],
    ["172.32.0.0", false],
    ["192.168.0.1", true],
    ["192.167.255.255", false],
    ["127.0.0.1", true],
    ["127.255.255.255", true],
    ["169.254.169.254", true], // cloud metadata endpoint
    ["100.64.0.1", true], // CGNAT
    ["100.63.255.255", false],
    ["0.0.0.1", true],
    ["224.0.0.1", true], // multicast
    ["8.8.8.8", false],
    ["1.1.1.1", false],
    ["93.184.216.34", false],
  ])("%s -> private=%s", (ip, expected) => {
    expect(isPrivateAddress(ip)).toBe(expected);
  });
});

describe("isPrivateAddress - IPv6", () => {
  it.each([
    ["::1", true], // loopback
    ["::", true], // unspecified
    ["fe80::1", true], // link-local
    ["fc00::1", true], // unique local
    ["fd12:3456:789a::1", true], // unique local, non-zero subnet
    ["ff02::1", true], // multicast
    ["2001:4860:4860::8888", false], // real public address (Google DNS)
    ["2606:4700:4700::1111", false], // real public address (Cloudflare DNS)
    // IPv4-mapped addresses embed a real IPv4 target - must check that too.
    ["::ffff:127.0.0.1", true],
    ["::ffff:10.0.0.1", true],
    ["::ffff:8.8.8.8", false],
  ])("%s -> private=%s", (ip, expected) => {
    expect(isPrivateAddress(ip)).toBe(expected);
  });
});

describe("assertPublicHost", () => {
  it('rejects "localhost" without any DNS lookup', async () => {
    await expect(assertPublicHost("localhost")).rejects.toThrow(SsrfBlockedError);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("rejects a literal private IPv4 address with no DNS lookup needed", async () => {
    await expect(assertPublicHost("127.0.0.1")).rejects.toThrow(SsrfBlockedError);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("rejects a literal private IPv6 address", async () => {
    await expect(assertPublicHost("fe80::1")).rejects.toThrow(SsrfBlockedError);
  });

  it("accepts a literal public IPv4 address with no DNS lookup needed", async () => {
    await expect(assertPublicHost("93.184.216.34")).resolves.toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("rejects a hostname that resolves to a private address", async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: "169.254.169.254", family: 4 }] as never);
    await expect(assertPublicHost("metadata.internal.example")).rejects.toThrow(SsrfBlockedError);
  });

  it("accepts a hostname that resolves only to public addresses", async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: "8.8.8.8", family: 4 }] as never);
    await expect(assertPublicHost("public.example.com")).resolves.toBeUndefined();
  });

  // Regression-relevant: a hostname can have multiple A/AAAA records -
  // checking only the first would be a bypass (register a benign public
  // record plus a private one, let the guard see only the first).
  it("rejects a hostname with multiple records where even one is private", async () => {
    vi.mocked(lookup).mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ] as never);
    await expect(assertPublicHost("mixed.example.com")).rejects.toThrow(SsrfBlockedError);
  });
});
