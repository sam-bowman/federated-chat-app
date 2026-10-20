import type { HomeServer } from "./client";

export type DiscoveryErrorCode =
  | "invalid_input"
  | "network_error"
  | "not_json"
  | "missing_fields"
  | "incompatible_server";

export class DiscoveryError extends Error {
  code: DiscoveryErrorCode;
  constructor(code: DiscoveryErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface ParsedServerInput {
  /** Pre-filled username for the login/register form, if the input included one. */
  username?: string;
  /**
   * Host (with optional port, and possibly already carrying an explicit
   * scheme) to fetch `.well-known` from. Not necessarily the server's
   * self-reported `domain` - that comes back in the discovery response.
   */
  domainOrOrigin: string;
}

const EXPLICIT_SCHEME = /^https?:\/\//i;

/**
 * Unlike the server's own `parseIdentity` (server/src/lib/ids.ts), which
 * makes username required and domain optional (defaulting to the server's
 * own domain), this has the opposite shape: domain is required (there's no
 * default to fall back to before any server is picked) and username is
 * optional. Accepts `@user:domain`, `user:domain`, a bare domain, a bare
 * `host:port`, or an explicit `http(s)://...` origin.
 */
export function parseServerInput(input: string): ParsedServerInput {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new DiscoveryError("invalid_input", "Enter a server, e.g. chat.example.com or @you:chat.example.com.");
  }

  const stripped = trimmed.replace(/^@/, "");

  if (EXPLICIT_SCHEME.test(stripped)) {
    return { domainOrOrigin: stripped };
  }

  const colonIndex = stripped.indexOf(":");
  if (colonIndex === -1) {
    if (!isBareDomainAcceptable(stripped)) {
      throw new DiscoveryError("invalid_input", "Enter a server, e.g. chat.example.com or @you:chat.example.com.");
    }
    return { domainOrOrigin: stripped };
  }

  const before = stripped.slice(0, colonIndex);
  const after = stripped.slice(colonIndex + 1);

  // "localhost:4001" (domain:port, no username) vs. "alice:chat.example.com"
  // (username:domain) look identical in shape - the part after the first
  // colon being all digits is what tells the two apart.
  if (/^\d+$/.test(after)) {
    return { domainOrOrigin: stripped };
  }

  if (!before) {
    throw new DiscoveryError("invalid_input", "Enter a server, e.g. chat.example.com or @you:chat.example.com.");
  }
  return { username: before, domainOrOrigin: after };
}

function isBareDomainAcceptable(domain: string): boolean {
  return domain.includes(".") || domain.toLowerCase() === "localhost";
}

function buildOrigin(domainOrOrigin: string): string {
  return EXPLICIT_SCHEME.test(domainOrOrigin) ? domainOrOrigin : `https://${domainOrOrigin}`;
}

const DISCOVERY_TIMEOUT_MS = 8000;

/**
 * Fetches `.well-known/communication-platform` from the parsed input's
 * origin and returns a HomeServer. Only validates that the server speaks
 * the API/WS path convention this client understands - it never composes
 * `apiBase`/`websocketPath` into the stored value (see client.ts: every
 * call site already embeds the full path, so a stored value needs to be a
 * bare origin or paths get double-prefixed).
 */
export async function discoverHomeServer(parsed: ParsedServerInput): Promise<HomeServer> {
  const origin = buildOrigin(parsed.domainOrOrigin);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${origin}/.well-known/communication-platform`, { signal: controller.signal });
  } catch {
    throw new DiscoveryError("network_error", `Couldn't reach ${origin}. Check the address and try again.`);
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    throw new DiscoveryError("network_error", `${origin} responded with an error (HTTP ${res.status}).`);
  }

  let doc: unknown;
  try {
    doc = await res.json();
  } catch {
    throw new DiscoveryError("not_json", `${origin} didn't return a valid discovery document.`);
  }

  if (
    typeof doc !== "object" ||
    doc === null ||
    typeof (doc as Record<string, unknown>).domain !== "string" ||
    typeof (doc as Record<string, unknown>).apiBase !== "string" ||
    typeof (doc as Record<string, unknown>).websocketPath !== "string"
  ) {
    throw new DiscoveryError("missing_fields", `${origin}'s discovery document is missing required fields.`);
  }

  const parsedDoc = doc as {
    domain: string;
    serverName?: string;
    apiBase: string;
    websocketPath: string;
    registration?: { enabled?: boolean; inviteOnly?: boolean };
  };

  if (parsedDoc.apiBase !== "/api/v1" || parsedDoc.websocketPath !== "/ws") {
    throw new DiscoveryError("incompatible_server", `${parsedDoc.domain} uses an API convention this client doesn't understand.`);
  }

  return {
    origin,
    domain: parsedDoc.domain,
    serverName: parsedDoc.serverName ?? parsedDoc.domain,
    registrationEnabled: parsedDoc.registration?.enabled ?? false,
    // Only a plain `true` counts: anything else (absent, a string, a number) is a server that did not say.
    registrationInviteOnly: parsedDoc.registration?.inviteOnly === true,
  };
}

/** `false` only when the document says federation is off, either way it can say so; anything else (including nothing) is on. */
function federationFlag(doc: Record<string, unknown>): boolean | undefined {
  const federation = doc.federation as { enabled?: unknown } | null | undefined;
  const features = doc.features as { federation?: unknown } | null | undefined;
  if (federation?.enabled === false || features?.federation === false) return false;
  if (federation?.enabled === true || features?.federation === true) return true;
  return undefined;
}

export interface ServerInfo {
  serverName: string;
  domain: string;
  /** Absent on servers older than the release that started reporting it. */
  serverVersion?: string;
  protocolVersion?: string;
  /**
   * False when the server says it is private (it does not talk to other servers). Absent means it did not say, which is
   * how every server before this setting behaved: it federates.
   */
  federationEnabled?: boolean;
  /** True when the server says voice channels can be joined on it; absent or false otherwise (a server that predates voice says nothing). */
  voiceEnabled?: boolean;
}

/**
 * Reads the display-only facts from a server's discovery document. Unlike
 * discoverHomeServer this validates nothing about compatibility - it is only for
 * showing the user what they are connected to - and every field is untrusted
 * text, so a field of the wrong type is treated as missing.
 */
export async function fetchServerInfo(origin: string, signal?: AbortSignal): Promise<ServerInfo> {
  const res = await fetch(`${origin}/.well-known/communication-platform`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const doc = (await res.json()) as Record<string, unknown> | null;
  if (typeof doc !== "object" || doc === null) throw new Error("not a discovery document");
  const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
  const domain = text(doc.domain) ?? "";
  return {
    serverName: text(doc.serverName) ?? domain,
    domain,
    serverVersion: text(doc.serverVersion),
    protocolVersion: text(doc.protocolVersion),
    federationEnabled: federationFlag(doc),
    voiceEnabled: (doc.features as { voice?: unknown } | null | undefined)?.voice === true,
  };
}
