import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscoveryError, discoverHomeServer, parseServerInput } from "./discovery";

afterEach(() => {
  vi.unstubAllGlobals();
});

function wellKnownResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

const validDoc = {
  domain: "chat.example.com",
  serverName: "Example Chat",
  apiBase: "/api/v1",
  websocketPath: "/ws",
  registration: { enabled: true },
};

describe("parseServerInput", () => {
  it("accepts an @user:domain identity", () => {
    expect(parseServerInput("@alice:chat.example.com")).toEqual({
      username: "alice",
      domainOrOrigin: "chat.example.com",
    });
  });

  it("accepts user:domain without the leading @", () => {
    expect(parseServerInput("alice:chat.example.com")).toEqual({
      username: "alice",
      domainOrOrigin: "chat.example.com",
    });
  });

  it("accepts a bare domain with no username", () => {
    expect(parseServerInput("chat.example.com")).toEqual({ domainOrOrigin: "chat.example.com" });
  });

  it("accepts bare localhost with no username", () => {
    expect(parseServerInput("localhost")).toEqual({ domainOrOrigin: "localhost" });
  });

  it("treats host:port as a domain, not username:domain, when the part after the colon is numeric", () => {
    expect(parseServerInput("localhost:4001")).toEqual({ domainOrOrigin: "localhost:4001" });
  });

  it("keeps a port attached to the domain when a username is also present", () => {
    expect(parseServerInput("alice:localhost:4001")).toEqual({
      username: "alice",
      domainOrOrigin: "localhost:4001",
    });
  });

  it("accepts an explicit http:// origin with no username", () => {
    expect(parseServerInput("http://localhost:4001")).toEqual({ domainOrOrigin: "http://localhost:4001" });
  });

  it("accepts an explicit https:// origin", () => {
    expect(parseServerInput("https://chat.example.com")).toEqual({ domainOrOrigin: "https://chat.example.com" });
  });

  it("rejects a bare username with no domain to default to", () => {
    expect(() => parseServerInput("alice")).toThrow(DiscoveryError);
  });

  it("rejects empty input", () => {
    expect(() => parseServerInput("   ")).toThrow(DiscoveryError);
  });

  it("rejects @username with no domain", () => {
    expect(() => parseServerInput("@alice")).toThrow(DiscoveryError);
  });
});

describe("discoverHomeServer", () => {
  it("resolves a HomeServer from a valid discovery document, defaulting to https", async () => {
    const fetchMock = vi.fn(async (_url?: string) => wellKnownResponse(validDoc));
    vi.stubGlobal("fetch", fetchMock);

    const result = await discoverHomeServer({ domainOrOrigin: "chat.example.com" });

    expect(result).toEqual({
      origin: "https://chat.example.com",
      domain: "chat.example.com",
      serverName: "Example Chat",
      registrationEnabled: true,
    });
    expect(fetchMock.mock.calls[0][0]).toBe("https://chat.example.com/.well-known/communication-platform");
  });

  it("uses an explicit scheme as-is instead of defaulting to https", async () => {
    const fetchMock = vi.fn(async (_url?: string) => wellKnownResponse({ ...validDoc, domain: "localhost" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await discoverHomeServer({ domainOrOrigin: "http://localhost:4001" });

    expect(result.origin).toBe("http://localhost:4001");
    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:4001/.well-known/communication-platform");
  });

  it("falls back to the self-reported domain for serverName when absent", async () => {
    const { serverName: _serverName, ...docWithoutName } = validDoc;
    vi.stubGlobal("fetch", vi.fn(async () => wellKnownResponse(docWithoutName)));

    const result = await discoverHomeServer({ domainOrOrigin: "chat.example.com" });
    expect(result.serverName).toBe("chat.example.com");
  });

  it("defaults registrationEnabled to false when absent", async () => {
    const { registration: _registration, ...docWithoutRegistration } = validDoc;
    vi.stubGlobal("fetch", vi.fn(async () => wellKnownResponse(docWithoutRegistration)));

    const result = await discoverHomeServer({ domainOrOrigin: "chat.example.com" });
    expect(result.registrationEnabled).toBe(false);
  });

  it("throws network_error on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 500 })));

    await expect(discoverHomeServer({ domainOrOrigin: "chat.example.com" })).rejects.toMatchObject({
      code: "network_error",
    });
  });

  it("throws network_error when fetch rejects (unreachable host, CORS failure, etc.)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      })
    );

    await expect(discoverHomeServer({ domainOrOrigin: "chat.example.com" })).rejects.toMatchObject({
      code: "network_error",
    });
  });

  it("throws not_json when the response body isn't valid JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>not json</html>", { status: 200 })));

    await expect(discoverHomeServer({ domainOrOrigin: "chat.example.com" })).rejects.toMatchObject({
      code: "not_json",
    });
  });

  it("throws missing_fields when required fields are absent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => wellKnownResponse({ domain: "chat.example.com" })));

    await expect(discoverHomeServer({ domainOrOrigin: "chat.example.com" })).rejects.toMatchObject({
      code: "missing_fields",
    });
  });

  it("throws incompatible_server when apiBase/websocketPath don't match this client's convention", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => wellKnownResponse({ ...validDoc, apiBase: "/v2" })));

    await expect(discoverHomeServer({ domainOrOrigin: "chat.example.com" })).rejects.toMatchObject({
      code: "incompatible_server",
    });
  });
});
