/**
 * The accounts this device is signed in to, each with its own tokens (#49, phase 2). Plain `localStorage`, one entry per account
 * (`chat.session.<id>`, so two tabs changing two accounts never overwrite each other, and a refreshed token only ever rewrites its own
 * account's entry), and every read tolerates a missing, corrupt or hand-edited value.
 *
 * WHICH account a tab uses is that tab's own choice, kept in `sessionStorage` (it survives a reload and is not shared with other tabs).
 * `localStorage` only remembers the account used last, which is where a NEW tab starts. A tab that has chosen never silently falls back to
 * another account when its own goes: it ends up with none, because a request for one person's screen sent with another person's token is
 * the one thing this must never do.
 *
 * This is NOT the list of remembered identities (lib/recentAccounts.ts, which holds no tokens and can be switched off): an account is in this
 * list only while it is signed in, and signing out removes it, tokens and all.
 */
export interface AccountSession {
  /** `origin|username`, lower case: see sessionId(). */
  id: string;
  /** Scheme+host+port, the server the tokens were issued by and the only one they are ever sent to. Always http(s). */
  origin: string;
  domain: string;
  serverName: string;
  registrationEnabled: boolean;
  registrationInviteOnly?: boolean;
  /** Empty only for a session carried over from before accounts were kept, until the first answer from the server says whose it is. */
  username: string;
  accessToken: string;
  refreshToken: string;
  lastUsedAt: number;
}

export const SESSION_PREFIX = "chat.session.";
const CURSOR_PREFIX = "chat.syncCursor.";
const TAB_ACTIVE_KEY = "chat.activeAccount";
const LAST_ACTIVE_KEY = "chat.lastAccount";
/** What a client stored before this list existed: one account's tokens, the server, and the sync position. */
const LEGACY = { access: "chat.accessToken", refresh: "chat.refreshToken", cursor: "chat.syncCursor" } as const;

// Storage can throw (disabled, quota, a private window): every use is guarded, and a failure reads as "nothing there".
function read(store: "local" | "tab", key: string): string | null {
  try {
    return (store === "local" ? localStorage : sessionStorage).getItem(key);
  } catch {
    return null;
  }
}

function write(store: "local" | "tab", key: string, value: string | null) {
  try {
    const area = store === "local" ? localStorage : sessionStorage;
    if (value === null) area.removeItem(key);
    else area.setItem(key, value);
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

export function sessionId(origin: string, username: string): string {
  return `${origin.toLowerCase()}|${username.toLowerCase()}`;
}

export function sameOrigin(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** The part of an identity (`@name:domain`) after the first colon: where the person lives. */
function domainFromIdentity(identity: string | undefined, fallback: string): string {
  return identity && identity.includes(":") ? identity.slice(identity.indexOf(":") + 1).toLowerCase() : fallback;
}

function parseSession(value: unknown): AccountSession | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.origin !== "string" ||
    !isHttpOrigin(v.origin) ||
    typeof v.username !== "string" ||
    typeof v.accessToken !== "string" ||
    typeof v.refreshToken !== "string" ||
    !v.accessToken ||
    !v.refreshToken
  ) {
    return null;
  }
  // Copied field by field: nothing else in a stored value is ever carried along.
  return {
    id: sessionId(v.origin, v.username),
    origin: v.origin,
    domain: typeof v.domain === "string" ? v.domain : "",
    serverName: typeof v.serverName === "string" ? v.serverName : "",
    registrationEnabled: v.registrationEnabled !== false,
    ...(typeof v.registrationInviteOnly === "boolean" ? { registrationInviteOnly: v.registrationInviteOnly } : {}),
    username: v.username,
    accessToken: v.accessToken,
    refreshToken: v.refreshToken,
    lastUsedAt: typeof v.lastUsedAt === "number" && Number.isFinite(v.lastUsedAt) ? v.lastUsedAt : 0,
  };
}

export function readSession(id: string): AccountSession | null {
  const raw = read("local", SESSION_PREFIX + id);
  if (!raw) return null;
  try {
    return parseSession(JSON.parse(raw));
  } catch {
    return null;
  }
}

function writeSession(session: AccountSession) {
  const { id, ...fields } = session;
  write("local", SESSION_PREFIX + id, JSON.stringify(fields));
}

/** Every account signed in on this device, the one used most recently first. */
export function listSessions(): AccountSession[] {
  const found: AccountSession[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(SESSION_PREFIX)) continue;
      const session = readSession(key.slice(SESSION_PREFIX.length));
      if (session) found.push(session);
    }
  } catch {
    return [];
  }
  return found.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

/** The account this tab is using, or null: none signed in, or this tab's own has been signed out elsewhere. */
export function getActiveId(): string | null {
  const own = read("tab", TAB_ACTIVE_KEY);
  if (own) return readSession(own) ? own : null;
  // A tab that has not chosen yet starts where the last one left off, and keeps that, so another tab switching later does not move it.
  const last = read("local", LAST_ACTIVE_KEY);
  if (last && readSession(last)) {
    write("tab", TAB_ACTIVE_KEY, last);
    return last;
  }
  return null;
}

export function getActiveSession(): AccountSession | null {
  const id = getActiveId();
  return id ? readSession(id) : null;
}

/** Makes this tab use that account (and new tabs start on it). Reload afterwards: nothing already on screen belongs to it. */
export function activateSession(id: string) {
  write("tab", TAB_ACTIVE_KEY, id);
  write("local", LAST_ACTIVE_KEY, id);
}

/** A person has just signed in or registered: keep their tokens and make this tab use them. */
export function startSession(input: {
  origin: string;
  domain: string;
  serverName: string;
  registrationEnabled: boolean;
  registrationInviteOnly?: boolean;
  username: string;
  identity?: string;
  accessToken: string;
  refreshToken: string;
}): AccountSession {
  const session: AccountSession = {
    id: sessionId(input.origin, input.username),
    origin: input.origin,
    domain: domainFromIdentity(input.identity, input.domain),
    serverName: input.serverName,
    registrationEnabled: input.registrationEnabled,
    ...(input.registrationInviteOnly !== undefined ? { registrationInviteOnly: input.registrationInviteOnly } : {}),
    username: input.username,
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    lastUsedAt: Date.now(),
  };
  writeSession(session);
  activateSession(session.id);
  return session;
}

/** A refreshed pair of tokens for the account they belong to. Does nothing if that account has been signed out meanwhile. */
export function updateTokens(id: string, accessToken: string, refreshToken: string) {
  const session = readSession(id);
  if (session) writeSession({ ...session, accessToken, refreshToken });
}

/** Signs one account out of this device: its tokens and sync position go, and nothing that points at it is left behind. */
export function removeSession(id: string) {
  write("local", SESSION_PREFIX + id, null);
  write("local", CURSOR_PREFIX + id, null);
  if (read("local", LAST_ACTIVE_KEY) === id) write("local", LAST_ACTIVE_KEY, null);
  if (read("tab", TAB_ACTIVE_KEY) === id) write("tab", TAB_ACTIVE_KEY, null);
}

export function getSyncCursor(id: string): string | undefined {
  return read("local", CURSOR_PREFIX + id) ?? undefined;
}

export function setSyncCursor(id: string, cursor: string) {
  write("local", CURSOR_PREFIX + id, cursor);
}

/**
 * A client that was signed in before accounts were kept has one pair of tokens under the old keys. They become an account (whose name the
 * first answer from the server will fill in), so an update does not sign anyone out. Does nothing without old tokens or a known server.
 */
export function adoptLegacySession(server: { origin: string; domain: string; serverName: string; registrationEnabled: boolean; registrationInviteOnly?: boolean } | null) {
  const accessToken = read("local", LEGACY.access);
  const refreshToken = read("local", LEGACY.refresh);
  if (!accessToken || !refreshToken || !server || !isHttpOrigin(server.origin)) return;
  const session: AccountSession = {
    id: sessionId(server.origin, ""),
    origin: server.origin,
    domain: server.domain,
    serverName: server.serverName,
    registrationEnabled: server.registrationEnabled,
    ...(server.registrationInviteOnly !== undefined ? { registrationInviteOnly: server.registrationInviteOnly } : {}),
    username: "",
    accessToken,
    refreshToken,
    lastUsedAt: Date.now(),
  };
  writeSession(session);
  const cursor = read("local", LEGACY.cursor);
  if (cursor) setSyncCursor(session.id, cursor);
  for (const key of Object.values(LEGACY)) write("local", key, null);
  activateSession(session.id);
}

/** Whose a carried-over session is, now the server has said: it becomes an ordinary account under its real name. */
export function claimLegacySession(person: { username: string; identity?: string }): string | null {
  const id = getActiveId();
  const session = id ? readSession(id) : null;
  if (!id || !session || session.username !== "") return null;
  const claimed: AccountSession = {
    ...session,
    id: sessionId(session.origin, person.username),
    username: person.username,
    domain: domainFromIdentity(person.identity, session.domain),
  };
  const cursor = getSyncCursor(id);
  removeSession(id);
  writeSession(claimed);
  if (cursor) setSyncCursor(claimed.id, cursor);
  activateSession(claimed.id);
  return claimed.id;
}
