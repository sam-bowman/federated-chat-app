// The directory (#109, phase 5): the communities a server lists as PUBLIC and the people who chose to be listed, for someone to browse.
//
// A server publishes its own (`GET /federation/v1/directory/...`, answered to other servers, and used by its own people through
// `GET /api/v1/directory/...`), and a person browses ANOTHER server's through their own server, which asks it and passes the answer on.
// That answer comes from a stranger's server and goes to our own people's screens, so everything in it is checked here, item by item,
// and an item that is not right is dropped rather than the page failing: a peer cannot make browsing fail, or put markup, a control
// character, a script URL or a name of the wrong length in front of our people.
//
// Kept free of config.ts imports so it can be unit-tested on its own.
import { sanitizeIconColor, sanitizeIconText, sanitizeRemoteIconUrl } from "./communityIcon.js";
import { sanitizeRemoteProfile } from "./profileFields.js";

export const DIRECTORY_PAGE_SIZE = 20;
export const DIRECTORY_SEARCH_MAX_CHARACTERS = 64;
/** More than a page is never accepted from another server, whatever it sends. */
const MAX_ITEMS_ACCEPTED = 50;

const UNSAFE_TEXT = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const CURSOR = /^[0-9A-Za-z_-]{1,64}$/;
const COMMUNITY_ID = /^[0-9A-Za-z_-]{1,64}$/;
const USERNAME = /^[a-z0-9_]{3,32}$/;
const COMMUNITY_NAME_MAX = 100;
const COMMUNITY_DESCRIPTION_MAX = 500;

export interface CommunityListing {
  /** The community's protocolId: with `domain`, the code to join it. */
  id: string;
  domain: string;
  name: string;
  description: string | null;
  iconUrl: string | null;
  iconText: string | null;
  iconColor: string | null;
  memberCount: number;
}

export interface PersonListing {
  /** The person's protocolId. */
  id: string;
  username: string;
  domain: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
}

export interface DirectoryPage<T> {
  items: T[];
  /** Pass back as `cursor` for the next page; null when this was the last. */
  nextCursor: string | null;
}

export type DirectoryQuery = { ok: true; q: string | null; cursor: string | null } | { ok: false };

/** What a request for a page may carry: a search (trimmed, a short line of text) and the cursor an earlier page gave. */
export function parseDirectoryQuery(query: Record<string, unknown>): DirectoryQuery {
  const rawQ = query.q;
  const rawCursor = query.cursor;
  if ((rawQ !== undefined && typeof rawQ !== "string") || (rawCursor !== undefined && typeof rawCursor !== "string")) return { ok: false };
  const q = typeof rawQ === "string" ? rawQ.trim() : "";
  if (UNSAFE_TEXT.test(q) || [...q].length > DIRECTORY_SEARCH_MAX_CHARACTERS) return { ok: false };
  if (typeof rawCursor === "string" && rawCursor !== "" && !CURSOR.test(rawCursor)) return { ok: false };
  return { ok: true, q: q === "" ? null : q, cursor: typeof rawCursor === "string" && rawCursor !== "" ? rawCursor : null };
}

/** The query string to ask another server for a page, or "" for the first page of everything. */
export function directoryQueryString(q: string | null, cursor: string | null): string {
  const parts: string[] = [];
  if (q) parts.push(`q=${encodeURIComponent(q)}`);
  if (cursor) parts.push(`cursor=${encodeURIComponent(cursor)}`);
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

/** A line of text of 1 to `max` characters with nothing in it that is not printable, or null. */
function line(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text !== "" && text.length <= max * 4 && [...text].length <= max && !UNSAFE_TEXT.test(text) ? text : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function pageOf<T>(raw: unknown, item: (entry: unknown) => T | null): DirectoryPage<T> {
  const body = asRecord(raw);
  const entries = Array.isArray(body.items) ? body.items.slice(0, MAX_ITEMS_ACCEPTED) : [];
  const items = entries.map(item).filter((x): x is T => x !== null);
  const next = typeof body.nextCursor === "string" && CURSOR.test(body.nextCursor) ? body.nextCursor : null;
  return { items, nextCursor: next };
}

/**
 * The communities another server listed, kept only where each is right. `domain` is the server that was asked, never what an item
 * says: a server speaks for its own communities only, so it cannot list someone else's.
 */
export function sanitizeCommunityPage(raw: unknown, domain: string): DirectoryPage<CommunityListing> {
  return pageOf(raw, (entry) => {
    const c = asRecord(entry);
    const name = line(c.name, COMMUNITY_NAME_MAX);
    if (typeof c.id !== "string" || !COMMUNITY_ID.test(c.id) || name === null) return null;
    const description =
      typeof c.description === "string" &&
      c.description.trim() !== "" &&
      c.description.length <= COMMUNITY_DESCRIPTION_MAX &&
      !UNSAFE_TEXT.test(c.description.replace(/[\n\r\t]/g, ""))
        ? c.description
        : null;
    const members = typeof c.memberCount === "number" && Number.isInteger(c.memberCount) && c.memberCount >= 0 ? Math.min(c.memberCount, 1_000_000_000) : 0;
    return {
      id: c.id,
      domain,
      name,
      description,
      iconUrl: sanitizeRemoteIconUrl(c.iconUrl),
      iconText: sanitizeIconText(c.iconText),
      iconColor: sanitizeIconColor(c.iconColor),
      memberCount: members,
    };
  });
}

/** The people another server listed, kept only where each is right (see sanitizeCommunityPage). */
export function sanitizePeoplePage(raw: unknown, domain: string): DirectoryPage<PersonListing> {
  return pageOf(raw, (entry) => {
    const p = asRecord(entry);
    if (typeof p.id !== "string" || !COMMUNITY_ID.test(p.id) || typeof p.username !== "string" || !USERNAME.test(p.username)) return null;
    const fields = sanitizeRemoteProfile(p);
    if (fields.displayName === undefined) return null;
    // Only an absolute URL means anything to us: a path would resolve against OUR server.
    return {
      id: p.id,
      username: p.username,
      domain,
      displayName: fields.displayName,
      avatarUrl: sanitizeRemoteIconUrl(p.avatarUrl),
      bio: fields.bio,
    };
  });
}
