export interface TtlCacheOptions {
  /** Fresh window; a value younger than this is served without a fetch. */
  ttlMs: number;
  /** Absolute retention bound; entries older than this are dropped, never served. */
  staleMaxMs: number;
  /** After a failed fetch, no refetch happens for this long. */
  failureCooldownMs: number;
  now?: () => number;
  /** 0..1, scales expiry to ttlMs * (0.9 + 0.2 * jitter()). */
  jitter?: () => number;
}

export interface CacheHit<T> {
  value: T;
  asOf: number;
  stale: boolean;
}

interface Entry {
  value: unknown;
  asOf: number;
  expiresAt: number;
}

interface Failure {
  failedAt: number;
  error: unknown;
}

function freezeDeep(value: unknown, seen: WeakSet<object>): void {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  Object.freeze(value);
  for (const inner of Object.values(value)) freezeDeep(inner, seen);
}

// Cached values are handed to many callers; freezing keeps one caller's
// mutation from rewriting what the next caller reads.
function deepFreeze<T>(value: T): T {
  freezeDeep(value, new WeakSet());
  return value;
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

/**
 * Generic in-memory TTL cache: single-flight per key, failure cooldown,
 * stale-if-error and a hard retention bound (docs/security.md par. 8 - the
 * only cache this server keeps, and nothing in it outlives the window).
 * Knows nothing about Livespace.
 */
export function createTtlCache(opts: TtlCacheOptions): {
  get<T>(
    key: string,
    fetch: () => Promise<T>,
    callerOpts?: { signal?: AbortSignal },
  ): Promise<CacheHit<T>>;
  invalidate(key: string): void;
} {
  const now = opts.now ?? (() => Date.now());
  const jitter = opts.jitter ?? Math.random;
  const entries = new Map<string, Entry>();
  const failures = new Map<string, Failure>();
  const inFlight = new Map<string, Promise<Entry>>();

  function liveEntry(key: string): Entry | undefined {
    const entry = entries.get(key);
    if (!entry) return undefined;
    if (now() - entry.asOf > opts.staleMaxMs) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  }

  async function runFetch(key: string, fetch: () => Promise<unknown>): Promise<Entry> {
    try {
      const value = deepFreeze(await fetch());
      const asOf = now();
      const entry: Entry = {
        value,
        asOf,
        expiresAt: asOf + opts.ttlMs * (0.9 + 0.2 * jitter()),
      };
      entries.set(key, entry);
      failures.delete(key);
      return entry;
    } catch (error) {
      failures.set(key, { failedAt: now(), error });
      throw error;
    } finally {
      inFlight.delete(key);
    }
  }

  async function awaitFlight(
    flight: Promise<Entry>,
    signal: AbortSignal | undefined,
  ): Promise<Entry> {
    if (!signal) return await flight;
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(abortError(signal));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([flight, aborted]);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  async function get<T>(
    key: string,
    fetch: () => Promise<T>,
    callerOpts?: { signal?: AbortSignal },
  ): Promise<CacheHit<T>> {
    const signal = callerOpts?.signal;
    if (signal?.aborted) throw abortError(signal);

    const entry = liveEntry(key);
    if (entry && now() < entry.expiresAt) {
      return { value: entry.value as T, asOf: entry.asOf, stale: false };
    }

    const failure = failures.get(key);
    if (failure && now() - failure.failedAt < opts.failureCooldownMs) {
      if (entry) return { value: entry.value as T, asOf: entry.asOf, stale: true };
      throw failure.error;
    }

    // The shared fetch never carries a caller signal: one caller walking away
    // must not cancel the work the other callers are waiting for.
    let flight = inFlight.get(key);
    if (!flight) {
      flight = runFetch(key, fetch);
      inFlight.set(key, flight);
    }

    try {
      const fresh = await awaitFlight(flight, signal);
      return { value: fresh.value as T, asOf: fresh.asOf, stale: false };
    } catch (error) {
      // An aborted caller gets the abort, never a stale fallback.
      if (signal?.aborted) throw error;
      const previous = liveEntry(key);
      if (previous) {
        return { value: previous.value as T, asOf: previous.asOf, stale: true };
      }
      throw error;
    }
  }

  function invalidate(key: string): void {
    entries.delete(key);
    failures.delete(key);
  }

  return { get, invalidate };
}
