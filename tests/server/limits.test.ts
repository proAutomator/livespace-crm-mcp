import { describe, expect, test } from "bun:test";
import { createRequestLimiter } from "../../src/server/limits.js";

function fixedClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("createRequestLimiter", () => {
  test("burst tokens admit, exhaustion rejects with a retry hint", async () => {
    const clock = fixedClock();
    const limiter = createRequestLimiter({
      ratePerMinute: 60,
      burst: 2,
      maxConcurrent: 10,
      maxQueue: 10,
      now: clock.now,
    });

    const a = await limiter.admit("bearer:aa");
    const b = await limiter.admit("bearer:aa");
    expect(a.admitted).toBe(true);
    expect(b.admitted).toBe(true);
    const c = await limiter.admit("bearer:aa");
    expect(c.admitted).toBe(false);
    if (!c.admitted) expect(c.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  test("tokens refill over time", async () => {
    const clock = fixedClock();
    const limiter = createRequestLimiter({
      ratePerMinute: 60,
      burst: 1,
      maxConcurrent: 10,
      maxQueue: 10,
      now: clock.now,
    });

    expect((await limiter.admit("p")).admitted).toBe(true);
    expect((await limiter.admit("p")).admitted).toBe(false);
    clock.advance(1000); // 60/min = 1 token per second
    expect((await limiter.admit("p")).admitted).toBe(true);
  });

  test("principals have independent buckets", async () => {
    const clock = fixedClock();
    const limiter = createRequestLimiter({
      ratePerMinute: 60,
      burst: 1,
      maxConcurrent: 10,
      maxQueue: 10,
      now: clock.now,
    });

    expect((await limiter.admit("bearer:aa")).admitted).toBe(true);
    expect((await limiter.admit("bearer:aa")).admitted).toBe(false);
    expect((await limiter.admit("bearer:bb")).admitted).toBe(true);
  });

  test("concurrency cap queues and release hands the slot over", async () => {
    const clock = fixedClock();
    const limiter = createRequestLimiter({
      ratePerMinute: 6000,
      burst: 100,
      maxConcurrent: 1,
      maxQueue: 5,
      now: clock.now,
    });

    const first = await limiter.admit("p");
    expect(first.admitted).toBe(true);
    let settled = false;
    const queued = limiter.admit("p").then((admission) => {
      settled = true;
      return admission;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    if (first.admitted) first.release();
    const second = await queued;
    expect(second.admitted).toBe(true);
    if (second.admitted) second.release();
  });

  test("full queue rejects immediately", async () => {
    const clock = fixedClock();
    const limiter = createRequestLimiter({
      ratePerMinute: 6000,
      burst: 100,
      maxConcurrent: 1,
      maxQueue: 1,
      now: clock.now,
    });

    const holder = await limiter.admit("p");
    expect(holder.admitted).toBe(true);
    void limiter.admit("p"); // occupies the single queue slot
    const overflow = await limiter.admit("p");
    expect(overflow.admitted).toBe(false);
    if (!overflow.admitted) expect(overflow.retryAfterSeconds).toBe(1);
  });

  test("an aborted waiter leaves the bounded queue immediately", async () => {
    const clock = fixedClock();
    const limiter = createRequestLimiter({
      ratePerMinute: 6000,
      burst: 100,
      maxConcurrent: 1,
      maxQueue: 1,
      now: clock.now,
    });

    const holder = await limiter.admit("p");
    expect(holder.admitted).toBe(true);
    const controller = new AbortController();
    const reason = new DOMException("synthetic client disconnected", "AbortError");
    const queued = limiter.admit("p", controller.signal);
    controller.abort(reason);
    const outcome = await Promise.race([
      queued.then(
        () => "resolved" as const,
        (error: unknown) => error,
      ),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 100)),
    ]);

    if (outcome === "hung") {
      if (holder.admitted) holder.release();
      const stale = await queued;
      if (stale.admitted) stale.release();
    }
    expect(outcome).toBe(reason);

    const replacement = limiter.admit("p");
    if (holder.admitted) holder.release();
    const next = await replacement;
    expect(next.admitted).toBe(true);
    if (next.admitted) next.release();
  });
});
