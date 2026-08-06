import { describe, expect, test } from "bun:test";
import { loadServerConfig } from "../../src/config/server-env.js";

/** 38 bytes - the codec refuses anything under 32 (AGENTS.md: synthetic). */
const REQUEST_STATE_KEY = "synthetic-request-state-key-0123456789";

describe("loadServerConfig", () => {
  test("defaults: loopback bind, port 3020, no auth, read-write", () => {
    const config = loadServerConfig({});
    expect(config).toEqual({
      port: 3020,
      bindHost: "127.0.0.1",
      readOnly: false,
      allowedHostnames: ["localhost", "127.0.0.1", "[::1]"],
      allowedOriginHostnames: ["localhost", "127.0.0.1", "[::1]"],
      rateLimitPerMinute: 120,
      rateLimitBurst: 30,
      maxConcurrentRequests: 8,
      maxQueuedRequests: 16,
    });
    expect(config.authToken).toBeUndefined();
  });

  test("rate limit knobs parse and validate", () => {
    const config = loadServerConfig({
      MCP_RATE_LIMIT_PER_MINUTE: "300",
      MCP_RATE_LIMIT_BURST: "50",
      MCP_MAX_CONCURRENT_REQUESTS: "4",
      MCP_MAX_QUEUED_REQUESTS: "8",
    });
    expect(config.rateLimitPerMinute).toBe(300);
    expect(config.rateLimitBurst).toBe(50);
    expect(config.maxConcurrentRequests).toBe(4);
    expect(config.maxQueuedRequests).toBe(8);
    expect(() => loadServerConfig({ MCP_RATE_LIMIT_BURST: "0" })).toThrow(
      /MCP_RATE_LIMIT_BURST/,
    );
    expect(() => loadServerConfig({ MCP_MAX_CONCURRENT_REQUESTS: "-1" })).toThrow(
      /MCP_MAX_CONCURRENT_REQUESTS/,
    );
  });

  test("parses port, read-only flag, and auth token", () => {
    const config = loadServerConfig({
      MCP_PORT: "4100",
      LIVESPACE_MCP_READ_ONLY: "true",
      MCP_AUTH_TOKEN: "synthetic-bearer-token",
      MCP_REQUEST_STATE_KEY: REQUEST_STATE_KEY,
    });
    expect(config.port).toBe(4100);
    expect(config.readOnly).toBe(true);
    expect(config.authToken).toBe("synthetic-bearer-token");
    expect(config.requestStateKey).toBe(REQUEST_STATE_KEY);
  });

  test("fail-closed: non-loopback bind without MCP_AUTH_TOKEN throws", () => {
    expect(() => loadServerConfig({ MCP_BIND_HOST: "0.0.0.0" })).toThrow(
      /MCP_AUTH_TOKEN/,
    );
  });

  test("fail-closed: non-loopback bind without MCP_ALLOWED_HOSTS throws", () => {
    expect(() =>
      loadServerConfig({
        MCP_BIND_HOST: "0.0.0.0",
        MCP_AUTH_TOKEN: "synthetic-bearer-token",
      }),
    ).toThrow(/MCP_ALLOWED_HOSTS/);
  });

  test("non-loopback bind with token, hosts and a state key is accepted", () => {
    const config = loadServerConfig({
      MCP_BIND_HOST: "0.0.0.0",
      MCP_AUTH_TOKEN: "synthetic-bearer-token",
      MCP_ALLOWED_HOSTS: "mcp.example.com, alt.example.com",
      MCP_REQUEST_STATE_KEY: REQUEST_STATE_KEY,
    });
    expect(config.allowedHostnames).toEqual(["mcp.example.com", "alt.example.com"]);
  });

  test("a request-state key shorter than 32 bytes is refused", () => {
    expect(() =>
      loadServerConfig({ MCP_REQUEST_STATE_KEY: "synthetic-short-key" }),
    ).toThrow(/MCP_REQUEST_STATE_KEY/);
  });

  test("fail-closed: an authenticated server needs MCP_REQUEST_STATE_KEY", () => {
    expect(() =>
      loadServerConfig({ MCP_AUTH_TOKEN: "synthetic-bearer-token" }),
    ).toThrow(/MCP_REQUEST_STATE_KEY/);
  });

  test("fail-closed: a non-loopback bind needs MCP_REQUEST_STATE_KEY", () => {
    expect(() =>
      loadServerConfig({
        MCP_BIND_HOST: "0.0.0.0",
        MCP_AUTH_TOKEN: "synthetic-bearer-token",
        MCP_ALLOWED_HOSTS: "mcp.example.com",
      }),
    ).toThrow(/MCP_REQUEST_STATE_KEY/);
  });

  test("loopback development without a key boots on the process-local fallback", () => {
    const config = loadServerConfig({});
    expect(config.requestStateKey).toBeUndefined();
  });

  test("extra origin hostnames merge with defaults on loopback", () => {
    const config = loadServerConfig({
      MCP_ALLOWED_ORIGIN_HOSTNAMES: "app.example.com",
    });
    expect(config.allowedOriginHostnames).toContain("app.example.com");
    expect(config.allowedOriginHostnames).toContain("localhost");
  });

  test("rejects invalid port", () => {
    expect(() => loadServerConfig({ MCP_PORT: "not-a-port" })).toThrow(/MCP_PORT/);
    expect(() => loadServerConfig({ MCP_PORT: "70000" })).toThrow(/MCP_PORT/);
  });
});
