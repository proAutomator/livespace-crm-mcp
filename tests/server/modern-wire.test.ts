import { describe, expect, test } from "bun:test";
import { buildApp } from "../../src/server/app.js";
import type { ServerConfig } from "../../src/config/server-env.js";
import type { AppDeps } from "../../src/server/mcp.js";
import type { MetadataService } from "../../src/server/tools/crm-metadata.js";
import type { ActivityFetchers } from "../../src/livespace/activity.js";
import type { RecordFetchers } from "../../src/livespace/records.js";
import type { DealStepReader } from "../../src/livespace/stage-moves.js";
import type { WriteFetchers } from "../../src/livespace/writes.js";
import { person, wallEntry } from "../support/records.js";

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
    const instance = app({ metadata: fakeMetadata(syntheticSection) });

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

  test("every listed tool carries its exact security annotations", async () => {
    const listed = await jsonFromResponse(
      await app({
        metadata: fakeMetadata(syntheticSection),
        records: fakeRecords(),
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
        metadata: fakeMetadata(syntheticSection),
        records: fakeRecords(),
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
        metadata: fakeMetadata(syntheticSection),
        records: fakeRecords(),
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
      metadata: fakeMetadata(() => {
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
      metadata: fakeMetadata(syntheticSection),
      records: fakeRecords(),
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
      app({ metadata: fakeMetadata(syntheticSection), activity: fakeActivity() }),
    );
    expect(names).toEqual(["health", "crm_metadata"]);
  });

  test("records without activity keep get_records but drop get_activity", async () => {
    const names = await listNames(
      app({ metadata: fakeMetadata(syntheticSection), records: fakeRecords() }),
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
      records: fakeRecords({
        searchPhrase: async () => ({
          hits: [
            {
              id: "person-synthetic-1",
              name: "Synthetic Person",
              description: "Synthetic Company",
              modified: "2025-01-03 03:04:05+02",
            },
          ],
          rawCount: 1,
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
    expect(payload.result.structuredContent.errors).toEqual([]);
  });

  test("get_records answers a batch call end to end", async () => {
    const instance = fullApp({
      records: fakeRecords({
        getRecord: (async (_kind: string, id: string) =>
          person({ id })) as RecordFetchers["getRecord"],
      }),
    });
    const payload = await jsonFromResponse(
      await instance.request(
        modernRequest({
          method: "tools/call",
          name: "get_records",
          params: {
            name: "get_records",
            arguments: { kind: "person", ids: ["person-synthetic-1"] },
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
      records: fakeRecords({
        searchPhrase: async () => {
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
    const instance = fullApp({
      records: fakeRecords({
        getRecord: (async () => {
          throw new Error("SENSITIVE-synthetic upstream body");
        }) as RecordFetchers["getRecord"],
      }),
    });
    const raw = await (
      await instance.request(
        modernRequest({
          method: "tools/call",
          name: "get_records",
          params: {
            name: "get_records",
            arguments: { kind: "person", ids: ["person-synthetic-1"] },
          },
          id: 14,
        }),
      )
    ).text();
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

  test("a wall failure degrades to a sanitized wallError, record still ok", async () => {
    const instance = fullApp({
      records: fakeRecords({
        getRecord: (async (_kind: string, id: string) =>
          person({ id })) as RecordFetchers["getRecord"],
      }),
      activity: fakeActivity({
        recordWall: async () => {
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
            ids: ["person-synthetic-1"],
            includeWall: true,
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
    expect(item.wallError.code).toBe("UPSTREAM_ERROR");
    expect(payload.result.isError).toBeUndefined();
  });

  test("record data is never cached: two identical calls hit upstream twice", async () => {
    const calls: string[] = [];
    const instance = fullApp({
      records: fakeRecords({
        getRecord: (async (_kind: string, id: string) => {
          calls.push(id);
          return person({ id });
        }) as RecordFetchers["getRecord"],
      }),
    });
    const request = () =>
      instance.request(
        modernRequest({
          method: "tools/call",
          name: "get_records",
          params: {
            name: "get_records",
            arguments: { kind: "person", ids: ["person-synthetic-1"] },
          },
          id: 17,
        }),
      );
    await request();
    await request();
    expect(calls).toEqual(["person-synthetic-1", "person-synthetic-1"]);
  });

  test("the record and activity modules never reach for the cache", async () => {
    // docs/security.md par. 8: the only cache is dictionary data. A stray
    // import here would be the first step to persisting record content.
    for (const path of ["../../src/livespace/records.ts", "../../src/livespace/activity.ts"]) {
      const source = await Bun.file(new URL(path, import.meta.url)).text();
      expect(source).not.toContain("server/cache");
    }
  });
});
