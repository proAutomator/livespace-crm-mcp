# M2 Server Core - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A running, stateless Streamable HTTP MCP server (protocol 2026-07-28, dual-era) with fail-closed startup, bearer auth, Host/Origin guards, a `health` tool, instructions v1, and a `/health` endpoint.

**Architecture:** One deployment-scoped `createMcpHandler` whose factory builds a fresh `McpServer` per request (SDK-managed `server/discover`, stateless legacy fallback for 2025-era clients). A plain Hono app mounts it at `/mcp` behind three gates: Host+Origin validation (SDK helpers), optional bearer auth (mandatory on non-loopback binds, fail-closed at startup), and a request body cap. The `health` tool is the first dual-channel tool (markdown + `structuredContent`) and can optionally ping Livespace through the M1 client.

**Tech Stack:** `@modelcontextprotocol/server` 2.0.0 (exact), `hono` 4.13.0 (exact), `zod` 4.4.3 (exact). No `@modelcontextprotocol/hono` adapter - custom middleware needs plain Hono anyway (same choice as overment's template).

## Global Constraints

- All M0b+M1 global constraints still apply (English, TDD, synthetic fixtures with the "synthetic" marker, `{code, message, hint}` errors, no secrets in code/logs/errors).
- Runtime deps after this plan: exactly `@modelcontextprotocol/server`, `hono`, `zod` (docs/security.md par. 7). Pin exact versions.
- Zod idiom: `import * as z from "zod/v4"` (SDK docs canonical form). Schemas passed as `z.object({...})`, never raw shapes (raw-shape overload is deprecated).
- Register tools inside the `createMcpHandler` factory - never on a shared `McpServer` instance (SDK requirement for stateless HTTP).
- Fail-closed startup (docs/security.md par. 2 and par. 10.1): non-loopback `MCP_BIND_HOST` requires both `MCP_AUTH_TOKEN` and `MCP_ALLOWED_HOSTS`; refuse to start otherwise.
- Bearer comparison must be constant-time and portable (WebCrypto digest-then-compare, no `node:crypto`).
- HTTP tests run in-process via `app.request(...)` - no port binding, no network.
- Unit tests MUST NOT touch the network; live verification happens in the final task via `bun run dev` + curl.

**Precondition:** M0b+M1 complete on `main` (they are). If `bun run typecheck` fails after installing the SDK with a `Buffer`-related error from the SDK's `.d.mts`, run `bun add --exact --dev @types/node` and change tsconfig `types` to `["@types/bun", "node"]` - the SDK's published types reference Node globals.

---

### Task 1: Dependencies and server config with fail-closed startup

**Files:**
- Modify: `package.json` (deps via bun add)
- Create: `src/config/server-env.ts`
- Create: `tests/config/server-env.test.ts`
- Modify: `.env.example` (add `MCP_ALLOWED_HOSTS`, `MCP_ALLOWED_ORIGIN_HOSTNAMES`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `interface ServerConfig { port: number; bindHost: string; authToken?: string; readOnly: boolean; allowedHostnames: string[]; allowedOriginHostnames: string[] }` and `function loadServerConfig(env: Record<string, string | undefined>): ServerConfig` (throws on invalid/fail-closed violations). Used by Tasks 2-4.

- [ ] **Step 1: Install runtime deps with exact pins**

Run: `bun add --exact @modelcontextprotocol/server@2.0.0 hono@4.13.0 zod@4.4.3`
Expected: `dependencies` in package.json with exact versions; lockfile updated.
Then run: `bun run typecheck` - if it fails on `Buffer` in SDK `.d.mts`, apply the tsconfig contingency from Global Constraints and re-run until clean.

- [ ] **Step 2: Write the failing tests**

Create `tests/config/server-env.test.ts`:

```ts
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test tests/config/server-env.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 4: Implement `src/config/server-env.ts`**

```ts
export interface ServerConfig {
  port: number;
  bindHost: string;
  authToken?: string;
  readOnly: boolean;
  allowedHostnames: string[];
  allowedOriginHostnames: string[];
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const LOCAL_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];

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
  };
}
```

Note: the defaults test expects `toEqual` without `authToken`; the conditional spread keeps the key absent (`exactOptionalPropertyTypes` friendly).

- [ ] **Step 5: Run tests, typecheck**

Run: `bun test tests/config/server-env.test.ts && bun run typecheck`
Expected: PASS, clean.

- [ ] **Step 6: Extend `.env.example`** - append after the `LIVESPACE_MCP_READ_ONLY` block:

```bash
# Required when MCP_BIND_HOST is not loopback: hostnames clients use to reach
# this server (Host-header allowlist, DNS-rebinding protection).
MCP_ALLOWED_HOSTS=

# Optional extra browser origins allowed to call /mcp (hostnames only).
MCP_ALLOWED_ORIGIN_HOSTNAMES=
```

- [ ] **Step 7: Commit**

```bash
git add package.json bun.lockb src/config/server-env.ts tests/config/server-env.test.ts .env.example
git commit -m "feat: server config with fail-closed public bind"
```

---

### Task 2: Instructions v1 and the health tool core

**Files:**
- Create: `src/server/instructions.ts`
- Create: `src/server/tools/health.ts`
- Test: `tests/server/instructions.test.ts`
- Test: `tests/server/tools/health.test.ts`

**Interfaces:**
- Consumes: `LivespaceClient` (M1), `ServerConfig` (Task 1).
- Produces: `function buildInstructions(options: { readOnly: boolean }): string`; `const healthToolConfig` (name/config for registerTool) and `function runHealthCheck(deps: HealthDeps, args: HealthArgs): Promise<HealthResult>` where `HealthDeps = { version: string; readOnly: boolean; livespacePing?: () => Promise<{ name?: string; login?: string }> }`, `HealthArgs = { checkLivespace?: boolean }`, `HealthResult = { text: string; structured: { ok: boolean; version: string; protocol: string; readOnly: boolean; livespace?: { reachable: boolean; user?: string } } }`. Used by Task 3.

- [ ] **Step 1: Write the failing tests**

Create `tests/server/instructions.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { buildInstructions } from "../../src/server/instructions.js";

describe("buildInstructions", () => {
  test("contains the operating-manual anchors", () => {
    const text = buildInstructions({ readOnly: false });
    expect(text).toContain("Livespace");
    expect(text).toContain("CRITICAL");
    expect(text).toContain("health");
    expect(text.length).toBeGreaterThan(200);
  });

  test("read-only mode is announced when active", () => {
    expect(buildInstructions({ readOnly: true })).toContain("read-only");
    expect(buildInstructions({ readOnly: false })).not.toContain("read-only mode is ON");
  });
});
```

Create `tests/server/tools/health.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { healthToolConfig, runHealthCheck } from "../../../src/server/tools/health.js";

describe("healthToolConfig", () => {
  test("is read-only, idempotent, and closed-world", () => {
    expect(healthToolConfig.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });
});

describe("runHealthCheck", () => {
  const deps = { version: "0.0.0-test", readOnly: false };

  test("reports server status without touching Livespace by default", async () => {
    const result = await runHealthCheck(deps, {});
    expect(result.structured).toEqual({
      ok: true,
      version: "0.0.0-test",
      protocol: "2026-07-28",
      readOnly: false,
    });
    expect(result.text).toContain("ok");
    expect(result.structured.livespace).toBeUndefined();
  });

  test("checkLivespace pings through the injected client", async () => {
    const result = await runHealthCheck(
      { ...deps, livespacePing: async () => ({ name: "Test User", login: "synthetic-login" }) },
      { checkLivespace: true },
    );
    expect(result.structured.livespace).toEqual({ reachable: true, user: "Test User" });
    expect(result.text).toContain("Test User");
  });

  test("Livespace failure is reported, not thrown, and text carries the hint", async () => {
    const result = await runHealthCheck(
      {
        ...deps,
        livespacePing: async () => {
          throw Object.assign(new Error("Invalid API key (562)."), {
            hint: "Verify LIVESPACE_API_KEY (Livespace: Account settings -> API).",
          });
        },
      },
      { checkLivespace: true },
    );
    expect(result.structured.ok).toBe(false);
    expect(result.structured.livespace).toEqual({ reachable: false });
    expect(result.text).toContain("Verify LIVESPACE_API_KEY");
  });

  test("read-only mode surfaces in both channels", async () => {
    const result = await runHealthCheck({ version: "0.0.0-test", readOnly: true }, {});
    expect(result.structured.readOnly).toBe(true);
    expect(result.text).toContain("read-only");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/server`
Expected: FAIL - modules not found.

- [ ] **Step 3: Implement `src/server/instructions.ts`**

```ts
export function buildInstructions(options: { readOnly: boolean }): string {
  const readOnlyNote = options.readOnly
    ? "\nNOTE: read-only mode is ON. Write tools are disabled and not listed.\n"
    : "";

  return `Unofficial MCP server for Livespace CRM. It exposes intent-shaped tools
instead of mirroring the raw API, adds server-side sorting and aggregation the
API lacks, and returns errors with recovery hints.
${readOnlyNote}
Quick start:
- Call the "health" tool first to confirm the server and (optionally, with
  checkLivespace: true) the Livespace connection are working.
- More tools (metadata, search, records, activity, analyze, writes) arrive in
  later milestones; each describes its own inputs.

CRITICAL - Livespace facts this server enforces for you:
- Deal status (open/won/lost) is NOT the same as the process stage. Stage
  changes happen by completing process steps; dedicated tools handle that.
- Record IDs from this API differ from the IDs visible in the Livespace UI.
  Never guess IDs; always take them from tool results.
- All operations run with the permissions of the API key's user. A
  "permission denied" error is a Livespace permission issue, not a bug.

Error handling: every error carries {code, message, hint}. Follow the hint -
it names the fix or the tool to call next.`;
}
```

- [ ] **Step 4: Implement `src/server/tools/health.ts`**

```ts
import * as z from "zod/v4";

export const PROTOCOL_VERSION = "2026-07-28";

export interface HealthDeps {
  version: string;
  readOnly: boolean;
  livespacePing?: () => Promise<{ name?: string; login?: string }>;
}

export interface HealthArgs {
  checkLivespace?: boolean;
}

export interface HealthResult {
  text: string;
  structured: {
    ok: boolean;
    version: string;
    protocol: string;
    readOnly: boolean;
    livespace?: { reachable: boolean; user?: string };
  };
}

export const healthToolConfig = {
  title: "Server Health",
  description:
    "Check that this MCP server is up. Pass checkLivespace: true to also " +
    "verify the Livespace API connection (one lightweight call).",
  inputSchema: z.object({
    checkLivespace: z
      .boolean()
      .optional()
      .describe("Also ping Livespace with the configured credentials (default false)"),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    version: z.string(),
    protocol: z.string(),
    readOnly: z.boolean(),
    livespace: z
      .object({ reachable: z.boolean(), user: z.string().optional() })
      .optional(),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
} as const;

export async function runHealthCheck(
  deps: HealthDeps,
  args: HealthArgs,
): Promise<HealthResult> {
  const lines: string[] = [];
  let ok = true;
  let livespace: { reachable: boolean; user?: string } | undefined;

  if (args.checkLivespace === true && deps.livespacePing) {
    try {
      const me = await deps.livespacePing();
      livespace = me.name === undefined ? { reachable: true } : { reachable: true, user: me.name };
      lines.push(`Livespace: reachable${me.name ? ` as ${me.name}` : ""}.`);
    } catch (error) {
      ok = false;
      livespace = { reachable: false };
      const hint =
        typeof error === "object" && error !== null && "hint" in error
          ? String((error as { hint: unknown }).hint)
          : "Check credentials and connectivity.";
      lines.push(`Livespace: NOT reachable. ${hint}`);
    }
  }

  lines.unshift(
    `Server ${ok ? "ok" : "degraded"} (v${deps.version}, protocol ${PROTOCOL_VERSION})` +
      (deps.readOnly ? ", read-only mode" : ""),
  );

  return {
    text: lines.join("\n"),
    structured: {
      ok,
      version: deps.version,
      protocol: PROTOCOL_VERSION,
      readOnly: deps.readOnly,
      ...(livespace === undefined ? {} : { livespace }),
    },
  };
}
```

- [ ] **Step 5: Run tests, typecheck**

Run: `bun test tests/server && bun run typecheck`
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add src/server/instructions.ts src/server/tools/health.ts tests/server
git commit -m "feat: instructions v1 and health check core"
```

---

### Task 3: Stateless MCP HTTP server with auth and origin guards

**Files:**
- Create: `src/server/mcp.ts`
- Create: `src/server/app.ts`
- Create: `src/index.ts`
- Modify: `package.json` (add `"dev": "bun run src/index.ts"` script)
- Test: `tests/server/http.test.ts`

**Interfaces:**
- Consumes: `loadServerConfig`/`ServerConfig` (Task 1), `buildInstructions`, `healthToolConfig`, `runHealthCheck` (Task 2), `LivespaceClient` (M1), SDK: `createMcpHandler`, `McpServer`, `hostHeaderValidationResponse`, `originValidationResponse`.
- Produces: `function createServerFactory(deps: AppDeps): McpServerFactory-compatible function`; `function buildApp(deps: AppDeps): Hono` where `AppDeps = { config: ServerConfig; version: string; livespacePing?: () => Promise<{ name?: string; login?: string }> }`; `src/index.ts` boots everything with `Bun.serve`.

- [ ] **Step 1: Write the failing tests**

Create `tests/server/http.test.ts`:

```ts
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

function mcpRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://127.0.0.1:3020/mcp", {
    method: "POST",
    headers: {
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
    const response = await app.request("http://127.0.0.1:3020/health");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("ok");
    expect(JSON.stringify(body)).not.toContain("synthetic-bearer-token");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/server/http.test.ts`
Expected: FAIL - modules not found.

- [ ] **Step 3: Implement `src/server/mcp.ts`**

```ts
import { McpServer } from "@modelcontextprotocol/server";
import type { ServerConfig } from "../config/server-env.js";
import { buildInstructions } from "./instructions.js";
import { healthToolConfig, runHealthCheck } from "./tools/health.js";

export interface AppDeps {
  config: ServerConfig;
  version: string;
  livespacePing?: (() => Promise<{ name?: string; login?: string }>) | undefined;
}

// Fresh server per request (SDK requirement for stateless HTTP). Tool
// registration happens here and nowhere else.
export function createServerFactory(deps: AppDeps): () => McpServer {
  return () => {
    const server = new McpServer(
      {
        name: "livespace-mcp",
        title: "Livespace CRM (unofficial)",
        version: deps.version,
        description:
          "Unofficial MCP server for Livespace CRM: intent-shaped tools, " +
          "server-side aggregation, errors with recovery hints.",
      },
      {
        instructions: buildInstructions({ readOnly: deps.config.readOnly }),
        cacheHints: {
          "server/discover": { ttlMs: 60_000, cacheScope: "private" },
          "tools/list": { ttlMs: 60_000, cacheScope: "private" },
        },
      },
    );

    server.registerTool("health", healthToolConfig, async (args) => {
      const result = await runHealthCheck(
        {
          version: deps.version,
          readOnly: deps.config.readOnly,
          ...(deps.livespacePing ? { livespacePing: deps.livespacePing } : {}),
        },
        args,
      );
      return {
        content: [{ type: "text", text: result.text }],
        structuredContent: result.structured,
        ...(result.structured.ok ? {} : { isError: true }),
      };
    });

    return server;
  };
}
```

- [ ] **Step 4: Implement `src/server/app.ts`**

```ts
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import { Hono } from "hono";
import { createServerFactory, type AppDeps } from "./mcp.js";
import { PROTOCOL_VERSION } from "./tools/health.js";

const MAX_BODY_BYTES = 1024 * 1024;

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

// Constant-time, portable bearer comparison: compare fixed-length digests so
// neither string length nor prefix leaks through timing.
async function tokensEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < da.length; i += 1) diff |= (da[i] ?? 0) ^ (db[i] ?? 0);
  return diff === 0;
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "www-authenticate": 'Bearer realm="mcp"',
    },
  });
}

export function buildApp(deps: AppDeps) {
  const handler = createMcpHandler(createServerFactory(deps), {
    legacy: "stateless",
    responseMode: "auto",
  });

  const app = new Hono();

  app.use("*", async (c, next) => {
    const request = c.req.raw;
    const rejected =
      hostHeaderValidationResponse(request, deps.config.allowedHostnames) ??
      originValidationResponse(request, deps.config.allowedOriginHostnames);
    if (rejected) return rejected;
    await next();
  });

  app.get("/health", (c) =>
    c.json({
      status: "ok",
      version: deps.version,
      protocol: PROTOCOL_VERSION,
      readOnly: deps.config.readOnly,
      authEnabled: deps.config.authToken !== undefined,
    }),
  );

  app.all("/mcp", async (c) => {
    const request = c.req.raw;

    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (contentLength > MAX_BODY_BYTES) {
      return new Response(JSON.stringify({ error: "payload too large" }), {
        status: 413,
        headers: { "content-type": "application/json" },
      });
    }

    if (deps.config.authToken !== undefined) {
      const header = c.req.header("authorization") ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7) : "";
      if (token === "" || !(await tokensEqual(token, deps.config.authToken))) {
        return unauthorized();
      }
    }

    return handler.fetch(request);
  });

  return app;
}
```

- [ ] **Step 5: Implement `src/index.ts`**

```ts
import { loadLivespaceConfig } from "./config/env.js";
import { loadServerConfig } from "./config/server-env.js";
import { LivespaceClient } from "./livespace/client.js";
import { buildApp } from "./server/app.js";
import packageJson from "../package.json";

const serverConfig = loadServerConfig(process.env);
const livespaceConfig = loadLivespaceConfig(process.env);
const client = new LivespaceClient(livespaceConfig);

const app = buildApp({
  config: serverConfig,
  version: packageJson.version,
  livespacePing: () =>
    client.call<{ name?: string; login?: string }>("Default", "User_getInfo"),
});

const server = Bun.serve({
  hostname: serverConfig.bindHost,
  port: serverConfig.port,
  fetch: app.fetch,
});

console.error(
  `livespace-mcp v${packageJson.version} listening on ` +
    `${serverConfig.bindHost}:${serverConfig.port} ` +
    `(auth: ${serverConfig.authToken !== undefined ? "on" : "off"}, ` +
    `read-only: ${serverConfig.readOnly})`,
);

function shutdown() {
  server.stop();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
```

Add to `package.json` scripts: `"dev": "bun run src/index.ts"`.
Note: importing package.json requires tsconfig `"resolveJsonModule": true` - add it to compilerOptions if typecheck complains.

- [ ] **Step 6: Run the full suite and typecheck**

Run: `bun test && bun run typecheck`
Expected: all tests PASS (M0b+M1 suites plus the new server tests), clean typecheck.

- [ ] **Step 7: Commit**

```bash
git add src/server tests/server src/index.ts package.json bun.lockb tsconfig.json
git commit -m "feat: stateless mcp http server with auth and origin guards"
```

---

### Task 4: Live verification and docs

**Files:**
- Modify: `README.md` (Development section: dev server + curl verification)
- Modify: `.ai/PLAN.md`, `.ai/HANDOFF.md` (status)

- [ ] **Step 1: Boot the server and verify over real HTTP**

Run (background): `bun run dev`
Then:

```bash
curl -s -X POST http://127.0.0.1:3020/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
curl -s http://127.0.0.1:3020/health
```

Expected: tools/list JSON containing the `health` tool; `/health` returns `{"status":"ok",...}`. Then call the health tool with `checkLivespace: true` against the sandbox:

```bash
curl -s -X POST http://127.0.0.1:3020/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"health","arguments":{"checkLivespace":true}}}'
```

Expected: `structuredContent.livespace.reachable: true`. Stop the dev server afterwards.

- [ ] **Step 2: Update README Development section** - replace the current block with:

```markdown
## Development

```bash
bun install
bun test            # offline unit tests
bun run typecheck
bun run smoke       # LIVE Livespace API check (uses .env or macOS Keychain)
bun run dev         # start the MCP server on http://127.0.0.1:3020/mcp
```

Quick manual check once `bun run dev` is running:

```bash
curl -s -X POST http://127.0.0.1:3020/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

`bun run smoke` and the health tool's `checkLivespace` perform real API calls
with your credentials. Point them at a test instance, never at a production CRM.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: dev server run and verification instructions"
```

---

## Self-Review

1. **Spec coverage:** stateless Streamable HTTP + dual-era (`legacy: 'stateless'`) ✔; `server/discover` SDK-managed from serverInfo/instructions/cacheHints ✔; fail-closed startup (par. 10.1 test in Task 1) ✔; bearer 401 + `WWW-Authenticate` (par. 10.2) ✔; origin guard (par. 10.5) ✔; annotations enforced on the listed tool (par. 10.7, health only for now) ✔; body cap ✔; `/health` endpoint ✔; instructions v1 ✔; read-only flag parsed and surfaced (full tool-hiding enforcement lands with write tools, M6 - noted in `.ai/PLAN.md`).
2. **Placeholder scan:** all code steps complete; the two tsconfig contingencies (`@types/node`, `resolveJsonModule`) are explicit conditional instructions, not TBDs.
3. **Type consistency:** `ServerConfig` (Task 1) matches `AppDeps.config` usage (Tasks 2-3); `healthToolConfig`/`runHealthCheck` signatures match the registration in `src/server/mcp.ts`; `buildApp(deps)` consumed identically in tests and `src/index.ts`.
