import { describe, expect, test } from "bun:test";
import { buildApp } from "../../src/server/app.js";
import type { ServerConfig } from "../../src/config/server-env.js";

const BASE_CONFIG: ServerConfig = {
  port: 3020,
  bindHost: "127.0.0.1",
  readOnly: false,
  allowUnboundWriteConfirmation: false,
  allowedHostnames: ["localhost", "127.0.0.1", "[::1]"],
  allowedOriginHostnames: ["localhost", "127.0.0.1", "[::1]"],
  // Generous limits so ordinary tests never trip the limiter.
  rateLimitPerMinute: 6000,
  rateLimitBurst: 1000,
  maxConcurrentRequests: 16,
  maxQueuedRequests: 32,
  requestIngressTimeoutMs: 10_000,
  requestExecutionTimeoutMs: 90_000,
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
  test("legacy calls reject unsupported health and metadata arguments before executing", async () => {
    let calls = 0;
    const instance = buildApp({
      config: BASE_CONFIG, version: "0.0.0-test",
      livespacePing: async () => { calls++; return {}; },
      metadata: { get: (async () => { calls++; return { data: [], asOf: 0, stale: false }; }) as never },
    });
    for (const name of ["health", "crm_metadata"]) {
      const args = name === "health" ? { checkLivespace: true, typo: true } : { sections: ["users"], typo: true };
      const payload = await jsonFromResponse(await instance.request(mcpRequest({
        jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args },
      })));
      expect(payload.error).toBeUndefined();
      expect(payload.result.isError).toBe(true);
      expect(payload.result.structuredContent).toBeUndefined();
      expect(payload.result.content[0].text).toContain("Input validation error");
    }
    expect(calls).toBe(0);
  });

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

  test("MCP responses cannot be cached and vary by authorization", async () => {
    const app = buildApp({ config: BASE_CONFIG, version: "0.0.0-test" });
    const response = await app.request(mcpRequest(TOOLS_LIST));
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("vary")).toContain("Authorization");
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

  test("rejects a JSON-RPC batch before any tool work", async () => {
    let calls = 0;
    const app = buildApp({
      config: {
        ...BASE_CONFIG,
        rateLimitPerMinute: 60,
        rateLimitBurst: 1,
        maxConcurrentRequests: 1,
      },
      version: "0.0.0-test",
      livespacePing: async () => {
        calls += 1;
        return {};
      },
    });
    const batch = Array.from({ length: 20 }, (_, index) => ({
      jsonrpc: "2.0",
      id: index + 1,
      method: "tools/call",
      params: { name: "health", arguments: { checkLivespace: true } },
    }));

    const response = await app.request(mcpRequest(batch));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      error: {
        code: -32600,
        message: "Bad Request: JSON-RPC batches are not supported by this endpoint",
      },
      id: null,
    });
    expect(calls).toBe(0);
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

  test("an absolute ingress deadline bounds a stalled body and releases its slot", async () => {
    const config = {
      ...BASE_CONFIG,
      maxConcurrentRequests: 1,
      maxQueuedRequests: 1,
      requestIngressTimeoutMs: 100,
    };
    const app = buildApp({ config, version: "0.0.0-test" });
    let source: ReadableStreamDefaultController<Uint8Array> | undefined;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller;
        controller.enqueue(new TextEncoder().encode("{"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const stalled = new Request("http://127.0.0.1:3020/mcp", {
      method: "POST",
      headers: {
        host: "127.0.0.1:3020",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body,
    });

    const stalledResponse = app.request(stalled);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const queuedResponse = app.request(mcpRequest(TOOLS_LIST));
    const settled = Promise.all([stalledResponse, queuedResponse]);
    const responses = await Promise.race([
      settled,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
    ]);

    if (responses === null) {
      source?.close();
      await settled;
    }
    expect(responses).not.toBeNull();
    expect(responses?.[0]?.status).toBe(408);
    expect(await responses?.[0]?.json()).toEqual({ error: "request_timeout" });
    expect(responses?.[1]?.status).toBe(200);
    expect(cancelled).toBe(true);
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

  test("the execution deadline aborts tool work after body upload", async () => {
    let observedSignal: AbortSignal | undefined;
    const startedAt = Date.now();
    const app = buildApp({
      config: { ...BASE_CONFIG, requestExecutionTimeoutMs: 50 },
      version: "0.0.0-test",
      livespacePing: async (opts) => {
        observedSignal = opts?.signal;
        await Promise.race([
          new Promise<void>((resolve) =>
            opts?.signal?.addEventListener("abort", () => resolve(), { once: true }),
          ),
          Bun.sleep(250),
        ]);
        if (opts?.signal?.aborted) {
          throw new DOMException("synthetic execution deadline", "TimeoutError");
        }
        return {};
      },
    });

    const response = await app.request(
      mcpRequest({
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: { name: "health", arguments: { checkLivespace: true } },
      }),
    );
    await response.text();
    expect(observedSignal?.aborted).toBe(true);
    expect(observedSignal?.reason).toBeDefined();
    expect(Date.now() - startedAt).toBeLessThan(200);
  });

  test("cancelling response consumption aborts the forwarded tool signal", async () => {
    const started = Promise.withResolvers<AbortSignal | undefined>();
    const app = buildApp({
      config: BASE_CONFIG,
      version: "0.0.0-test",
      livespacePing: async (opts) => {
        started.resolve(opts?.signal);
        await new Promise<void>((resolve) =>
          opts?.signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
        throw new DOMException("synthetic response cancelled", "AbortError");
      },
    });
    const response = await app.request(
      mcpRequest({
        jsonrpc: "2.0",
        id: 12,
        method: "tools/call",
        params: { name: "health", arguments: { checkLivespace: true } },
      }),
    );
    const signal = await started.promise;
    await response.body?.cancel("synthetic response cancelled");
    expect(signal?.aborted).toBe(true);
  });

  test("a streamed tool response keeps its admission slot until completion", async () => {
    const started = Promise.withResolvers<AbortSignal | undefined>();
    const config = {
      ...BASE_CONFIG,
      maxConcurrentRequests: 1,
      maxQueuedRequests: 1,
      requestExecutionTimeoutMs: 1_000,
    };
    const app = buildApp({
      config,
      version: "0.0.0-test",
      livespacePing: async (opts) => {
        started.resolve(opts?.signal);
        await new Promise<void>((resolve) =>
          opts?.signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
        throw new DOMException("synthetic response cancelled", "AbortError");
      },
    });
    const first = await app.request(
      mcpRequest({
        jsonrpc: "2.0",
        id: 13,
        method: "tools/call",
        params: { name: "health", arguments: { checkLivespace: true } },
      }),
    );
    await started.promise;

    const queued = Promise.resolve(app.request(mcpRequest(TOOLS_LIST)));
    const early = await Promise.race([
      queued.then(() => "resolved" as const),
      Bun.sleep(25).then(() => "waiting" as const),
    ]);
    expect(early).toBe("waiting");

    await first.body?.cancel("synthetic response cancelled");
    expect((await queued).status).toBe(200);
  });

  test("an execution deadline releases a streamed response slot", async () => {
    const started = Promise.withResolvers<void>();
    const config = {
      ...BASE_CONFIG,
      maxConcurrentRequests: 1,
      maxQueuedRequests: 1,
      requestExecutionTimeoutMs: 50,
    };
    const app = buildApp({
      config,
      version: "0.0.0-test",
      livespacePing: async (opts) => {
        started.resolve();
        await new Promise<void>((resolve) =>
          opts?.signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
        throw new DOMException("synthetic execution deadline", "TimeoutError");
      },
    });
    const first = await app.request(
      mcpRequest({
        jsonrpc: "2.0",
        id: 14,
        method: "tools/call",
        params: { name: "health", arguments: { checkLivespace: true } },
      }),
    );
    await started.promise;

    const queued = Promise.resolve(app.request(mcpRequest(TOOLS_LIST)));
    const second = await Promise.race([
      queued,
      Bun.sleep(300).then(() => undefined),
    ]);
    expect(second?.status).toBe(200);
    await first.body?.cancel("synthetic cleanup");
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
    expect(body).toEqual({ status: "ok" });
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
