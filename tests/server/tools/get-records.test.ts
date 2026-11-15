import { describe, expect, test } from "bun:test";
import * as z from "zod/v4";
import { LivespaceError } from "../../../src/livespace/errors.js";
import { CALL_BUDGETS, CallBudget } from "../../../src/livespace/v2/budget.js";
import { MEDIA_JSON, MEDIA_MINIMAL } from "../../../src/livespace/v2/media-types.js";
import type {
  BudgetSummaryV2,
  DealProcessV2,
  RecordReader,
  SearchQuery,
  V2Kind,
} from "../../../src/livespace/v2/records.js";
import type {
  RecordEntryType,
  TimelineEntry,
  TimelineReader,
} from "../../../src/livespace/v2/timeline.js";
import {
  getRecordsToolConfig,
  runGetRecords,
  type GetRecordsArgs,
  type GetRecordsDeps,
} from "../../../src/server/tools/get-records.js";
import { syntheticId } from "../../support/v2.js";
import { companyV2, dealV2, personV2, taskV2 } from "../../support/v2-records.js";

// Every value below is invented. No CRM data, no sandbox values (AGENTS.md).

const DEAL = syntheticId(301);

const PROCESS: DealProcessV2 = {
  process: { id: syntheticId(401), name: "SYNTHETIC Process" },
  currentStage: { id: syntheticId(412), name: "SYNTHETIC Stage 2" },
  stages: [
    {
      id: syntheticId(411),
      name: "SYNTHETIC Stage 1",
      position: 1,
      state: "completed",
      completedAt: "2026-01-20T12:00:00Z",
      steps: [{ id: syntheticId(421), name: "SYNTHETIC Step 1", required: false, completed: true }],
    },
    {
      id: syntheticId(412),
      name: "SYNTHETIC Stage 2",
      position: 2,
      state: "current",
      completedAt: null,
      steps: [{ id: syntheticId(422), name: "SYNTHETIC Step 2", required: true, completed: false }],
    },
  ],
};

const BUDGET: BudgetSummaryV2 = {
  currency: "PLN",
  revenue: { forecast: 1000, executed: 250.5 },
  cost: { forecast: 100, executed: 0 },
  margin: { forecast: 900, executed: 250.5 },
  quantity: { forecast: 4, executed: 1 },
};

const LINE = {
  id: syntheticId(431),
  product: { id: syntheticId(441), name: "SYNTHETIC Product" },
  quantity: 3,
  unitPrice: 100.5,
  value: 271.35,
  currency: "PLN",
  forecast: true,
  description: "SYNTHETIC line",
};

function entry(type: RecordEntryType): TimelineEntry {
  return {
    type,
    id: syntheticId(951),
    date: "2026-02-01T09:00:00Z",
    author: { id: syntheticId(801), name: "SYNTHETIC Author" },
    text: `SYNTHETIC ${type} text`,
    textTruncated: false,
    url: null,
  };
}

interface Call {
  op: string;
  kind?: string;
  id?: string;
  detail?: unknown;
  budget?: CallBudget;
}

interface Harness {
  deps: GetRecordsDeps;
  calls: Call[];
  ops: (op: string) => Call[];
}

type Canned = unknown | (() => unknown);

function settle(value: Canned): unknown {
  const resolved = typeof value === "function" ? (value as () => unknown)() : value;
  if (resolved instanceof Error) throw resolved;
  return resolved;
}

interface HarnessOptions {
  /** Per id: the record, null for not found, an Error to throw. */
  records?: Record<string, Canned>;
  process?: Canned;
  lines?: Canned;
  budget?: Canned;
  tasks?: Canned;
  entries?: Partial<Record<RecordEntryType, Canned>>;
  writesEnabled?: boolean;
}

const FIXTURES = { person: personV2, company: companyV2, deal: dealV2, task: taskV2 } as const;

function harness(options: HarnessOptions = {}): Harness {
  const calls: Call[] = [];
  const records = {
    get: async (kind: V2Kind, id: string, opts: { budget: CallBudget; media?: string }) => {
      calls.push({ op: "get", kind, id, detail: opts.media, budget: opts.budget });
      if (options.records !== undefined && id in options.records) {
        return settle(options.records[id]);
      }
      return FIXTURES[kind]({ id } as never);
    },
    dealProcess: async (id: string, opts: { budget: CallBudget }) => {
      calls.push({ op: "process", id, budget: opts.budget });
      return options.process === undefined ? PROCESS : settle(options.process);
    },
    dealLines: async (id: string, opts: { budget: CallBudget }) => {
      calls.push({ op: "products", id, budget: opts.budget });
      return options.lines === undefined ? { lines: [LINE], totalCount: 1 } : settle(options.lines);
    },
    dealBudget: async (id: string, opts: { budget: CallBudget }) => {
      calls.push({ op: "budget", id, budget: opts.budget });
      return options.budget === undefined ? BUDGET : settle(options.budget);
    },
    search: async (kind: V2Kind, query: SearchQuery, opts: { budget: CallBudget }) => {
      calls.push({ op: "tasks", kind, detail: query, budget: opts.budget });
      return options.tasks === undefined
        ? { items: [taskV2()], totalCount: 7, totalCountExact: true }
        : settle(options.tasks);
    },
  } as unknown as RecordReader;
  const timeline = {
    recordEntries: async (
      kind: string,
      id: string,
      type: RecordEntryType,
      opts: { limit: number; budget: CallBudget },
    ) => {
      calls.push({ op: type, kind, id, detail: opts.limit, budget: opts.budget });
      const canned = options.entries?.[type];
      return canned === undefined ? { entries: [entry(type)], totalCount: 9 } : settle(canned);
    },
  } as unknown as TimelineReader;
  return {
    deps: { records, timeline, writesEnabled: options.writesEnabled ?? false },
    calls,
    ops: (op) => calls.filter((call) => call.op === op),
  };
}

const outputSchema = getRecordsToolConfig.outputSchema;

type Structured = z.output<typeof outputSchema>;

async function run(h: Harness, args: GetRecordsArgs, signal?: AbortSignal) {
  const result = await runGetRecords(h.deps, args, signal === undefined ? {} : { signal });
  // Every answer must fit the declared output schema, errors included.
  const parsed = outputSchema.safeParse(result.structured);
  expect(parsed.success).toBe(true);
  return { ...result, out: result.structured as Structured };
}

function ids(count: number, from = 1): string[] {
  return Array.from({ length: count }, (_, index) => syntheticId(from + index));
}

describe("get_records reading", () => {
  test("reads each id on its own and reports a per-item status", async () => {
    const [found, missing, broken] = ids(3, 301);
    const h = harness({
      records: {
        [missing!]: null,
        [broken!]: () =>
          new LivespaceError(
            "VALIDATION_ERROR",
            "SYNTHETIC invalid",
            "SYNTHETIC fix",
            undefined,
            undefined,
            false,
            { fields: ["/id"], requestId: "0123456789abcdef0123456789abcdef" },
          ),
      },
    });
    const result = await run(h, { kind: "deal", ids: [found!, missing!, broken!] });
    expect(result.isError).toBe(false);
    expect(result.out.summary).toEqual({ requested: 3, ok: 1, notFound: 1, failed: 1 });
    expect(result.out.items[0]).toMatchObject({ id: found, status: "ok" });
    expect(result.out.items[0]?.deal?.id).toBe(found!);
    expect(result.out.items[1]?.status).toBe("not_found");
    expect(result.out.items[1]?.hint).toContain("not visible to the integration user");
    // The strict item schema carries the sanitized v2 error details.
    expect(result.out.items[2]).toEqual({
      id: broken!,
      status: "error",
      code: "VALIDATION_ERROR",
      message: "SYNTHETIC invalid",
      hint: "SYNTHETIC fix",
      fields: ["/id"],
      requestId: "0123456789abcdef0123456789abcdef",
    });
    expect(result.text).toBe("get_records deal (1 ok, 1 not_found, 1 failed)");
  });

  test("an id that is not id-shaped fails its item without a request", async () => {
    // Livespace answers 400 for a malformed id and a 400 still costs the
    // shared daily budget, so ids of the old API never reach it.
    const h = harness();
    const result = await run(h, {
      kind: "deal",
      ids: ["deal-1", DEAL, "12345"],
      include: ["process"],
    });
    expect(result.isError).toBe(false);
    expect(result.out.summary).toEqual({ requested: 3, ok: 1, notFound: 0, failed: 2 });
    expect(result.out.items[0]).toMatchObject({
      id: "deal-1",
      status: "error",
      code: "VALIDATION_ERROR",
    });
    expect(result.out.items[0]?.hint).toContain("search_crm");
    expect(result.out.items[1]?.status).toBe("ok");
    expect(h.ops("get").map((call) => call.id)).toEqual([DEAL]);
    expect(h.ops("process")).toHaveLength(1);

    // Only malformed ids: an error result, and nothing was sent.
    const none = harness();
    const allBad = await run(none, { kind: "person", ids: ["person-synthetic-1"] });
    expect(allBad.isError).toBe(true);
    expect(none.calls).toHaveLength(0);
  });

  test("ids that cannot be sent do not count against the request plan", async () => {
    const h = harness();
    const mixed = [...ids(20), "a", "b", "c", "d", "e"];
    const result = await run(h, { kind: "deal", ids: mixed, include: ["process", "notes"] });
    expect(result.isError).toBe(false);
    expect(h.calls).toHaveLength(60);
    expect(result.out.summary).toMatchObject({ requested: 25, ok: 20, failed: 5 });
  });

  test("the record sits under the key of its kind, cut to the detail level", async () => {
    for (const kind of ["person", "company", "deal", "task"] as const) {
      const h = harness();
      const result = await run(h, { kind, ids: [syntheticId(1)] });
      const item = result.out.items[0] as Record<string, unknown>;
      expect(Object.keys(item).sort()).toEqual(["id", kind, "status"].sort());
      const record = item[kind] as Record<string, unknown>;
      expect("customFields" in record).toBe(false);
    }
    const full = harness();
    const result = await run(full, { kind: "deal", ids: [DEAL], detail: "full" });
    expect(result.out.items[0]?.deal).toEqual(dealV2({ id: DEAL }));
  });

  test("minimal detail reads minimal rows, the other levels whole rows", async () => {
    const h = harness();
    await run(h, { kind: "deal", ids: [DEAL], detail: "minimal" });
    await run(h, { kind: "deal", ids: [DEAL] });
    await run(h, { kind: "deal", ids: [DEAL], detail: "full" });
    expect(h.ops("get").map((call) => call.detail)).toEqual([MEDIA_MINIMAL, MEDIA_JSON, MEDIA_JSON]);
  });

  test("duplicate ids are collapsed before anything is read", async () => {
    const h = harness();
    const result = await run(h, { kind: "person", ids: [DEAL, DEAL, syntheticId(2)] });
    expect(h.ops("get")).toHaveLength(2);
    expect(result.out.summary.requested).toBe(2);
  });

  test("an unexpected failure never leaks its text", async () => {
    const h = harness({
      records: { [DEAL]: () => new Error("SYNTHETIC upstream body with a secret") },
    });
    const result = await run(h, { kind: "deal", ids: [DEAL] });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC upstream body");
    expect(result.out.items[0]).toMatchObject({ status: "error", code: "UPSTREAM_ERROR" });
  });

  test("a cancelled call throws instead of answering", async () => {
    const controller = new AbortController();
    const h = harness({
      records: {
        [DEAL]: () => {
          controller.abort();
          return new Error("SYNTHETIC abort");
        },
      },
    });
    await expect(
      runGetRecords(h.deps, { kind: "deal", ids: [DEAL] }, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
  });

  test("the text channel carries counts and fixed wording, never CRM text", async () => {
    const h = harness();
    const result = await run(h, {
      kind: "deal",
      ids: [DEAL],
      include: ["process", "products", "budget", "notes", "calls", "emails", "tasks"],
    });
    expect(result.text).not.toContain("SYNTHETIC");
  });

  test("the input schema is strict and caps ids at 25", () => {
    const schema = getRecordsToolConfig.inputSchema;
    expect(schema.safeParse({ kind: "deal", ids: ids(25) }).success).toBe(true);
    expect(schema.safeParse({ kind: "deal", ids: ids(26) }).success).toBe(false);
    expect(schema.safeParse({ kind: "deal", ids: [DEAL], includeWall: true }).success).toBe(false);
    expect(schema.safeParse({ kind: "deal", ids: [DEAL], include: ["feed"] }).success).toBe(false);
    expect(schema.safeParse({ kind: "note", ids: [DEAL] }).success).toBe(false);
  });

  test("the tool is annotated read-only and idempotent", () => {
    expect(getRecordsToolConfig.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });
});

describe("get_records includes", () => {
  test("includes that exceed the call budget are refused up front", async () => {
    // Review Focus 4: 25 ids with two includes is 75 requests against the
    // account's shared daily budget; the read budget is 60.
    const h = harness();
    const result = await run(h, { kind: "deal", ids: ids(25), include: ["process", "notes"] });
    expect(result.isError).toBe(true);
    expect(result.out.errors[0]?.code).toBe("BAD_PARAMS");
    expect(result.out.errors[0]?.hint).toContain("75");
    expect(result.out.errors[0]?.hint).toContain(String(CALL_BUDGETS.read));
    expect(result.out.errors[0]?.hint).toContain("20 ids");
    expect(h.calls).toHaveLength(0);

    // 20 ids with the same includes is exactly 60 and goes through.
    const fits = harness();
    const ok = await run(fits, { kind: "deal", ids: ids(20), include: ["process", "notes"] });
    expect(ok.isError).toBe(false);
    expect(fits.calls).toHaveLength(60);
  });

  test("25 ids without includes fit, and every request spends one call budget", async () => {
    const h = harness();
    await run(h, { kind: "person", ids: ids(25) });
    expect(h.calls).toHaveLength(25);
    const budgets = new Set(h.calls.map((call) => call.budget));
    expect(budgets.size).toBe(1);
    expect([...budgets][0]?.max).toBe(CALL_BUDGETS.read);
  });

  test("process include maps stages, state and required steps", async () => {
    const h = harness();
    const result = await run(h, { kind: "deal", ids: [DEAL], include: ["process"] });
    expect(result.out.items[0]?.process).toEqual(PROCESS);
    expect(h.ops("process").map((call) => call.id)).toEqual([DEAL]);
  });

  test("products and budget includes map lines and totals", async () => {
    const h = harness({ lines: { lines: [LINE], totalCount: 140 } });
    const result = await run(h, { kind: "deal", ids: [DEAL], include: ["products", "budget"] });
    const item = result.out.items[0];
    expect(item?.products).toEqual({ lines: [LINE], totalCount: 140, truncated: true });
    expect(item?.budget).toEqual(BUDGET);

    const masked = harness({ budget: null, lines: { lines: [], totalCount: 0 } });
    const maskedResult = await run(masked, {
      kind: "deal",
      ids: [DEAL],
      include: ["products", "budget"],
    });
    expect(maskedResult.out.items[0]?.budget).toBeNull();
    expect(maskedResult.out.items[0]?.products).toEqual({
      lines: [],
      totalCount: 0,
      truncated: false,
    });
  });

  test("notes, calls and emails return the latest five entries with their total", async () => {
    const h = harness();
    const result = await run(h, {
      kind: "company",
      ids: [syntheticId(201)],
      include: ["notes", "calls", "emails"],
    });
    const item = result.out.items[0];
    expect(item?.notes).toEqual({ entries: [entry("note")], totalCount: 9 });
    expect(item?.calls).toEqual({ entries: [entry("call")], totalCount: 9 });
    expect(item?.emails).toEqual({ entries: [entry("email")], totalCount: 9 });
    for (const op of ["note", "call", "email"]) {
      expect(h.ops(op).map((call) => [call.kind, call.id, call.detail])).toEqual([
        ["company", syntheticId(201), 5],
      ]);
    }
  });

  test("tasks include lists the record's latest tasks as minimal rows", async () => {
    const cases = [
      ["person", "people.id"],
      ["company", "companies.id"],
      ["deal", "deals.id"],
    ] as const;
    for (const [kind, field] of cases) {
      const h = harness();
      const result = await run(h, { kind, ids: [DEAL], include: ["tasks"] });
      const query = h.ops("tasks")[0]?.detail as SearchQuery;
      expect(h.ops("tasks")[0]?.kind).toBe("task");
      expect(query).toEqual({
        filter: { field, operator: "eq", value: DEAL },
        page: 1,
        perPage: 5,
        media: MEDIA_MINIMAL,
      });
      const tasks = result.out.items[0]?.tasks;
      expect(tasks?.totalCount).toBe(7);
      expect(tasks?.items).toEqual([
        {
          id: syntheticId(501),
          title: "SYNTHETIC Task",
          completed: false,
          dueType: "scheduled",
          startsAt: "2026-03-01T09:00:00Z",
          allDay: false,
          private: false,
          url: taskV2().url,
        },
      ]);
    }
  });

  test("emails include needs the e-mail scope and reports INSUFFICIENT_SCOPE per record", async () => {
    const scope = () =>
      new LivespaceError(
        "INSUFFICIENT_SCOPE",
        "SYNTHETIC scope",
        "SYNTHETIC add crm:email:read",
        undefined,
        undefined,
        false,
        { requestId: "0123456789abcdef0123456789abcdef" },
      );
    const h = harness({ entries: { email: scope } });
    const result = await run(h, { kind: "deal", ids: ids(5, 301), include: ["notes", "emails"] });
    // The records and their notes are still delivered.
    expect(result.isError).toBe(false);
    expect(result.out.summary).toMatchObject({ ok: 5, failed: 0 });
    for (const item of result.out.items) {
      expect(item.status).toBe("ok");
      expect(item.notes?.entries).toHaveLength(1);
      expect(item.emails).toBeUndefined();
      expect(item.includeErrors).toHaveLength(1);
      expect(item.includeErrors?.[0]).toMatchObject({
        include: "emails",
        code: "INSUFFICIENT_SCOPE",
        message: "SYNTHETIC scope",
        hint: "SYNTHETIC add crm:email:read",
      });
    }
    // A request id belongs to the request that was made: the records that
    // were spared the request do not quote it.
    const withRequestId = result.out.items.filter(
      (item) => item.includeErrors?.[0]?.requestId !== undefined,
    );
    expect(withRequestId.length).toBe(h.ops("email").length);
    // A missing scope is the same for every record: once seen, the include
    // is not asked again, so it does not burn the daily budget 5 times.
    expect(h.ops("email").length).toBeLessThanOrEqual(2);
    expect(result.text).toContain("include errors: 5");
  });

  test("a failing include degrades its item and leaves the others alone", async () => {
    let round = 0;
    const h = harness({
      process: () => {
        round += 1;
        return round === 1 ? new Error("SYNTHETIC upstream body") : PROCESS;
      },
    });
    const result = await run(h, { kind: "deal", ids: ids(2, 301), include: ["process"] });
    expect(result.out.items[0]?.includeErrors?.[0]).toMatchObject({
      include: "process",
      code: "UPSTREAM_ERROR",
    });
    expect(result.out.items[0]?.status).toBe("ok");
    expect(result.out.items[1]?.process).toEqual(PROCESS);
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC upstream body");
  });

  test("includes are not read for a record that was not found", async () => {
    const h = harness({ records: { [DEAL]: null } });
    await run(h, { kind: "deal", ids: [DEAL], include: ["process", "notes"] });
    expect(h.calls.map((call) => call.op)).toEqual(["get"]);
  });

  test("an include that does not exist for the kind is refused naming the kind", async () => {
    const cases: [GetRecordsArgs["kind"], NonNullable<GetRecordsArgs["include"]>][] = [
      ["person", ["process"]],
      ["company", ["products"]],
      ["person", ["budget"]],
      ["task", ["notes"]],
      ["task", ["tasks"]],
      ["task", ["wall"]],
    ];
    for (const [kind, include] of cases) {
      const h = harness();
      const result = await run(h, { kind, ids: [syntheticId(1)], include });
      expect(result.isError).toBe(true);
      expect(result.out.errors[0]?.code).toBe("BAD_PARAMS");
      expect(result.out.errors[0]?.hint).toContain(kind);
      expect(h.calls).toHaveLength(0);
    }
  });

  test("wall is reported unavailable, costs no request and does not fail the call", async () => {
    const h = harness();
    const result = await run(h, { kind: "deal", ids: ids(25), include: ["wall"] });
    expect(result.isError).toBe(false);
    expect(h.calls).toHaveLength(25);
    expect(result.out.unavailable).toEqual([
      { include: "wall", hint: expect.stringContaining("notes") },
    ]);
    expect(result.text).toContain("wall: unavailable");
  });

  test("repeated includes are read once", async () => {
    const h = harness();
    await run(h, { kind: "deal", ids: [DEAL], include: ["notes", "notes", "process"] });
    expect(h.calls.map((call) => call.op)).toEqual(["get", "process", "note"]);
  });
});

describe("get_records next steps", () => {
  test("a read without includes points at them, a read with includes does not", async () => {
    const plain = await run(harness(), { kind: "deal", ids: [DEAL] });
    expect((plain.out.nextSteps ?? []).join(" ")).toContain("include");
    const rich = await run(harness(), { kind: "deal", ids: [DEAL], include: ["process"] });
    expect((rich.out.nextSteps ?? []).join(" ")).not.toContain("include adds");
  });

  test("nothing read means no next steps", async () => {
    const h = harness({ records: { [DEAL]: null } });
    const result = await run(h, { kind: "deal", ids: [DEAL] });
    expect(result.out.nextSteps).toBeUndefined();
  });

  test("next steps never contain record text", async () => {
    const h = harness({ writesEnabled: true });
    const result = await run(h, {
      kind: "deal",
      ids: [DEAL],
      detail: "full",
      include: ["notes", "tasks"],
    });
    const steps = result.out.nextSteps ?? [];
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.length).toBeLessThanOrEqual(3);
    expect(steps.join(" ")).not.toContain("SYNTHETIC");
  });
});
