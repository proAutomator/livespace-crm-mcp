export interface ServerConfig {
  port: number;
  bindHost: string;
  authToken?: string;
  readOnly: boolean;
  /** Explicit escape hatch for clients that cannot perform form elicitation. */
  allowUnboundWriteConfirmation: boolean;
  allowedHostnames: string[];
  allowedOriginHostnames: string[];
  rateLimitPerMinute: number;
  rateLimitBurst: number;
  maxConcurrentRequests: number;
  maxQueuedRequests: number;
  /** Absolute budget shared by admission queueing and request-body upload. */
  requestIngressTimeoutMs: number;
  /** Absolute budget for MCP tool execution after the request body is read. */
  requestExecutionTimeoutMs: number;
  /**
   * HMAC secret for the write-confirmation `requestState`. Required whenever
   * write tools are enabled; normally absent from read-only processes.
   */
  requestStateKey?: string;
  /**
   * `LIVESPACE_V2_SHARED_ACCESS=acknowledged`: the operator accepts that every
   * client of a non-loopback bind sees what the v2 integration user sees
   * (docs/security.md par. 2, decision D1-A).
   */
  v2SharedAccessAcknowledged: boolean;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const LOCAL_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];

const MIN_AUTH_TOKEN_BYTES = 32;
/** The SDK's codec refuses a shorter one, and so does startup. */
const MIN_REQUEST_STATE_KEY_BYTES = 32;
const MAX_REQUEST_INGRESS_TIMEOUT_MS = 60_000;
/**
 * Bound by Bun, not by taste: the runtime's idle timeout has to outlast
 * ingress plus execution (see `idleTimeoutSeconds`), and Bun accepts at most
 * 255 s. 60 s + 180 s + the margin stays under it.
 */
const MAX_REQUEST_EXECUTION_TIMEOUT_MS = 180_000;

/** The largest `idleTimeout` Bun.serve accepts. */
export const BUN_MAX_IDLE_TIMEOUT_SECONDS = 255;
/** Room for the server's own timeout response after the execution deadline. */
const IDLE_TIMEOUT_MARGIN_SECONDS = 5;

/**
 * Bun closes a connection that stays silent for its idle timeout, 10 s by
 * default, even while a handler is still working. A slow tool call must end
 * with this server's own deadline result, never with a dropped connection, so
 * the runtime waits out ingress plus execution and a margin.
 */
export function idleTimeoutSeconds(config: ServerConfig): number {
  const deadlines = config.requestIngressTimeoutMs + config.requestExecutionTimeoutMs;
  return Math.ceil(deadlines / 1000) + IDLE_TIMEOUT_MARGIN_SECONDS;
}

function positiveInt(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function splitHostList(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\s,]+/)
    .map((host) => host.trim())
    .filter((host) => host !== "");
}

function booleanFlag(
  env: Record<string, string | undefined>,
  name: string,
  fallback: boolean,
): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be either true or false.`);
}

/** Only the exact word counts; anything else set is a typo, never a "no". */
function sharedAccessFlag(env: Record<string, string | undefined>): boolean {
  const raw = env["LIVESPACE_V2_SHARED_ACCESS"]?.trim();
  if (raw === undefined || raw === "") return false;
  if (raw === "acknowledged") return true;
  throw new Error(
    "LIVESPACE_V2_SHARED_ACCESS accepts only the value acknowledged.",
  );
}

export function loadServerConfig(
  env: Record<string, string | undefined>,
): ServerConfig {
  const portRaw = env["MCP_PORT"]?.trim() ?? "3020";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("MCP_PORT must be an integer between 1 and 65535.");
  }

  const bindHost = env["MCP_BIND_HOST"]?.trim() || "127.0.0.1";
  const authToken = env["MCP_AUTH_TOKEN"]?.trim() || undefined;
  if (
    authToken !== undefined &&
    new TextEncoder().encode(authToken).byteLength < MIN_AUTH_TOKEN_BYTES
  ) {
    throw new Error(
      `MCP_AUTH_TOKEN must be at least ${MIN_AUTH_TOKEN_BYTES} bytes ` +
        "and generated from cryptographically random data.",
    );
  }
  const writesRequested = booleanFlag(
    env,
    "LIVESPACE_MCP_ENABLE_WRITES",
    false,
  );
  const readOnlyKillSwitch = booleanFlag(
    env,
    "LIVESPACE_MCP_READ_ONLY",
    false,
  );
  const readOnly = !writesRequested || readOnlyKillSwitch;
  const allowUnboundWriteConfirmation = booleanFlag(
    env,
    "MCP_ALLOW_UNBOUND_WRITE_CONFIRMATION",
    false,
  );
  const extraHosts = splitHostList(env["MCP_ALLOWED_HOSTS"]);
  const extraOrigins = splitHostList(env["MCP_ALLOWED_ORIGIN_HOSTNAMES"]);

  const v2SharedAccessAcknowledged = sharedAccessFlag(env);

  const loopback = LOOPBACK_HOSTS.has(bindHost);
  if (!readOnly && authToken === undefined) {
    throw new Error(
      "LIVESPACE_MCP_ENABLE_WRITES=true requires MCP_AUTH_TOKEN, including " +
        "on loopback. Refusing to expose unauthenticated write tools.",
    );
  }
  if (!loopback) {
    // Fail closed (docs/security.md par. 2): a public bind without auth or
    // an explicit host allowlist must never boot.
    if (!authToken) {
      throw new Error(
        "MCP_BIND_HOST is not loopback, so MCP_AUTH_TOKEN is required. " +
          "Refusing to start an unauthenticated public server.",
      );
    }
    if (extraHosts.length === 0) {
      throw new Error(
        "MCP_BIND_HOST is not loopback, so MCP_ALLOWED_HOSTS is required " +
          "(comma-separated hostnames clients will use to reach this server).",
      );
    }
    // The v2 key is an integration user that sees every active record, so a
    // shared endpoint must be a stated choice, never a side effect of a bind
    // address (docs/security.md par. 2). 0.2.0 always runs with a v2 key.
    if (!v2SharedAccessAcknowledged) {
      throw new Error(
        "MCP_BIND_HOST is not loopback, so LIVESPACE_V2_SHARED_ACCESS=acknowledged " +
          "is required: every client of this server sees what the Livespace " +
          "API v2 integration user sees.",
      );
    }
  }

  const requestStateKey = env["MCP_REQUEST_STATE_KEY"]?.trim() || undefined;
  if (
    requestStateKey !== undefined &&
    new TextEncoder().encode(requestStateKey).byteLength < MIN_REQUEST_STATE_KEY_BYTES
  ) {
    throw new Error(
      `MCP_REQUEST_STATE_KEY must be at least ${MIN_REQUEST_STATE_KEY_BYTES} bytes ` +
        "(the HMAC key that signs write confirmations).",
    );
  }
  if (requestStateKey === undefined && !readOnly) {
    // Fail closed (docs/security.md par. 5): a write confirmation is only
    // single-use and unforgeable while one stable key signs it.
    throw new Error(
      "MCP_REQUEST_STATE_KEY is required when writes are enabled. Set a " +
        "random secret of at least " +
        `${MIN_REQUEST_STATE_KEY_BYTES} bytes; it signs write confirmations.`,
    );
  }

  const allowedHostnames = loopback ? [...LOCAL_HOSTNAMES, ...extraHosts] : extraHosts;
  const allowedOriginHostnames = loopback
    ? [...LOCAL_HOSTNAMES, ...extraOrigins]
    : extraOrigins.length > 0
      ? extraOrigins
      : extraHosts;
  const requestIngressTimeoutMs = positiveInt(
    env,
    "MCP_REQUEST_INGRESS_TIMEOUT_MS",
    10_000,
  );
  if (requestIngressTimeoutMs > MAX_REQUEST_INGRESS_TIMEOUT_MS) {
    throw new Error(
      "MCP_REQUEST_INGRESS_TIMEOUT_MS must not exceed " +
        `${MAX_REQUEST_INGRESS_TIMEOUT_MS} milliseconds.`,
    );
  }
  const requestExecutionTimeoutMs = positiveInt(
    env,
    "MCP_REQUEST_EXECUTION_TIMEOUT_MS",
    90_000,
  );
  if (requestExecutionTimeoutMs > MAX_REQUEST_EXECUTION_TIMEOUT_MS) {
    throw new Error(
      "MCP_REQUEST_EXECUTION_TIMEOUT_MS must not exceed " +
        `${MAX_REQUEST_EXECUTION_TIMEOUT_MS} milliseconds.`,
    );
  }

  return {
    port,
    bindHost,
    ...(authToken === undefined ? {} : { authToken }),
    readOnly,
    allowUnboundWriteConfirmation,
    allowedHostnames,
    allowedOriginHostnames,
    rateLimitPerMinute: positiveInt(env, "MCP_RATE_LIMIT_PER_MINUTE", 120),
    rateLimitBurst: positiveInt(env, "MCP_RATE_LIMIT_BURST", 30),
    maxConcurrentRequests: positiveInt(env, "MCP_MAX_CONCURRENT_REQUESTS", 8),
    maxQueuedRequests: positiveInt(env, "MCP_MAX_QUEUED_REQUESTS", 16),
    requestIngressTimeoutMs,
    requestExecutionTimeoutMs,
    ...(requestStateKey === undefined ? {} : { requestStateKey }),
    v2SharedAccessAcknowledged,
  };
}
