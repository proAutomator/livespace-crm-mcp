import { describe, expect, test } from "bun:test";
import { buildApp } from "../../src/server/app.js";
import type { ServerConfig } from "../../src/config/server-env.js";

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

async function captureStderr<T>(
  scenario: () => Promise<T>,
): Promise<{ value: T; lines: string[] }> {
  const real = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]): void => {
    lines.push(args.map(String).join(" "));
  };
  try {
    return { value: await scenario(), lines };
  } finally {
    console.error = real;
  }
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

  test("bearer auth: every rejected form gets 401 with the exact challenge", async () => {
    const config = { ...BASE_CONFIG, authToken: "synthetic-bearer-token" };
    const app = buildApp({ config, version: "0.0.0-test" });

    const rejectedHeaders: Array<Record<string, string>> = [
      {},
      { authorization: "Bearer synthetic-wrong-token" },
      { authorization: "Bearer " },
      { authorization: "Basic synthetic-basic-token" },
    ];
    for (const headers of rejectedHeaders) {
      const response = await app.request(mcpRequest(TOOLS_LIST, headers));
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe('Bearer realm="mcp"');
    }
  });

  test("bearer auth: correct token passes", async () => {
    const config = { ...BASE_CONFIG, authToken: "synthetic-bearer-token" };
    const app = buildApp({ config, version: "0.0.0-test" });
    const response = await app.request(
      mcpRequest(TOOLS_LIST, { authorization: "Bearer synthetic-bearer-token" }),
    );
    expect(response.status).toBe(200);
  });

  test("failed bearer attempts are rate limited without blocking the valid token", async () => {
    const config = {
      ...BASE_CONFIG,
      authToken: "synthetic-bearer-token",
      rateLimitPerMinute: 60,
      rateLimitBurst: 2,
    };
    const app = buildApp({ config, version: "0.0.0-test" });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const rejected = await app.request(
        mcpRequest(TOOLS_LIST, {
          authorization: `Bearer synthetic-wrong-token-${attempt}`,
        }),
      );
      expect(rejected.status).toBe(401);
    }

    const limited = await app.request(
      mcpRequest(TOOLS_LIST, {
        authorization: "Bearer synthetic-wrong-token-over-limit",
      }),
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/u);

    const accepted = await app.request(
      mcpRequest(TOOLS_LIST, {
        authorization: "Bearer synthetic-bearer-token",
      }),
    );
    expect(accepted.status).toBe(200);
  });

  test("oversized bodies get 413", async () => {
    const app = buildApp({ config: BASE_CONFIG, version: "0.0.0-test" });
    const response = await app.request(
      mcpRequest(TOOLS_LIST, { "content-length": String(2 * 1024 * 1024) }),
    );
    expect(response.status).toBe(413);
  });

  test("requests beyond the rate limit get 429 with Retry-After", async () => {
    const config = { ...BASE_CONFIG, rateLimitPerMinute: 60, rateLimitBurst: 2 };
    const app = buildApp({ config, version: "0.0.0-test" });
    expect((await app.request(mcpRequest(TOOLS_LIST))).status).toBe(200);
    expect((await app.request(mcpRequest(TOOLS_LIST))).status).toBe(200);
    const limited = await app.request(mcpRequest(TOOLS_LIST));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
  });

  test("chunked body over the cap gets 413 even without Content-Length", async () => {
    const app = buildApp({ config: BASE_CONFIG, version: "0.0.0-test" });
    const big = new Uint8Array(2 * 1024 * 1024).fill(120);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(big);
        controller.close();
      },
    });
    const response = await app.request(
      new Request("http://127.0.0.1:3020/mcp", {
        method: "POST",
        headers: {
          host: "127.0.0.1:3020",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body,
      }),
    );
    expect(response.status).toBe(413);
  });

  test("buffering a normal MCP body preserves client cancellation", async () => {
    const started = Promise.withResolvers<AbortSignal | undefined>();
    const releasePing = Promise.withResolvers<void>();
    const app = buildApp({
      config: BASE_CONFIG,
      version: "0.0.0-test",
      livespacePing: async (opts) => {
        started.resolve(opts?.signal);
        await releasePing.promise;
        if (opts?.signal?.aborted) {
          throw new DOMException("synthetic client disconnected", "AbortError");
        }
        return {};
      },
    });
    const controller = new AbortController();
    const request = new Request("http://127.0.0.1:3020/mcp", {
      method: "POST",
      headers: {
        host: "127.0.0.1:3020",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "health", arguments: { checkLivespace: true } },
      }),
      signal: controller.signal,
    });

    const pending = app.request(request);
    const forwardedSignal = await started.promise;
    controller.abort("synthetic client disconnected");
    await Promise.resolve();
    try {
      expect(forwardedSignal).toBeInstanceOf(AbortSignal);
      expect(forwardedSignal?.aborted).toBe(true);
    } finally {
      releasePing.resolve();
      await pending;
    }
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

  test("upstream bodies and bearer tokens reach neither results nor stderr", async () => {
    const bearer = "synthetic-bearer-token-log-marker";
    const rejectedBearer = "synthetic-rejected-bearer-log-marker";
    const upstream = "SENSITIVE-synthetic-upstream-body";
    const app = buildApp({
      config: { ...BASE_CONFIG, authToken: bearer },
      version: "0.0.0-test",
      livespacePing: async () => {
        throw new Error(`${upstream} ${bearer}`);
      },
    });

    const { value, lines } = await captureStderr(async () => {
      const rejected = await app.request(
        mcpRequest(TOOLS_LIST, { authorization: `Bearer ${rejectedBearer}` }),
      );
      const tool = await app.request(
        mcpRequest(
          {
            jsonrpc: "2.0",
            id: 9,
            method: "tools/call",
            params: { name: "health", arguments: { checkLivespace: true } },
          },
          { authorization: `Bearer ${bearer}` },
        ),
      );
      return { rejected: await rejected.text(), tool: await tool.text() };
    });

    const visible = `${value.rejected}\n${value.tool}\n${lines.join("\n")}`;
    expect(visible).not.toContain(upstream);
    expect(visible).not.toContain(bearer);
    expect(visible).not.toContain(rejectedBearer);
    expect(lines).toEqual([]);
  });
});
