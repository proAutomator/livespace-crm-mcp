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
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const LOCAL_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];

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

  const allowedHostnames = loopback ? [...LOCAL_HOSTNAMES, ...extraHosts] : extraHosts;
  const allowedOriginHostnames = loopback
    ? [...LOCAL_HOSTNAMES, ...extraOrigins]
    : extraOrigins.length > 0
      ? extraOrigins
      : extraHosts;

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
  };
}
