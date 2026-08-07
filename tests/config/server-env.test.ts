import { describe, expect, test } from "bun:test";
import { loadServerConfig } from "../../src/config/server-env.js";

/** 38 bytes - the codec refuses anything under 32 (AGENTS.md: synthetic). */
const REQUEST_STATE_KEY = "synthetic-request-state-key-0123456789";
/** 33 bytes - authenticated startup refuses anything under 32. */
const AUTH_TOKEN = "synthetic-bearer-token-0123456789";

describe("loadServerConfig", () => {
  test("defaults: loopback bind, port 3020, no auth, read-only", () => {
    const config = loadServerConfig({});
    expect(config).toEqual({
      port: 3020,
      bindHost: "127.0.0.1",
      readOnly: true,
      allowUnboundWriteConfirmation: false,
      allowedHostnames: ["localhost", "127.0.0.1", "[::1]"],
      allowedOriginHostnames: ["localhost", "127.0.0.1", "[::1]"],
      rateLimitPerMinute: 120,
      rateLimitBurst: 30,
      maxConcurrentRequests: 8,
      maxQueuedRequests: 16,
      requestIngressTimeoutMs: 10_000,
      requestExecutionTimeoutMs: 90_000,
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

  test("request ingress timeout parses and stays within the hard maximum", () => {
    const config = loadServerConfig({ MCP_REQUEST_INGRESS_TIMEOUT_MS: "25000" });
    expect(config.requestIngressTimeoutMs).toBe(25_000);
    expect(() =>
      loadServerConfig({ MCP_REQUEST_INGRESS_TIMEOUT_MS: "0" }),
    ).toThrow(/MCP_REQUEST_INGRESS_TIMEOUT_MS/);
    expect(() =>
      loadServerConfig({ MCP_REQUEST_INGRESS_TIMEOUT_MS: "60001" }),
    ).toThrow(/MCP_REQUEST_INGRESS_TIMEOUT_MS/);
  });

  test("request execution timeout parses and stays within the hard maximum", () => {
    const config = loadServerConfig({ MCP_REQUEST_EXECUTION_TIMEOUT_MS: "120000" });
    expect(config.requestExecutionTimeoutMs).toBe(120_000);
    expect(() =>
      loadServerConfig({ MCP_REQUEST_EXECUTION_TIMEOUT_MS: "0" }),
    ).toThrow(/MCP_REQUEST_EXECUTION_TIMEOUT_MS/);
    expect(() =>
      loadServerConfig({ MCP_REQUEST_EXECUTION_TIMEOUT_MS: "300001" }),
    ).toThrow(/MCP_REQUEST_EXECUTION_TIMEOUT_MS/);
  });

  test("parses port, read-only flag, and auth token", () => {
    const config = loadServerConfig({
      MCP_PORT: "4100",
      LIVESPACE_MCP_READ_ONLY: "true",
      MCP_AUTH_TOKEN: AUTH_TOKEN,
      MCP_REQUEST_STATE_KEY: REQUEST_STATE_KEY,
    });
    expect(config.port).toBe(4100);
    expect(config.readOnly).toBe(true);
    expect(config.authToken).toBe(AUTH_TOKEN);
    expect(config.requestStateKey).toBe(REQUEST_STATE_KEY);
  });

  test("writes need an explicit opt-in plus authentication", () => {
    expect(() =>
      loadServerConfig({ LIVESPACE_MCP_ENABLE_WRITES: "true" }),
    ).toThrow(/MCP_AUTH_TOKEN/);

    const config = loadServerConfig({
      LIVESPACE_MCP_ENABLE_WRITES: "true",
      MCP_AUTH_TOKEN: AUTH_TOKEN,
      MCP_REQUEST_STATE_KEY: REQUEST_STATE_KEY,
    });
    expect(config.readOnly).toBe(false);
  });

  test("the read-only kill switch wins over a write opt-in", () => {
    const config = loadServerConfig({
      LIVESPACE_MCP_ENABLE_WRITES: "true",
      LIVESPACE_MCP_READ_ONLY: "true",
    });
    expect(config.readOnly).toBe(true);
  });

  test("security booleans are strict and unbound confirmation defaults off", () => {
    expect(() =>
      loadServerConfig({ LIVESPACE_MCP_ENABLE_WRITES: "yes" }),
    ).toThrow(/LIVESPACE_MCP_ENABLE_WRITES/);
    expect(() =>
      loadServerConfig({ LIVESPACE_MCP_READ_ONLY: "1" }),
    ).toThrow(/LIVESPACE_MCP_READ_ONLY/);
    expect(() =>
      loadServerConfig({ MCP_ALLOW_UNBOUND_WRITE_CONFIRMATION: "on" }),
    ).toThrow(/MCP_ALLOW_UNBOUND_WRITE_CONFIRMATION/);

    const config = loadServerConfig({
      MCP_ALLOW_UNBOUND_WRITE_CONFIRMATION: "true",
    });
    expect(config.allowUnboundWriteConfirmation).toBe(true);
  });

  test("an auth token shorter than 32 bytes is refused", () => {
    expect(() =>
      loadServerConfig({
        MCP_AUTH_TOKEN: "synthetic-short-token",
        MCP_REQUEST_STATE_KEY: REQUEST_STATE_KEY,
      }),
    ).toThrow(/MCP_AUTH_TOKEN.*32 bytes/u);
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
        MCP_AUTH_TOKEN: AUTH_TOKEN,
      }),
    ).toThrow(/MCP_ALLOWED_HOSTS/);
  });

  test("non-loopback bind with token, hosts and a state key is accepted", () => {
    const config = loadServerConfig({
      MCP_BIND_HOST: "0.0.0.0",
      MCP_AUTH_TOKEN: AUTH_TOKEN,
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

  test("an authenticated read-only server does not need write state", () => {
    const config = loadServerConfig({ MCP_AUTH_TOKEN: AUTH_TOKEN });
    expect(config.readOnly).toBe(true);
    expect(config.requestStateKey).toBeUndefined();
  });

  test("fail-closed: write-enabled startup needs MCP_REQUEST_STATE_KEY", () => {
    expect(() =>
      loadServerConfig({
        LIVESPACE_MCP_ENABLE_WRITES: "true",
        MCP_AUTH_TOKEN: AUTH_TOKEN,
      }),
    ).toThrow(/MCP_REQUEST_STATE_KEY/);
  });

  test("loopback read-only development does not build write state", () => {
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
