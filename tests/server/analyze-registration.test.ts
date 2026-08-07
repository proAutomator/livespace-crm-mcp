import { describe, expect, test } from "bun:test";
import type { ServerConfig } from "../../src/config/server-env.js";
import type { ActivityFetchers } from "../../src/livespace/activity.js";
import type { ProcessInfo } from "../../src/livespace/metadata.js";
import type { DealRecord, ListPage, RecordFetchers } from "../../src/livespace/records.js";
import { buildApp } from "../../src/server/app.js";
import type { AppDeps } from "../../src/server/mcp.js";
import type { MetadataService } from "../../src/server/tools/crm-metadata.js";
import { deal } from "../support/records.js";

// Every value below is invented. No CRM data, no sandbox values (AGENTS.md).

const BASE_CONFIG: ServerConfig = {
  port: 3020,
  bindHost: "127.0.0.1",
  readOnly: false,
  allowUnboundWriteConfirmation: false,
  allowedHostnames: ["localhost", "127.0.0.1", "[::1]"],
  allowedOriginHostnames: ["localhost", "127.0.0.1", "[::1]"],
  rateLimitPerMinute: 6000,
  rateLimitBurst: 1000,
  maxConcurrentRequests: 16,
  maxQueuedRequests: 32,
  requestIngressTimeoutMs: 10_000,
  requestExecutionTimeoutMs: 90_000,
};

const PROTOCOL = "2026-07-28";

// app.request() sends no Host header and the transport guard fails closed, so
// every request here carries one explicitly.
function modernRequest(options: {
  method: string;
  name?: string;
  params?: Record<string, unknown>;
  id?: number;
}): Request {
  return new Request("http://127.0.0.1:3020/mcp", {
    method: "POST",
    headers: {
      host: "127.0.0.1:3020",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL,
      "mcp-method": options.method,
      ...(options.name === undefined ? {} : { "mcp-name": options.name }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: options.id ?? 1,
      method: options.method,
      params: {
        ...(options.params ?? {}),
        _meta: {
          "io.modelcontextprotocol/protocolVersion": PROTOCOL,
          "io.modelcontextprotocol/clientInfo": {
            name: "analyze-registration-test",
            version: "0.0.0",
          },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
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

function unexpectedCall(): never {
  throw new Error("fetcher not configured for this test");
}

// Process and stage names are markers: they must never reach the text channel
// (docs/security.md par. 4).
const MARKER = "SYNTHETIC-MARKER";

const PROCESSES: ProcessInfo[] = [
  {
    id: "proc-a",
    name: `${MARKER} Process A`,
    stages: [{ id: "a1", name: `${MARKER} Stage A1`, steps: [] }],
  },
  {
    id: "proc-b",
    name: `${MARKER} Process B`,
    stages: [{ id: "b1", name: `${MARKER} Stage B1`, steps: [] }],
  },
];

const OPEN_DEAL = deal({
  id: "deal-synthetic-401",
  processId: "proc-a",
  stageId: "a1",
  processName: `${MARKER} Process A`,
  stageName: `${MARKER} Stage A1`,
  value: 100,
  currency: "PLN",
  probability: 20,
});

function fakeRecords(overrides: Partial<RecordFetchers> = {}): RecordFetchers {
  return {
    listPersons: unexpectedCall,
    listCompanies: unexpectedCall,
    listDeals: unexpectedCall,
    listTasks: unexpectedCall,
    searchPhrase: unexpectedCall,
    getRecord: unexpectedCall,
    ...overrides,
  } as RecordFetchers;
}

function fakeActivity(overrides: Partial<ActivityFetchers> = {}): ActivityFetchers {
  return {
    recordWall: unexpectedCall,
    crmFeed: unexpectedCall,
    ...overrides,
  } as ActivityFetchers;
}

function fakeMetadata(counter?: { reads: number }): MetadataService {
  return {
    get: async (section: string) => {
      if (counter) counter.reads += 1;
      return {
        data: section === "processes" ? PROCESSES : [],
        asOf: 1_000,
        stale: false,
      };
    },
  } as unknown as MetadataService;
}

/** One open deal page, recording how often the deal fetcher was reached. */
function dealFetcher(counter: { calls: number }): Partial<RecordFetchers> {
  return {
    listDeals: (async (): Promise<ListPage<DealRecord>> => {
      counter.calls += 1;
      return { items: [OPEN_DEAL], hasMore: false, rawCount: 1 };
    }) as RecordFetchers["listDeals"],
  };
}

function app(deps: Partial<AppDeps> = {}) {
  return buildApp({ config: BASE_CONFIG, version: "0.0.0-test", ...deps });
}

async function listNames(instance: ReturnType<typeof app>): Promise<any[]> {
  const listed = await jsonFromResponse(
    await instance.request(modernRequest({ method: "tools/list" })),
  );
  return listed.result.tools;
}

describe("analyze registration", () => {
  test("is listed last, after the other read tools", async () => {
    const tools = await listNames(
      app({
        metadata: fakeMetadata(),
        records: fakeRecords(),
        activity: fakeActivity(),
      }),
    );
    expect(tools.map((t: any) => t.name)).toEqual([
      "health",
      "crm_metadata",
      "search_crm",
      "get_records",
      "get_activity",
      "analyze",
    ]);
    const entry = tools.find((t: any) => t.name === "analyze");
    expect(entry.annotations.readOnlyHint).toBe(true);
    expect(entry.annotations.openWorldHint).toBe(false);
  });

  test("needs both the activity fetchers and the metadata service", async () => {
    const withoutMetadata = await listNames(
      app({ records: fakeRecords(), activity: fakeActivity() }),
    );
    expect(withoutMetadata.map((t: any) => t.name)).not.toContain("analyze");

    const withoutActivity = await listNames(
      app({ metadata: fakeMetadata(), records: fakeRecords() }),
    );
    expect(withoutActivity.map((t: any) => t.name)).not.toContain("analyze");
  });

  test("answers a pipeline_summary call end to end", async () => {
    const counter = { calls: 0 };
    const instance = app({
      metadata: fakeMetadata(),
      records: fakeRecords(dealFetcher(counter)),
      activity: fakeActivity(),
    });
    const response = await instance.request(
      modernRequest({
        method: "tools/call",
        name: "analyze",
        params: {
          name: "analyze",
          arguments: { analysis: "pipeline_summary" },
        },
        id: 20,
      }),
    );
    expect(response.status).toBe(200);
    const payload = await jsonFromResponse(response);
    expect(payload.result.resultType).toBe("complete");
    expect(payload.result.isError).toBeUndefined();

    const structured = payload.result.structuredContent;
    expect(structured.analysis).toBe("pipeline_summary");
    expect(structured.pipelineSummary.totalOpenDeals).toBe(1);
    expect(structured.pipelineSummary.processes.length).toBe(2);
    expect(structured.pipelineSummary.basedOn.deals).toEqual({
      fetched: 1,
      truncated: false,
    });
    expect(structured.errors).toEqual([]);

    // Counts only: no process or stage name reaches the markdown channel.
    const text = payload.result.content[0].text;
    expect(text).toBe(
      "analyze pipeline_summary: 1 open deals across 2 processes (truncated: false).",
    );
    expect(text).not.toContain(MARKER);
  });

  test("record data is never cached: two identical analyze calls hit upstream twice", async () => {
    // docs/security.md par. 8: only dictionary data may be cached, so the deal
    // sweep must run again while the metadata service may answer from one read.
    const counter = { calls: 0 };
    const reads = { reads: 0 };
    const instance = app({
      metadata: fakeMetadata(reads),
      records: fakeRecords(dealFetcher(counter)),
      activity: fakeActivity(),
    });
    const request = () =>
      instance.request(
        modernRequest({
          method: "tools/call",
          name: "analyze",
          params: { name: "analyze", arguments: { analysis: "pipeline_summary" } },
          id: 21,
        }),
      );
    await request();
    await request();
    expect(counter.calls).toBe(2);
    expect(reads.reads).toBeGreaterThan(0);
  });

  test("the aggregation modules never reach for the cache", async () => {
    // The import path differs per directory ("../cache.js" vs "../../server/
    // cache.js"), so the scan is a regex rather than a fixed string.
    for (const path of [
      "../../src/livespace/aggregate.ts",
      "../../src/server/tools/analyze.ts",
    ]) {
      const source = await Bun.file(new URL(path, import.meta.url)).text();
      expect(source).not.toMatch(/from\s+"[^"]*cache\.js"/u);
    }
  });
});
