import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { requireAuth } from "../../middleware/auth.js";

export const syncRouter = Router();

// Both come from the address, so both are checked: a cursor that is not a whole number used to reach BigInt() and a limit that is not one
// reached the database, and either answered 500 (found by the dynamic scan, #250). The limit is cut to 500 as before; the cursor is a
// sequence number, so it has to fit the 64-bit column.
const syncQuery = z.object({
  cursor: z.string().regex(/^\d{1,18}$/).optional(),
  limit: z.coerce.number().int().min(1).default(100).transform((n) => Math.min(n, 500)),
});

// Resumable sync: GET /api/v1/sync?cursor=<seq>&limit=100
// Returns events strictly after `cursor` (by local sequence) for the
// authenticated user, plus the cursor to use on the next call. Omitting
// `cursor` returns the most recent window and a cursor to pick up from.
syncRouter.get("/", requireAuth, async (req, res) => {
  const parsed = syncQuery.safeParse({ cursor: req.query.cursor || undefined, limit: req.query.limit });
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  const { limit } = parsed.data;
  const cursor = parsed.data.cursor === undefined ? null : BigInt(parsed.data.cursor);

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
