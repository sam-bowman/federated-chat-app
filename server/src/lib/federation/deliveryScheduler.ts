// Runs the "try to deliver this right now" attempt for freshly queued federation events in the background,
// so the request that queued them does not wait for it (see outbox.ts's enqueueFederationEvent). Split out
// of outbox.ts, which imports config.js and the database, so the scheduling rules can be unit-tested alone.
//
// Three rules:
//  - Attempts to the SAME domain run one after another, in the order they were scheduled, so a message and
//    its edit reach a peer in order even when the edit is queued milliseconds after the message.
//  - Attempts to DIFFERENT domains run at the same time: one slow or dead peer never delays another.
//  - After a failed attempt to a domain, further immediate attempts to it are skipped for a cooldown. The
//    events stay queued for the outbox worker's backoff; without this, a dead peer would pile up one slow
//    attempt per message and fall further behind for as long as it stays down.

export class DeliveryScheduler {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly failedAt = new Map<string, number>();

  constructor(
    private readonly cooldownMs: number,
    private readonly now: () => number = Date.now
  ) {}

  /**
   * Runs `task` once every task already scheduled for `domain` has finished. A task that throws is passed to
   * `onError` and never stops the ones behind it.
   */
  schedule(domain: string, task: () => Promise<void>, onError: (err: unknown) => void): void {
    const previous = this.tails.get(domain) ?? Promise.resolve();
    const run: Promise<void> = previous
      .then(task)
      .catch(onError)
      .then(() => {
        this.inFlight.delete(run);
        if (this.tails.get(domain) === run) this.tails.delete(domain);
      });
    this.tails.set(domain, run);
    this.inFlight.add(run);
  }

  recordFailure(domain: string): void {
    this.failedAt.set(domain, this.now());
  }

  recordSuccess(domain: string): void {
    this.failedAt.delete(domain);
  }

  /** True while the last attempt to `domain` failed less than `cooldownMs` ago. */
  inCooldown(domain: string): boolean {
    const at = this.failedAt.get(domain);
    return at !== undefined && this.now() - at < this.cooldownMs;
  }

  /** Resolves once every attempt scheduled so far, and any scheduled meanwhile, has finished. */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  /** Forgets what it knows about failures (tests; nothing in production needs to). */
  forgetFailures(): void {
    this.failedAt.clear();
  }
}
