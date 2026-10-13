import { isIP } from "node:net";

// TRUST_PROXY tells Express how many reverse proxies / load balancers sit between
// the internet and this server, so `req.ip` - what the rate limiter keys on - is the
// real client instead of the proxy. Behind an ingress controller without it,
// every user shares the proxy's address and therefore ONE rate-limit bucket: ten
// logins by anyone lock everyone else out for 15 minutes (reproduced behind
// Traefik on Kubernetes).
//
// Deliberately strict, because getting this wrong is a security problem in the
// other direction: trusting an X-Forwarded-For that a client can set lets that
// client pick its own rate-limit identity. So there is no "true"/"trust
// everything" value and no catch-all range - only a hop count or named proxies.
//
// Kept free of config.ts imports so it can be unit-tested on its own.

const KEYWORDS = new Set(["loopback", "linklocal", "uniquelocal"]);

const TOO_BROAD =
  'trusts every address, which lets a client choose its own rate-limit identity via X-Forwarded-For - use a hop count (e.g. 1) or the specific address ranges of your proxies';

function isValidAddressOrCidr(entry: string): boolean {
  const [address, prefix, ...rest] = entry.split("/");
  if (rest.length > 0) return false;
  const family = isIP(address);
  if (family === 0) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (family === 4 ? 32 : 128);
}

/**
 * Parses `TRUST_PROXY`.
 * - unset, empty, `false` or `0`: no proxy trusted (the default; `req.ip` is the socket's address)
 * - a positive integer: that many proxy hops, counted from the server (`1` = one ingress/load balancer)
 * - a comma-separated list: the proxies to trust, each `loopback`, `linklocal`, `uniquelocal`, an IP, or a CIDR range
 */
export function parseTrustProxy(raw: string | undefined): false | number | string[] {
  const value = (raw ?? "").trim();
  if (value === "" || value.toLowerCase() === "false" || value === "0") return false;

  if (/^\d+$/.test(value)) return Number(value);

  if (value.toLowerCase() === "true") {
    throw new Error(`TRUST_PROXY=true ${TOO_BROAD}`);
  }

  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  for (const entry of entries) {
    if (entry === "0.0.0.0/0" || entry === "::/0") throw new Error(`TRUST_PROXY entry "${entry}" ${TOO_BROAD}`);
    if (!KEYWORDS.has(entry) && !isValidAddressOrCidr(entry)) {
      throw new Error(
        `TRUST_PROXY entry "${entry}" is not valid - use a number of hops (e.g. 1), or a comma-separated list of loopback, linklocal, uniquelocal, IP addresses and CIDR ranges`
      );
    }
  }
  return entries;
}
