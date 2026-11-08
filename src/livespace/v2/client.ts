import { cancelledError, LivespaceError } from "../errors.js";
import {
  combineSignals,
  DEFAULT_TIMEOUT_MS,
  defaultSleep,
  type LivespaceClientOptions,
  MAX_RETRY_AFTER_MS,
  retryDelayMs,
} from "../http-shared.js";
import { createThrottle } from "../throttle.js";
import { type CallBudget, type RateLimitSnapshot, RateLimitTracker } from "./budget.js";
import { MEDIA_JSON, type V2ContentType, type V2MediaType } from "./media-types.js";
import { errorFromProblem, readRequestId } from "./problems.js";

/**
 * HTTP client for the Livespace public API v2 (docs/security.md par. 1, 3, 5,
 * 6). One static Bearer key, sent only in the `Authorization` header to
 * `https://<subdomain>.livespace.io/api/v2`; redirects are not followed, so
 * the key never travels to another host. The method union has no `DELETE`
 * on purpose: this server deletes nothing.
 */

export interface V2Request {
  method: "GET" | "POST" | "PATCH";
  /** Built by `v2Path` only, so every id in it is percent-encoded. */
  path: string;
  /** Arrays are comma-joined (`style: form, explode: false`). */
  query?: Record<string, string | number | boolean | readonly string[] | undefined>;
  body?: unknown;
  accept?: V2MediaType;
  contentType?: V2ContentType;
  /** Only where the API supports it; a keyed write may be retried once. */
  idempotencyKey?: string;
}

export interface V2CallOptions {
  signal?: AbortSignal;
  /** Write semantics: no blind retry once the request went out. */
  write?: boolean;
  timeoutMs?: number;
  /** The tool call's request budget; every HTTP attempt spends one unit. */
  budget?: CallBudget;
  /** Skips the daily reserve; meant for `health` only. */
  essential?: boolean;
}

export interface V2Response<T> {
  data: T;
  extra: Record<string, unknown>;
  requestId: string | null;
  /** `Idempotent-Replayed: true`: the stored answer of an earlier request. */
  replayed: boolean;
}

export interface LivespaceV2ClientConfig {
  subdomain: string;
  apiKey: string;
  dailyReserve: number;
}

export interface LivespaceV2ClientOptions extends LivespaceClientOptions {
  /** Clock for the burst window, epoch ms. */
  now?: () => number;
}

const METHODS: ReadonlySet<string> = new Set(["GET", "POST", "PATCH"]);
/** What `v2Path` produces: unreserved characters, `%XX` escapes and slashes. */
const PATH_RE = /^\/(?!\/)[A-Za-z0-9\-._~%/]*$/;
const DOT_SEGMENT_RE = /^(?:\.|%2e){1,2}$/i;
const IDEMPOTENCY_KEY_RE = /^[\x21-\x7e]{1,255}$/;
/** The longest burst window the client waits out before a request. */
const MAX_BURST_WAIT_MS = 10_000;

/**
 * `v2Path("/deals/{}/process", id)`: each `{}` takes one id, percent-encoded.
 * A count mismatch is a programming error. An empty id or a dot segment is
 * refused, because `encodeURIComponent` leaves `.` and `..` as they are and a
 * URL parser would resolve them as path traversal.
 */
export function v2Path(template: string, ...ids: string[]): string {
  const parts = template.split("{}");
  if (parts.length - 1 !== ids.length) {
    throw new RangeError(
      `v2Path: the template has ${parts.length - 1} placeholders for ${ids.length} ids.`,
    );
  }
  let path = parts[0] ?? "";
  ids.forEach((id, index) => {
    if (id === "" || id === "." || id === "..") {
      throw new LivespaceError(
        "VALIDATION_ERROR",
        "A record id is empty or not a valid id.",
        "Take ids from search_crm or crm_metadata instead of guessing them.",
      );
    }
    path += encodeURIComponent(id) + (parts[index + 1] ?? "");
  });
  return path;
}

/** A fresh key for one logical write; reused only by its own retry. */
export function newIdempotencyKey(): string {
  return `lcm-${crypto.randomUUID()}`;
}

function encodeQueryValue(value: string | number | boolean | readonly string[]): string {
  if (typeof value === "string") return encodeURIComponent(value);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError("A query number must be finite.");
    return String(value);
  }
  return value.map((item) => encodeURIComponent(item)).join(",");
}

function queryString(query: V2Request["query"]): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeQueryValue(value)}`);
  }
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function writeOutcomeUnknown(): LivespaceError {
  return new LivespaceError(
    "WRITE_OUTCOME_UNKNOWN",
    "The write request failed mid-flight; Livespace may or may not have applied it.",
    "Re-read the affected records to verify the outcome before retrying.",
  );
}

/** Per-attempt bookkeeping the retry loop reads after a failure. */
interface AttemptState {
  dispatched: boolean;
}

export class LivespaceV2Client {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly tracker: RateLimitTracker;
  private readonly withSlot: <T>(fn: () => Promise<T>, signal?: AbortSignal) => Promise<T>;

  constructor(
    private readonly config: LivespaceV2ClientConfig,
    options: LivespaceV2ClientOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.tracker = new RateLimitTracker(options.now);
    // At most 2 requests in flight and 150 ms between starts, per attempt
    // (docs/security.md par. 3): a retry waiting out its backoff holds no slot.
    this.withSlot = createThrottle({
      maxConcurrent: 2,
      minIntervalMs: 150,
      sleep: this.sleep,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }

  rateLimit(): RateLimitSnapshot {
    return this.tracker.snapshot();
  }

  /**
   * One logical request with its retries.
   *
   * Reads retry transport failures (429, 5xx, timeout, network) up to
   * `maxAttempts`. Writes are phase-aware (docs/security.md par. 5): a 429 is
   * a known refusal and retries; any other failure after dispatch leaves the
   * outcome unknown. Without an `Idempotency-Key` that is final. With one, the
   * request is sent once more with the same key, and a `409` naming a
   * `Retry-After` (the first request still running) is waited out once.
   */
  async request<T>(req: V2Request, opts: V2CallOptions = {}): Promise<V2Response<T>> {
    const url = this.url(req);
    const write = opts.write === true;
    const keyed = req.idempotencyKey !== undefined;
    let unknown = false;
    let keyedRetryUsed = false;
    let conflictRetryUsed = false;
    let failure: LivespaceError | undefined;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const state: AttemptState = { dispatched: false };
      try {
        return await this.withSlot(() => this.once<T>(url, req, opts, state), opts.signal);
      } catch (error) {
        failure = this.normalize(error, opts.signal);
      }

      if (failure.code === "CANCELLED") {
        // Even a caller abort cannot make a dispatched write's outcome known.
        if (write && (unknown || state.dispatched)) throw writeOutcomeUnknown();
        throw failure;
      }

      let retry = false;
      if (!write) {
        retry = failure.transport;
      } else if (failure.code === "RATE_LIMITED" && failure.transport) {
        // Rejected before processing: this attempt is known not to apply.
        retry = true;
      } else if (failure.transport && state.dispatched) {
        unknown = true;
        if (keyed && !keyedRetryUsed) {
          keyedRetryUsed = true;
          retry = true;
        }
      } else if (failure.code === "CONFLICT" && keyed && failure.retryAfterMs !== undefined) {
        if (!conflictRetryUsed) {
          conflictRetryUsed = true;
          retry = true;
        }
      }

      const tooLong =
        failure.retryAfterMs !== undefined && failure.retryAfterMs > MAX_RETRY_AFTER_MS;
      if (!retry || tooLong || attempt === this.maxAttempts) {
        if (write && unknown) throw writeOutcomeUnknown();
        throw failure;
      }
      await this.sleep(retryDelayMs(attempt, failure.retryAfterMs, this.random));
    }
    // Unreachable: the last attempt either returns or throws above.
    if (write && unknown) throw writeOutcomeUnknown();
    throw failure ?? cancelledError();
  }

  /** Anything thrown that is not ours is an abort from the queue or a bug. */
  private normalize(error: unknown, signal: AbortSignal | undefined): LivespaceError {
    if (error instanceof LivespaceError) return error;
    if (signal?.aborted) return cancelledError();
    throw error;
  }

  private url(req: V2Request): string {
    if (!METHODS.has(req.method)) {
      throw new RangeError("The v2 client sends only GET, POST and PATCH.");
    }
    // URL parsers resolve `.` and `..` segments, `%2e` spellings included.
    if (!PATH_RE.test(req.path) || req.path.split("/").some((part) => DOT_SEGMENT_RE.test(part))) {
      throw new RangeError("A v2 path must come from v2Path.");
    }
    if (req.idempotencyKey !== undefined && !IDEMPOTENCY_KEY_RE.test(req.idempotencyKey)) {
      throw new RangeError("An Idempotency-Key is 1-255 printable ASCII characters.");
    }
    return (
      `https://${this.config.subdomain}.livespace.io/api/v2${req.path}` +
      queryString(req.query)
    );
  }

  /** The checks that refuse a request before it goes out. */
  private async beforeDispatch(opts: V2CallOptions): Promise<void> {
    if (opts.signal?.aborted) throw cancelledError();
    if (opts.essential !== true && this.tracker.isDailyBudgetLow(this.config.dailyReserve)) {
      const left = this.tracker.snapshot().dailyRemaining;
      throw new LivespaceError(
        "DAILY_BUDGET_LOW",
        `The account's daily Livespace API v2 budget is down to ${left} requests, ` +
          `at or below the reserve of ${this.config.dailyReserve}.`,
        "The budget is shared by every integration of the account and resets " +
          "at 00:00 UTC. Retry after the reset, or lower LIVESPACE_V2_DAILY_RESERVE " +
          "if the reserve is set too high.",
      );
    }
    const burstWait = this.tracker.burstWaitMs();
    if (burstWait > MAX_BURST_WAIT_MS) {
      throw new LivespaceError(
        "RATE_LIMITED",
        `The Livespace API v2 burst limit is spent for the next ${Math.ceil(burstWait / 1000)} s.`,
        "Wait before retrying; reduce request frequency if it persists.",
        undefined,
        burstWait,
      );
    }
    if (burstWait > 0) await this.sleep(burstWait);
    if (opts.signal?.aborted) throw cancelledError();
    opts.budget?.spend();
  }

  /**
   * Exactly ONE HTTP attempt. The body is read inside the timed window, and
   * this is the only place that mints retryable (`transport: true`) errors
   * for network failures and timeouts.
   */
  private async once<T>(
    url: string,
    req: V2Request,
    opts: V2CallOptions,
    state: AttemptState,
  ): Promise<V2Response<T>> {
    await this.beforeDispatch(opts);

    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.config.apiKey}`,
      accept: req.accept ?? MEDIA_JSON,
    };
    const init: RequestInit = { method: req.method, headers, redirect: "manual" };
    if (req.body !== undefined) {
      headers["content-type"] = req.contentType ?? MEDIA_JSON;
      init.body = JSON.stringify(req.body);
    }
    if (req.idempotencyKey !== undefined) headers["idempotency-key"] = req.idempotencyKey;

    const combined = combineSignals(AbortSignal.timeout(timeoutMs), opts.signal);
    init.signal = combined.signal;
    let response: Response;
    let text: string;
    try {
      state.dispatched = true;
      response = await this.fetchImpl(url, init);
      text = await response.text();
    } catch (cause) {
      if (cause instanceof LivespaceError) throw cause;
      if (opts.signal?.aborted) throw cancelledError();
      // The caught value is reduced to a category: its text may echo the
      // request, and upstream text never enters a LivespaceError
      // (docs/security.md par. 6).
      if (cause instanceof DOMException && cause.name === "TimeoutError") {
        throw new LivespaceError(
          "TIMEOUT",
          `Livespace API v2 did not respond within ${timeoutMs} ms.`,
          "Retry; if it persists, reduce the request size.",
          undefined,
          undefined,
          true,
        );
      }
      throw new LivespaceError(
        "NETWORK_ERROR",
        "Network error while calling Livespace API v2.",
        "Check connectivity and LIVESPACE_SUBDOMAIN, then retry.",
        undefined,
        undefined,
        true,
      );
    } finally {
      combined.dispose();
    }

    this.tracker.observe(response.headers);
    const requestId = readRequestId(response.headers.get("x-request-id")) ?? null;
    const replayed = response.headers.get("idempotent-replayed") === "true";

    if (response.status < 200 || response.status >= 300) {
      throw errorFromProblem(response.status, parseJson(text), response.headers);
    }
    if (response.status === 204) {
      return { data: undefined as T, extra: {}, requestId, replayed };
    }
    const body = parseJson(text);
    if (!isRecord(body) || !("data" in body)) {
      // A write that answered 2xx was applied; only its answer is unreadable.
      if (opts.write === true) throw writeOutcomeUnknown();
      throw new LivespaceError(
        "UPSTREAM_ERROR",
        "Livespace API v2 returned a response in an unexpected shape.",
        "Retry once; report it on the issue tracker if it persists.",
      );
    }
    return {
      data: body["data"] as T,
      extra: isRecord(body["extra"]) ? body["extra"] : {},
      requestId,
      replayed,
    };
  }
}

function parseJson(text: string): unknown {
  if (text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
