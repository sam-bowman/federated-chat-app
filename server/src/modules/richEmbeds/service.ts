import { prisma } from "../../db.js";
import type { RichEmbed, PictureSources } from "../../lib/richEmbed.js";
import { IMAGE_STORE_LIMITS, imagesOn, storeImage } from "../linkPreview/images.js";
import { announceEmbeds, imageWho } from "../linkPreview/service.js";

// The pictures of a bot's cards (#132, phase 3a). A bot names a picture by address; the server that ACCEPTED the message fetches it once, with
// every rule a link preview's picture has (the guarded fetcher, the bytes decide what it is, size limits, a copy of its own), and the card shows
// the copy, so a reader's browser never contacts the bot author's server. The card is stored and announced at once WITHOUT its pictures and
// announced again with them, after the answer, so a slow picture never holds up a message. A bot has a budget of pictures of its own.

/**
 * Fetches the pictures `sources` name (one entry per card, in order) and puts the copies on the card they belong to, if the message still has
 * exactly the cards `stored`. Quiet by design: a picture that cannot be had is a card without one, and a failure of any kind never reaches the bot.
 */
export async function attachPictures(messageId: string, botId: string, stored: RichEmbed[], sources: PictureSources[]): Promise<void> {
  if (!imagesOn() || !sources.some((s) => s.image || s.thumbnail)) return;
  const budget = { key: `bot:${botId}`, perHour: IMAGE_STORE_LIMITS.perBotPerHour };
  const next: RichEmbed[] = stored.map((embed) => ({ ...embed }));
  let changed = false;
  for (let i = 0; i < next.length; i++) {
    for (const kind of ["image", "thumbnail"] as const) {
      const address = sources[i]?.[kind];
      if (!address) continue;
      const copy = await storeImage(address, imageWho(), budget);
      if (copy) {
        next[i][kind] = copy;
        changed = true;
      }
    }
  }
  if (!changed) return;
  // Only if the message still has the cards it had when the pictures were asked for: an edit made meanwhile has its own pictures coming, and
  // these would be on the wrong cards. (jsonb compares by value, not by the order of keys.)
  const updated = await prisma.$executeRaw`
    UPDATE "Message" SET "richEmbeds" = ${JSON.stringify(next)}::jsonb
    WHERE id = ${messageId} AND "deletedAt" IS NULL AND "richEmbeds" = ${JSON.stringify(stored)}::jsonb`;
  if (updated === 1) await announceEmbeds(messageId);
}

/** Starts fetching the pictures in the background, if there are any: the bot is not kept waiting for them. */
export function schedulePictures(messageId: string, botId: string, stored: RichEmbed[], sources: PictureSources[]): void {
  void attachPictures(messageId, botId, stored, sources).catch((err) => console.error("[rich embed] could not attach pictures to a message:", err));
}

