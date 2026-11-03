import { prisma } from "../../db.js";
import { config } from "../../config.js";
import { parseEmbeds, type Embed, type EmbedImage } from "../../lib/linkPreview/embed.js";
import { fetchImage } from "../../lib/linkPreview/fetchPage.js";
import { IMAGE_LIMITS, checkImage } from "../../lib/linkPreview/imageInfo.js";
import { toAbsoluteMediaUrl } from "../../lib/mediaUrl.js";
import { deleteFile, uploadFile } from "../../lib/storage/index.js";

// The pictures of link previews (#244). The server that ACCEPTED a message fetches the picture its link names once, with every rule a page read
// has (lib/linkPreview/fetchPage.ts), checks the bytes are really a small picture of one of four kinds (lib/linkPreview/imageInfo.ts: the
// other site's word is never taken), and keeps its own copy through the ordinary storage driver. A reader's browser then only ever asks a server
// of this federation for it, never the linked site. Other servers are told where the copy is and never fetch anything themselves. Off unless
// LINK_PREVIEW_IMAGES_ENABLED (and previews are on).

/** Everything one picture, and all of them together, may cost. The first two are the same kind of limit pages have; the byte total is a ceiling on disk. */
export const IMAGE_STORE_LIMITS = {
  timeoutMs: 8000,
  maxRedirects: 3,
  /** Pictures this server fetches in an hour, whoever's message they are in (a page that is cached costs none). */
  perServerPerHour: 300,
  concurrent: 2,
  /** When the copies already made add up to this much, no new one is made: the preview shows without its picture. */
  maxTotalBytes: 1024 * 1024 * 1024,
  /** A picture fetched from the same address within this long is reused, so many pages naming one logo make one copy. */
  reuseMs: 7 * 24 * 60 * 60 * 1000,
  /** A copy is not removed within two days of when it was last given to a message, even if none shows it yet: the message that will is still being made. */
  graceMs: 2 * 24 * 60 * 60 * 1000,
  /** How often copies nothing shows any more are removed. */
  pruneEveryMs: 60 * 60 * 1000,
} as const;

/** Whether pictures are in use: they need previews to be on as well. */
export function imagesOn(): boolean {
  return config.linkPreviewsEnabled && config.linkPreviewImagesEnabled;
}

let fetchedThisHour: number[] = [];
let running = 0;
const waiting: (() => void)[] = [];

/** Forgets how many pictures were fetched (tests only). */
export function resetImageLimitsForTests(): void {
  fetchedThisHour = [];
}

function underHourlyLimit(now: number): boolean {
  fetchedThisHour = fetchedThisHour.filter((t) => now - t < 60 * 60 * 1000);
  if (fetchedThisHour.length >= IMAGE_STORE_LIMITS.perServerPerHour) return false;
  fetchedThisHour.push(now);
  return true;
}

async function withSlot<T>(work: () => Promise<T>): Promise<T> {
  if (running >= IMAGE_STORE_LIMITS.concurrent) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await work();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

/** How a copy is named in a message's embeds, if this server still has it. A copy is gone once no message showed it (see pruneImages). */
export async function existingImage(url: string): Promise<EmbedImage | null> {
  const row = await prisma.linkPreviewImage.findUnique({ where: { url } });
  return row ? { url: row.url, width: row.width, height: row.height } : null;
}

/**
 * A copy of the picture at `address`, made now or reused, or null for no picture (never an error: a picture that cannot be had is a card without
 * one). `who` is how the fetch introduces itself and, in tests, whether it may reach this machine.
 */
export async function storeImage(address: string, who: { userAgent: string; allowPrivate: boolean }): Promise<EmbedImage | null> {
  const now = Date.now();
  const reusable = await prisma.linkPreviewImage.findFirst({
    where: { sourceUrl: address, createdAt: { gt: new Date(now - IMAGE_STORE_LIMITS.reuseMs) } },
    orderBy: { createdAt: "desc" },
  });
  if (reusable) {
    // Used again: so it is not removed in the moment between this and the message being given it.
    await prisma.linkPreviewImage.updateMany({ where: { id: reusable.id }, data: { lastUsedAt: new Date(now) } });
    return { url: reusable.url, width: reusable.width, height: reusable.height };
  }

  const stored = await prisma.linkPreviewImage.aggregate({ _sum: { bytes: true } });
  if ((stored._sum.bytes ?? 0) >= IMAGE_STORE_LIMITS.maxTotalBytes) return null;
  if (!underHourlyLimit(now)) return null;

  const got = await withSlot(() =>
    fetchImage(address, {
      timeoutMs: IMAGE_STORE_LIMITS.timeoutMs,
      maxBytes: IMAGE_LIMITS.maxBytes,
      maxRedirects: IMAGE_STORE_LIMITS.maxRedirects,
      userAgent: who.userAgent,
      allowPrivate: who.allowPrivate,
    })
  );
  if (!got.ok) return null;
  // What the site said it was decided only whether to read on: the file's own bytes decide what it is.
  const checked = checkImage(got.bytes);
  if (!checked.ok) return null;

  const { info } = checked;
  const saved = await uploadFile({ buffer: got.bytes, originalFilename: `preview.${info.extension}`, contentType: info.contentType });
  const url = toAbsoluteMediaUrl(saved.url, config.baseUrl);
  try {
    await prisma.linkPreviewImage.create({ data: { url, storedUrl: saved.url, sourceUrl: address, width: info.width, height: info.height, bytes: got.bytes.length } });
  } catch (err) {
    await deleteFile(saved.url).catch(() => false); // a file with no record would never be removed
    throw err;
  }
  return { url, width: info.width, height: info.height };
}

/** The previews of a message as they may be shown now: without their pictures while pictures are off (a card that was only a picture goes too). */
export function visibleEmbeds(raw: unknown): Embed[] {
  const embeds = parseEmbeds(raw);
  if (imagesOn()) return embeds;
  return embeds.flatMap((embed) => {
    if (!embed.image) return [embed];
    const { image: _image, ...rest } = embed;
    return rest.title !== null || rest.description !== null ? [rest] : [];
  });
}

/**
 * Removes the copies no message shows any more, and all of them while pictures are off. A message shows a copy while it is not deleted and its
 * embeds name the copy's address. The set of addresses in use is read in ONE query (a join per picture would read the messages once each).
 * Returns how many were removed.
 */
export async function pruneImages(now: Date = new Date()): Promise<number> {
  let removed = 0;
  for (let batch = 0; batch < 20; batch++) {
    const doomed = imagesOn()
      ? await prisma.$queryRaw<{ id: string; storedUrl: string }[]>`
          WITH used AS (
            SELECT DISTINCT e->'image'->>'url' AS url
            FROM "Message" m,
                 jsonb_array_elements(CASE WHEN jsonb_typeof(m.embeds) = 'array' THEN m.embeds ELSE '[]'::jsonb END) e
            WHERE m.embeds IS NOT NULL AND m."deletedAt" IS NULL
          )
          SELECT i.id, i."storedUrl"
          FROM "LinkPreviewImage" i
          LEFT JOIN used u ON u.url = i.url
          WHERE i."lastUsedAt" < ${new Date(now.getTime() - IMAGE_STORE_LIMITS.graceMs)} AND u.url IS NULL
          LIMIT 200`
      : await prisma.linkPreviewImage.findMany({ select: { id: true, storedUrl: true }, take: 200 });
    if (doomed.length === 0) break;
    for (const image of doomed) {
      try {
        await deleteFile(image.storedUrl); // false when it was already gone, which is the same for us
        await prisma.linkPreviewImage.deleteMany({ where: { id: image.id } });
        removed++;
      } catch (err) {
        console.error("[link preview] could not remove a stored picture:", err);
      }
    }
  }
  return removed;
}

/** Removes unused copies shortly after start and then every hour (an hour is how soon turning pictures off takes the files away). */
export function startImagePruning(intervalMs: number = IMAGE_STORE_LIMITS.pruneEveryMs): () => void {
  const run = () => {
    pruneImages().catch((err) => console.error("[link preview] could not remove unused pictures:", err));
  };
  const first = setTimeout(run, 60 * 1000);
  const timer = setInterval(run, intervalMs);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
