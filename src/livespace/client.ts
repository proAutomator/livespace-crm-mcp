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
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The token fetch is sub-second in practice (measured on a sandbox account),
 * so it keeps its own tight budget and ignores per-call overrides. That caps a
 * slow read at roughly maxAttempts x (10 s token + 60 s dispatch) instead of
 * maxAttempts x (60 + 60) s.
 */
export const TOKEN_TIMEOUT_MS = 10_000;

export interface LivespaceClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface LivespaceCallOptions {
  signal?: AbortSignal;
  /** Write calls are never auto-retried once the signed request went out. */
  write?: boolean;
  /** Overrides the timeout of the signed dispatch only, never of the token fetch. */
  timeoutMs?: number;
}

/** One signed request, minted fresh for every attempt. */
interface PreparedRequest {
  url: string;
  body: URLSearchParams;
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
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
      const url = `${this.baseUrl()}/${encodeURIComponent(module)}/${encodeURIComponent(method)}`;
      // Signing happens inside `prepare`, so every retry mints a fresh
      // token/session pair. Replaying a spent session made Livespace answer
      // 561 and told the model to go check its credentials.
      const prepare = async (): Promise<PreparedRequest> => {
        const { token, sessionId } = await this.getToken(opts.signal);
        const sha = await buildSignature(
          this.config.apiKey,
          token,
          this.config.apiSecret,
        );
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
        return { url, body };
      };
      const envelope = await this.post(prepare, {
        write: opts.write === true,
        signal: opts.signal,
        timeoutMs: opts.timeoutMs,
      });
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
    // write - only the signed dispatch gets write semantics. Retrying is the
    // caller's business: `post` owns the loop around the whole attempt.
    const envelope = await this.singleFetch(
      `${this.baseUrl()}/_Api/auth_call/_api_method/getToken`,
      body,
      { timeoutMs: TOKEN_TIMEOUT_MS, signal },
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

  /**
   * Exactly ONE HTTP attempt. This is the only place that mints retryable
   * (`transport: true`) errors; the response body is read inside the timed
   * window and the TIMEOUT message reports the timeout actually used.
   */
  private async singleFetch(
    url: string,
    body: URLSearchParams,
    opts: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<Envelope> {
    const combined = combineSignals(AbortSignal.timeout(opts.timeoutMs), opts.signal);
    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: combined.signal,
      });
      if (response.status === 429) {
        throw new LivespaceError(
          "RATE_LIMITED",
          "Livespace rate-limited the request (HTTP 429).",
          "Wait before retrying; reduce request frequency if it persists.",
          undefined,
          parseRetryAfterMs(response.headers.get("retry-after")),
          true,
        );
      }
      if (response.status >= 500) {
        throw new LivespaceError(
          "UPSTREAM_ERROR",
          `Livespace responded with HTTP ${response.status}.`,
          "Retry with backoff; reduce the request size if it persists.",
          undefined,
          parseRetryAfterMs(response.headers.get("retry-after")),
          true,
        );
      }
      return (await response.json()) as Envelope;
    } catch (cause) {
      // Our own classification passes through untouched.
      if (cause instanceof LivespaceError) throw cause;
      if (opts.signal?.aborted) throw cancelledError();
      // The caught error is deliberately reduced to a category: upstream
      // error text must never enter LivespaceError (docs/security.md par. 6).
      if (cause instanceof DOMException && cause.name === "TimeoutError") {
        throw new LivespaceError(
          "TIMEOUT",
          `Livespace did not respond within ${opts.timeoutMs} ms.`,
          "Retry; if it persists, reduce the request size.",
          undefined,
          undefined,
          true,
        );
      }
      throw new LivespaceError(
        "NETWORK_ERROR",
        "Network error while calling Livespace.",
        "Check connectivity and LIVESPACE_SUBDOMAIN, then retry.",
        undefined,
        undefined,
        true,
      );
    } finally {
      combined.dispose();
    }
  }

  /**
   * The retry engine. It wraps the WHOLE composite attempt: `prepare` mints a
   * fresh token and signature, then the signed request goes out once. Only
   * transport failures retry - business failures from the envelope stop dead.
   *
   * Write semantics are phase-aware. The token fetch is a safe read, so a
   * prepare-phase transport failure retries even for writes; the moment the
   * signed request has been dispatched a write stops, because a 5xx, timeout
   * or dropped socket leaves the outcome unknown and a blind retry could
   * duplicate CRM records (docs/security.md par. 5). An HTTP 429 is the
   * exception: it was rejected before processing, so the outcome is known.
   */
  private async post(
    prepare: () => Promise<PreparedRequest>,
    opts: { write: boolean; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Envelope> {
    let lastError: LivespaceError | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      if (opts.signal?.aborted) throw cancelledError();
      let signedDispatch = false;
      try {
        const request = await prepare();
        signedDispatch = true;
        return await this.singleFetch(request.url, request.body, {
          timeoutMs: opts.timeoutMs ?? this.timeoutMs,
          signal: opts.signal,
        });
      } catch (error) {
        if (!(error instanceof LivespaceError) || !error.transport) throw error;
        if (opts.signal?.aborted) throw cancelledError();
        if (opts.write && signedDispatch) {
          if (error.code === "RATE_LIMITED") throw error;
          // The caller must verify by re-reading instead of blindly retrying
          // (M6 contract).
          throw new LivespaceError(
            "WRITE_OUTCOME_UNKNOWN",
            "The write request failed mid-flight; Livespace may or may not have applied it.",
            "Re-read the affected records to verify the outcome before retrying.",
            error.resultCode,
          );
        }
        lastError = error;
      }
      if (attempt < this.maxAttempts) {
        await this.sleep(this.retryDelayMs(attempt, lastError?.retryAfterMs));
      }
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
