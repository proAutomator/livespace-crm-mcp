export interface RequestLimiterOptions {
  ratePerMinute: number;
  burst: number;
  maxConcurrent: number;
  maxQueue: number;
  now?: () => number;
}

export type Admission =
  | { admitted: true; release: () => void }
  | { admitted: false; retryAfterSeconds: number };

interface Bucket {
  tokens: number;
  updatedAt: number;
}

// The MCP spec makes rate limiting of tool invocations a server MUST
// (spec 2026-07-28, Tools, Security Considerations). This limiter protects
// the server itself; the Livespace throttle protects the upstream API.
// Principal cardinality is tiny (one shared bearer or "anonymous"), so the
// bucket map cannot grow unbounded.
export function createRequestLimiter(opts: RequestLimiterOptions): {
  admit(principal: string): Promise<Admission>;
} {
  const now = opts.now ?? (() => Date.now());
  const tokensPerMs = opts.ratePerMinute / 60_000;
  const buckets = new Map<string, Bucket>();
  let active = 0;
  const queue: Array<(admission: Admission) => void> = [];

  function release(): void {
    const next = queue.shift();
    if (next) {
      // Hand the freed slot directly to the next waiter; `active` is unchanged.
      next({ admitted: true, release });
      return;
    }
    active -= 1;
  }

  function takeToken(
    principal: string,
  ): { ok: true } | { ok: false; retryAfterSeconds: number } {
    const bucket = buckets.get(principal) ?? { tokens: opts.burst, updatedAt: now() };
    const elapsed = now() - bucket.updatedAt;
    bucket.tokens = Math.min(opts.burst, bucket.tokens + elapsed * tokensPerMs);
    bucket.updatedAt = now();
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      buckets.set(principal, bucket);
      return { ok: true };
    }
    buckets.set(principal, bucket);
    const waitMs = (1 - bucket.tokens) / tokensPerMs;
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) };
  }

  async function admit(principal: string): Promise<Admission> {
    const token = takeToken(principal);
    if (!token.ok) {
      return { admitted: false, retryAfterSeconds: token.retryAfterSeconds };
    }
    if (active < opts.maxConcurrent) {
      active += 1;
      return { admitted: true, release };
    }
    if (queue.length >= opts.maxQueue) {
      return { admitted: false, retryAfterSeconds: 1 };
    }
    return new Promise<Admission>((resolve) => queue.push(resolve));
  }

  return { admit };
}
