import type { FederationOutboxEvent, Prisma } from "@prisma/client";
import { prisma } from "../../db.js";
import { config } from "../../config.js";
import { federationFetch, setOnDeliverySuccess } from "./client.js";
import { DeliveryScheduler } from "./deliveryScheduler.js";
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
// admin UI (tracked in GitHub issues) is the natural place to surface/retry FAILED
// rows by hand; nothing does that yet, so they just sit there inertly.
const BASE_DELAY_MS = 30 * 1000;
const MAX_DELAY_MS = 60 * 60 * 1000;
const MAX_ATTEMPTS = 20;

// A claim (status flipped to IN_PROGRESS) older than this is assumed
// abandoned - its owning process crashed or was killed mid-delivery -
// and is eligible to be reclaimed by any worker, including this same
// process's next tick.
const STALE_CLAIM_MS = 2 * 60 * 1000;

// After a failed immediate attempt to a domain, skip further immediate attempts to it for this long and
// leave its events to the worker's backoff (see DeliveryScheduler for why).
const IMMEDIATE_ATTEMPT_COOLDOWN_MS = 5 * 1000;

const scheduler = new DeliveryScheduler(IMMEDIATE_ATTEMPT_COOLDOWN_MS);

/**
 * Durably queues an outbound federation event and returns; the immediate
 * delivery attempt happens in the BACKGROUND. The caller's request used to
 * wait for that attempt, which for a peer that is down meant waiting out its
 * whole retry cycle (1.5 s with a refused connection, far longer if the peer
 * just never answers) before the sender got their response, once per such
 * domain, in a row. The event is already safely recorded by the time this
 * returns, so nothing is lost if the attempt fails, the process dies, or the
 * peer is down: the background worker (startFederationOutboxWorker) or a
 * future successful call to the same domain (federationFetch's own
 * post-success flush - see client.ts) picks it up with backoff.
 *
 * The common case (peer is up) still delivers within milliseconds. Attempts
 * to one domain run one at a time in queued order (a message and its edit
 * must arrive in that order); different domains run side by side.
 *
 * Never throws for a delivery problem - that was always best-effort from the
 * caller's point of view (its own local DB change already committed). It does
 * reject if the event cannot be recorded, since that one is not best-effort.
 */
export async function enqueueFederationEvent(
  domain: string,
  path: string,
  body: unknown
): Promise<void> {
  const row = await prisma.federationOutboxEvent.create({
    data: { domain, path, body: (body ?? {}) as Prisma.InputJsonValue },
  });
  scheduler.schedule(
    domain,
    async () => {
      // The domain just failed: don't spend another slow attempt on it. The row stays PENDING for the worker.
      if (scheduler.inCooldown(domain)) return;
      await attemptDelivery(row);
    },
    (err) => console.error(`[federation] immediate delivery to ${domain} failed unexpectedly:`, err)
  );
}

/**
 * Resolves once every immediate delivery attempt started so far has finished. For tests, which need to see
 * what a peer received after the request that caused it has returned, and for anything that wants a clean
 * stop. Nothing in the request path waits for this.
 */
export function waitForPendingDeliveries(): Promise<void> {
  return scheduler.idle();
}

/** Test-only: forget which domains recently failed, so one test's dead peer doesn't suppress the next test's attempt. */
export function resetFederationOutboxStateForTests(): void {
  scheduler.forgetFailures();
}

/** What one attempt came to: sent, refused by the peer for good, failed and queued for a retry, or not ours to try. */
type Outcome = "delivered" | "rejected" | "retry" | "skipped";

/**
 * Claims and attempts one outbox row. Safe to call concurrently (from
 * this process's own worker tick and a fresh request-triggered flush at
 * the same time, or from another replica entirely) - the claim is a
 * single conditional UPDATE, so at most one caller ever proceeds past it
 * for a given row.
 */
async function attemptDelivery(row: FederationOutboxEvent): Promise<Outcome> {
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
  if (claimed.count === 0) return "skipped"; // another worker already has it

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
      // A peer that takes the connection and then says nothing must not hold this attempt open for as
      // long as the operating system allows.
      timeoutMs: config.federationOutboxTimeoutMs,
    });
    scheduler.recordSuccess(row.domain);
    if (res.ok) {
      await prisma.federationOutboxEvent.delete({ where: { id: row.id } });
      return "delivered";
    }
    // A non-ok response that federationFetch still returned (rather than
    // throwing) is a 4xx - the peer received and rejected the request.
    // Retrying the exact same body won't change that, so this is terminal,
    // not a transient failure to back off and retry.
    await prisma.federationOutboxEvent.update({
      where: { id: row.id },
      data: { status: "FAILED", lastError: `http_${res.status}` },
    });
    return "rejected";
  } catch (err) {
    scheduler.recordFailure(row.domain);
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
    return "retry";
  }
}

/**
 * Attempts the rows in order, stopping at the first one that has to be retried: if the oldest event for a
 * peer could not be delivered, sending the newer ones past it would put them out of order, and trying each
 * in turn against a peer that just failed only multiplies the waiting.
 */
async function attemptInOrder(rows: FederationOutboxEvent[]): Promise<void> {
  for (const row of rows) {
    if ((await attemptDelivery(row)) === "retry") return;
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
  await attemptInOrder(rows);
}

/**
 * One worker pass. A domain is attempted only when its OLDEST unfinished event is due (or its claim has gone
 * stale), and then in order: if the oldest is still backing off - or another attempt is mid-delivery on it -
 * the newer ones wait, even if their own timers have passed, because delivering them first would put them
 * ahead of an older event the peer has not seen (a message and its edit, say). Domains are independent of
 * each other, so a dead peer never delays a healthy one. Exported for tests; the worker is the only caller.
 */
export async function processDueOutboxEvents(): Promise<void> {
  const rows = await prisma.federationOutboxEvent.findMany({
    where: { status: { in: ["PENDING", "IN_PROGRESS"] } },
    orderBy: { createdAt: "asc" },
    take: 5000,
  });
  const now = Date.now();
  const staleBefore = now - STALE_CLAIM_MS;
  const byDomain = new Map<string, FederationOutboxEvent[]>();
  for (const row of rows) byDomain.set(row.domain, [...(byDomain.get(row.domain) ?? []), row]);

  const ready: FederationOutboxEvent[][] = [];
  for (const queue of byDomain.values()) {
    const oldest = queue[0];
    const due =
      oldest.status === "PENDING"
        ? oldest.nextAttemptAt.getTime() <= now
        : oldest.claimedAt !== null && oldest.claimedAt.getTime() <= staleBefore;
    // Rows another worker is attempting right now are not ours to start; the ones after them wait too.
    if (due) ready.push(queue.filter((r) => r.status === "PENDING" || (r.claimedAt !== null && r.claimedAt.getTime() <= staleBefore)));
  }
  await Promise.allSettled(ready.map(attemptInOrder));
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
