import type { Prisma } from "@prisma/client";
import { prisma } from "../../db.js";
import { newProtocolId } from "../../lib/ids.js";
import { sendToUser } from "../../ws/gateway.js";

/**
 * Appends an event to each recipient's sync outbox and pushes it live to any
 * open WebSocket connections they have. A client that was offline sees the
 * same event later via GET /api/v1/sync?cursor=... — this is the one place
 * "did this user see it yet" is decided, so online delivery and offline
 * catch-up can never drift apart.
 */
export async function emitSyncEvent(
  recipientIds: string[],
  type: string,
  payload: Record<string, unknown>
) {
  const uniqueRecipients = [...new Set(recipientIds)];
  if (uniqueRecipients.length === 0) return;

  await prisma.$transaction(
    uniqueRecipients.map((recipientId) =>
      prisma.syncEvent.create({
        data: {
          protocolId: newProtocolId(),
          recipientId,
          type,
          payload: payload as Prisma.InputJsonValue,
        },
      })
    )
  );

  for (const recipientId of uniqueRecipients) {
    sendToUser(recipientId, { type, ...payload });
  }
}
