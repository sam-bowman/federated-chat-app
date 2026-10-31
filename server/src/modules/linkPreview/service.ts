import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../db.js";
import { config } from "../../config.js";
import { serverVersion } from "../../lib/version.js";
import { enqueueFederationEvent } from "../../lib/federation/outbox.js";
import { parseEmbeds, sameEmbeds, type Embed } from "../../lib/linkPreview/embed.js";
import { createFailureReporter } from "../../lib/linkPreview/failureLog.js";
import { fetchPage, type FetchLimits } from "../../lib/linkPreview/fetchPage.js";
import { extractLinks } from "../../lib/linkPreview/links.js";
import { readPageMeta } from "../../lib/linkPreview/pageMeta.js";
import { emitSyncEvent } from "../sync/events.js";
import { getRemoteCommunityDomains, getRemoteConversationDomains, localMessageRecipients } from "../messages/federationRelay.js";

// Link previews (#197): a small card under a message with the title, description and site of the pages it links to. The server that
// ACCEPTED the message reads each page once (so only this server's address is shown to the linked site, never a reader's), keeps
// what it learned for a day, and tells everyone who sees the message. Other servers never read the page: they are told what this
// one found, and check it (lib/linkPreview/embed.ts) before they show it. Off unless LINK_PREVIEWS_ENABLED.

/** What one page read may cost. The numbers are the ones the issue asked for: short, small, few. */
export const PAGE_LIMITS = { timeoutMs: 5000, maxBytes: 256 * 1024, maxRedirects: 3 } as const;
/** A page that gave a preview is not read again for this long; one that gave nothing for a shorter time (it may be down). */
export const CACHE_TTL_MS = { ok: 24 * 60 * 60 * 1000, nothing: 60 * 60 * 1000 } as const;
/** Pages one person can make this server read in a window, and in all, whatever they send. A cached page costs nothing. */
export const READ_LIMITS = { perUser: 20, perUserWindowMs: 10 * 60 * 1000, perServer: 600, perServerWindowMs: 60 * 60 * 1000, concurrent: 4 } as const;

/** Tests only: lets the fetch reach a server on this machine, which the guard refuses. Never set by the server itself. */
export const testHooks: { allowPrivate: boolean } = { allowPrivate: false };

const userReads = new Map<string, number[]>();
let serverReads: number[] = [];
let running = 0;
const waiting: (() => void)[] = [];

/** Forgets how many pages anyone has read (tests only). */
export function resetLimitsForTests(): void {
  userReads.clear();
  serverReads = [];
}

function underLimit(userId: string, now: number): boolean {
  const mine = (userReads.get(userId) ?? []).filter((t) => now - t < READ_LIMITS.perUserWindowMs);
  serverReads = serverReads.filter((t) => now - t < READ_LIMITS.perServerWindowMs);
  if (mine.length >= READ_LIMITS.perUser || serverReads.length >= READ_LIMITS.perServer) {
    userReads.set(userId, mine);
    return false;
  }
  mine.push(now);
  serverReads.push(now);
  userReads.set(userId, mine);
  return true;
}

async function withSlot<T>(work: () => Promise<T>): Promise<T> {
  if (running >= READ_LIMITS.concurrent) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await work();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

function limits(): FetchLimits {
  return { ...PAGE_LIMITS, userAgent: `FederatedChatLinkPreview/${serverVersion} (+${config.baseUrl})`, allowPrivate: testHooks.allowPrivate };
}

// Why a page could not be read goes in the log (at most once in five minutes for each reason): to the person it is only "no preview", so
// without it nobody would find out that the server cannot look up names (#236).
const reportFailure = createFailureReporter((format, ...args) => console.warn(format, ...args));

/** The preview for one address: from what was learned recently, or by reading the page. Null for no preview, never an error. */
export async function previewFor(url: string, userId: string): Promise<Embed | null> {
  const now = Date.now();
  const cached = await prisma.linkPreviewCache.findUnique({ where: { url } });
  if (cached && now - cached.fetchedAt.getTime() < (cached.ok ? CACHE_TTL_MS.ok : CACHE_TTL_MS.nothing)) {
    return cached.ok ? (parseEmbeds([{ url, title: cached.title, description: cached.description, siteName: cached.siteName }])[0] ?? null) : null;
  }
  if (!underLimit(userId, now)) return null; // not remembered: asking again later is fine

  const page = await withSlot(() => fetchPage(url, limits()));
  if (!page.ok) reportFailure(page);
  const meta = page.ok ? readPageMeta(page.html, page.finalUrl) : null;
  const embed = meta ? (parseEmbeds([{ url, ...meta }])[0] ?? null) : null;
  const data = { ok: embed !== null, title: embed?.title ?? null, description: embed?.description ?? null, siteName: embed?.siteName ?? null, fetchedAt: new Date() };
  await prisma.linkPreviewCache.upsert({ where: { url }, create: { url, ...data }, update: data });
  // Old entries are not kept for ever.
  if (Math.random() < 0.02) await prisma.linkPreviewCache.deleteMany({ where: { fetchedAt: { lt: new Date(now - 7 * 24 * 60 * 60 * 1000) } } });
  return embed;
}

/** The previews for the addresses in some text, at most MAX_LINKS of them, in the order they appear. */
export async function embedsForText(text: string, userId: string): Promise<Embed[]> {
  const found = await Promise.all(extractLinks(text).map((url) => previewFor(url, userId).catch(() => null)));
  return found.filter((e): e is Embed => e !== null);
}

/** Where a message's previews have to be sent to other servers: the path to post them to, per domain. */
async function relayTargets(message: { id: string; protocolId: string; conversationId: string | null; channelId: string | null }): Promise<{ domain: string; path: string }[]> {
  if (message.conversationId) {
    return (await getRemoteConversationDomains(message.conversationId)).map((domain) => ({ domain, path: `/messages/${message.protocolId}/embeds` }));
  }
  if (message.channelId) {
    const channel = await prisma.channel.findUnique({ where: { id: message.channelId }, include: { community: true } });
    // A cached copy of someone else's community never relays: only its own home server does.
    if (!channel || channel.community.isRemote) return [];
    const domains = await getRemoteCommunityDomains(channel.communityId);
    return domains.map((domain) => ({ domain, path: `/communities/${channel.community.protocolId}/channels/${channel.protocolId}/messages/${message.protocolId}/embeds` }));
  }
  return [];
}

/** Tells everyone who sees the message what its previews are now: this server's people, and the other servers that hold a copy. */
export async function announceEmbeds(messageId: string): Promise<void> {
  const message = await prisma.message.findUnique({ where: { id: messageId } });
  if (!message || message.deletedAt) return;
  const embeds = parseEmbeds(message.embeds);
  const { recipients, location } = await localMessageRecipients(message);
  await emitSyncEvent(recipients, "message:embeds", { messageId: message.protocolId, embeds, ...location });
  for (const { domain, path } of await relayTargets(message)) await enqueueFederationEvent(domain, path, { embeds });
}

/**
 * Reads the pages a message links to and, if that changes its previews, keeps and announces them. Quiet by design: a failure of any
 * kind is no preview, never an error for the person who sent the message.
 */
export async function generateEmbeds(messageProtocolId: string): Promise<void> {
  if (!config.linkPreviewsEnabled) return;
  const message = await prisma.message.findUnique({ where: { protocolId: messageProtocolId }, include: { sender: true } });
  // Only for what this server's own people wrote (another server reads the pages for its people), and not an invitation card.
  if (!message || message.deletedAt || message.embedsRemoved || message.invite || message.sender.isRemote) return;
  const embeds = await embedsForText(message.content, message.senderId);
  if (sameEmbeds(embeds, parseEmbeds(message.embeds))) return;
  // The message may have been edited, deleted or had its previews taken off while the pages were being read.
  const changed = await prisma.message.updateMany({
    where: { id: message.id, content: message.content, deletedAt: null, embedsRemoved: false },
    data: { embeds: embeds.length > 0 ? (embeds as unknown as Prisma.InputJsonValue) : Prisma.DbNull },
  });
  if (changed.count === 1) await announceEmbeds(message.id);
}

/** Starts reading in the background, if there is anything to read: the person is not kept waiting for a page. */
export function scheduleEmbeds(messageProtocolId: string, text: string): void {
  if (!config.linkPreviewsEnabled || extractLinks(text, 1).length === 0) return;
  void generateEmbeds(messageProtocolId).catch((err) => console.error("[link preview] could not make previews for a message:", err));
}

/** After an edit: previews that no longer match the text go at once, and the new text's links are read. */
export async function refreshAfterEdit(messageId: string, messageProtocolId: string, newText: string): Promise<void> {
  if (!config.linkPreviewsEnabled) return;
  const message = await prisma.message.findUnique({ where: { id: messageId } });
  if (!message) return;
  const stillLinked = new Set(extractLinks(newText));
  const had = parseEmbeds(message.embeds);
  const kept = had.filter((e) => stillLinked.has(e.url));
  if (!sameEmbeds(kept, had)) {
    await prisma.message.update({ where: { id: messageId }, data: { embeds: kept.length > 0 ? (kept as unknown as Prisma.InputJsonValue) : Prisma.DbNull } });
    await announceEmbeds(messageId);
  }
  scheduleEmbeds(messageProtocolId, newText);
}

/** The author takes the previews off their message: gone, and not brought back by an edit. */
export async function removeEmbeds(messageId: string): Promise<void> {
  await prisma.message.update({ where: { id: messageId }, data: { embeds: Prisma.DbNull, embedsRemoved: true } });
  await announceEmbeds(messageId);
}
