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
    registration?: { enabled?: boolean };
  };

  if (parsedDoc.apiBase !== "/api/v1" || parsedDoc.websocketPath !== "/ws") {
    throw new DiscoveryError("incompatible_server", `${parsedDoc.domain} uses an API convention this client doesn't understand.`);
  }

  return {
    origin,
    domain: parsedDoc.domain,
    serverName: parsedDoc.serverName ?? parsedDoc.domain,
    registrationEnabled: parsedDoc.registration?.enabled ?? false,
  };
}
