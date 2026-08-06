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
  // Bumped by invalidate(): a fetch that started before it must not write its
  // result back, or the invalidated key resurrects.
  const generations = new Map<string, number>();

  function generationOf(key: string): number {
    return generations.get(key) ?? 0;
  }

  // Retention is a hard bound (docs/security.md par. 8), so it cannot depend on
  // a key being read again: every get() drops everything past the window.
  function sweep(): void {
    const cutoff = now() - opts.staleMaxMs;
    for (const [key, entry] of entries) {
      if (entry.asOf < cutoff) entries.delete(key);
    }
    for (const [key, failure] of failures) {
      if (failure.failedAt < cutoff) failures.delete(key);
    }
  }

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
    const generation = generationOf(key);
    const current = () => generationOf(key) === generation;
    try {
      // Promise.resolve().then(fetch) keeps a synchronously throwing fetcher
      // from settling before get() stores this promise - otherwise `finally`
      // clears the in-flight slot first and the rejected flight stays cached.
      const value = deepFreeze(await Promise.resolve().then(fetch));
      const asOf = now();
      const entry: Entry = {
        value,
        asOf,
        expiresAt: asOf + opts.ttlMs * (0.9 + 0.2 * jitter()),
      };
      if (current()) {
        entries.set(key, entry);
        failures.delete(key);
      }
      return entry;
    } catch (error) {
      if (current()) failures.set(key, { failedAt: now(), error });
      throw error;
    } finally {
      // Only ever clear our own slot: after an invalidate the slot may already
      // belong to a newer fetch.
      if (current()) inFlight.delete(key);
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

    sweep();
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
    generations.set(key, generationOf(key) + 1);
    entries.delete(key);
    failures.delete(key);
    inFlight.delete(key);
  }

  return { get, invalidate };
}
