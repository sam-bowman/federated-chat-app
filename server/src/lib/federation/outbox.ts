import type { FederationOutboxEvent, Prisma } from "@prisma/client";
import { prisma } from "../../db.js";
import { federationFetch, setOnDeliverySuccess } from "./client.js";
import { backoffMs } from "./outboxBackoff.js";

// Registered as a module-load side effect (not inside a function some
// caller has to remember to invoke) so it's active as soon as anything
// imports this module - see client.ts's own comment on why this is a
// callback registration rather than a direct import in that direction.
setOnDeliverySuccess((domain) => {
  flushOutboxForDomain(domain).catch((err) =>
    console.error(`[federation] outbox flush for ${domain} failed:`, err)
  );
});

// Exponential backoff, capped at 1 hour, giving up (status: FAILED, no
// longer auto-retried) after this many attempts - roughly a day of
// retrying a genuinely-down peer before treating it as gone. A future
// admin UI (see ROADMAP.md) is the natural place to surface/retry FAILED
// rows by hand; nothing does that yet, so they just sit there inertly.
const BASE_DELAY_MS = 30 * 1000;
const MAX_DELAY_MS = 60 * 60 * 1000;
const MAX_ATTEMPTS = 20;

// A claim (status flipped to IN_PROGRESS) older than this is assumed
// abandoned - its owning process crashed or was killed mid-delivery -
// and is eligible to be reclaimed by any worker, including this same
// process's next tick.
const STALE_CLAIM_MS = 2 * 60 * 1000;

/**
 * Durably queues an outbound federation event, then makes one immediate
 * delivery attempt - the common case (peer is up) still delivers
 * synchronously within the request that triggered it, exactly like a bare
 * federationFetch() call used to. The difference is only when that
 * attempt fails: the event is already safely recorded, for the
 * background worker (startFederationOutboxWorker) or a future successful
 * call to the same domain (federationFetch's own post-success flush - see
 * client.ts) to pick up later, instead of just being logged and lost.
 *
 * Never throws - a federation delivery failure was always meant to be
 * best-effort from the caller's point of view (the caller's own local DB
 * change already committed), so there's nothing for a caller to catch
 * here that wasn't already true before the outbox existed.
 */
export async function enqueueFederationEvent(
  domain: string,
  path: string,
  body: unknown
): Promise<void> {
  const row = await prisma.federationOutboxEvent.create({
    data: { domain, path, body: (body ?? {}) as Prisma.InputJsonValue },
  });
  await attemptDelivery(row);
}

/**
 * Claims and attempts one outbox row. Safe to call concurrently (from
 * this process's own worker tick and a fresh request-triggered flush at
 * the same time, or from another replica entirely) - the claim is a
 * single conditional UPDATE, so at most one caller ever proceeds past it
 * for a given row.
 */
async function attemptDelivery(row: FederationOutboxEvent): Promise<void> {
  const claimed = await prisma.federationOutboxEvent.updateMany({
    where: {
      id: row.id,
      OR: [
        { status: "PENDING" },
        // Reclaim a stale IN_PROGRESS row (its original claimer crashed
        // mid-delivery) - without this branch, a row that reached here via
        // dueRowsWhere()'s stale-IN_PROGRESS clause could never actually be
        // claimed, since its status is IN_PROGRESS, not PENDING.
        { status: "IN_PROGRESS", claimedAt: { lte: new Date(Date.now() - STALE_CLAIM_MS) } },
      ],
    },
    data: { status: "IN_PROGRESS", claimedAt: new Date() },
  });
  if (claimed.count === 0) return; // another worker already has it

  try {
    const res = await federationFetch(row.domain, row.path, {
      body: row.body as Record<string, unknown>,
      // Retries driven by the outbox must not re-trigger federationFetch's
      // own "flush this domain's outbox" hook on success - see client.ts.
      // Each flush already processes every row that was due when it
      // started; a retry re-triggering another whole flush pass converges
      // harmlessly (the claim above makes it safe either way) but is
      // pure waste, so it's switched off here specifically.
      skipOutboxFlush: true,
    });
    if (res.ok) {
      await prisma.federationOutboxEvent.delete({ where: { id: row.id } });
      return;
    }
    // A non-ok response that federationFetch still returned (rather than
    // throwing) is a 4xx - the peer received and rejected the request.
    // Retrying the exact same body won't change that, so this is terminal,
    // not a transient failure to back off and retry.
    await prisma.federationOutboxEvent.update({
      where: { id: row.id },
      data: { status: "FAILED", lastError: `http_${res.status}` },
    });
  } catch (err) {
    const attempts = row.attempts + 1;
    const message = err instanceof Error ? err.message : String(err);
    await prisma.federationOutboxEvent.update({
      where: { id: row.id },
      data:
        attempts >= MAX_ATTEMPTS
          ? { status: "FAILED", attempts, lastError: message }
          : {
              status: "PENDING",
              attempts,
              nextAttemptAt: new Date(Date.now() + backoffMs(attempts, BASE_DELAY_MS, MAX_DELAY_MS)),
              lastError: message,
            },
    });
  }
}

function staleInProgressWhere(domain?: string): Prisma.FederationOutboxEventWhereInput {
  return { domain, status: "IN_PROGRESS", claimedAt: { lte: new Date(Date.now() - STALE_CLAIM_MS) } };
}

/**
 * Attempts every row still queued for one domain, oldest first, ignoring
 * nextAttemptAt entirely - called (fire-and-forget, never awaited) right
 * after federationFetch() succeeds against that domain. The whole point is
 * to flush the backlog *promptly* on fresh evidence the peer is reachable
 * again, not to re-check the same due-by-timer condition the background
 * worker already covers - a row backed off for another 55 minutes would
 * otherwise never actually benefit from this, defeating it. Sequential on
 * purpose: bursts of retries against a peer that was *just* flaky are
 * exactly the wrong time to hammer it with concurrent requests.
 */
export async function flushOutboxForDomain(domain: string): Promise<void> {
  const rows = await prisma.federationOutboxEvent.findMany({
    where: { OR: [{ domain, status: "PENDING" }, staleInProgressWhere(domain)] },
    orderBy: { createdAt: "asc" },
  });
  for (const row of rows) {
    await attemptDelivery(row);
  }
}

/** Attempts every currently-due (by nextAttemptAt) row across all domains - see startFederationOutboxWorker(). */
async function processDueOutboxEvents(): Promise<void> {
  const rows = await prisma.federationOutboxEvent.findMany({
    where: {
      OR: [{ status: "PENDING", nextAttemptAt: { lte: new Date() } }, staleInProgressWhere()],
    },
    orderBy: { createdAt: "asc" },
  });
  for (const row of rows) {
    await attemptDelivery(row);
  }
}

const WORKER_INTERVAL_MS = 30 * 1000;

/**
 * Background safety net for events that never get an opportunistic flush
 * (flushOutboxForDomain above) because nothing else happens to succeed
 * against that domain in the meantime. Every replica runs this
 * independently and safely - see attemptDelivery's claim.
 */
export function startFederationOutboxWorker(): () => void {
  const interval = setInterval(() => {
    processDueOutboxEvents().catch((err) => console.error("[federation] outbox worker tick failed:", err));
  }, WORKER_INTERVAL_MS);
  return () => clearInterval(interval);
}
