// Which other servers this one will talk to (#109, phase 2): FEDERATION_ALLOWED_DOMAINS and FEDERATION_BLOCKED_DOMAINS.
//
//   - neither set: every server, as ever;
//   - ALLOWED set: only those, and no others ("only my family's server");
//   - BLOCKED set: every server except those;
//   - a domain in both is a mistake and refuses startup, rather than quietly letting one list win.
//
// Like FEDERATION_ENABLED, these are parsed strictly: a list that cannot be understood stops the server with a message
// saying which entry. Guessing would leave the operator believing in a restriction that is not what is in force (an
// entry that is quietly dropped from an allow-list is a server that is left out; one dropped from a block-list is a
// server that is let in). Entries are exact domains, optionally with a port; no wildcards.
//
// Kept free of config.ts imports so it can be unit-tested on its own.

/** A domain as federation addresses it: lower-case host, optionally `:port`. */
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*(:[0-9]{1,5})?$/;

/** Whether a value is a server's domain as federation addresses it: a host name, optionally with a port, in any case. */
export function isDomainName(value: string): boolean {
  return DOMAIN.test(normalizeDomain(value));
}

/** What identifies a domain in the lists: case does not matter, a trailing dot (a fully-qualified name) does not either. */
export function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.(?=$|:)/, "");
}

/**
 * Parses one list. Unset or blank means no list. Otherwise comma-separated domains; spaces around an entry and a trailing
 * comma are fine, anything that is not a plain domain throws, naming the variable and the entry.
 */
export function parseDomainList(name: string, raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return [];
  const entries: string[] = [];
  for (const piece of raw.split(",")) {
    const entry = normalizeDomain(piece);
    if (entry === "") continue;
    if (entry.includes("*")) {
      throw new Error(`${name} has "${piece.trim()}": wildcards are not supported. List each server's domain exactly, for example chat.example.com.`);
    }
    if (!DOMAIN.test(entry)) {
      throw new Error(
        `${name} has "${piece.trim()}", which is not a domain. Use the server's domain as it appears after the colon in a username (chat.example.com, or chat.example.com:8443), separated by commas, with no https:// and no path.`
      );
    }
    if (!entries.includes(entry)) entries.push(entry);
  }
  return entries;
}

export interface DomainPolicy {
  /** Whether this server may talk to `domain`: neither contacted by it nor accepted from it when the answer is no. */
  isPermitted(domain: string): boolean;
  /** The lists as configured, for the startup log. */
  readonly allowed: readonly string[];
  readonly blocked: readonly string[];
}

/** Builds the policy from the two lists. A domain in both refuses with a message naming it. */
export function createDomainPolicy(allowed: readonly string[], blocked: readonly string[]): DomainPolicy {
  const allow = new Set(allowed.map(normalizeDomain));
  const block = new Set(blocked.map(normalizeDomain));
  for (const domain of allow) {
    if (block.has(domain)) {
      throw new Error(`FEDERATION_ALLOWED_DOMAINS and FEDERATION_BLOCKED_DOMAINS both list "${domain}". Remove it from one of them.`);
    }
  }
  return {
    allowed: [...allow],
    blocked: [...block],
    isPermitted(domain: string): boolean {
      const key = normalizeDomain(domain);
      if (block.has(key)) return false;
      return allow.size === 0 || allow.has(key);
    },
  };
}

/** What is said at startup, so the operator can see what the server understood. Null when there is no limit. */
export function describePolicy(policy: DomainPolicy): string | null {
  if (policy.allowed.length > 0) return `only talks to: ${policy.allowed.join(", ")}`;
  if (policy.blocked.length > 0) return `talks to every server except: ${policy.blocked.join(", ")}`;
  return null;
}
