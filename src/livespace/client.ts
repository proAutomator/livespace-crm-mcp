import type { LivespaceConfig } from "../config/env.js";
import { buildSignature } from "./crypto.js";
import { cancelledError, errorFromEnvelope, LivespaceError } from "./errors.js";
import { createThrottle } from "./throttle.js";

interface Envelope {
  data: unknown;
  error: unknown;
  result: number;
  status: boolean;
}

// Echo-style methods (Default/ping) reflect the request payload, which since
// the payload-format fix includes the auth fields. Strip them so credentials
// can never reach callers, logs, or the model (docs/security.md par. 6).
function stripAuthEcho(data: unknown): unknown {
  if (Array.isArray(data)) {
    return data.map((item) => stripAuthEcho(item));
  }
  if (data !== null && typeof data === "object") {
    return Object.fromEntries(
      Object.entries(data as Record<string, unknown>).filter(
        ([key]) => !key.startsWith("_api"),
      ),
    );
  }
  return data;
}

const BASE_RETRY_DELAY_MS = 200;
const MAX_RETRY_DELAY_MS = 2_000;
const MAX_RETRY_AFTER_MS = 10_000;

export interface LivespaceClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface LivespaceCallOptions {
  signal?: AbortSignal;
  /** Write calls are never auto-retried after being sent. */
  write?: boolean;
}

interface CombinedSignal {
  signal: AbortSignal;
  dispose: () => void;
}

// AbortSignal.any is not available on every supported runtime; combine
// manually and always clean up listeners.
function combineSignals(primary: AbortSignal, extra?: AbortSignal): CombinedSignal {
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
function parseRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.round(seconds * 1000);
}

export class LivespaceClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly withSlot: <T>(
    fn: () => Promise<T>,
    signal?: AbortSignal,
  ) => Promise<T>;

  constructor(
    private readonly config: LivespaceConfig,
    options: LivespaceClientOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.sleep =
      options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    this.random = options.random ?? Math.random;
    this.withSlot = createThrottle({
      maxConcurrent: 2,
      minIntervalMs: 150,
      sleep: this.sleep,
    });
  }

  async call<T = unknown>(
    module: string,
    method: string,
    params: Record<string, unknown> = {},
    opts: LivespaceCallOptions = {},
  ): Promise<T> {
    try {
      return await this.callThrottled<T>(module, method, params, opts);
    } catch (error) {
      // Aborts surface from the throttle queue as raw AbortErrors; the client
      // contract is {code, message, hint} everywhere.
      if (opts.signal?.aborted && !(error instanceof LivespaceError)) {
        throw cancelledError();
      }
      throw error;
    }
  }

  private async callThrottled<T>(
    module: string,
    method: string,
    params: Record<string, unknown>,
    opts: LivespaceCallOptions,
  ): Promise<T> {
    return this.withSlot(async () => {
      const { token, sessionId } = await this.getToken(opts.signal);
      const sha = await buildSignature(this.config.apiKey, token, this.config.apiSecret);
      // Livespace expects the auth fields inside the `data` JSON for signed
      // calls (separate form fields return 561). Auth fields are spread last
      // so caller params can never override them.
      const body = new URLSearchParams({
        data: JSON.stringify({
          ...params,
          _api_auth: "key",
          _api_key: this.config.apiKey,
          _api_sha: sha,
          _api_session: sessionId,
        }),
      });
      const envelope = await this.post(
        `${this.baseUrl()}/${encodeURIComponent(module)}/${encodeURIComponent(method)}`,
        body,
        { write: opts.write === true, signal: opts.signal },
      );
      if (envelope.status !== true || envelope.result !== 200) {
        throw errorFromEnvelope(envelope.result);
      }
      return stripAuthEcho(envelope.data) as T;
    }, opts.signal);
  }

  private baseUrl(): string {
    return `https://${this.config.subdomain}.livespace.io/api/public/json`;
  }

  private async getToken(
    signal?: AbortSignal,
  ): Promise<{ token: string; sessionId: string }> {
    const body = new URLSearchParams({
      _api_auth: "key",
      _api_key: this.config.apiKey,
    });
    // The token fetch is always a safe read, even when the logical call is a
    // write - only the signed call itself gets write semantics.
    const envelope = await this.post(
      `${this.baseUrl()}/_Api/auth_call/_api_method/getToken`,
      body,
      { write: false, signal },
    );
    if (envelope.status !== true || envelope.result !== 200) {
      throw errorFromEnvelope(envelope.result);
    }
    const data = envelope.data as { token?: string; session_id?: string };
    if (!data.token || !data.session_id) {
      throw new LivespaceError(
        "AUTH_FAILED",
        "Livespace token response was malformed.",
        "Verify credentials; if they are correct, retry.",
      );
    }
    return { token: data.token, sessionId: data.session_id };
  }

  // Full jitter (AWS style): a random fraction of the capped exponential
  // backoff, or the upstream Retry-After when one was provided
  // (docs/security.md par. 3 requires jitter, no hot retry loops).
  private retryDelayMs(attempt: number, retryAfterMs: number | undefined): number {
    if (retryAfterMs !== undefined) {
      return Math.min(retryAfterMs, MAX_RETRY_AFTER_MS);
    }
    const cap = Math.min(BASE_RETRY_DELAY_MS * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
    return Math.floor(this.random() * cap);
  }

  private async post(
    url: string,
    body: URLSearchParams,
    opts: { write: boolean; signal?: AbortSignal },
  ): Promise<Envelope> {
    if (opts.signal?.aborted) throw cancelledError();
    // Reads retry; writes get exactly one attempt because a timeout or 5xx
    // after the request was sent leaves the outcome unknown - blind retries
    // could duplicate CRM records (docs/security.md par. 5).
    const attempts = opts.write ? 1 : this.maxAttempts;
    let lastError: LivespaceError | undefined;
    let outcomeUnknown = false;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let retryAfterMs: number | undefined;
      const combined = combineSignals(
        AbortSignal.timeout(this.timeoutMs),
        opts.signal,
      );
      try {
        const response = await this.fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: body.toString(),
          signal: combined.signal,
        });
        if (response.status === 429) {
          // Rejected before processing, so even a write is safe to retry
          // explicitly; outcomeUnknown stays false.
          retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
          lastError = new LivespaceError(
            "RATE_LIMITED",
            "Livespace rate-limited the request (HTTP 429).",
            "Wait before retrying; reduce request frequency if it persists.",
          );
        } else if (response.status >= 500) {
          retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
          outcomeUnknown = true;
          lastError = new LivespaceError(
            "UPSTREAM_ERROR",
            `Livespace responded with HTTP ${response.status}.`,
            "Retry with backoff; reduce the request size if it persists.",
          );
        } else {
          return (await response.json()) as Envelope;
        }
      } catch (cause) {
        if (opts.signal?.aborted) throw cancelledError();
        outcomeUnknown = true;
        // The caught error is deliberately reduced to a category: upstream
        // error text must never enter LivespaceError (docs/security.md par. 6).
        lastError =
          cause instanceof DOMException && cause.name === "TimeoutError"
            ? new LivespaceError(
                "TIMEOUT",
                `Livespace did not respond within ${this.timeoutMs} ms.`,
                "Retry; if it persists, reduce the request size.",
              )
            : new LivespaceError(
                "NETWORK_ERROR",
                "Network error while calling Livespace.",
                "Check connectivity and LIVESPACE_SUBDOMAIN, then retry.",
              );
      } finally {
        combined.dispose();
      }
      if (attempt < attempts) {
        await this.sleep(this.retryDelayMs(attempt, retryAfterMs));
      }
    }
    if (opts.write && outcomeUnknown) {
      // The request may have reached Livespace before failing; the caller
      // must verify by re-reading instead of blindly retrying (M6 contract).
      throw new LivespaceError(
        "WRITE_OUTCOME_UNKNOWN",
        "The write request failed mid-flight; Livespace may or may not have applied it.",
        "Re-read the affected records to verify the outcome before retrying.",
        lastError?.resultCode,
      );
    }
    throw (
      lastError ??
      new LivespaceError(
        "NETWORK_ERROR",
        "Network error while calling Livespace.",
        "Check connectivity and retry.",
      )
    );
  }
}
