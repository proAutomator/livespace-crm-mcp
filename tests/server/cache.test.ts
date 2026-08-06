import { describe, expect, test } from "bun:test";
import { createTtlCache, type TtlCacheOptions } from "../../src/server/cache.js";

function fixedClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Keep the shared promise "handled" so a caller that walks away from it
  // does not surface as an unhandled rejection.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

function makeCache(
  clock: { now: () => number },
  overrides: Partial<TtlCacheOptions> = {},
) {
  return createTtlCache({
    ttlMs: 1000,
    staleMaxMs: 5000,
    failureCooldownMs: 200,
    jitter: () => 0.5,
    now: clock.now,
    ...overrides,
  });
}

const neverResolves = new Promise<string>(() => {});

describe("createTtlCache", () => {
  test("serves a cached value inside the ttl and refetches after expiry", async () => {
    const clock = fixedClock();
    const cache = makeCache(clock);
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return `v${calls}`;
    };

    expect(await cache.get("k", fetcher)).toEqual({
      value: "v1",
      asOf: 0,
      stale: false,
    });

    clock.advance(999);
    expect(await cache.get("k", fetcher)).toEqual({
      value: "v1",
      asOf: 0,
      stale: false,
    });
    expect(calls).toBe(1);

    clock.advance(2);
    expect(await cache.get("k", fetcher)).toEqual({
      value: "v2",
      asOf: 1001,
      stale: false,
    });
    expect(calls).toBe(2);
  });

  test("jitter scales the expiry window at both edges", async () => {
    const high = fixedClock();
    const highCache = makeCache(high, { jitter: () => 1 });
    let highCalls = 0;
    const highFetch = async () => {
      highCalls += 1;
      return "v";
    };
    await highCache.get("k", highFetch);
    high.advance(1050);
    await highCache.get("k", highFetch);
    expect(highCalls).toBe(1);

    const low = fixedClock();
    const lowCache = makeCache(low, { jitter: () => 0 });
    let lowCalls = 0;
    const lowFetch = async () => {
      lowCalls += 1;
      return "v";
    };
    await lowCache.get("k", lowFetch);
    low.advance(901);
    await lowCache.get("k", lowFetch);
    expect(lowCalls).toBe(2);
  });

  test("concurrent gets share one fetch per key", async () => {
    const clock = fixedClock();
    const cache = makeCache(clock);
    const shared = deferred<string>();
    let calls = 0;
    const fetcher = () => {
      calls += 1;
      return shared.promise;
    };

    const first = cache.get("k", fetcher);
    const second = cache.get("k", fetcher);
    shared.resolve("v");
    expect(await first).toEqual({ value: "v", asOf: 0, stale: false });
    expect(await second).toEqual({ value: "v", asOf: 0, stale: false });
    expect(calls).toBe(1);

    let aCalls = 0;
    let bCalls = 0;
    void cache.get("a", () => {
      aCalls += 1;
      return neverResolves;
    });
    void cache.get("a", () => {
      aCalls += 1;
      return neverResolves;
    });
    void cache.get("b", () => {
      bCalls += 1;
      return neverResolves;
    });
    await flush();
    expect(aCalls).toBe(1);
    expect(bCalls).toBe(1);
  });

  test("keys are independent and invalidate drops only its own key", async () => {
    const clock = fixedClock();
    const cache = makeCache(clock);
    let aCalls = 0;
    let bCalls = 0;
    const fetchA = async () => {
      aCalls += 1;
      return `va${aCalls}`;
    };
    const fetchB = async () => {
      bCalls += 1;
      return `vb${bCalls}`;
    };

    expect((await cache.get("a", fetchA)).value).toBe("va1");
    expect((await cache.get("b", fetchB)).value).toBe("vb1");

    clock.advance(100);
    cache.invalidate("a");

    expect(await cache.get("a", fetchA)).toEqual({
      value: "va2",
      asOf: 100,
      stale: false,
    });
    expect(await cache.get("b", fetchB)).toEqual({
      value: "vb1",
      asOf: 0,
      stale: false,
    });
    expect(bCalls).toBe(1);
  });

  test("stale-if-error serves the previous value inside staleMaxMs", async () => {
    const clock = fixedClock();
    const cache = makeCache(clock);
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      if (calls > 1) throw new Error("synthetic upstream failure");
      return "v1";
    };

    await cache.get("k", fetcher);
    clock.advance(2000);

    expect(await cache.get("k", fetcher)).toEqual({
      value: "v1",
      asOf: 0,
      stale: true,
    });
  });

  test("entries older than staleMaxMs are dropped and never served", async () => {
    const clock = fixedClock();
    const cache = makeCache(clock);
    let calls = 0;
    let mode: "ok" | "fail" = "ok";
    const fetcher = async () => {
      calls += 1;
      if (mode === "fail") throw new Error("synthetic upstream failure");
      return `v${calls}`;
    };

    await cache.get("k", fetcher);
    clock.advance(5001);
    mode = "fail";

    const error = await rejection(cache.get("k", fetcher));
    expect((error as Error).message).toBe("synthetic upstream failure");

    clock.advance(201);
    mode = "ok";
    expect(await cache.get("k", fetcher)).toEqual({
      value: "v3",
      asOf: 5202,
      stale: false,
    });
  });

  test("failure cooldown suppresses refetching and replays the remembered error", async () => {
    const clock = fixedClock();
    const cache = makeCache(clock);
    const failure = new Error("synthetic upstream failure");
    let calls = 0;
    let mode: "fail" | "ok" = "fail";
    const fetcher = async () => {
      calls += 1;
      if (mode === "fail") throw failure;
      return "v";
    };

    expect(await rejection(cache.get("k", fetcher))).toBe(failure);
    clock.advance(199);
    expect(await rejection(cache.get("k", fetcher))).toBe(failure);
    expect(calls).toBe(1);

    clock.advance(2);
    mode = "ok";
    expect((await cache.get("k", fetcher)).value).toBe("v");
    expect(calls).toBe(2);
  });

  test("a failed fetch clears the in-flight slot so the next get retries", async () => {
    const clock = fixedClock();
    const cache = makeCache(clock);
    const first = deferred<string>();
    const second = deferred<string>();
    let calls = 0;
    const fetcher = () => {
      calls += 1;
      return calls === 1 ? first.promise : second.promise;
    };

    const pending = cache.get("k", fetcher);
    first.reject(new Error("synthetic upstream failure"));
    await rejection(pending);

    clock.advance(201);
    const retry = cache.get("k", fetcher);
    second.resolve("v2");
    expect(await retry).toEqual({ value: "v2", asOf: 201, stale: false });
    expect(calls).toBe(2);
  });

  test("a synchronously throwing fetcher does not poison the key", async () => {
    const clock = fixedClock();
    const cache = makeCache(clock);
    let calls = 0;
    const fetcher = (): Promise<string> => {
      calls += 1;
      if (calls === 1) throw new Error("synthetic synchronous failure");
      return Promise.resolve(`v${calls}`);
    };

    const error = await rejection(cache.get("k", fetcher));
    expect((error as Error).message).toBe("synthetic synchronous failure");

    clock.advance(201);
    expect(await cache.get("k", fetcher)).toEqual({
      value: "v2",
      asOf: 201,
      stale: false,
    });
    expect(calls).toBe(2);
  });

  test("invalidate during a pending fetch keeps the result from resurrecting", async () => {
    const clock = fixedClock();
    const cache = makeCache(clock);
    const pending = deferred<string>();
    let calls = 0;
    const fetcher = () => {
      calls += 1;
      return calls === 1 ? pending.promise : Promise.resolve(`v${calls}`);
    };

    const first = cache.get("k", fetcher);
    cache.invalidate("k");
    pending.resolve("v1");
    expect((await first).value).toBe("v1");

    expect((await cache.get("k", fetcher)).value).toBe("v2");
    expect(calls).toBe(2);
  });

  test("the retention sweep drops expired entries of keys nobody re-reads", async () => {
    const clock = fixedClock();
    const cache = makeCache(clock);
    await cache.get("a", async () => "va1");
    await cache.get("b", async () => "vb1");

    clock.advance(5001);
    expect((await cache.get("a", async () => "va2")).value).toBe("va2");

    // "b" was swept by the get("a") call, so there is no stale value left to
    // fall back on when its next fetch fails.
    const error = await rejection(
      cache.get("b", async () => {
        throw new Error("synthetic upstream failure");
      }),
    );
    expect((error as Error).message).toBe("synthetic upstream failure");
  });

  test("stored values are deep frozen", async () => {
    const clock = fixedClock();
    const cache = makeCache(clock);
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return {
        list: [
          {
            id: "aaaa1111-2222-3333-4444-55556666zz01",
            name: "Synthetic Process A",
          },
        ],
      };
    };

    const hit = await cache.get("k", fetcher);
    const [item] = hit.value.list;
    expect(Object.isFrozen(hit.value)).toBe(true);
    expect(Object.isFrozen(hit.value.list)).toBe(true);
    expect(Object.isFrozen(item)).toBe(true);

    try {
      if (item) item.name = "mutated";
    } catch {
      // frozen objects reject writes in strict mode
    }

    const again = await cache.get("k", fetcher);
    expect(again.value.list[0]?.name).toBe("Synthetic Process A");
    expect(calls).toBe(1);
  });

  test("an aborted caller rejects while the shared fetch keeps running", async () => {
    const clock = fixedClock();
    const cache = makeCache(clock);
    const pendingFetch = deferred<string>();
    let calls = 0;
    const fetcher = () => {
      calls += 1;
      return pendingFetch.promise;
    };

    const controller = new AbortController();
    const aborted = cache.get("k", fetcher, { signal: controller.signal });
    controller.abort();
    expect((await rejection(aborted) as Error).name).toBe("AbortError");

    pendingFetch.resolve("v");
    await flush();

    const hit = await cache.get("k", fetcher);
    expect(hit.value).toBe("v");
    expect(hit.stale).toBe(false);
    expect(calls).toBe(1);
  });

  test("a pre-aborted signal rejects before any fetch runs", async () => {
    const clock = fixedClock();
    const cache = makeCache(clock);
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return "v";
    };

    const error = await rejection(
      cache.get("k", fetcher, { signal: controller.signal }),
    );
    expect((error as Error).name).toBe("AbortError");
    expect(calls).toBe(0);
  });

  test("an aborted caller never receives a stale fallback", async () => {
    const clock = fixedClock();
    const cache = makeCache(clock);
    const hanging = deferred<string>();
    let calls = 0;
    const fetcher = () => {
      calls += 1;
      return calls === 1 ? Promise.resolve("v1") : hanging.promise;
    };

    await cache.get("k", fetcher);
    clock.advance(2000);

    const controller = new AbortController();
    // rejection() fails the test if the stale value is handed back instead.
    const pending = cache.get("k", fetcher, { signal: controller.signal });
    controller.abort();
    expect((await rejection(pending) as Error).name).toBe("AbortError");
  });
});
