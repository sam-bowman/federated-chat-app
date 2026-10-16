import { config } from "../../config.js";
import { prisma } from "../../db.js";
import { DIRECTORY_PAGE_SIZE, type CommunityListing, type DirectoryPage, type PersonListing } from "../../lib/directory.js";
import { toAbsoluteMediaUrl } from "../../lib/mediaUrl.js";

/**
 * This server's own directory (the caller has already checked that it publishes one). Newest first: a protocolId is a ULID, so it
 * sorts by when the thing was made, and the cursor is just the last one on the page, which stays right if something is added or
 * removed between pages. One more row than a page is read, to know whether there is a next page.
 */

/**
 * What a search is matched with. Prisma's `contains` puts the text into a LIKE pattern as it is, so a `%` or `_` someone typed would be
 * a wildcard (a search for "%" would match everything); they are escaped here so a search means what it says.
 */
const literally = (q: string) => q.replace(/[\\%_]/g, "\\$&");

/** The PUBLIC communities hosted here whose name or description contains `q` (when there is one). */
export async function listPublicCommunities(q: string | null, cursor: string | null, limit = DIRECTORY_PAGE_SIZE): Promise<DirectoryPage<CommunityListing>> {
  const rows = await prisma.community.findMany({
    where: {
      isRemote: false,
      visibility: "PUBLIC",
      ...(cursor ? { protocolId: { lt: cursor } } : {}),
      ...(q ? { OR: [{ name: { contains: literally(q), mode: "insensitive" } }, { description: { contains: literally(q), mode: "insensitive" } }] } : {}),
    },
    orderBy: { protocolId: "desc" },
    take: limit + 1,
    select: {
      protocolId: true,
      name: true,
      description: true,
      iconUrl: true,
      iconText: true,
      iconColor: true,
      _count: { select: { members: true } },
    },
  });
  const page = rows.slice(0, limit);
  return {
    items: page.map((c) => ({
      id: c.protocolId,
      domain: config.domain,
      name: c.name,
      description: c.description,
      // Relative under the disk storage driver, which means nothing to anyone browsing from another server.
      iconUrl: c.iconUrl ? toAbsoluteMediaUrl(c.iconUrl, config.baseUrl) : null,
      iconText: c.iconText,
      iconColor: c.iconColor,
      memberCount: c._count.members,
    })),
    nextCursor: rows.length > limit ? page[page.length - 1].protocolId : null,
  };
}

/**
 * The people here who chose to be listed AND can be found: someone who has since hidden from other servers is not listed whatever
 * they chose before, and when the server has switched findability off for everyone nobody is. `exceptUserId` leaves out the one
 * looking (their own entry is of no use to them).
 */
export async function listListedPeople(
  q: string | null,
  cursor: string | null,
  limit = DIRECTORY_PAGE_SIZE,
  exceptUserId?: string
): Promise<DirectoryPage<PersonListing>> {
  if (config.userDiscoverability === "forced-off") return { items: [], nextCursor: null };
  const rows = await prisma.user.findMany({
    where: {
      isRemote: false,
      listedInDirectory: true,
      discoverable: true,
      ...(exceptUserId ? { id: { not: exceptUserId } } : {}),
      ...(cursor ? { protocolId: { lt: cursor } } : {}),
      ...(q ? { OR: [{ username: { contains: literally(q), mode: "insensitive" } }, { displayName: { contains: literally(q), mode: "insensitive" } }] } : {}),
    },
    orderBy: { protocolId: "desc" },
    take: limit + 1,
    select: { protocolId: true, username: true, displayName: true, avatarUrl: true, bio: true },
  });
  const page = rows.slice(0, limit);
  return {
    items: page.map((u) => ({
      id: u.protocolId,
      username: u.username,
      domain: config.domain,
      displayName: u.displayName,
      avatarUrl: u.avatarUrl ? toAbsoluteMediaUrl(u.avatarUrl, config.baseUrl) : null,
      bio: u.bio,
    })),
    nextCursor: rows.length > limit ? page[page.length - 1].protocolId : null,
  };
}
