import { describe, expect, test } from "bun:test";
import { buildApp } from "../../src/server/app.js";
import type { ServerConfig } from "../../src/config/server-env.js";
import { MAX_TOOL_INPUT_ELEMENTS, type AppDeps } from "../../src/server/mcp.js";
import type { V1MetadataService as MetadataService } from "../../src/server/v1-metadata.js";
import type { ActivityFetchers } from "../../src/livespace/activity.js";
import type { RecordFetchers } from "../../src/livespace/records.js";
import type { RecordReader } from "../../src/livespace/v2/records.js";
import type { DealStepReader } from "../../src/livespace/stage-moves.js";
import type { WriteFetchers } from "../../src/livespace/writes.js";
import { person, wallEntry } from "../support/records.js";
import { healthPing } from "../support/health.js";
import { fakeV2Metadata } from "../support/metadata.js";
import { personV2 } from "../support/v2-records.js";
import { fakeRecordReader, fakeTimeline } from "../support/v2-reader.js";

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
  v2SharedAccessAcknowledged: false,
  // 44 ASCII bytes, invented: it keeps the write codec off its per-process
  // random fallback so nothing here depends on a startup warning.
  requestStateKey: "synthetic-request-state-key-0123456789-abcd",
};

const PROTOCOL = "2026-07-28";

function meta(
  protocolVersion: string = PROTOCOL,
  clientCapabilities: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    "io.modelcontextprotocol/protocolVersion": protocolVersion,
    "io.modelcontextprotocol/clientInfo": {
      name: "modern-wire-test",
      version: "0.0.0",
    },
    "io.modelcontextprotocol/clientCapabilities": clientCapabilities,
  };
}

interface ModernRequestOptions {
  method: string;
  params?: Record<string, unknown>;
  name?: string;
  id?: number;
  metaProtocolVersion?: string;
  clientCapabilities?: Record<string, unknown>;
  headerOverrides?: Record<string, string>;
  omitHeaders?: string[];
  omitMeta?: boolean;
}

function modernRequest(options: ModernRequestOptions): Request {
  const params: Record<string, unknown> = {
    ...(options.params ?? {}),
    ...(options.omitMeta
      ? {}
      : { _meta: meta(options.metaProtocolVersion, options.clientCapabilities) }),
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

function app(deps: Partial<AppDeps> = {}) {
  return buildApp({ config: BASE_CONFIG, version: "0.0.0-test", ...deps });
}

// Fully synthetic record and activity fetchers. Only the members a given test
// exercises are overridden; everything else throws so an unexpected upstream
// call is loud rather than silently empty.
function unexpectedCall(): never {
  throw new Error("fetcher not configured for this test");
}

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

// Write fetchers that never write: the sweeps below only need the five write
// tools to be REGISTERED, and a call that reached one would be a loud failure.
function fakeWrites(): WriteFetchers {
  const never =
    (method: string) =>
    async (): Promise<never> => {
      throw new Error(`unexpected write call: ${method}`);
    };
  return {
    createPerson: never("createPerson"),
    createCompany: never("createCompany"),
    createDeal: never("createDeal"),
    createTask: never("createTask"),
    updatePerson: never("updatePerson"),
    updateCompany: never("updateCompany"),
    updateDeal: never("updateDeal"),
    updateTask: never("updateTask"),
    addNote: never("addNote"),
    addCall: never("addCall"),
    moveDealSteps: never("moveDealSteps"),
    sendNotification: never("sendNotification"),
    findPersonByEmail: never("findPersonByEmail"),
    findCompanyByName: never("findCompanyByName"),
  } as unknown as WriteFetchers;
}

// The deal step reader `move_deals_to_stage` plans from; registration is all
// the sweeps need, so an actual read is a loud failure here too.
function fakeDealSteps(): DealStepReader {
  return {
    readStepState: async () => {
      throw new Error("unexpected step-state read");
    },
  };
}

/** The account subdomain notification deep links are built from. */
const SUBDOMAIN = "synthetic";

// Fully synthetic dictionary data; `read` may throw to simulate a section
// failure.
function fakeV1Metadata(read: (section: string) => unknown = () => []): MetadataService {
  return {
    get: async (section: string) => ({
      data: read(section),
      asOf: 1_000,
      stale: false,
    }),
  } as unknown as MetadataService;
}

const SYNTHETIC_CURRENT_USER = {
  integrationLogin: "synthetic-integration",
  timeZone: "Europe/Warsaw",
  actingUser: {
    id: "user-synthetic-1",
    name: "Synthetic User",
    email: "synthetic.user@example.invalid",
  },
};

// API v2 dictionary data for crm_metadata; unnamed sections answer empty.
function syntheticSection(section: string): unknown {
  if (section === "currentUser") return SYNTHETIC_CURRENT_USER;
  if (section === "sources") {
    return [{ id: "source-synthetic-1", name: "Synthetic Source", parentId: null }];
  }
  return undefined;
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
    expect(payload.result.structuredContent.backend).toEqual({ api: "v2", v1Fallback: false });
    expect(payload.result.structuredContent.livespace).toBeUndefined();
  });

  test("health with checkLivespace reports the v2 backend over the wire", async () => {
    const response = await app({
      v1Fallback: true,
      livespace: healthPing(async () => ({})),
    }).request(
      modernRequest({
        method: "tools/call",
        name: "health",
        params: { name: "health", arguments: { checkLivespace: true } },
        id: 3,
      }),
    );
    expect(response.status).toBe(200);
    const payload = await jsonFromResponse(response);
    expect(payload.result.isError).toBeUndefined();
    expect(payload.result.structuredContent.backend).toEqual({ api: "v2", v1Fallback: true });
    expect(payload.result.structuredContent.livespace).toEqual({
      reachable: true,
      integrationUser: "synthetic-integration",
      timeZone: "Europe/Warsaw",
      actingUser: null,
      dailyRemaining: null,
      dailyReserve: 5000,
      hint: expect.stringContaining("LIVESPACE_ACTING_USER_EMAIL"),
    });
    // The login and the time zone are upstream text: structured channel only.
    expect(payload.result.content[0].text).not.toContain("synthetic-integration");
    expect(payload.result.content[0].text).not.toContain("Europe/Warsaw");
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

  // SDK 2.0.0 served this request; 2.1.0 and later refuse it before dispatch.
  test("missing MCP-Protocol-Version on a modern request is rejected before tool work", async () => {
    let calls = 0;
    const response = await app({
      livespace: healthPing(async () => {
        calls += 1;
        return {};
      }),
    }).request(
      modernRequest({
        method: "tools/call",
        name: "health",
        params: { name: "health", arguments: { checkLivespace: true } },
        omitHeaders: ["mcp-protocol-version"],
      }),
    );
    expect(response.status).toBe(400);
    const payload = await jsonFromResponse(response);
    expect(payload.error.code).toBe(-32020);
    expect(calls).toBe(0);
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
  test("health and metadata reject unknown arguments before any dependency call", async () => {
    let calls = 0;
    const instance = app({
      livespace: healthPing(async () => { calls++; return {}; }),
      metadata: fakeV2Metadata(() => { calls++; return []; }),
    });
    const listed = await jsonFromResponse(await instance.request(modernRequest({ method: "tools/list" })));
    for (const name of ["health", "crm_metadata"]) {
      expect(listed.result.tools.find((tool: any) => tool.name === name).inputSchema.additionalProperties).toBe(false);
      const args = name === "health" ? { checkLivespace: true, unexpected: true } : { sections: ["users"], unexpected: true };
      const payload = await jsonFromResponse(await instance.request(modernRequest({
        method: "tools/call", name, params: { name, arguments: args },
      })));
      expect(payload.error).toBeUndefined();
      expect(payload.result.isError).toBe(true);
      expect(payload.result.structuredContent).toBeUndefined();
      expect(payload.result.content[0].text).toContain("Input validation error");
    }
    expect(calls).toBe(0);
  });

  test("userQuery reaches metadata and returns only matching users", async () => {
    const sections: string[] = [];
    const instance = app({ metadata: fakeV2Metadata((section) => {
      sections.push(section);
      return [
        { id: "synthetic-user-1", name: "Synthetic Alice", email: "alice@synthetic.example", team: null },
        { id: "synthetic-user-2", name: "Synthetic Bob", email: "bob@synthetic.example", team: null },
      ];
    }) });
    const payload = await jsonFromResponse(await instance.request(modernRequest({
      method: "tools/call", name: "crm_metadata",
      params: { name: "crm_metadata", arguments: { userQuery: " ALICE@ " } },
    })));
    expect(payload.result.isError).toBeUndefined();
    expect(Object.keys(payload.result.structuredContent.sections)).toEqual(["users"]);
    expect(payload.result.structuredContent.sections.users.data.map((user: any) => user.id)).toEqual(["synthetic-user-1"]);
    expect(sections).toEqual(["users"]);
  });

  test("is listed and callable when a metadata service is configured", async () => {
    const instance = app({ metadata: fakeV2Metadata(syntheticSection),
      v1Metadata: fakeV1Metadata() });

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
    expect(payload.result.structuredContent.sections.currentUser.data.actingUser.name).toBe(
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

  test("every listed tool carries its exact security annotations", async () => {
    const listed = await jsonFromResponse(
      await app({
        metadata: fakeV2Metadata(syntheticSection),
      v1Metadata: fakeV1Metadata(),
        records: fakeRecords(),
        recordReader: fakeRecordReader(),
        timeline: fakeTimeline(),
        activity: fakeActivity(),
        writes: fakeWrites(),
        dealSteps: fakeDealSteps(),
        subdomain: SUBDOMAIN,
      }).request(modernRequest({ method: "tools/list" })),
    );
    const read = {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    };
    const expected: Record<string, Record<string, boolean>> = {
      health: read,
      crm_metadata: read,
      search_crm: read,
      get_records: read,
      get_activity: read,
      analyze: read,
      create_records: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      update_records: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      log_activities: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      move_deals_to_stage: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      notify_user: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    };
    const checked: string[] = [];
    for (const tool of listed.result.tools) {
      expect(tool.annotations).toEqual(expected[tool.name]);
      checked.push(tool.name);
    }
    expect(checked).toEqual(Object.keys(expected));
  });

  test("read-only mode keeps the surface at the six read tools", async () => {
    const listed = await jsonFromResponse(
      await buildApp({
        config: { ...BASE_CONFIG, readOnly: true },
        version: "0.0.0-test",
        metadata: fakeV2Metadata(syntheticSection),
      v1Metadata: fakeV1Metadata(),
        records: fakeRecords(),
        recordReader: fakeRecordReader(),
        timeline: fakeTimeline(),
        activity: fakeActivity(),
        writes: fakeWrites(),
        dealSteps: fakeDealSteps(),
        subdomain: SUBDOMAIN,
      }).request(modernRequest({ method: "tools/list" })),
    );
    expect(listed.result.tools.map((t: any) => t.name)).toEqual([
      "health",
      "crm_metadata",
      "search_crm",
      "get_records",
      "get_activity",
      "analyze",
    ]);
  });

  test("an elicitation-capable client gets input_required from a write tool", async () => {
    // The capability travels in the request's own `_meta` envelope, so the
    // helper has to be able to declare it.
    const payload = await jsonFromResponse(
      await app({
        metadata: fakeV2Metadata(syntheticSection),
      v1Metadata: fakeV1Metadata(),
        records: fakeRecords(),
        recordReader: fakeRecordReader(),
        timeline: fakeTimeline(),
        activity: fakeActivity(),
        writes: fakeWrites(),
      }).request(
        modernRequest({
          method: "tools/call",
          name: "create_records",
          clientCapabilities: { elicitation: {} },
          params: {
            name: "create_records",
            arguments: { persons: [{ firstname: "Synthetic Given" }] },
          },
          id: 30,
        }),
      ),
    );
    expect(payload.result.resultType).toBe("input_required");
    expect(payload.result.inputRequests.confirm.method).toBe("elicitation/create");
  });

  test("an unexpected upstream failure never leaks its text over the wire", async () => {
    const instance = app({
      metadata: fakeV2Metadata(() => {
        throw new Error("SENSITIVE-synthetic upstream body");
      }),
    });
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

describe("read tool wiring", () => {
  function fullApp(overrides: Partial<AppDeps> = {}) {
    return app({
      metadata: fakeV2Metadata(syntheticSection),
      v1Metadata: fakeV1Metadata(),
      records: fakeRecords(),
        recordReader: fakeRecordReader(),
        timeline: fakeTimeline(),
      activity: fakeActivity(),
      ...overrides,
    });
  }

  async function listNames(instance: ReturnType<typeof app>): Promise<string[]> {
    const listed = await jsonFromResponse(
      await instance.request(modernRequest({ method: "tools/list" })),
    );
    return listed.result.tools.map((t: any) => t.name);
  }

  test("all six tools are listed in registration order", async () => {
    const listed = await jsonFromResponse(
      await fullApp().request(modernRequest({ method: "tools/list" })),
    );
    expect(listed.result.tools.map((t: any) => t.name)).toEqual([
      "health",
      "crm_metadata",
      "search_crm",
      "get_records",
      "get_activity",
      "analyze",
    ]);
    expect(listed.result.tools.length).toBe(6);
  });

  test("without record fetchers only health and crm_metadata are listed", async () => {
    const names = await listNames(
      app({ metadata: fakeV2Metadata(syntheticSection),
      v1Metadata: fakeV1Metadata(), activity: fakeActivity() }),
    );
    expect(names).toEqual(["health", "crm_metadata"]);
  });

  test("the API v2 deps alone list search_crm and get_records", async () => {
    // No v1 key pair: the two record tools read API v2 and need nothing else.
    const names = await listNames(
      app({
        metadata: fakeV2Metadata(syntheticSection),
        recordReader: fakeRecordReader(),
        timeline: fakeTimeline(),
      }),
    );
    expect(names).toEqual(["health", "crm_metadata", "search_crm", "get_records"]);
  });

  test("search_crm needs the dictionaries and get_records the timeline lists", async () => {
    expect(await listNames(app({ recordReader: fakeRecordReader() }))).toEqual(["health"]);
    expect(
      await listNames(app({ recordReader: fakeRecordReader(), timeline: fakeTimeline() })),
    ).toEqual(["health", "get_records"]);
  });

  test("records without activity keep get_records but drop get_activity", async () => {
    const names = await listNames(
      app({ metadata: fakeV2Metadata(syntheticSection),
      v1Metadata: fakeV1Metadata(), records: fakeRecords(), recordReader: fakeRecordReader(), timeline: fakeTimeline() }),
    );
    expect(names).toEqual([
      "health",
      "crm_metadata",
      "search_crm",
      "get_records",
    ]);
  });

  test("search_crm answers a phrase call end to end", async () => {
    const instance = fullApp({
      recordReader: fakeRecordReader({
        phrase: async () => ({
          hits: [
            {
              kind: "person",
              id: "00000000-0000-4000-8000-000000000101",
              name: "SYNTHETIC Person",
              url: null,
              company: null,
            },
          ],
          totalCount: 1,
          rowCount: 1,
        }),
      }),
    });
    const payload = await jsonFromResponse(
      await instance.request(
        modernRequest({
          method: "tools/call",
          name: "search_crm",
          params: {
            name: "search_crm",
            arguments: { kinds: ["persons"], phrase: "synthetic" },
          },
          id: 10,
        }),
      ),
    );
    expect(payload.result.resultType).toBe("complete");
    expect(payload.result.structuredContent.results.persons.returned).toBe(1);
    expect(payload.result.structuredContent.phrase.totalCount).toBe(1);
    expect(payload.result.structuredContent.errors).toEqual([]);
    // CRM text stays in the structured channel.
    expect(payload.result.content[0].text).not.toContain("SYNTHETIC");
  });

  // GHSA-jm63-cq47-j5jp: a shared server or transport matched responses to
  // clients by JSON-RPC id alone, and SDK clients all start counting at 0.
  // Two calls with the same id, both in flight at once, must each get their own.
  test("overlapping calls with the same JSON-RPC id each get their own result", async () => {
    let arrived = 0;
    let releaseBoth: () => void = () => undefined;
    const bothArrived = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const instance = fullApp({
      recordReader: fakeRecordReader({
        phrase: async ({ q }) => {
          arrived += 1;
          if (arrived === 2) releaseBoth();
          await bothArrived;
          return {
            hits: [{ kind: "person", id: `person-${q}`, name: q, url: null, company: null }],
            totalCount: 1,
            rowCount: 1,
          };
        },
      }),
    });
    const call = (phrase: string) =>
      instance.request(
        modernRequest({
          method: "tools/call",
          name: "search_crm",
          params: { name: "search_crm", arguments: { kinds: ["persons"], phrase } },
          id: 0,
        }),
      );
    const responses = await Promise.all([call("alpha-synthetic"), call("bravo-synthetic")]);
    const names = await Promise.all(
      responses.map(async (response) => {
        expect(response.status).toBe(200);
        const payload = await jsonFromResponse(response);
        expect(payload.id).toBe(0);
        return payload.result.structuredContent.results.persons.hits[0].name;
      }),
    );
    expect(names).toEqual(["alpha-synthetic", "bravo-synthetic"]);
  });

  test("get_records answers a batch call end to end", async () => {
    const instance = fullApp({
      recordReader: fakeRecordReader({
        get: (async (_kind: string, id: string) => personV2({ id })) as RecordReader["get"],
      }),
    });
    const payload = await jsonFromResponse(
      await instance.request(
        modernRequest({
          method: "tools/call",
          name: "get_records",
          params: {
            name: "get_records",
            arguments: { kind: "person", ids: ["00000000-0000-4000-8000-000000000101"] },
          },
          id: 11,
        }),
      ),
    );
    expect(payload.result.resultType).toBe("complete");
    expect(payload.result.structuredContent.summary).toEqual({
      requested: 1,
      ok: 1,
      notFound: 0,
      failed: 0,
    });
  });

  test("get_activity answers a record wall call end to end", async () => {
    const instance = fullApp({
      activity: fakeActivity({
        recordWall: async () => ({
          entries: [wallEntry()],
          truncated: false,
          totalEntries: 1,
        }),
      }),
    });
    const payload = await jsonFromResponse(
      await instance.request(
        modernRequest({
          method: "tools/call",
          name: "get_activity",
          params: {
            name: "get_activity",
            arguments: {
              source: "record",
              record: { kind: "person", id: "person-synthetic-1" },
            },
          },
          id: 12,
        }),
      ),
    );
    expect(payload.result.resultType).toBe("complete");
    expect(payload.result.structuredContent.source).toBe("record");
    expect(payload.result.structuredContent.count).toBe(1);
  });

  test("an upstream failure in search_crm never leaks its text over the wire", async () => {
    const instance = fullApp({
      recordReader: fakeRecordReader({
        phrase: async () => {
          throw new Error("SENSITIVE-synthetic upstream body");
        },
      }),
    });
    const raw = await (
      await instance.request(
        modernRequest({
          method: "tools/call",
          name: "search_crm",
          params: {
            name: "search_crm",
            arguments: { kinds: ["persons"], phrase: "synthetic" },
          },
          id: 13,
        }),
      )
    ).text();
    expect(raw).not.toContain("SENSITIVE-synthetic");
  });

  test("an upstream failure in get_records never leaks its text over the wire", async () => {
    let reached = 0;
    const instance = fullApp({
      recordReader: fakeRecordReader({
        get: (async () => {
          reached += 1;
          throw new Error("SENSITIVE-synthetic upstream body");
        }) as RecordReader["get"],
      }),
    });
    const raw = await (
      await instance.request(
        modernRequest({
          method: "tools/call",
          name: "get_records",
          params: {
            name: "get_records",
            arguments: { kind: "person", ids: ["00000000-0000-4000-8000-000000000101"] },
          },
          id: 14,
        }),
      )
    ).text();
    expect(reached).toBe(1);
    expect(raw).not.toContain("SENSITIVE-synthetic");
  });

  test("an upstream failure in get_activity never leaks its text over the wire", async () => {
    const instance = fullApp({
      activity: fakeActivity({
        recordWall: async () => {
          throw new Error("SENSITIVE-synthetic upstream body");
        },
      }),
    });
    const raw = await (
      await instance.request(
        modernRequest({
          method: "tools/call",
          name: "get_activity",
          params: {
            name: "get_activity",
            arguments: {
              source: "record",
              record: { kind: "person", id: "person-synthetic-1" },
            },
          },
          id: 15,
        }),
      )
    ).text();
    expect(raw).not.toContain("SENSITIVE-synthetic");
  });

  test("a failing include degrades to a sanitized includeError, record still ok", async () => {
    const instance = fullApp({
      recordReader: fakeRecordReader({
        get: (async (_kind: string, id: string) => personV2({ id })) as RecordReader["get"],
      }),
      timeline: fakeTimeline({
        recordEntries: async () => {
          throw new Error("SENSITIVE-synthetic upstream body");
        },
      }),
    });
    const response = await instance.request(
      modernRequest({
        method: "tools/call",
        name: "get_records",
        params: {
          name: "get_records",
          arguments: {
            kind: "person",
            ids: ["00000000-0000-4000-8000-000000000101"],
            include: ["notes"],
          },
        },
        id: 16,
      }),
    );
    const raw = await response.text();
    expect(raw).not.toContain("SENSITIVE-synthetic");
    const dataLine = raw.split("\n").find((line) => line.startsWith("data: "));
    const payload = JSON.parse(dataLine ? dataLine.slice(6) : raw);
    const item = payload.result.structuredContent.items[0];
    expect(item.status).toBe("ok");
    expect(item.includeErrors[0]).toMatchObject({ include: "notes", code: "UPSTREAM_ERROR" });
    expect(payload.result.isError).toBeUndefined();
  });

  test("the removed includeWall argument is refused by the strict input schema", async () => {
    const payload = await jsonFromResponse(
      await fullApp().request(
        modernRequest({
          method: "tools/call",
          name: "get_records",
          params: {
            name: "get_records",
            arguments: { kind: "person", ids: ["00000000-0000-4000-8000-000000000101"], includeWall: true },
          },
          id: 18,
        }),
      ),
    );
    expect(payload.result?.isError ?? payload.error !== undefined).toBe(true);
  });

  test("record data is never cached: two identical calls hit upstream twice", async () => {
    const calls: string[] = [];
    const instance = fullApp({
      recordReader: fakeRecordReader({
        get: (async (_kind: string, id: string) => {
          calls.push(id);
          return personV2({ id });
        }) as RecordReader["get"],
      }),
    });
    const request = () =>
      instance.request(
        modernRequest({
          method: "tools/call",
          name: "get_records",
          params: {
            name: "get_records",
            arguments: { kind: "person", ids: ["00000000-0000-4000-8000-000000000101"] },
          },
          id: 17,
        }),
      );
    await request();
    await request();
    expect(calls).toEqual(["00000000-0000-4000-8000-000000000101", "00000000-0000-4000-8000-000000000101"]);
  });

  test("the record and activity modules never reach for the cache", async () => {
    // docs/security.md par. 8: the only cache is dictionary data. A stray
    // import here would be the first step to persisting record content.
    for (const path of [
      "../../src/livespace/records.ts",
      "../../src/livespace/activity.ts",
      "../../src/livespace/v2/records.ts",
      "../../src/livespace/v2/timeline.ts",
      "../../src/livespace/v2/filters.ts",
    ]) {
      const source = await Bun.file(new URL(path, import.meta.url)).text();
      expect(source).not.toContain("server/cache");
    }
  });
});

/**
 * The largest number of elements (array elements plus object members, the
 * SDK's `maxToolInputElements` measure) an input valid under `schema` can hold.
 * An array without `maxItems`, or an object open to unlisted members, has no
 * such number and fails the test that calls this.
 */
function maxInputElements(schema: any, path: string): number {
  const branches = schema.anyOf ?? schema.oneOf;
  if (branches !== undefined) {
    return Math.max(...branches.map((branch: any) => maxInputElements(branch, path)));
  }
  if (schema.type === "array") {
    if (schema.maxItems === undefined) throw new Error(`${path} has no maxItems`);
    return schema.maxItems * (1 + maxInputElements(schema.items ?? {}, `${path}[]`));
  }
  if (schema.type === "object") {
    if (schema.additionalProperties !== false) {
      throw new Error(`${path} accepts unlisted members`);
    }
    let total = 0;
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      total += 1 + maxInputElements(child, `${path}.${key}`);
    }
    return total;
  }
  return 0;
}

describe("tool input bounds", () => {
  function everyToolApp(overrides: Partial<AppDeps> = {}) {
    return app({
      metadata: fakeV2Metadata(syntheticSection),
      v1Metadata: fakeV1Metadata(),
      records: fakeRecords(),
        recordReader: fakeRecordReader(),
        timeline: fakeTimeline(),
      activity: fakeActivity(),
      writes: fakeWrites(),
      dealSteps: fakeDealSteps(),
      subdomain: SUBDOMAIN,
      ...overrides,
    });
  }

  // GHSA-46jr-4wx8-v453 and GHSA-mrhx-c7xc-m3w5: validation cost grows with
  // every element of the arguments, so a valid call has a known ceiling and
  // the server's cap sits above it.
  test("every tool input is bounded and fits under the input element cap", async () => {
    const listed = await jsonFromResponse(
      await everyToolApp().request(modernRequest({ method: "tools/list" })),
    );
    const largest: Record<string, number> = {};
    for (const tool of listed.result.tools) {
      largest[tool.name] = maxInputElements(tool.inputSchema, tool.name);
    }
    expect(Object.keys(largest)).toHaveLength(11);
    for (const [name, count] of Object.entries(largest)) {
      expect({ name, fits: count <= MAX_TOOL_INPUT_ELEMENTS }).toEqual({ name, fits: true });
    }
  });

  test("a call over the input element cap is refused before validation and tool work", async () => {
    let calls = 0;
    const instance = everyToolApp({
      recordReader: fakeRecordReader({
        phrase: async () => {
          calls += 1;
          return { hits: [], totalCount: 0, rowCount: 0 };
        },
      }),
    });
    const payload = await jsonFromResponse(
      await instance.request(
        modernRequest({
          method: "tools/call",
          name: "search_crm",
          params: {
            name: "search_crm",
            arguments: {
              phrase: "synthetic",
              padding: Array.from({ length: MAX_TOOL_INPUT_ELEMENTS }, () => 0),
            },
          },
        }),
      ),
    );
    expect(payload.result.isError).toBe(true);
    expect(payload.result.content[0].text).toContain(
      `more than the maximum of ${MAX_TOOL_INPUT_ELEMENTS} elements`,
    );
    expect(calls).toBe(0);
  });
});
