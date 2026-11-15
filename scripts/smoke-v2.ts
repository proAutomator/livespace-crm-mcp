import { fileURLToPath } from "node:url";
import { loadLivespaceConfig } from "../src/config/env.js";
import { LivespaceError } from "../src/livespace/errors.js";
import { LivespaceV2Client } from "../src/livespace/v2/client.js";
import { MEDIA_MINIMAL } from "../src/livespace/v2/media-types.js";
import { V2_METADATA_SECTIONS } from "../src/livespace/v2/metadata.js";

// Read-only live check of API v2. Run it against a demo or sandbox account
// only, never a production CRM. It reads LIVESPACE_SUBDOMAIN and
// LIVESPACE_API_V2_KEY from the environment (Bun loads a local .env, or a
// secret manager can inject them) and runs in two parts:
//
// 1. The client alone: `GET /users/me` and one deal search (two logical
//    requests; a read may retry a transport failure).
// 2. The real server: `src/index.ts` started as a child process in read-only
//    mode on loopback, then `health` and `crm_metadata` called over HTTP, one
//    dictionary section at a time. About 35 requests in all. The child gets
//    its settings from this script alone: it does not load a `.env` file.
//
// Output is statuses and counts only: never record content, never the key.
// This script's output may land in terminals, CI logs or transcripts.

const PROTOCOL = "2026-07-28";
const WRITE_TOOLS = [
  "create_records",
  "update_records",
  "move_deals_to_stage",
  "log_activities",
  "notify_user",
];

class SmokeFailure extends Error {}

function requestIdState(requestId: string | null): string {
  return requestId === null ? "missing" : "present";
}

function present(value: unknown): string {
  return typeof value === "string" && value !== "" ? "present" : "missing";
}

async function checkClient(): Promise<void> {
  const config = loadLivespaceConfig({
    LIVESPACE_SUBDOMAIN: process.env["LIVESPACE_SUBDOMAIN"],
    LIVESPACE_API_V2_KEY: process.env["LIVESPACE_API_V2_KEY"],
    LIVESPACE_V2_DAILY_RESERVE: process.env["LIVESPACE_V2_DAILY_RESERVE"],
  });
  const client = new LivespaceV2Client({
    subdomain: config.subdomain,
    apiKey: config.v2ApiKey,
    dailyReserve: config.dailyReserve,
  });

  // A success from the client is a 2xx; the contract lists only 200 for both.
  const me = await client.request<Record<string, unknown>>(
    { method: "GET", path: "/users/me" },
    { essential: true },
  );
  console.log(`GET /users/me: 200, requestId ${requestIdState(me.requestId)}`);

  // A search is a read sent as POST: `write: false` lets it retry.
  const deals = await client.request<unknown[]>(
    { method: "POST", path: "/deals/searches", body: { perPage: 1 }, accept: MEDIA_MINIMAL },
    { write: false },
  );
  const total = deals.extra["totalCount"];
  const rows = Array.isArray(deals.data) ? deals.data.length : "not a list";
  console.log(
    `POST /deals/searches: 200, totalCount ${typeof total === "number" ? total : "missing"}, ` +
      `rows ${rows}, requestId ${requestIdState(deals.requestId)}`,
  );
  console.log(`dailyRemaining: ${client.rateLimit().dailyRemaining ?? "unknown"}`);
}

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

/** One modern-era MCP request to the local server; SSE or plain JSON back. */
async function mcp(
  base: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const name = typeof params["name"] === "string" ? params["name"] : undefined;
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL,
      "mcp-method": method,
      ...(name === undefined ? {} : { "mcp-name": name }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": PROTOCOL,
          "io.modelcontextprotocol/clientInfo": { name: "smoke-v2", version: "0.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  let payload: unknown;
  try {
    payload = JSON.parse(dataLine === undefined ? text : dataLine.slice(6));
  } catch {
    payload = undefined;
  }
  const result = (payload as { result?: unknown } | undefined)?.result;
  if (response.status !== 200 || result === null || typeof result !== "object") {
    // The body may quote tool output, so only the status is printed.
    throw new SmokeFailure(`${method} answered HTTP ${response.status} without a result`);
  }
  return result as Record<string, unknown>;
}

async function callTool(
  base: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  return (await mcp(base, "tools/call", { name, arguments: args })) as ToolResult;
}

/** `health` with the Livespace check; returns the daily budget it reports. */
async function dailyRemaining(base: string): Promise<number | null> {
  const health = await callTool(base, "health", { checkLivespace: true });
  const livespace = health.structuredContent?.["livespace"] as
    | Record<string, unknown>
    | undefined;
  if (livespace?.["reachable"] !== true) {
    throw new SmokeFailure("health: Livespace API v2 is not reachable through the server");
  }
  const left = livespace["dailyRemaining"];
  return typeof left === "number" ? left : null;
}

async function waitUntilUp(base: string, child: { exitCode: number | null }): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new SmokeFailure("the server exited during startup");
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await Bun.sleep(200);
  }
  throw new SmokeFailure("the server did not answer /health within 10 s");
}

async function checkServer(): Promise<void> {
  const port = process.env["SMOKE_V2_PORT"]?.trim() || "3049";
  const base = `http://127.0.0.1:${port}`;
  // Only what the server needs, and `--no-env-file` below, so neither the
  // caller's environment nor a local `.env` can switch writes, a bearer token
  // or a network bind on. No v1 pair: the v2 tools stand alone.
  const env: Record<string, string> = {
    LIVESPACE_MCP_READ_ONLY: "true",
    MCP_BIND_HOST: "127.0.0.1",
    MCP_PORT: port,
    // The run makes about 35 MCP calls in a row; the defaults allow a burst of 30.
    MCP_RATE_LIMIT_PER_MINUTE: "600",
    MCP_RATE_LIMIT_BURST: "100",
  };
  for (const name of [
    "LIVESPACE_SUBDOMAIN",
    "LIVESPACE_API_V2_KEY",
    "LIVESPACE_V2_DAILY_RESERVE",
    "LIVESPACE_ACTING_USER_EMAIL",
  ]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "run",
      fileURLToPath(new URL("../src/index.ts", import.meta.url)),
    ],
    { env, stdout: "ignore", stderr: "ignore" },
  );
  // `finally` does not run when this process is signalled, and an orphaned
  // server would keep the port and the key in memory.
  const stopOnSignal = (): void => {
    child.kill();
    process.exit(130);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, stopOnSignal);
  }
  // A server that answers while the child is gone is somebody else's.
  const ownServer = (): void => {
    if (child.exitCode !== null) {
      throw new SmokeFailure(
        `the server exited; if port ${port} is taken, set SMOKE_V2_PORT to a free one`,
      );
    }
  };

  try {
    await waitUntilUp(base, child);
    await Bun.sleep(300);
    ownServer();

    const listed = await mcp(base, "tools/list");
    const tools = Array.isArray(listed["tools"])
      ? listed["tools"].map((tool) => String((tool as { name?: unknown }).name))
      : [];
    console.log(`server tools (read-only, no v1 pair): ${tools.join(", ")}`);
    if (!tools.includes("health") || !tools.includes("crm_metadata")) {
      throw new SmokeFailure("health and crm_metadata must be listed");
    }
    if (tools.some((tool) => WRITE_TOOLS.includes(tool))) {
      throw new SmokeFailure("a write tool is listed in read-only mode");
    }

    const health = await callTool(base, "health", { checkLivespace: true });
    const structured = health.structuredContent ?? {};
    const livespace = (structured["livespace"] ?? {}) as Record<string, unknown>;
    const backend = (structured["backend"] ?? {}) as Record<string, unknown>;
    const acting = !("actingUser" in livespace)
      ? "not checked"
      : livespace["actingUser"] === null
        ? "none"
        : "resolved";
    console.log(
      `health: ok ${structured["ok"] === true}, readOnly ${structured["readOnly"] === true}, ` +
        `backend ${String(backend["api"])}, v1Fallback ${backend["v1Fallback"] === true}, ` +
        `reachable ${livespace["reachable"] === true}, ` +
        `integrationUser ${present(livespace["integrationUser"])}, ` +
        `timeZone ${present(livespace["timeZone"])}, actingUser ${acting}, ` +
        `dailyRemaining ${typeof livespace["dailyRemaining"] === "number" ? livespace["dailyRemaining"] : "unknown"}, ` +
        `dailyReserve ${String(livespace["dailyReserve"])}`,
    );
    if (structured["ok"] !== true || livespace["reachable"] !== true) {
      throw new SmokeFailure("health did not reach Livespace API v2");
    }

    // One section per call on a cold cache. The cost of a section is the drop
    // of the account's daily budget around it, minus the one request the
    // following `health` spends itself. Another integration working on the
    // account at the same moment would inflate a count. The baseline is a
    // second `health`: with an acting user configured the first one also read
    // the user list, after it took its own count (so `users` then costs 0).
    let before = await dailyRemaining(base);
    let failed = 0;
    let spent = 0;
    for (const section of V2_METADATA_SECTIONS) {
      const result = await callTool(base, "crm_metadata", { sections: [section] });
      const sections = (result.structuredContent?.["sections"] ?? {}) as Record<
        string,
        Record<string, unknown>
      >;
      const errors = (result.structuredContent?.["errors"] ?? []) as Array<
        Record<string, unknown>
      >;
      const after = await dailyRemaining(base);
      const requests = before === null || after === null ? null : before - after - 1;
      before = after;
      if (requests !== null) spent += requests;
      const envelope = sections[section];
      if (envelope === undefined) {
        failed += 1;
        console.log(
          `crm_metadata ${section}: ERROR ${String(errors[0]?.["code"] ?? "unknown")}, ` +
            `requests ${requests ?? "unknown"}`,
        );
        continue;
      }
      const items =
        typeof envelope["totalItems"] === "number" ? `items ${envelope["totalItems"]}, ` : "";
      console.log(
        `crm_metadata ${section}: ok, ${items}truncated ${envelope["truncated"] === true}, ` +
          `stale ${envelope["stale"] === true}, hint ${typeof envelope["hint"] === "string" ? "yes" : "no"}, ` +
          `requests ${requests ?? "unknown"}`,
      );
    }

    const all = await callTool(base, "crm_metadata", {});
    const allSections = Object.keys(
      (all.structuredContent?.["sections"] ?? {}) as Record<string, unknown>,
    ).length;
    const after = await dailyRemaining(base);
    const cached = before === null || after === null ? null : before - after - 1;
    console.log(
      `crm_metadata all sections: ${allSections}/${V2_METADATA_SECTIONS.length} ok, ` +
        `requests ${cached ?? "unknown"} (served from the cache)`,
    );
    console.log(`crm_metadata total on a cold cache: ${spent} requests`);
    console.log(`dailyRemaining: ${after ?? "unknown"}`);

    ownServer();
    if (failed > 0 || allSections !== V2_METADATA_SECTIONS.length) {
      throw new SmokeFailure(`${failed} section(s) failed`);
    }
  } finally {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.off(signal, stopOnSignal);
    }
    child.kill();
    await child.exited;
  }
}

try {
  await checkClient();
  await checkServer();
  console.log("smoke-v2: OK");
} catch (error) {
  // A LivespaceError carries only our fixed wording (docs/security.md par. 6),
  // and a SmokeFailure only what this script wrote itself.
  if (error instanceof LivespaceError) {
    console.error(`smoke-v2: ${error.code} - ${error.message}`);
  } else if (error instanceof SmokeFailure) {
    console.error(`smoke-v2: ${error.message}`);
  } else {
    console.error("smoke-v2: unexpected failure");
  }
  process.exit(1);
}
