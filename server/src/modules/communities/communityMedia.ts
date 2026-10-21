import { prisma } from "../../db.js";
import { deleteFile } from "../../lib/storage/index.js";

/**
 * Every uploaded file a community owns: its icon, its channels' message attachments and its own
 * emoticons' images. Collect these BEFORE deleting the community - the rows that name them go with it.
 */
export async function collectCommunityMediaUrls(communityId: string): Promise<string[]> {
  const [community, attachments, emoticons] = await Promise.all([
    prisma.community.findUnique({ where: { id: communityId }, select: { iconUrl: true } }),
    prisma.attachment.findMany({ where: { message: { channel: { communityId } } }, select: { url: true } }),
    prisma.emoticon.findMany({ where: { communityId }, select: { imageUrl: true } }),
  ]);
  const urls = [community?.iconUrl, ...attachments.map((a) => a.url), ...emoticons.map((e) => e.imageUrl)];
  return [...new Set(urls.filter((u): u is string => !!u))];
}

/**
 * Every uploaded file that is only a person's own: their picture, the files attached to the messages they wrote and the images of the
 * emoticons they made for themselves. A community's emoticon they made is the community's. Collect these BEFORE erasing the account:
 * the rows that name them go with it.
 */
export async function collectUserMediaUrls(userId: string): Promise<string[]> {
  const [user, attachments, emoticons] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { avatarUrl: true } }),
    prisma.attachment.findMany({ where: { message: { senderId: userId } }, select: { url: true } }),
    prisma.emoticon.findMany({ where: { creatorId: userId, communityId: null }, select: { imageUrl: true } }),
  ]);
  const urls = [user?.avatarUrl, ...attachments.map((a) => a.url), ...emoticons.map((e) => e.imageUrl)];
  return [...new Set(urls.filter((u): u is string => !!u))];
}

async function stillReferenced(url: string): Promise<boolean> {
  const [user, attachment, emoticon, community] = await Promise.all([
    prisma.user.findFirst({ where: { avatarUrl: url }, select: { id: true } }),
    prisma.attachment.findFirst({ where: { url }, select: { id: true } }),
    prisma.emoticon.findFirst({ where: { imageUrl: url }, select: { id: true } }),
    prisma.community.findFirst({ where: { iconUrl: url }, select: { id: true } }),
  ]);
  return !!(user || attachment || emoticon || community);
}

/**
 * Deletes the files in `urls` that nothing refers to any more. Call it AFTER the community is gone, so
 * "still referenced" is judged on what is left: a file someone else also points at (a user whose
 * avatar is the same upload as the icon, an emoticon forked from one of ours that kept the image) must
 * stay. Best effort - a failure to delete is logged, never allowed to undo or fail the deletion, and
 * a URL that isn't ours to delete (a remote server's, say) is skipped by the storage adapter.
 * Returns how many files were removed.
 */
export async function deleteUnreferencedMedia(urls: string[]): Promise<number> {
  let removed = 0;
  for (const url of urls) {
    try {
      if (await stillReferenced(url)) continue;
      if (await deleteFile(url)) removed++;
    } catch (err) {
      console.error("[communities] couldn't delete an uploaded file left by something that was deleted:", err);
    }
  }
  return removed;
}
