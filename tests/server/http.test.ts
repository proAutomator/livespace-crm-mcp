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

function mcpRequest(
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request("http://127.0.0.1:3020/mcp", {
    method: "POST",
    headers: {
      // app.request() does not synthesize a Host header the way a real HTTP
      // stack does, and the host guard correctly fails closed without one.
      host: "127.0.0.1:3020",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const TOOLS_LIST = { jsonrpc: "2.0", id: 1, method: "tools/list" };

async function jsonFromResponse(response: Response): Promise<any> {
  const text = await response.text();
  if (text.startsWith("event:") || text.includes("\ndata: ")) {
    const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
    return JSON.parse(dataLine?.slice(6) ?? "{}");
  }
  return JSON.parse(text);
}

describe("MCP HTTP surface", () => {
  test("tools/list exposes the health tool with annotations", async () => {
    const app = buildApp({ config: BASE_CONFIG, version: "0.0.0-test" });
    const response = await app.request(mcpRequest(TOOLS_LIST));
    expect(response.status).toBe(200);
    const payload = await jsonFromResponse(response);
    const tools = payload.result.tools;
    expect(tools.map((t: any) => t.name)).toContain("health");
    const health = tools.find((t: any) => t.name === "health");
    expect(health.annotations.readOnlyHint).toBe(true);
  });

  test("tools/call health returns dual-channel result", async () => {
    const app = buildApp({ config: BASE_CONFIG, version: "0.0.0-test" });
    const response = await app.request(
      mcpRequest({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "health", arguments: {} },
      }),
    );
    const payload = await jsonFromResponse(response);
    expect(payload.result.structuredContent.ok).toBe(true);
    expect(payload.result.content[0].text).toContain("ok");
  });

  test("unknown Origin is rejected", async () => {
    const app = buildApp({ config: BASE_CONFIG, version: "0.0.0-test" });
    const response = await app.request(
      mcpRequest(TOOLS_LIST, { origin: "https://evil.example.com" }),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  test("localhost Origin passes", async () => {
    const app = buildApp({ config: BASE_CONFIG, version: "0.0.0-test" });
    const response = await app.request(
      mcpRequest(TOOLS_LIST, { origin: "http://localhost:3020" }),
    );
    expect(response.status).toBe(200);
  });

  test("bearer auth: missing and wrong tokens get 401 with WWW-Authenticate", async () => {
    const config = { ...BASE_CONFIG, authToken: "synthetic-bearer-token" };
    const app = buildApp({ config, version: "0.0.0-test" });

    const missing = await app.request(mcpRequest(TOOLS_LIST));
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toContain("Bearer");

    const wrong = await app.request(
      mcpRequest(TOOLS_LIST, { authorization: "Bearer synthetic-wrong-token" }),
    );
    expect(wrong.status).toBe(401);
  });

  test("bearer auth: correct token passes", async () => {
    const config = { ...BASE_CONFIG, authToken: "synthetic-bearer-token" };
    const app = buildApp({ config, version: "0.0.0-test" });
    const response = await app.request(
      mcpRequest(TOOLS_LIST, { authorization: "Bearer synthetic-bearer-token" }),
    );
    expect(response.status).toBe(200);
  });

  test("oversized bodies get 413", async () => {
    const app = buildApp({ config: BASE_CONFIG, version: "0.0.0-test" });
    const response = await app.request(
      mcpRequest(TOOLS_LIST, { "content-length": String(2 * 1024 * 1024) }),
    );
    expect(response.status).toBe(413);
  });

  test("GET /health reports status without secrets", async () => {
    const config = { ...BASE_CONFIG, authToken: "synthetic-bearer-token" };
    const app = buildApp({ config, version: "0.0.0-test" });
    const response = await app.request(
      new Request("http://127.0.0.1:3020/health", {
        headers: { host: "127.0.0.1:3020" },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("ok");
    expect(JSON.stringify(body)).not.toContain("synthetic-bearer-token");
  });
});
