import { describe, expect, test } from "bun:test";
import { buildApp } from "../../src/server/app.js";
import type { ServerConfig } from "../../src/config/server-env.js";
import type { MetadataService } from "../../src/server/tools/crm-metadata.js";

const BASE_CONFIG: ServerConfig = {
  port: 3020,
  bindHost: "127.0.0.1",
  readOnly: false,
  allowedHostnames: ["localhost", "127.0.0.1", "[::1]"],
  allowedOriginHostnames: ["localhost", "127.0.0.1", "[::1]"],
  // Generous limits so ordinary tests never trip the limiter.
  rateLimitPerMinute: 6000,
  rateLimitBurst: 1000,
  maxConcurrentRequests: 16,
  maxQueuedRequests: 32,
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

function app(metadata?: MetadataService) {
  return buildApp({
    config: BASE_CONFIG,
    version: "0.0.0-test",
    ...(metadata ? { metadata } : {}),
  });
}

// Fully synthetic dictionary data; `read` may throw to simulate a section
// failure.
function fakeMetadata(read: (section: string) => unknown): MetadataService {
  return {
    get: async (section: string) => ({
      data: read(section),
      asOf: 1_000,
      stale: false,
    }),
  } as unknown as MetadataService;
}

const SYNTHETIC_CURRENT_USER = {
  id: "user-synthetic-1",
  name: "Synthetic User",
  email: "synthetic.user@example.invalid",
  position: "Synthetic Position",
  permissions: { contact_add: true },
  teams: [],
};

function syntheticSection(section: string): unknown {
  if (section === "currentUser") return SYNTHETIC_CURRENT_USER;
  if (section === "sources") return ["Synthetic Source"];
  return [];
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

describe("crm_metadata wiring", () => {
  test("is listed and callable when a metadata service is configured", async () => {
    const instance = app(fakeMetadata(syntheticSection));

    const listed = await jsonFromResponse(
      await instance.request(modernRequest({ method: "tools/list" })),
    );
    expect(listed.result.tools.map((t: any) => t.name)).toEqual([
      "health",
      "crm_metadata",
    ]);
    const entry = listed.result.tools.find(
      (t: any) => t.name === "crm_metadata",
    );
    expect(entry.annotations.readOnlyHint).toBe(true);
    expect(entry.annotations.openWorldHint).toBe(false);

    const response = await instance.request(
      modernRequest({
        method: "tools/call",
        name: "crm_metadata",
        params: {
          name: "crm_metadata",
          arguments: { sections: ["currentUser"] },
        },
        id: 3,
      }),
    );
    expect(response.status).toBe(200);
    const payload = await jsonFromResponse(response);
    expect(payload.result.resultType).toBe("complete");
    expect(payload.result.structuredContent.sections.currentUser.data.name).toBe(
      "Synthetic User",
    );
    expect(payload.result.structuredContent.errors).toEqual([]);
  });

  test("is not listed when no metadata service is configured", async () => {
    const listed = await jsonFromResponse(
      await app().request(modernRequest({ method: "tools/list" })),
    );
    expect(listed.result.tools.map((t: any) => t.name)).toEqual(["health"]);
  });

  test("every listed tool carries the four annotation booleans", async () => {
    const listed = await jsonFromResponse(
      await app(fakeMetadata(syntheticSection)).request(
        modernRequest({ method: "tools/list" }),
      ),
    );
    expect(listed.result.tools.length).toBeGreaterThan(1);
    for (const tool of listed.result.tools) {
      expect(tool.annotations).toBeDefined();
      for (const hint of [
        "readOnlyHint",
        "destructiveHint",
        "idempotentHint",
        "openWorldHint",
      ]) {
        expect(typeof tool.annotations[hint]).toBe("boolean");
      }
    }
  });

  test("an unexpected upstream failure never leaks its text over the wire", async () => {
    const instance = app(
      fakeMetadata(() => {
        throw new Error("SENSITIVE-synthetic upstream body");
      }),
    );
    const response = await instance.request(
      modernRequest({
        method: "tools/call",
        name: "crm_metadata",
        params: {
          name: "crm_metadata",
          arguments: { sections: ["currentUser"] },
        },
        id: 4,
      }),
    );
    expect(response.status).toBe(200);
    const raw = await response.text();
    expect(raw).not.toContain("SENSITIVE-synthetic");
    const dataLine = raw.split("\n").find((line) => line.startsWith("data: "));
    const payload = JSON.parse(dataLine ? dataLine.slice(6) : raw);
    expect(payload.result.isError).toBe(true);
  });
});
