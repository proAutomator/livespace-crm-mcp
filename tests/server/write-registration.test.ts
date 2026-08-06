import { describe, expect, test } from "bun:test";
import { isInputRequiredResult } from "@modelcontextprotocol/server";
import type { ServerConfig } from "../../src/config/server-env.js";
import type { ActivityFetchers } from "../../src/livespace/activity.js";
import type { ProcessInfo } from "../../src/livespace/metadata.js";
import type { RecordFetchers } from "../../src/livespace/records.js";
import type { DealStepReader } from "../../src/livespace/stage-moves.js";
import type { PersonWrite, WriteFetchers } from "../../src/livespace/writes.js";
import { buildApp } from "../../src/server/app.js";
import type { AppDeps } from "../../src/server/mcp.js";
import type { MetadataService } from "../../src/server/tools/crm-metadata.js";
import { person } from "../support/records.js";

/**
 * The five write tools over the real wire: what is listed, what read-only
 * refuses, and the two rounds of a confirmed write.
 *
 * Every value below is invented. No CRM data, no sandbox values, and no call
 * leaves the process (AGENTS.md).
 */

const PROTOCOL = "2026-07-28";

/** 44 ASCII bytes: comfortably over the codec's 32-byte floor, and fake. */
const REQUEST_STATE_KEY = "synthetic-request-state-key-0123456789-abcd";

const BASE_CONFIG: ServerConfig = {
  port: 3020,
  bindHost: "127.0.0.1",
  readOnly: false,
  allowedHostnames: ["localhost", "127.0.0.1", "[::1]"],
  allowedOriginHostnames: ["localhost", "127.0.0.1", "[::1]"],
  rateLimitPerMinute: 6000,
  rateLimitBurst: 1000,
  maxConcurrentRequests: 16,
  maxQueuedRequests: 32,
  requestStateKey: REQUEST_STATE_KEY,
};

const WRITE_TOOLS = [
  "create_records",
  "update_records",
  "log_activities",
  "move_deals_to_stage",
  "notify_user",
];

const READ_TOOLS = [
  "health",
  "crm_metadata",
  "search_crm",
  "get_records",
  "get_activity",
  "analyze",
];

/** The account subdomain the notification deep links are built from. */
const SUBDOMAIN = "synthetic";

const PERSON_ARGS = { persons: [{ firstname: "Synthetic Given" }] };

const APPROVAL_MESSAGE =
  "Create 1 CRM record(s) (1 persons, 0 companies, 0 deals, 0 tasks). " +
  "0 duplicate(s) will be skipped. Approve?";

// app.request() sends no Host header and the transport guard fails closed, so
// every request here carries one explicitly.
function modernRequest(options: {
  method: string;
  name?: string;
  params?: Record<string, unknown>;
  id?: number;
  clientCapabilities?: Record<string, unknown>;
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
            name: "write-registration-test",
            version: "0.0.0",
          },
          "io.modelcontextprotocol/clientCapabilities": options.clientCapabilities ?? {},
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

const PROCESSES: ProcessInfo[] = [
  { id: "process-synthetic-501", name: "Synthetic Process", stages: [] },
];

function fakeMetadata(): MetadataService {
  return {
    get: async (section: string) => ({
      data: section === "processes" ? PROCESSES : [],
      asOf: 1_000,
      stale: false,
    }),
  } as unknown as MetadataService;
}

function fakeRecords(overrides: Partial<RecordFetchers> = {}): RecordFetchers {
  return {
    listPersons: unexpectedCall,
    listCompanies: unexpectedCall,
    listDeals: unexpectedCall,
    listTasks: unexpectedCall,
    searchPhrase: unexpectedCall,
    getRecord: (async (_kind: string, id: string) => person({ id })) as RecordFetchers["getRecord"],
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

interface WriteCall {
  method: string;
  input: unknown;
}

/**
 * Write fetchers that RECORD every call. Only the create path a confirmed
 * person write needs is implemented; every other method throws, so a tool that
 * reaches for one is a loud failure rather than a silent pass.
 */
function fakeWrites(calls: WriteCall[] = []): WriteFetchers {
  const never =
    (method: string) =>
    async (): Promise<never> => {
      throw new Error(`unexpected write call: ${method}`);
    };
  return {
    createPerson: async (input: PersonWrite) => {
      calls.push({ method: "createPerson", input });
      return { id: "person-synthetic-001" };
    },
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
    findPersonByEmail: async (email: string) => {
      calls.push({ method: "findPersonByEmail", input: email });
      return null;
    },
    findCompanyByName: async (name: string) => {
      calls.push({ method: "findCompanyByName", input: name });
      return null;
    },
  } as unknown as WriteFetchers;
}

/** A step reader that never answers: registration is all these tests need. */
function fakeDealSteps(): DealStepReader {
  return {
    readStepState: async () => {
      throw new Error("unexpected step-state read");
    },
  };
}

function app(deps: Partial<AppDeps> = {}, config: ServerConfig = BASE_CONFIG) {
  return buildApp({
    config,
    version: "0.0.0-test",
    metadata: fakeMetadata(),
    records: fakeRecords(),
    activity: fakeActivity(),
    dealSteps: fakeDealSteps(),
    subdomain: SUBDOMAIN,
    ...deps,
  });
}

async function listTools(instance: ReturnType<typeof app>): Promise<any[]> {
  const listed = await jsonFromResponse(
    await instance.request(modernRequest({ method: "tools/list" })),
  );
  return listed.result.tools;
}

/** One `create_records` round, with whatever retry material it carries. */
function createCall(options: {
  args?: Record<string, unknown>;
  id?: number;
  clientCapabilities?: Record<string, unknown>;
  requestState?: string;
  inputResponses?: Record<string, unknown>;
}): Request {
  return modernRequest({
    method: "tools/call",
    name: "create_records",
    id: options.id ?? 1,
    ...(options.clientCapabilities === undefined
      ? {}
      : { clientCapabilities: options.clientCapabilities }),
    params: {
      name: "create_records",
      arguments: options.args ?? PERSON_ARGS,
      ...(options.requestState === undefined ? {} : { requestState: options.requestState }),
      ...(options.inputResponses === undefined ? {} : { inputResponses: options.inputResponses }),
    },
  });
}

const ELICITATION_CAPABLE = { elicitation: {} };

describe("write tool registration", () => {
  test("all eleven tools are listed in registration order", async () => {
    const tools = await listTools(app({ writes: fakeWrites() }));
    expect(tools.map((tool: any) => tool.name)).toEqual([...READ_TOOLS, ...WRITE_TOOLS]);
  });

  test("each write tool declares its own destructiveness and idempotence", async () => {
    const tools = await listTools(app({ writes: fakeWrites() }));
    // A move overwrites checkboxes and re-sending it changes nothing the second
    // time; an update overwrites fields; the other three only ever add.
    const expected: Record<string, { destructive: boolean; idempotent: boolean }> = {
      create_records: { destructive: false, idempotent: false },
      update_records: { destructive: true, idempotent: false },
      log_activities: { destructive: false, idempotent: false },
      move_deals_to_stage: { destructive: true, idempotent: true },
      notify_user: { destructive: false, idempotent: false },
    };
    for (const name of WRITE_TOOLS) {
      const entry = tools.find((tool: any) => tool.name === name);
      expect(entry.annotations.readOnlyHint).toBe(false);
      expect(entry.annotations.openWorldHint).toBe(false);
      expect(entry.annotations.destructiveHint).toBe(expected[name]?.destructive);
      expect(entry.annotations.idempotentHint).toBe(expected[name]?.idempotent);
    }
  });

  test("read-only mode lists the six read tools and none of the write tools", async () => {
    const tools = await listTools(
      app({ writes: fakeWrites() }, { ...BASE_CONFIG, readOnly: true }),
    );
    const names = tools.map((tool: any) => tool.name);
    expect(names).toEqual(READ_TOOLS);
    for (const name of WRITE_TOOLS) expect(names).not.toContain(name);
  });

  test("a missing step reader or subdomain leaves its own tool unregistered", async () => {
    const withoutSteps = (
      await listTools(app({ writes: fakeWrites(), dealSteps: undefined }))
    ).map((tool: any) => tool.name);
    expect(withoutSteps).not.toContain("move_deals_to_stage");
    expect(withoutSteps).toContain("notify_user");

    const withoutSubdomain = (
      await listTools(app({ writes: fakeWrites(), subdomain: undefined }))
    ).map((tool: any) => tool.name);
    expect(withoutSubdomain).not.toContain("notify_user");
    expect(withoutSubdomain).toContain("move_deals_to_stage");
  });

  test("without write fetchers the six read tools are listed", async () => {
    const names = (await listTools(app())).map((tool: any) => tool.name);
    expect(names.length).toBe(6);
    for (const name of WRITE_TOOLS) expect(names).not.toContain(name);
  });

  test("read-only refuses a direct call to every write tool, fetchers untouched", async () => {
    const calls: WriteCall[] = [];
    const instance = app({ writes: fakeWrites(calls) }, { ...BASE_CONFIG, readOnly: true });
    for (const [index, name] of WRITE_TOOLS.entries()) {
      const payload = await jsonFromResponse(
        await instance.request(
          modernRequest({
            method: "tools/call",
            name,
            id: 100 + index,
            params: { name, arguments: PERSON_ARGS },
          }),
        ),
      );
      expect(payload.result).toBeUndefined();
      expect(payload.error.code).toBe(-32602);
      expect(payload.error.message).toContain(name);
    }
    expect(calls).toEqual([]);
  });

  test("a plain create_records call previews and writes nothing", async () => {
    const calls: WriteCall[] = [];
    const payload = await jsonFromResponse(
      await app({ writes: fakeWrites(calls) }).request(createCall({ id: 20 })),
    );
    expect(payload.result.resultType).toBe("complete");
    expect(payload.result.isError).toBeUndefined();
    const structured = payload.result.structuredContent;
    expect(structured.requiresConfirmation).toBe(true);
    expect(structured.plan.length).toBe(1);
    expect(structured.plan[0].status).toBe("create");
    expect(structured.results).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test("an elicitation-capable client gets an input_required result with signed state", async () => {
    const calls: WriteCall[] = [];
    const payload = await jsonFromResponse(
      await app({ writes: fakeWrites(calls) }).request(
        createCall({ id: 21, clientCapabilities: ELICITATION_CAPABLE }),
      ),
    );
    expect(payload.result.resultType).toBe("input_required");
    expect(isInputRequiredResult(payload.result)).toBe(true);
    expect(payload.result.inputRequests.confirm.method).toBe("elicitation/create");
    expect(payload.result.inputRequests.confirm.params.message).toBe(APPROVAL_MESSAGE);
    expect(typeof payload.result.requestState).toBe("string");
    expect(calls).toEqual([]);
  });

  test("round two with an accepted confirmation writes exactly once per item", async () => {
    const calls: WriteCall[] = [];
    const instance = app({ writes: fakeWrites(calls) });
    const first = await jsonFromResponse(
      await instance.request(createCall({ id: 22, clientCapabilities: ELICITATION_CAPABLE })),
    );
    const payload = await jsonFromResponse(
      await instance.request(
        createCall({
          id: 23,
          clientCapabilities: ELICITATION_CAPABLE,
          requestState: first.result.requestState,
          inputResponses: { confirm: { action: "accept", content: { confirm: true } } },
        }),
      ),
    );
    expect(payload.result.resultType).toBe("complete");
    expect(payload.result.isError).toBeUndefined();
    expect(payload.result.structuredContent.counts).toEqual({
      ok: 1,
      skippedDuplicate: 0,
      error: 0,
      unknownOutcome: 0,
      notAttempted: 0,
    });
    expect(calls.filter((call) => call.method === "createPerson").length).toBe(1);
  });

  test("a declined confirmation writes nothing and says so", async () => {
    const calls: WriteCall[] = [];
    const instance = app({ writes: fakeWrites(calls) });
    const first = await jsonFromResponse(
      await instance.request(createCall({ id: 24, clientCapabilities: ELICITATION_CAPABLE })),
    );
    const payload = await jsonFromResponse(
      await instance.request(
        createCall({
          id: 25,
          clientCapabilities: ELICITATION_CAPABLE,
          requestState: first.result.requestState,
          inputResponses: { confirm: { action: "decline" } },
        }),
      ),
    );
    expect(payload.result.resultType).toBe("complete");
    expect(payload.result.structuredContent.declined).toBe(true);
    expect(payload.result.content[0].text).toContain(
      "Confirmation was declined; nothing was written.",
    );
    expect(calls).toEqual([]);
  });

  test("an accepted confirmation carrying confirm false writes nothing", async () => {
    const calls: WriteCall[] = [];
    const instance = app({ writes: fakeWrites(calls) });
    const first = await jsonFromResponse(
      await instance.request(createCall({ id: 26, clientCapabilities: ELICITATION_CAPABLE })),
    );
    const payload = await jsonFromResponse(
      await instance.request(
        createCall({
          id: 27,
          clientCapabilities: ELICITATION_CAPABLE,
          requestState: first.result.requestState,
          inputResponses: { confirm: { action: "accept", content: { confirm: false } } },
        }),
      ),
    );
    expect(payload.result.structuredContent.declined).toBe(true);
    expect(calls).toEqual([]);
  });

  test("a tampered requestState is refused by the SDK seam with the frozen -32602", async () => {
    const calls: WriteCall[] = [];
    const instance = app({ writes: fakeWrites(calls) });
    const first = await jsonFromResponse(
      await instance.request(createCall({ id: 28, clientCapabilities: ELICITATION_CAPABLE })),
    );
    const wire: string = first.result.requestState;
    // Flip the FIRST character after the last dot (the MAC segment's first
    // base64url char): all six of its bits are significant, so the decoded
    // MAC always changes. The final char carries padding bits and a flip
    // there can decode to identical bytes (~6% of mints) - a flaky tamper.
    const dot = wire.lastIndexOf(".");
    const target = dot + 1;
    const tampered =
      wire.slice(0, target) +
      (wire[target] === "A" ? "B" : "A") +
      wire.slice(target + 1);
    const payload = await jsonFromResponse(
      await instance.request(
        createCall({
          id: 29,
          clientCapabilities: ELICITATION_CAPABLE,
          requestState: tampered,
          inputResponses: { confirm: { action: "accept", content: { confirm: true } } },
        }),
      ),
    );
    expect(payload.result).toBeUndefined();
    expect(payload.error.code).toBe(-32602);
    expect(payload.error.message).toBe("Invalid or expired requestState");
    expect(calls).toEqual([]);
  });

  test("a replayed confirmation is refused with BAD_PARAMS and writes nothing more", async () => {
    const calls: WriteCall[] = [];
    const instance = app({ writes: fakeWrites(calls) });
    const first = await jsonFromResponse(
      await instance.request(createCall({ id: 30, clientCapabilities: ELICITATION_CAPABLE })),
    );
    const round = (id: number) =>
      instance.request(
        createCall({
          id,
          clientCapabilities: ELICITATION_CAPABLE,
          requestState: first.result.requestState,
          inputResponses: { confirm: { action: "accept", content: { confirm: true } } },
        }),
      );
    await jsonFromResponse(await round(31));
    const replay = await jsonFromResponse(await round(32));
    expect(replay.result.isError).toBe(true);
    expect(replay.result.structuredContent.errors[0].code).toBe("BAD_PARAMS");
    expect(calls.filter((call) => call.method === "createPerson").length).toBe(1);
  });

  test("the write modules never reach for the cache", async () => {
    // docs/security.md par. 8: the only cache is dictionary data. A stray
    // import here would be the first step to persisting record content.
    for (const path of [
      "../../src/livespace/writes.ts",
      "../../src/server/tools/write-support.ts",
      "../../src/server/tools/create-records.ts",
      "../../src/server/tools/update-records.ts",
      "../../src/server/tools/log-activities.ts",
      "../../src/server/tools/move-deals-to-stage.ts",
      "../../src/server/tools/notify-user.ts",
      "../../src/livespace/stage-moves.ts",
    ]) {
      const source = await Bun.file(new URL(path, import.meta.url)).text();
      expect(source).not.toMatch(/from\s+"[^"]*cache\.js"/u);
    }
  });
});

describe("docs/security.md par. 5 after the write milestone", () => {
  async function securityDoc(): Promise<string> {
    return Bun.file(new URL("../../docs/security.md", import.meta.url)).text();
  }

  test("the dedupe bullet names the read-based lookup and the probe fact", async () => {
    const text = await securityDoc();
    expect(text).toContain("`__check_if_exists`");
    expect(text).toContain("does NOT dedupe");
    expect(text).toContain("exact e-mail");
    expect(text).not.toContain("Livespace's native dedupe check");
  });

  test("the re-read bullet separates an unavailable check from a failed write", async () => {
    const text = await securityDoc();
    expect(text).toContain("before -> after");
    expect(text).toContain("`verification: unavailable`");
    expect(text).not.toContain("before → after");
    expect(text).not.toContain("silent partial failures cannot hide");
  });

  test("the third verification case covers a write with no read-back at all", async () => {
    const text = await securityDoc();
    expect(text).toContain("unverifiable by construction");
    expect(text).toContain("dispatched, never as delivered");
    expect(text).toContain("never retried on an unknown outcome");
    // The old absolute is gone: a notification has no record to re-read.
    expect(text).not.toContain("After every write the server re-reads");
  });
});

describe("README after the write milestones", () => {
  async function readme(): Promise<string> {
    return Bun.file(new URL("../../README.md", import.meta.url)).text();
  }

  test("every v1 tool is described as live, none as planned", async () => {
    const text = await readme();
    for (const name of WRITE_TOOLS) expect(text).toContain(`\`${name}\``);
    expect(text).not.toContain("are still planned");
    expect(text).not.toContain("Planned tools");
  });

  test("the two newest tools are described by what they actually do", async () => {
    const text = (await readme()).replace(/\s+/gu, " ");
    expect(text).toContain("checking and unchecking process steps");
    expect(text).toContain("dispatched, never as delivered");
  });
});
