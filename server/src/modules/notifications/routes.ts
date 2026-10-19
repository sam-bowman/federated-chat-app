import { Router } from "express";
import { prisma } from "../../db.js";
import { requireAuth } from "../../middleware/auth.js";
import {
  MAX_SETTINGS_PER_USER,
  applyChange,
  serializeSetting,
  settingChangeSchema,
} from "../../lib/notificationSettings.js";
import { emitSyncEvent } from "../sync/events.js";

/**
 * What the signed-in person wants to hear and see when a message arrives, for everything and for one community, channel or
 * conversation (lib/notificationSettings.ts). It is kept here, per account, so a choice follows them to every device; WHETHER to
 * alert for a given message is decided by the client when the message arrives (it alone knows what is open and focused).
 */
export const notificationSettingsRouter = Router();

async function listFor(userId: string) {
  const rows = await prisma.notificationSetting.findMany({ where: { userId }, orderBy: { updatedAt: "asc" } });
  return rows.map(serializeSetting);
}

notificationSettingsRouter.get("/", requireAuth, async (req, res) => {
  res.json({ settings: await listFor(req.userId!) });
});

notificationSettingsRouter.put("/", requireAuth, async (req, res) => {
  const parsed = settingChangeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  const { type, id, sound, notify } = parsed.data;
  const key = { userId: req.userId!, targetType: type, targetId: id ?? "" };

  const existing = await prisma.notificationSetting.findUnique({ where: { userId_targetType_targetId: key } });
  const next = applyChange(existing, { sound, notify });

  if (next.empty) {
    // Nothing left to remember: forget the row, so "use the default" costs nothing.
    if (existing) await prisma.notificationSetting.delete({ where: { id: existing.id } });
  } else {
    if (!existing && (await prisma.notificationSetting.count({ where: { userId: req.userId! } })) >= MAX_SETTINGS_PER_USER) {
      return res.status(409).json({ error: "too_many_settings" });
    }
    await prisma.notificationSetting.upsert({
      where: { userId_targetType_targetId: key },
      create: { ...key, sound: next.sound, notify: next.notify },
      update: { sound: next.sound, notify: next.notify },
    });
  }

  const setting = serializeSetting({ targetType: type, targetId: key.targetId, sound: next.sound, notify: next.notify });
  // The person's other devices (and this one's other tabs) take the change as it is made.
  await emitSyncEvent([req.userId!], "notification-settings:updated", { setting });
  res.json({ setting, settings: await listFor(req.userId!) });
});
