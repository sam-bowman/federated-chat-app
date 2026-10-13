import { Router } from "express";
import { prisma } from "../../db.js";
import { requireAuth } from "../../middleware/auth.js";

export const syncRouter = Router();

// Resumable sync: GET /api/v1/sync?cursor=<seq>&limit=100
// Returns events strictly after `cursor` (by local sequence) for the
// authenticated user, plus the cursor to use on the next call. Omitting
// `cursor` returns the most recent window and a cursor to pick up from.
syncRouter.get("/", requireAuth, async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 100), 500);
  const cursorParam = req.query.cursor as string | undefined;
  const cursor = cursorParam ? BigInt(cursorParam) : null;

  const events = await prisma.syncEvent.findMany({
    where: {
      recipientId: req.userId!,
      ...(cursor !== null ? { seq: { gt: cursor } } : {}),
    },
    orderBy: { seq: "asc" },
    take: limit,
  });

  const nextCursor = events.length > 0 ? events[events.length - 1].seq.toString() : (cursor?.toString() ?? "0");

  res.json({
    events: events.map((e) => ({
      id: e.protocolId,
      type: e.type,
      payload: e.payload,
      createdAt: e.createdAt,
    })),
    nextCursor,
    hasMore: events.length === limit,
  });
});
