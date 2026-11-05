import { Router, type Request } from "express";
import { z } from "zod";
import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../db.js";
import { config } from "../../config.js";
import { requireAuth, requireBot } from "../../middleware/auth.js";
import { commandLimiter } from "../../middleware/rateLimit.js";
import { newProtocolId } from "../../lib/ids.js";
import { param } from "../../lib/params.js";
import { publicUser } from "../../lib/serialize.js";
import { Permission, hasPermission } from "../../lib/permissions.js";
import { checkOptions, parseCommands, storedOptions, type OptionValues } from "../../lib/botCommands.js";
import { interactionSnapshot } from "../../lib/interactionRef.js";
import { RICH_EMBED_LIMITS, prepareRichEmbeds, richEmbedInputSchema, type RichEmbed } from "../../lib/richEmbed.js";
import { sendToUser } from "../../ws/gateway.js";
import { getMemberPermissions } from "../communities/memberPermissions.js";
import { createChannelMessage } from "../channels/createMessage.js";
import { visibleRichEmbeds } from "../linkPreview/images.js";
import { INTERACTION_LIMITS, botView, connectedAmong, isConnected, pushCommandsUpdated, serializeCommand, usableBotsIn } from "./service.js";

// Slash commands (#132, phase 3b, docs/commands-3b-plan.md). A bot registers its commands (as itself); a member of a community it is in runs one,
// with options checked against the registered types, and the bot is sent an interaction (live only) and answers it within seconds. Four routers:
//   /commands                       the bot's own set
//   /communities/:id/commands       what a member may run here
//   /channels/:id/commands/:id      running one
//   /interactions/:id/...           the bot answering

// --- The bot's own commands -----------------------------------------------------------------------------------------------------------

export const botCommandsRouter = Router();

// The bot's WHOLE set, replacing what it had: leaving a command out removes it, and a command that keeps its name keeps its id (so an open form,
// an interaction on its way and a client's cache all survive the bot restarting and registering again).
botCommandsRouter.put("/", requireBot, async (req, res) => {
  const parsed = parseCommands(req.body);
  if (!parsed.ok) return res.status(400).json({ error: "invalid_commands", detail: parsed.detail });
  const botId = req.userId!;
  let rows;
  try {
    rows = await prisma.$transaction(async (tx) => {
      const existing = new Map((await tx.botCommand.findMany({ where: { botId } })).map((c) => [c.name, c]));
      const saved = [];
      for (const [position, def] of parsed.value.entries()) {
        const data = { description: def.description, options: def.options as unknown as Prisma.InputJsonValue, position };
        const row = existing.get(def.name);
        saved.push(
          row
            ? await tx.botCommand.update({ where: { id: row.id }, data })
            : await tx.botCommand.create({ data: { protocolId: newProtocolId(), botId, name: def.name, ...data } })
        );
      }
      await tx.botCommand.deleteMany({ where: { botId, name: { notIn: parsed.value.map((c) => c.name) } } });
      return saved;
    });
  } catch (err) {
    // Two registrations at once: the unique key decides, and the loser may simply send again.
    if ((err as { code?: string }).code === "P2002") return res.status(409).json({ error: "conflict" });
    throw err;
  }
  await pushCommandsUpdated(await prisma.user.findUniqueOrThrow({ where: { id: botId }, select: { id: true, protocolId: true } }));
  res.json({ commands: rows.map(serializeCommand) });
});

botCommandsRouter.get("/", requireBot, async (req, res) => {
  const rows = await prisma.botCommand.findMany({ where: { botId: req.userId! }, orderBy: { position: "asc" } });
  res.json({ commands: rows.map(serializeCommand) });
});

// --- What a member may run in a community ---------------------------------------------------------------------------------------------

export const communityCommandsRouter = Router();

communityCommandsRouter.get("/:id/commands", requireAuth, async (req, res) => {
  const community = await prisma.community.findUnique({ where: { protocolId: param(req, "id") } });
  const membership = community
    ? await prisma.communityMember.findUnique({ where: { communityId_userId: { communityId: community.id, userId: req.userId! } } })
    : null;
  if (!community || !membership) return res.status(404).json({ error: "not_found" });
  // A community this server only caches has no bots of its own here: its home server answers for it.
  if (community.isRemote) return res.json({ commands: [], canUse: false });

  const perms = await getMemberPermissions(community.id, req.userId!, community.ownerId);
  const canUse = hasPermission(perms, Permission.USE_COMMANDS) && hasPermission(perms, Permission.SEND_MESSAGES);
  if (!config.botsEnabled) return res.json({ commands: [], canUse });

  const rows = await prisma.botCommand.findMany({
    where: { bot: usableBotsIn(community.id) },
    include: { bot: true },
    orderBy: [{ bot: { displayName: "asc" } }, { position: "asc" }],
  });
  const online = await connectedAmong([...new Set(rows.map((r) => r.botId))]);
  res.json({
    canUse,
    commands: rows.map((row) => ({ ...serializeCommand(row), bot: publicUser(row.bot, req.userId!), botOnline: online.has(row.botId) })),
  });
});

// --- Running one ---------------------------------------------------------------------------------------------------------------------

export const channelCommandsRouter = Router();

const runSchema = z.object({ options: z.unknown().optional() });

channelCommandsRouter.post("/:id/commands/:commandId", requireAuth, commandLimiter, async (req, res) => {
  const parsed = runSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

  // A stranger cannot tell the channel exists; a voice channel has no messages to answer in.
  const channel = await prisma.channel.findUnique({ where: { protocolId: param(req, "id") }, include: { community: true } });
  const membership = channel
    ? await prisma.communityMember.findUnique({ where: { communityId_userId: { communityId: channel.communityId, userId: req.userId! } } })
    : null;
  if (!channel || !membership) return res.status(404).json({ error: "not_found" });
  if (channel.type !== "TEXT") return res.status(409).json({ error: "not_a_text_channel" });
  // The bot and its commands live on this server, so only a community this server hosts has them.
  if (channel.community.isRemote) return res.status(409).json({ error: "not_community_home" });
  if (!config.botsEnabled) return res.status(404).json({ error: "not_found" });

  const perms = await getMemberPermissions(channel.communityId, req.userId!, channel.community.ownerId);
  if (!hasPermission(perms, Permission.USE_COMMANDS) || !hasPermission(perms, Permission.SEND_MESSAGES)) return res.status(403).json({ error: "forbidden" });

  // The command must exist and belong to a bot that is in THIS community: one answer for every other case, so nothing can be probed.
  const command = await prisma.botCommand.findFirst({
    where: { protocolId: param(req, "commandId"), bot: usableBotsIn(channel.communityId) },
    include: { bot: true },
  });
  if (!command) return res.status(404).json({ error: "not_found" });

  // What was entered is checked against the registered types before the bot is told anything.
  const options = storedOptions(command.options);
  const checked = checkOptions(options, parsed.data.options);
  if (!checked.ok) return res.status(400).json({ error: "invalid_options", option: checked.option });
  const resolved = await resolveReferences(channel.communityId, options, checked.values);
  if (!resolved.ok) return res.status(400).json({ error: "invalid_options", option: resolved.option });

  // A bot nobody is listening for cannot answer: say so now instead of leaving the person to wait.
  if (!(await isConnected(command.botId))) return res.status(409).json({ error: "bot_offline" });
  const pending = await prisma.interaction.count({
    where: { botId: command.botId, state: { in: ["RECEIVED", "DEFERRED"] }, expiresAt: { gt: new Date() } },
  });
  if (pending >= INTERACTION_LIMITS.pendingPerBot) return res.status(429).json({ error: "bot_busy" });

  const now = new Date();
  const interaction = await prisma.interaction.create({
    data: {
      protocolId: newProtocolId(),
      botId: command.botId,
      communityId: channel.communityId,
      channelId: channel.id,
      userId: req.userId!,
      commandId: command.id,
      commandName: command.name,
      options: checked.values as unknown as Prisma.InputJsonValue,
      createdAt: now,
      expiresAt: new Date(now.getTime() + INTERACTION_LIMITS.expiresMs),
    },
  });
  const invoker = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! } });
  // Live only (never the sync log): it is useless after a few seconds, so it is not replayed to a bot that reconnects.
  sendToUser(command.botId, {
    type: "interaction:created",
    interaction: {
      id: interaction.protocolId,
      type: "command",
      command: { id: command.protocolId, name: command.name },
      options: checked.values,
      channelId: channel.protocolId,
      communityId: channel.community.protocolId,
      user: { id: invoker.protocolId, username: invoker.username, displayName: invoker.displayName, avatarUrl: invoker.avatarUrl },
      resolved: resolved.value,
      createdAt: interaction.createdAt.toISOString(),
    },
  });
  res.status(202).json({ interaction: { id: interaction.protocolId } });
});

/** The members and text channels a `member` or `channel` option names, which must be this community's own; they go to the bot beside the options. */
async function resolveReferences(communityId: string, options: ReturnType<typeof storedOptions>, values: OptionValues) {
  const memberIds: string[] = [];
  const channelIds: string[] = [];
  for (const option of options) {
    const value = values[option.name];
    if (typeof value !== "string") continue;
    if (option.type === "member") memberIds.push(value);
    if (option.type === "channel") channelIds.push(value);
  }
  const members = memberIds.length
    ? await prisma.communityMember.findMany({ where: { communityId, user: { protocolId: { in: memberIds } } }, include: { user: true } })
    : [];
  const channels = channelIds.length ? await prisma.channel.findMany({ where: { communityId, type: "TEXT", protocolId: { in: channelIds } } }) : [];
  const resolved = { members: {} as Record<string, unknown>, channels: {} as Record<string, unknown> };
  for (const m of members) resolved.members[m.user.protocolId] = publicUser(m.user);
  for (const c of channels) resolved.channels[c.protocolId] = { id: c.protocolId, name: c.name };
  for (const option of options) {
    const value = values[option.name];
    if (typeof value !== "string") continue;
    if (option.type === "member" && !(value in resolved.members)) return { ok: false as const, option: option.name };
    if (option.type === "channel" && !(value in resolved.channels)) return { ok: false as const, option: option.name };
  }
  return { ok: true as const, value: resolved };
}

// --- The bot answering ---------------------------------------------------------------------------------------------------------------

export const interactionsRouter = Router();

const reply = {
  content: z.string().max(8000).default(""),
  embeds: z.array(richEmbedInputSchema).max(RICH_EMBED_LIMITS.count).optional(),
};
const callbackSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message"), ...reply }),
  z.object({ type: z.literal("ephemeral"), ...reply }),
  z.object({ type: z.literal("deferred"), ephemeral: z.boolean().optional() }),
]);
const followupSchema = z.object(reply);

/** The interaction, if it is one addressed to THIS bot: someone else's is a 404, the same as one that does not exist. */
const loadInteraction = (req: Request) =>
  prisma.interaction.findFirst({
    where: { protocolId: param(req, "id"), botId: req.userId! },
    include: { channel: { include: { community: true } }, user: true, bot: true },
  });
type Loaded = NonNullable<Awaited<ReturnType<typeof loadInteraction>>>;

/** Whether the bot may post a visible reply in the community: it is a member holding SEND_MESSAGES (it is held to what a member is; a bot that left holds nothing). */
async function botMaySpeak(interaction: Loaded): Promise<boolean> {
  const perms = await getMemberPermissions(interaction.communityId, interaction.botId, interaction.channel.community.ownerId);
  return hasPermission(perms, Permission.SEND_MESSAGES);
}

type Prepared = { embeds: RichEmbed[]; sources: { image: string | null; thumbnail: string | null }[] } | null;

/** A reply's text and cards as they will be sent, or the refusal. A reply needs text or a card, as a message does. */
function prepareReply(body: { content: string; embeds?: z.infer<typeof richEmbedInputSchema>[] }): { ok: true; prepared: Prepared } | { ok: false; error: string } {
  if (body.content.length === 0 && (body.embeds?.length ?? 0) === 0) return { ok: false, error: "invalid_request" };
  if (!body.embeds?.length) return { ok: true, prepared: null };
  const result = prepareRichEmbeds(body.embeds);
  return result.ok ? { ok: true, prepared: result } : { ok: false, error: result.error };
}

/** A private reply: shown to the person who ran the command, alone, as a live event. It is never stored, so it is gone on reload. Cards in it carry no pictures. */
function sendPrivate(interaction: Loaded, content: string, prepared: Prepared) {
  sendToUser(interaction.userId, {
    type: "interaction:response",
    interactionId: interaction.protocolId,
    commandName: interaction.commandName,
    bot: botView(interaction.bot),
    channelId: interaction.channel.protocolId,
    content,
    richEmbeds: prepared ? visibleRichEmbeds(prepared.embeds) : [],
    createdAt: new Date().toISOString(),
  });
}

/** A visible reply: an ordinary message from the bot, marked with who ran which command. */
async function sendPublic(interaction: Loaded, content: string, prepared: Prepared) {
  return createChannelMessage({
    channel: interaction.channel,
    senderId: interaction.botId,
    content,
    prepared: prepared ? { ok: true, ...prepared } : null,
    interaction: interactionSnapshot({ id: interaction.protocolId, command: interaction.commandName, userId: interaction.user.protocolId, name: interaction.user.displayName }),
  });
}

interactionsRouter.post("/:id/callback", requireBot, async (req, res) => {
  const interaction = await loadInteraction(req);
  if (!interaction) return res.status(404).json({ error: "not_found" });
  const parsed = callbackSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  const body = parsed.data;

  // The first answer is held to a short window, so "didn't respond", which the person was shown, stays true. (The claim below is what enforces it, and
  // that the interaction has not been answered: checking either here as well would only be a second copy that could drift.)
  const firstAnswerCutoff = new Date(Date.now() - INTERACTION_LIMITS.firstAnswerMs);

  let prepared: Prepared = null;
  if (body.type !== "deferred") {
    const reply = prepareReply(body);
    if (!reply.ok) return res.status(400).json({ error: reply.error });
    prepared = reply.prepared;
    // A refused public reply does not use the interaction up: the bot may still answer privately.
    if (body.type === "message" && !(await botMaySpeak(interaction))) return res.status(403).json({ error: "forbidden" });
  }

  // Claimed in one step, so two answers at once cannot both win, and the window is checked again where it counts.
  const claimed = await prisma.interaction.updateMany({
    where: { id: interaction.id, state: "RECEIVED", createdAt: { gte: firstAnswerCutoff } },
    data: body.type === "deferred" ? { state: "DEFERRED", ephemeral: body.ephemeral === true } : { state: "DONE", answeredAt: new Date() },
  });
  if (claimed.count === 0) {
    const now = await prisma.interaction.findUnique({ where: { id: interaction.id }, select: { state: true } });
    return now?.state === "RECEIVED" ? res.status(410).json({ error: "interaction_expired" }) : res.status(409).json({ error: "already_answered" });
  }

  if (body.type === "deferred") {
    sendToUser(interaction.userId, { type: "interaction:update", interactionId: interaction.protocolId, state: "deferred", commandName: interaction.commandName, bot: botView(interaction.bot), channelId: interaction.channel.protocolId });
    return res.status(204).end();
  }
  if (body.type === "ephemeral") {
    sendPrivate(interaction, body.content, prepared);
    return res.status(204).end();
  }
  const made = await sendPublic(interaction, body.content, prepared);
  res.status(201).json({ message: { id: made.serialized.id } });
  made.afterAnswer();
});

// The answer to a deferred interaction, once, within 15 minutes of the person running the command; as a message or privately, as it was deferred.
interactionsRouter.post("/:id/followup", requireBot, async (req, res) => {
  const interaction = await loadInteraction(req);
  if (!interaction) return res.status(404).json({ error: "not_found" });
  const parsed = followupSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  const body = parsed.data;

  if (interaction.expiresAt.getTime() <= Date.now()) return res.status(410).json({ error: "interaction_expired" });
  if (interaction.state === "RECEIVED") return res.status(409).json({ error: "not_deferred" });

  const reply = prepareReply(body);
  if (!reply.ok) return res.status(400).json({ error: reply.error });
  if (!interaction.ephemeral && !(await botMaySpeak(interaction))) return res.status(403).json({ error: "forbidden" });

  const claimed = await prisma.interaction.updateMany({
    where: { id: interaction.id, state: "DEFERRED" },
    data: { state: "DONE", answeredAt: new Date() },
  });
  if (claimed.count === 0) return res.status(409).json({ error: "already_answered" });

  if (interaction.ephemeral) {
    sendPrivate(interaction, body.content, reply.prepared);
    return res.status(204).end();
  }
  const made = await sendPublic(interaction, body.content, reply.prepared);
  res.status(201).json({ message: { id: made.serialized.id } });
  made.afterAnswer();
});
