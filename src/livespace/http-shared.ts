/**
 * Transport helpers shared by the v1 (signed-session) and v2 (Bearer) clients.
 * Nothing here reads a response body: bodies are upstream data and each
 * client decides what of them, if anything, may pass (docs/security.md par. 6).
 */

export const BASE_RETRY_DELAY_MS = 200;
export const MAX_RETRY_DELAY_MS = 2_000;
/** The longest upstream `Retry-After` a client waits out. */
export const MAX_RETRY_AFTER_MS = 10_000;
export const DEFAULT_TIMEOUT_MS = 30_000;

export interface LivespaceClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export interface CombinedSignal {
  signal: AbortSignal;
  dispose: () => void;
}

// AbortSignal.any is not available on every supported runtime; combine
// manually and always clean up listeners.
export function combineSignals(primary: AbortSignal, extra?: AbortSignal): CombinedSignal {
  if (!extra) return { signal: primary, dispose: () => {} };
  const controller = new AbortController();
  const onPrimary = () => controller.abort(primary.reason);
  const onExtra = () => controller.abort(extra.reason);
  if (primary.aborted) controller.abort(primary.reason);
  else if (extra.aborted) controller.abort(extra.reason);
  primary.addEventListener("abort", onPrimary, { once: true });
  extra.addEventListener("abort", onExtra, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      primary.removeEventListener("abort", onPrimary);
      extra.removeEventListener("abort", onExtra);
    },
  };
}

// Only the delta-seconds form is honored; HTTP-date values are ignored.
export function parseRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.round(seconds * 1000);
}

// Full jitter (AWS style): a random fraction of the capped exponential
// backoff, or the upstream Retry-After when one was provided
// (docs/security.md par. 3 requires jitter, no hot retry loops).
export function retryDelayMs(
  attempt: number,
  retryAfterMs: number | undefined,
  random: () => number,
): number {
  if (retryAfterMs !== undefined) {
    return Math.min(retryAfterMs, MAX_RETRY_AFTER_MS);
  }
  const cap = Math.min(BASE_RETRY_DELAY_MS * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
  return Math.floor(random() * cap);
}
