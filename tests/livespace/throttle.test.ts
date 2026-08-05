import { describe, expect, test } from "bun:test";
import { createThrottle } from "../../src/livespace/throttle.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("createThrottle", () => {
  test("never runs more than maxConcurrent tasks at once", async () => {
    const withSlot = createThrottle({ maxConcurrent: 2, minIntervalMs: 0 });
    let active = 0;
    let peak = 0;
    const gates = [deferred(), deferred(), deferred(), deferred()];

    const runs = gates.map((gate) =>
      withSlot(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await gate.promise;
        active -= 1;
      }),
    );

    await Promise.resolve();
    expect(peak).toBeLessThanOrEqual(2);
    for (const gate of gates) gate.resolve();
    await Promise.all(runs);
    expect(peak).toBe(2);
  });

  test("sleeps to keep minIntervalMs between task starts", async () => {
    const sleeps: number[] = [];
    const withSlot = createThrottle({
      maxConcurrent: 1,
      minIntervalMs: 150,
      now: () => 1_000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await withSlot(async () => {});
    await withSlot(async () => {});

    expect(sleeps).toEqual([150]);
  });

  test("propagates results and errors and frees the slot afterwards", async () => {
    const withSlot = createThrottle({ maxConcurrent: 1, minIntervalMs: 0 });
    await expect(withSlot(async () => "ok")).resolves.toBe("ok");
    await expect(
      withSlot(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(withSlot(async () => "still works")).resolves.toBe("still works");
  });

  test("abort while queued rejects and releases no slot", async () => {
    const withSlot = createThrottle({ maxConcurrent: 1, minIntervalMs: 0 });
    let releaseFirst!: () => void;
    const first = withSlot(
      () => new Promise<void>((resolve) => (releaseFirst = resolve)),
    );
    const controller = new AbortController();
    const queued = withSlot(async () => "ran", controller.signal);
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    releaseFirst();
    await first;
    // The slot freed by `first` must still admit new work.
    await expect(withSlot(async () => "next")).resolves.toBe("next");
  });

  test("pre-aborted signal rejects before taking a slot", async () => {
    const withSlot = createThrottle({ maxConcurrent: 1, minIntervalMs: 0 });
    const controller = new AbortController();
    controller.abort();
    await expect(
      withSlot(async () => "never", controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
