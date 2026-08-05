export interface ThrottleOptions {
  maxConcurrent: number;
  minIntervalMs: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

// Load discipline is a Livespace ToS compliance requirement, not an
// optimization (docs/security.md par. 3).
export function createThrottle(
  opts: ThrottleOptions,
): <T>(fn: () => Promise<T>) => Promise<T> {
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());

  let active = 0;
  let lastStart: number | undefined;
  const waiters: Array<() => void> = [];

  async function acquire(): Promise<void> {
    if (active >= opts.maxConcurrent) {
      await new Promise<void>((resolve) => waiters.push(resolve));
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
    waiters.shift()?.();
  }

  return async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
    await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  };
}
