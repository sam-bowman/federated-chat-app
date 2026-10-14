/**
 * Identities (never passwords or tokens) the user has signed in with on this
 * device, so the client can offer them again. Plain `localStorage`, versioned,
 * and every read tolerates a missing, corrupt or hand-edited value.
 *
 * `serverName` and `domain` are reported by the server and so untrusted:
 * callers must render them as text only.
 */
export interface RecentAccount {
  /** Scheme+host+port, same shape as HomeServer.origin. Always http(s). */
  origin: string;
  domain: string;
  serverName: string;
  username: string;
  lastUsedAt: number;
}

export const RECENT_ACCOUNTS_KEY = "chat.recentAccounts";
export const REMEMBER_ACCOUNTS_KEY = "chat.rememberAccounts";
export const MAX_RECENT_ACCOUNTS = 8;
const VERSION = 1;

// Storage can throw (disabled, quota, private windows) - the list is a
// convenience, so failing to read or write it must never break sign-in.
function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

function isHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function sameAccount(a: { origin: string; username: string }, b: { origin: string; username: string }) {
  return a.origin.toLowerCase() === b.origin.toLowerCase() && a.username.toLowerCase() === b.username.toLowerCase();
}

function parseEntry(value: unknown): RecentAccount | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.origin !== "string" ||
    typeof v.domain !== "string" ||
    typeof v.serverName !== "string" ||
    typeof v.username !== "string" ||
    typeof v.lastUsedAt !== "number" ||
    !Number.isFinite(v.lastUsedAt) ||
    !v.username ||
    !isHttpOrigin(v.origin)
  ) {
    return null;
  }
  return {
    origin: v.origin,
    domain: v.domain,
    serverName: v.serverName,
    username: v.username,
    lastUsedAt: v.lastUsedAt,
  };
}

/** Most recent first, de-duplicated, capped. Invalid entries are dropped. */
export function getRecentAccounts(): RecentAccount[] {
  const raw = readRaw(RECENT_ACCOUNTS_KEY);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const { version, accounts } = parsed as { version?: unknown; accounts?: unknown };
  if (version !== VERSION || !Array.isArray(accounts)) return [];

  const result: RecentAccount[] = [];
  for (const entry of accounts.map(parseEntry)) {
    if (entry && !result.some((existing) => sameAccount(existing, entry))) result.push(entry);
  }
  return result.sort((a, b) => b.lastUsedAt - a.lastUsedAt).slice(0, MAX_RECENT_ACCOUNTS);
}

function save(accounts: RecentAccount[]) {
  writeRaw(RECENT_ACCOUNTS_KEY, accounts.length ? JSON.stringify({ version: VERSION, accounts }) : null);
}

/** "Remember on this device" - on unless the user turned it off. */
export function isRememberEnabled(): boolean {
  return readRaw(REMEMBER_ACCOUNTS_KEY) !== "false";
}

export function setRememberEnabled(enabled: boolean) {
  writeRaw(REMEMBER_ACCOUNTS_KEY, enabled ? null : "false");
}

/** Call only after a successful sign-in. A no-op when remembering is turned off. */
export function rememberAccount(account: Omit<RecentAccount, "lastUsedAt">, now = Date.now()) {
  if (!isRememberEnabled() || !account.username || !isHttpOrigin(account.origin)) return;
  // Copy the known fields only, so nothing else a caller passes is ever stored.
  const entry: RecentAccount = {
    origin: account.origin,
    domain: account.domain,
    serverName: account.serverName,
    username: account.username,
    lastUsedAt: now,
  };
  const others = getRecentAccounts().filter((existing) => !sameAccount(existing, entry));
  save([entry, ...others].slice(0, MAX_RECENT_ACCOUNTS));
}

export function forgetAccount(account: { origin: string; username: string }) {
  save(getRecentAccounts().filter((existing) => !sameAccount(existing, account)));
}

export function clearRecentAccounts() {
  save([]);
}

/** Usernames used on one server, most recent first. */
export function usernamesForServer(accounts: RecentAccount[], origin: string): string[] {
  return accounts.filter((a) => a.origin.toLowerCase() === origin.toLowerCase()).map((a) => a.username);
}
