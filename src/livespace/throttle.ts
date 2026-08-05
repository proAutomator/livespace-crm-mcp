export interface ThrottleOptions {
  maxConcurrent: number;
  minIntervalMs: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

// Load discipline is a Livespace ToS compliance requirement, not an
// optimization (docs/security.md par. 3). Cancellation must also reach work
// still waiting in the queue: a disconnected MCP client should not keep a
// Livespace call pending.
export function createThrottle(
  opts: ThrottleOptions,
): <T>(fn: () => Promise<T>, signal?: AbortSignal) => Promise<T> {
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());

  let active = 0;
  let lastStart: number | undefined;
  const waiters: Array<() => void> = [];

  async function acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw abortError(signal);
    if (active >= opts.maxConcurrent) {
      await new Promise<void>((resolve, reject) => {
        const waiter = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = () => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(abortError(signal as AbortSignal));
        };
        waiters.push(waiter);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    active += 1;
    if (lastStart !== undefined) {
      const wait = lastStart + opts.minIntervalMs - now();
      if (wait > 0) await sleep(wait);
    }
    lastStart = now();
  }

  function release(): void {
    active -= 1;
    // An aborted waiter removed itself from the queue, so the freed slot goes
    // to the next live waiter (which re-increments `active` in acquire()).
    waiters.shift()?.();
  }

  return async function withSlot<T>(
    fn: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    await acquire(signal);
    try {
      return await fn();
    } finally {
      release();
    }
  };
}
