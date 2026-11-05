import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { config } from "../../config.js";
import { requireAuth } from "../../middleware/auth.js";
import { webhookLimiter } from "../../middleware/rateLimit.js";
import { newProtocolId } from "../../lib/ids.js";
import { param } from "../../lib/params.js";
import { RICH_EMBED_LIMITS, prepareRichEmbeds, richEmbedInputSchema } from "../../lib/richEmbed.js";
import { publicUser } from "../../lib/serialize.js";
import { Permission, hasPermission } from "../../lib/permissions.js";
import { NO_SUCH_WEBHOOK_HASH, generateWebhookSecret, hashWebhookSecret, looksLikeWebhookSecret, secretMatches } from "../../lib/webhookSecret.js";
import { recordUserAudit } from "../audit/service.js";
import { getMemberPermissions } from "../communities/memberPermissions.js";
import { createChannelMessage } from "../channels/createMessage.js";
import { pruneRetiredWebhookSenders } from "./service.js";
import type { Channel, Community, User, Webhook } from "../../generated/prisma/client.js";

// Incoming webhooks (#132, phase 2; docs/webhooks.md). A webhook is a secret address a program can POST `{content}` to, to put a message in
// ONE channel. Everything for managing them is here (for PEOPLE: `requireAuth`, so a bot token is refused) and so is the post itself.
//
// The sender is a synthetic bot account of the webhook's own (User.isWebhook): the message model, the Bot badge, reports and the relay to
// other servers then work unchanged. It is not a community member, has no token, and cannot be found, added or befriended.

const nameSchema = z.string().trim().min(1).max(64);
// Lenient on purpose, like the profile's: the disk driver's /uploads/x.png is relative.
const avatarSchema = z.string().min(1).nullable();

const createSchema = z.object({ name: nameSchema, channelId: z.string().min(1), avatarUrl: avatarSchema.optional() });
const updateSchema = z.object({ name: nameSchema.optional(), channelId: z.string().min(1).optional(), avatarUrl: avatarSchema.optional() });
// A post is text, cards (#132: the same cards a bot sends, checked by the same validator), or both; it must have one of them.
const postSchema = z
  .object({
    content: z.string().max(8000).default(""),
    embeds: z.array(richEmbedInputSchema).max(RICH_EMBED_LIMITS.count).optional(),
  })
  .refine((d) => d.content.length > 0 || (d.embeds?.length ?? 0) > 0);

type WebhookRow = Webhook & { channel: Channel; sender: User; createdBy: User | null };
const WITH_PARTS = { channel: true, sender: true, createdBy: true } as const;

/** A webhook as a manager sees it. The secret is never part of it: it is shown once, when it is made or replaced. */
function serializeWebhook(webhook: WebhookRow, viewerId: string) {
  return {
    id: webhook.protocolId,
    name: webhook.name,
    avatarUrl: webhook.sender.avatarUrl,
    channelId: webhook.channel.protocolId,
    createdAt: webhook.createdAt,
    lastUsedAt: webhook.lastUsedAt,
    createdBy: webhook.createdBy ? publicUser(webhook.createdBy, viewerId) : null,
  };
}

/** The address a program posts to. The only place the secret ever appears in an answer. */
function webhookUrl(protocolId: string, secret: string): string {
  return `${config.baseUrl}/api/v1/webhooks/${protocolId}/${secret}`;
}

const target = (webhook: { protocolId: string; name: string }) => ({ type: "webhook", id: webhook.protocolId, label: webhook.name });

function requireWebhooksEnabled(_req: Request, res: Response, next: NextFunction) {
  if (!config.webhooksEnabled) return res.status(403).json({ error: "webhooks_disabled" });
  next();
}

/**
 * The community a manager is changing webhooks of, or null after answering. Someone who is not in it cannot tell it exists; a community on
 * another server cannot have webhooks here (its home server is the one that posts into it); and it takes MANAGE_WEBHOOKS.
 */
async function communityForManagement(req: Request, res: Response): Promise<Community | null> {
  const community = await prisma.community.findUnique({ where: { protocolId: param(req, "id") } });
  const membership = community
    ? await prisma.communityMember.findUnique({ where: { communityId_userId: { communityId: community.id, userId: req.userId! } } })
    : null;
  if (!community || !membership) {
    res.status(404).json({ error: "not_found" });
    return null;
  }
  if (community.isRemote) {
    res.status(409).json({ error: "not_community_home" });
    return null;
  }
  const perms = await getMemberPermissions(community.id, req.userId!, community.ownerId);
  if (!hasPermission(perms, Permission.MANAGE_WEBHOOKS)) {
    res.status(403).json({ error: "forbidden" });
    return null;
  }
  return community;
}

/** A text channel of this community, by protocol id. A voice channel has no messages to post. */
const textChannelOf = (community: Community, channelProtocolId: string) =>
  prisma.channel.findFirst({ where: { protocolId: channelProtocolId, communityId: community.id, type: "TEXT" } });

async function webhookOf(community: Community, req: Request): Promise<WebhookRow | null> {
  return prisma.webhook.findFirst({ where: { protocolId: param(req, "webhookId"), communityId: community.id }, include: WITH_PARTS });
}

// --- Managing them (mounted under /communities) ------------------------------------------------------------------------------------------

export const communityWebhooksRouter = Router();

communityWebhooksRouter.get("/:id/webhooks", requireAuth, async (req, res) => {
  const community = await communityForManagement(req, res);
  if (!community) return;
  const webhooks = await prisma.webhook.findMany({ where: { communityId: community.id }, include: WITH_PARTS, orderBy: { createdAt: "asc" } });
  res.json({ webhooks: webhooks.map((w) => serializeWebhook(w, req.userId!)), limit: config.webhooksPerCommunityLimit });
});

communityWebhooksRouter.post("/:id/webhooks", requireAuth, requireWebhooksEnabled, async (req, res) => {
  const community = await communityForManagement(req, res);
  if (!community) return;
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  const { name, channelId, avatarUrl } = parsed.data;

  const channel = await textChannelOf(community, channelId);
  if (!channel) return res.status(404).json({ error: "channel_not_found" });
  if ((await prisma.webhook.count({ where: { communityId: community.id } })) >= config.webhooksPerCommunityLimit) {
    return res.status(409).json({ error: "too_many_webhooks", limit: config.webhooksPerCommunityLimit });
  }

  const protocolId = newProtocolId();
  const secret = generateWebhookSecret();
  // The sender and the webhook are made together or not at all. The sender's name starts with a `~`, which the sign-up pattern can never produce.
  const webhook = await prisma.$transaction(async (tx) => {
    const sender = await tx.user.create({
      data: {
        protocolId: newProtocolId(),
        username: `~webhook-${protocolId}`,
        displayName: name,
        avatarUrl: avatarUrl ?? null,
        homeserverDomain: config.domain,
        isRemote: false,
        isBot: true,
        isWebhook: true,
        // Nobody on another server can look it up or befriend it (see isVisibleToDomain); it is reached through the messages it posts.
        discoverable: false,
        contactPolicy: "LOCAL_ONLY",
      },
    });
    return tx.webhook.create({
      data: { protocolId, communityId: community.id, channelId: channel.id, senderId: sender.id, createdById: req.userId!, name, secretHash: hashWebhookSecret(secret) },
      include: WITH_PARTS,
    });
  });
  await recordUserAudit(req.userId!, { action: "webhook.create", community, target: target(webhook), details: { channelId: channel.protocolId } });
  // The only time the address is ever shown.
  res.status(201).json({ webhook: serializeWebhook(webhook, req.userId!), url: webhookUrl(protocolId, secret) });
});

communityWebhooksRouter.patch("/:id/webhooks/:webhookId", requireAuth, async (req, res) => {
  const community = await communityForManagement(req, res);
  if (!community) return;
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  const webhook = await webhookOf(community, req);
  if (!webhook) return res.status(404).json({ error: "not_found" });

  let channelId: string | undefined;
  if (parsed.data.channelId !== undefined) {
    const channel = await textChannelOf(community, parsed.data.channelId);
    if (!channel) return res.status(404).json({ error: "channel_not_found" });
    channelId = channel.id;
  }
  const { name, avatarUrl } = parsed.data;
  await prisma.$transaction([
    prisma.webhook.update({ where: { id: webhook.id }, data: { name, channelId } }),
    // The name and picture people see are the sender's.
    prisma.user.update({ where: { id: webhook.senderId }, data: { displayName: name, avatarUrl } }),
  ]);
  const updated = await prisma.webhook.findUniqueOrThrow({ where: { id: webhook.id }, include: WITH_PARTS });
  const fields = Object.keys(parsed.data).filter((k) => parsed.data[k as keyof typeof parsed.data] !== undefined);
  await recordUserAudit(req.userId!, { action: "webhook.update", community, target: target(updated), details: { fields } });
  res.json({ webhook: serializeWebhook(updated, req.userId!) });
});

// A new address, which ends the old one at once.
communityWebhooksRouter.post("/:id/webhooks/:webhookId/url", requireAuth, requireWebhooksEnabled, async (req, res) => {
  const community = await communityForManagement(req, res);
  if (!community) return;
  const webhook = await webhookOf(community, req);
  if (!webhook) return res.status(404).json({ error: "not_found" });
  const secret = generateWebhookSecret();
  await prisma.webhook.update({ where: { id: webhook.id }, data: { secretHash: hashWebhookSecret(secret) } });
  await recordUserAudit(req.userId!, { action: "webhook.rotate", community, target: target(webhook) });
  res.json({ url: webhookUrl(webhook.protocolId, secret) });
});

// Deleting one keeps the messages it posted, under its name: a CI history should not vanish when the integration is retired. Allowed even
// when webhooks are switched off, so a manager can still clean up.
communityWebhooksRouter.delete("/:id/webhooks/:webhookId", requireAuth, async (req, res) => {
  const community = await communityForManagement(req, res);
  if (!community) return;
  const webhook = await webhookOf(community, req);
  if (!webhook) return res.status(404).json({ error: "not_found" });
  await prisma.webhook.delete({ where: { id: webhook.id } });
  // A sender that never posted has nothing to keep it for.
  await pruneRetiredWebhookSenders();
  await recordUserAudit(req.userId!, { action: "webhook.delete", community, target: target(webhook) });
  res.status(204).end();
});

// --- Posting (mounted under /webhooks) ---------------------------------------------------------------------------------------------------

export const webhookPostRouter = Router();

type Posting = Webhook & { sender: User; channel: Channel & { community: Community } };

/**
 * Finds the webhook the address names and checks its secret. Every way of being wrong (no such webhook, the wrong secret, a deleted channel,
 * webhooks switched off) is the SAME `404 not_found`, and the secret is compared the same way whether or not the webhook exists, so neither the
 * answer nor its timing says whether an id is real. The address is a credential: it is never logged (app.ts prints the route for a failure).
 */
async function verifyWebhook(req: Request, res: Response, next: NextFunction) {
  const notFound = () => res.status(404).json({ error: "not_found" });
  if (!config.webhooksEnabled) return notFound();
  const secret = param(req, "secret");
  if (!looksLikeWebhookSecret(secret)) return notFound();
  const webhook = (await prisma.webhook.findUnique({
    where: { protocolId: param(req, "id") },
    include: { sender: true, channel: { include: { community: true } } },
  })) as Posting | null;
  const matches = secretMatches(secret, webhook?.secretHash ?? NO_SUCH_WEBHOOK_HASH);
  if (!webhook || !matches) return notFound();
  // A community on another server never has one, and a voice channel has no messages; both would be a webhook that cannot work.
  if (webhook.channel.community.isRemote || webhook.channel.type !== "TEXT") return notFound();
  res.locals.webhook = webhook;
  res.locals.webhookId = webhook.protocolId;
  next();
}

webhookPostRouter.post("/:id/:secret", verifyWebhook, webhookLimiter, async (req, res) => {
  const webhook = res.locals.webhook as Posting;
  const parsed = postSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

  let prepared: Extract<ReturnType<typeof prepareRichEmbeds>, { ok: true }> | null = null;
  if (parsed.data.embeds?.length) {
    const result = prepareRichEmbeds(parsed.data.embeds);
    if (!result.ok) return res.status(400).json({ error: result.error });
    prepared = result;
  }

  // Written and told to everyone by the one function a person's or a bot's message goes through (modules/channels/createMessage.ts).
  const made = await createChannelMessage({ channel: webhook.channel, senderId: webhook.senderId, content: parsed.data.content, prepared });
  void markUsed(webhook);
  res.status(201).json({ id: made.message.protocolId });
  // The pages it links to (only if the server does previews) and the pictures named for its cards are read after the answer, as for any message.
  made.afterAnswer();
});

/** `lastUsedAt` is written at most once a minute, so a busy webhook is not a database write per message. Best effort: never fails a post. */
async function markUsed(webhook: Webhook): Promise<void> {
  const now = new Date();
  if (webhook.lastUsedAt && now.getTime() - webhook.lastUsedAt.getTime() < 60_000) return;
  try {
    await prisma.webhook.update({ where: { id: webhook.id }, data: { lastUsedAt: now } });
  } catch (err) {
    console.error("[webhook] could not record the use of a webhook:", err);
  }
}
