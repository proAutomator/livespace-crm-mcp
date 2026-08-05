import { describe, expect, test } from "bun:test";
import { buildApp } from "../../src/server/app.js";
import type { ServerConfig } from "../../src/config/server-env.js";

const BASE_CONFIG: ServerConfig = {
  port: 3020,
  bindHost: "127.0.0.1",
  readOnly: false,
  allowedHostnames: ["localhost", "127.0.0.1", "[::1]"],
  allowedOriginHostnames: ["localhost", "127.0.0.1", "[::1]"],
};

const PROTOCOL = "2026-07-28";

function meta(protocolVersion: string = PROTOCOL): Record<string, unknown> {
  return {
    "io.modelcontextprotocol/protocolVersion": protocolVersion,
    "io.modelcontextprotocol/clientInfo": {
      name: "modern-wire-test",
      version: "0.0.0",
    },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
}

interface ModernRequestOptions {
  method: string;
  params?: Record<string, unknown>;
  name?: string;
  id?: number;
  metaProtocolVersion?: string;
  headerOverrides?: Record<string, string>;
  omitHeaders?: string[];
  omitMeta?: boolean;
}

function modernRequest(options: ModernRequestOptions): Request {
  const params: Record<string, unknown> = {
    ...(options.params ?? {}),
    ...(options.omitMeta ? {} : { _meta: meta(options.metaProtocolVersion) }),
  };
  const headers: Record<string, string> = {
    host: "127.0.0.1:3020",
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": PROTOCOL,
    "mcp-method": options.method,
    ...(options.name === undefined ? {} : { "mcp-name": options.name }),
    ...(options.headerOverrides ?? {}),
  };
  for (const header of options.omitHeaders ?? []) delete headers[header];
  return new Request("http://127.0.0.1:3020/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: options.id ?? 1,
      method: options.method,
      params,
    }),
  });
}

async function jsonFromResponse(response: Response): Promise<any> {
  const text = await response.text();
  if (text.startsWith("event:") || text.includes("\ndata: ")) {
    const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
    return JSON.parse(dataLine?.slice(6) ?? "{}");
  }
  return JSON.parse(text);
}

function app() {
  return buildApp({ config: BASE_CONFIG, version: "0.0.0-test" });
}

describe("modern era (2026-07-28) wire behavior", () => {
  test("tools/list returns resultType complete and configured cache hints", async () => {
    const response = await app().request(modernRequest({ method: "tools/list" }));
    expect(response.status).toBe(200);
    const payload = await jsonFromResponse(response);
    expect(payload.result.resultType).toBe("complete");
    expect(payload.result.tools.map((t: any) => t.name)).toContain("health");
    expect(payload.result.ttlMs).toBe(60_000);
    expect(payload.result.cacheScope).toBe("private");
  });

  test("tools/list order is deterministic across requests", async () => {
    const instance = app();
    const first = await jsonFromResponse(
      await instance.request(modernRequest({ method: "tools/list" })),
    );
    const second = await jsonFromResponse(
      await instance.request(modernRequest({ method: "tools/list" })),
    );
    expect(second.result.tools.map((t: any) => t.name)).toEqual(
      first.result.tools.map((t: any) => t.name),
    );
  });

  test("tools/call health works end to end in the modern era", async () => {
    const response = await app().request(
      modernRequest({
        method: "tools/call",
        name: "health",
        params: { name: "health", arguments: {} },
        id: 2,
      }),
    );
    expect(response.status).toBe(200);
    const payload = await jsonFromResponse(response);
    expect(payload.result.resultType).toBe("complete");
    expect(payload.result.structuredContent.ok).toBe(true);
  });

  test("server/discover advertises 2026-07-28 and server identity", async () => {
    const response = await app().request(
      modernRequest({ method: "server/discover" }),
    );
    expect(response.status).toBe(200);
    const payload = await jsonFromResponse(response);
    expect(payload.result.supportedVersions).toContain(PROTOCOL);
    expect(payload.result.capabilities.tools).toBeDefined();
  });

  test("Mcp-Method header mismatching the body is rejected with -32020", async () => {
    const response = await app().request(
      modernRequest({
        method: "tools/call",
        name: "health",
        params: { name: "health", arguments: {} },
        headerOverrides: { "mcp-method": "tools/list" },
      }),
    );
    expect(response.status).toBe(400);
    const payload = await jsonFromResponse(response);
    expect(payload.error.code).toBe(-32020);
  });

  test("protocol version header disagreeing with _meta is rejected with -32020", async () => {
    const response = await app().request(
      modernRequest({ method: "tools/list", metaProtocolVersion: "2025-11-25" }),
    );
    expect(response.status).toBe(400);
    const payload = await jsonFromResponse(response);
    expect(payload.error.code).toBe(-32020);
  });

  test("missing Mcp-Method on a modern request is rejected with -32020", async () => {
    const response = await app().request(
      modernRequest({ method: "tools/list", omitHeaders: ["mcp-method"] }),
    );
    expect(response.status).toBe(400);
    const payload = await jsonFromResponse(response);
    expect(payload.error.code).toBe(-32020);
  });

  test("unsupported protocol version is rejected with -32022", async () => {
    const response = await app().request(
      modernRequest({
        method: "tools/list",
        metaProtocolVersion: "2091-01-01",
        headerOverrides: { "mcp-protocol-version": "2091-01-01" },
      }),
    );
    expect(response.status).toBe(400);
    const payload = await jsonFromResponse(response);
    expect(payload.error.code).toBe(-32022);
  });

  test("GET and DELETE on the MCP endpoint are not allowed", async () => {
    const instance = app();
    for (const method of ["GET", "DELETE"]) {
      const response = await instance.request(
        new Request("http://127.0.0.1:3020/mcp", {
          method,
          headers: { host: "127.0.0.1:3020" },
        }),
      );
      expect([405, 400]).toContain(response.status);
    }
  });
});
