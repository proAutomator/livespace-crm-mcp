export interface ServerConfig {
  port: number;
  bindHost: string;
  authToken?: string;
  readOnly: boolean;
  allowedHostnames: string[];
  allowedOriginHostnames: string[];
  rateLimitPerMinute: number;
  rateLimitBurst: number;
  maxConcurrentRequests: number;
  maxQueuedRequests: number;
  /** Absolute budget shared by admission queueing and request-body upload. */
  requestIngressTimeoutMs: number;
  /**
   * HMAC secret for the write-confirmation `requestState`. Absent only in
   * loopback development, where the codec falls back to a per-process random
   * key (see `buildWriteCodec`).
   */
  requestStateKey?: string;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const LOCAL_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];

const MIN_AUTH_TOKEN_BYTES = 32;
/** The SDK's codec refuses a shorter one, and so does startup. */
const MIN_REQUEST_STATE_KEY_BYTES = 32;
const MAX_REQUEST_INGRESS_TIMEOUT_MS = 60_000;

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
  const readOnly = env["LIVESPACE_MCP_READ_ONLY"]?.trim().toLowerCase() === "true";
  const extraHosts = splitHostList(env["MCP_ALLOWED_HOSTS"]);
  const extraOrigins = splitHostList(env["MCP_ALLOWED_ORIGIN_HOSTNAMES"]);

  const loopback = LOOPBACK_HOSTS.has(bindHost);
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
  if (requestStateKey === undefined && (authToken !== undefined || !loopback)) {
    // Fail closed (docs/security.md par. 5): a write confirmation is only
    // single-use and unforgeable while one stable key signs it. The random
    // per-process fallback is a loopback development convenience and nothing
    // more - it dies with the process and never spans two of them.
    throw new Error(
      "MCP_REQUEST_STATE_KEY is required once the server is authenticated or " +
        "bound off loopback. Set a random secret of at least " +
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

  return {
    port,
    bindHost,
    ...(authToken === undefined ? {} : { authToken }),
    readOnly,
    allowedHostnames,
    allowedOriginHostnames,
    rateLimitPerMinute: positiveInt(env, "MCP_RATE_LIMIT_PER_MINUTE", 120),
    rateLimitBurst: positiveInt(env, "MCP_RATE_LIMIT_BURST", 30),
    maxConcurrentRequests: positiveInt(env, "MCP_MAX_CONCURRENT_REQUESTS", 8),
    maxQueuedRequests: positiveInt(env, "MCP_MAX_QUEUED_REQUESTS", 16),
    requestIngressTimeoutMs,
    ...(requestStateKey === undefined ? {} : { requestStateKey }),
  };
}
