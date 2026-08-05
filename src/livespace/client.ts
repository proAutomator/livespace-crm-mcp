import type { LivespaceConfig } from "../config/env.js";
import { buildSignature } from "./crypto.js";
import { errorFromEnvelope, LivespaceError } from "./errors.js";
import { createThrottle } from "./throttle.js";

interface Envelope {
  data: unknown;
  error: unknown;
  result: number;
  status: boolean;
}

export interface LivespaceClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class LivespaceClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly withSlot: <T>(fn: () => Promise<T>) => Promise<T>;

  constructor(
    private readonly config: LivespaceConfig,
    options: LivespaceClientOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.sleep =
      options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
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
  ): Promise<T> {
    return this.withSlot(async () => {
      const { token, sessionId } = await this.getToken();
      const sha = await buildSignature(this.config.apiKey, token, this.config.apiSecret);
      const body = new URLSearchParams({
        _api_auth: "key",
        _api_key: this.config.apiKey,
        _api_sha: sha,
        _api_session: sessionId,
        data: JSON.stringify(params),
      });
      const envelope = await this.post(
        `${this.baseUrl()}/${encodeURIComponent(module)}/${encodeURIComponent(method)}`,
        body,
      );
      if (envelope.status !== true || envelope.result !== 200) {
        throw errorFromEnvelope(envelope.result);
      }
      return envelope.data as T;
    });
  }

  private baseUrl(): string {
    return `https://${this.config.subdomain}.livespace.io/api/public/json`;
  }

  private async getToken(): Promise<{ token: string; sessionId: string }> {
    const body = new URLSearchParams({
      _api_auth: "key",
      _api_key: this.config.apiKey,
    });
    const envelope = await this.post(
      `${this.baseUrl()}/_Api/auth_call/_api_method/getToken`,
      body,
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

  private async post(url: string, body: URLSearchParams): Promise<Envelope> {
    let lastError: LivespaceError | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const response = await this.fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: body.toString(),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (response.status >= 500) {
          lastError = new LivespaceError(
            "UPSTREAM_ERROR",
            `Livespace responded with HTTP ${response.status}.`,
            "Retry with backoff; reduce the request size if it persists.",
          );
        } else {
          return (await response.json()) as Envelope;
        }
      } catch (cause) {
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
      }
      if (attempt < this.maxAttempts) {
        await this.sleep(200 * 2 ** (attempt - 1));
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
