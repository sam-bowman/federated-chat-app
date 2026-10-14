import { describe, expect, it } from "vitest";
import { DeliveryScheduler } from "./deliveryScheduler.js";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const noErrors = (err: unknown) => {
  throw err;
};

describe("DeliveryScheduler ordering", () => {
  it("runs tasks for one domain strictly in the order they were scheduled, even when an earlier one is slower", async () => {
    const scheduler = new DeliveryScheduler(1000);
    const finished: string[] = [];
    scheduler.schedule("a.test", async () => { await delay(40); finished.push("first"); }, noErrors);
    scheduler.schedule("a.test", async () => { await delay(1); finished.push("second"); }, noErrors);
    scheduler.schedule("a.test", async () => { finished.push("third"); }, noErrors);

    await scheduler.idle();

    expect(finished).toEqual(["first", "second", "third"]);
  });

  it("does not let one domain hold up another", async () => {
    const scheduler = new DeliveryScheduler(1000);
    const finished: string[] = [];
    scheduler.schedule("slow.test", async () => { await delay(60); finished.push("slow"); }, noErrors);
    scheduler.schedule("fast.test", async () => { finished.push("fast"); }, noErrors);

    await scheduler.idle();

    expect(finished).toEqual(["fast", "slow"]);
  });

  it("keeps going after a task fails, reporting the error and still running what is queued behind it", async () => {
    const scheduler = new DeliveryScheduler(1000);
    const errors: unknown[] = [];
    const ran: string[] = [];
    scheduler.schedule("a.test", async () => { throw new Error("boom"); }, (e) => errors.push(e));
    scheduler.schedule("a.test", async () => { ran.push("after"); }, (e) => errors.push(e));

    await scheduler.idle();

    expect(ran).toEqual(["after"]);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("boom");
  });

  it("returns from schedule() at once, before the task has run", () => {
    const scheduler = new DeliveryScheduler(1000);
    let ran = false;
    scheduler.schedule("a.test", async () => { await delay(20); ran = true; }, noErrors);
    expect(ran).toBe(false);
    return scheduler.idle().then(() => expect(ran).toBe(true));
  });

  it("idle() also waits for work scheduled while it was waiting, and resolves at once when there is none", async () => {
    const scheduler = new DeliveryScheduler(1000);
    await scheduler.idle();
    const finished: string[] = [];
    scheduler.schedule("a.test", async () => {
      await delay(10);
      scheduler.schedule("b.test", async () => { await delay(10); finished.push("chained"); }, noErrors);
      finished.push("outer");
    }, noErrors);

    await scheduler.idle();

    expect(finished).toEqual(["outer", "chained"]);
  });
});

describe("DeliveryScheduler failure cooldown", () => {
  it("skips a domain for the cooldown after a failure, then allows it again", () => {
    let clock = 1_000;
    const scheduler = new DeliveryScheduler(5_000, () => clock);
    expect(scheduler.inCooldown("a.test")).toBe(false);

    scheduler.recordFailure("a.test");
    expect(scheduler.inCooldown("a.test")).toBe(true);
    clock += 4_999;
    expect(scheduler.inCooldown("a.test")).toBe(true);
    clock += 1;
    expect(scheduler.inCooldown("a.test")).toBe(false);
  });

  it("tracks each domain on its own, and a success ends the cooldown early", () => {
    const scheduler = new DeliveryScheduler(5_000, () => 0);
    scheduler.recordFailure("a.test");
    expect(scheduler.inCooldown("b.test")).toBe(false);

    scheduler.recordSuccess("a.test");
    expect(scheduler.inCooldown("a.test")).toBe(false);
  });

  it("forgetFailures() clears every cooldown", () => {
    const scheduler = new DeliveryScheduler(5_000, () => 0);
    scheduler.recordFailure("a.test");
    scheduler.recordFailure("b.test");
    scheduler.forgetFailures();
    expect(scheduler.inCooldown("a.test") || scheduler.inCooldown("b.test")).toBe(false);
  });
});
