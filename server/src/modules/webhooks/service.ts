import { prisma } from "../../db.js";

/**
 * Removes the synthetic senders of webhooks that are gone AND left no message behind. Deleting a webhook keeps its messages under its
 * name, so its sender stays while any message names it; once the messages are gone too (the channel or community was deleted, or the
 * webhook never posted) nothing needs the row. Best effort: it runs after the thing that made it possible has already happened, so a
 * failure is logged and never fails the request.
 */
export async function pruneRetiredWebhookSenders(): Promise<void> {
  try {
    await prisma.user.deleteMany({ where: { isWebhook: true, webhookSender: null, messages: { none: {} } } });
  } catch (err) {
    console.error("[webhook] could not remove retired webhook senders:", err);
  }
}
