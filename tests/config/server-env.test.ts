import { describe, expect, test } from "bun:test";
import { loadServerConfig } from "../../src/config/server-env.js";

describe("loadServerConfig", () => {
  test("defaults: loopback bind, port 3020, no auth, read-write", () => {
    const config = loadServerConfig({});
    expect(config).toEqual({
      port: 3020,
      bindHost: "127.0.0.1",
      readOnly: false,
      allowedHostnames: ["localhost", "127.0.0.1", "[::1]"],
      allowedOriginHostnames: ["localhost", "127.0.0.1", "[::1]"],
    });
    expect(config.authToken).toBeUndefined();
  });

  test("parses port, read-only flag, and auth token", () => {
    const config = loadServerConfig({
      MCP_PORT: "4100",
      LIVESPACE_MCP_READ_ONLY: "true",
      MCP_AUTH_TOKEN: "synthetic-bearer-token",
    });
    expect(config.port).toBe(4100);
    expect(config.readOnly).toBe(true);
    expect(config.authToken).toBe("synthetic-bearer-token");
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

  test("non-loopback bind with token and hosts is accepted", () => {
    const config = loadServerConfig({
      MCP_BIND_HOST: "0.0.0.0",
      MCP_AUTH_TOKEN: "synthetic-bearer-token",
      MCP_ALLOWED_HOSTS: "mcp.example.com, alt.example.com",
    });
    expect(config.allowedHostnames).toEqual(["mcp.example.com", "alt.example.com"]);
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
