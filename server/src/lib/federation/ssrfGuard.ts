import { lookup } from "node:dns/promises";
import { isIP, isIPv4, isIPv6 } from "node:net";

// Used before any outbound request to a domain supplied by untrusted
// input (a locally-authenticated user's typed `@user:domain`, or an
// inbound federation request's claimed origin) - see discovery.ts and
// client.ts. Never applied to FEDERATION_PEER_OVERRIDES-resolved domains,
// which are operator-set local dev config (how the alice.test/bob.test
// demo points at real localhost ports), not attacker input.
export class SsrfBlockedError extends Error {
  constructor(hostname: string) {
    super(`ssrf_blocked:${hostname}`);
    this.name = "SsrfBlockedError";
  }
}

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  return (((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0);
}

function inIPv4Range(ip: string, base: string, prefixLength: number): boolean {
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

// RFC 1918 private ranges, loopback, link-local, CGNAT, documentation/test,
// multicast, and reserved - the realistic SSRF-relevant IPv4 space, not an
// exhaustive IANA registry.
const PRIVATE_IPV4_RANGES: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function isPrivateIPv4(ip: string): boolean {
  return PRIVATE_IPV4_RANGES.some(([base, prefix]) => inIPv4Range(ip, base, prefix));
}

/** Expands a (possibly "::"-shortened, possibly IPv4-tailed) IPv6 literal into 8 hextet strings. */
function expandIPv6(ip: string): string[] {
  const addr = ip.split("%")[0]; // strip a zone id, not expected here but defensive

  const convertEmbeddedIPv4 = (parts: string[]): string[] => {
    if (parts.length === 0) return parts;
    const last = parts[parts.length - 1];
    if (!last.includes(".")) return parts;
    const octets = last.split(".").map(Number);
    const hi = (((octets[0] << 8) | octets[1]) >>> 0).toString(16);
    const lo = (((octets[2] << 8) | octets[3]) >>> 0).toString(16);
    return [...parts.slice(0, -1), hi, lo];
  };

  if (addr.includes("::")) {
    const idx = addr.indexOf("::");
    const head = addr.slice(0, idx);
    const tail = addr.slice(idx + 2);
    let headParts = convertEmbeddedIPv4(head ? head.split(":") : []);
    let tailParts = convertEmbeddedIPv4(tail ? tail.split(":") : []);
    const missing = 8 - (headParts.length + tailParts.length);
    return [...headParts, ...Array(Math.max(missing, 0)).fill("0"), ...tailParts];
  }

  return convertEmbeddedIPv4(addr.split(":"));
}

function ipv6ToBigInt(ip: string): bigint {
  let result = 0n;
  for (const hextet of expandIPv6(ip)) {
    result = (result << 16n) | BigInt(parseInt(hextet, 16) || 0);
  }
  return result;
}

function inIPv6Range(ip: string, base: string, prefixLength: number): boolean {
  const shift = 128n - BigInt(prefixLength);
  const mask = prefixLength === 0 ? 0n : ((1n << BigInt(prefixLength)) - 1n) << shift;
  return (ipv6ToBigInt(ip) & mask) === (ipv6ToBigInt(base) & mask);
}

const PRIVATE_IPV6_RANGES: [string, number][] = [
  ["::1", 128], // loopback
  ["::", 128], // unspecified
  ["fc00::", 7], // unique local (private)
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
];

function isPrivateIPv6(ip: string): boolean {
  if (PRIVATE_IPV6_RANGES.some(([base, prefix]) => inIPv6Range(ip, base, prefix))) return true;

  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::a.b.c.d) addresses embed
  // a real IPv4 address in the low 32 bits - extract and check that too, so
  // e.g. ::ffff:127.0.0.1 or ::ffff:10.0.0.1 can't slip through as "not an
  // IPv6 private range" while actually pointing at a private IPv4 target.
  if (inIPv6Range(ip, "::ffff:0:0", 96) || inIPv6Range(ip, "64:ff9b::", 96)) {
    const low32 = Number(ipv6ToBigInt(ip) & 0xffffffffn);
    const embeddedIPv4 = [
      (low32 >>> 24) & 0xff,
      (low32 >>> 16) & 0xff,
      (low32 >>> 8) & 0xff,
      low32 & 0xff,
    ].join(".");
    return isPrivateIPv4(embeddedIPv4);
  }

  return false;
}

export function isPrivateAddress(ip: string): boolean {
  if (isIPv4(ip)) return isPrivateIPv4(ip);
  if (isIPv6(ip)) return isPrivateIPv6(ip);
  return false;
}

/**
 * Throws SsrfBlockedError if `hostname` is (or resolves to) a private,
 * loopback, link-local, or otherwise non-public address. A hostname can
 * have multiple A/AAAA records - checking only the first would be a
 * bypass, so every resolved address is checked.
 */
export async function assertPublicHost(hostname: string): Promise<void> {
  if (hostname.toLowerCase() === "localhost") throw new SsrfBlockedError(hostname);

  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new SsrfBlockedError(hostname);
    return;
  }

  const addresses = await lookup(hostname, { all: true });
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) throw new SsrfBlockedError(hostname);
  }
}
