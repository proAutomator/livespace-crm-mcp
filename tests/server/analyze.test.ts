import { describe, expect, test } from "bun:test";
import * as z from "zod/v4";
import type {
  ActivityFetchers,
  CrmFeedPage,
  WallEntry,
} from "../../src/livespace/activity.js";
import {
  dayAfter,
  summarizeFeed,
  summarizeForecast,
  summarizePipeline,
  summarizeStageConversion,
  summarizeTasks,
  type Period,
} from "../../src/livespace/aggregate.js";
import { cancelledError, LivespaceError } from "../../src/livespace/errors.js";
import type { ProcessInfo } from "../../src/livespace/metadata.js";
import type {
  DealRecord,
  ListPage,
  RecordFetchers,
  TaskRecord,
} from "../../src/livespace/records.js";
import {
  ANALYZE_BUDGET_MS,
  analyzeToolConfig,
  runAnalyze,
  type AnalyzeArgs,
} from "../../src/server/tools/analyze.js";
import type { MetadataService } from "../../src/server/tools/crm-metadata.js";
import type { ToolError, ToolRunResult } from "../../src/server/tools/tool-error.js";
import { deal, task, wallEntry } from "../support/records.js";

// Every value below is invented. No CRM data, no sandbox values (AGENTS.md).

const PERIOD: Period = { from: "2026-01-01", to: "2026-01-31" };

const ENVELOPE_KEYS = [
  "pipelineSummary",
  "stageConversion",
  "activitySummary",
  "forecastVsRealization",
] as const;

function processInfo(id: string, stageIds: string[], label = "Synthetic"): ProcessInfo {
  return {
    id,
    name: `${label} Process ${id}`,
    stages: stageIds.map((stageId) => ({
      id: stageId,
      name: `${label} Stage ${stageId}`,
      steps: [],
    })),
  };
}

const PROCESSES = [processInfo("proc-a", ["a1", "a2"]), processInfo("proc-b", ["b1"])];

const OPEN_DEALS = [
  deal({ id: "d1", processId: "proc-a", stageId: "a1", value: 100, probability: 20 }),
  deal({ id: "d2", processId: "proc-a", stageId: "a2", value: 250, probability: 40 }),
  deal({ id: "d3", processId: "proc-b", stageId: "b1", value: 50, probability: 10 }),
];

const SCOPED_DEALS = [OPEN_DEALS[0] as DealRecord, OPEN_DEALS[1] as DealRecord];

const WON_DEALS = [
  deal({
    id: "w1",
    processId: "proc-a",
    stageId: "a2",
    status: "won",
    value: 900,
    statusChangeDate: "2026-01-15 12:00:00+01",
  }),
];

const LOST_DEALS = [
  deal({
    id: "l1",
    processId: "proc-a",
    stageId: "a1",
    status: "lost",
    value: 80,
    statusChangeDate: "2026-01-20 12:00:00+01",
  }),
];

const FORECAST_DEALS = [
  deal({ id: "f1", processId: "proc-a", stageId: "a1", dateEnd: "2026-01-10", value: 100, probability: 50 }),
  deal({ id: "f2", processId: "proc-a", stageId: "a2", dateEnd: "2026-03-10", value: 400, probability: 50 }),
];

const FEED_ENTRIES = [
  wallEntry({ date: "2026-01-05 08:00:00+01", type: "note" }),
  wallEntry({ date: "2026-01-06 08:00:00+01", type: "email" }),
];

const TASK_ROWS = [
  task({ id: "t1", dateFrom: "2026-01-07 09:00:00+01", isCompleted: true }),
  task({ id: "t2", dateFrom: "2026-01-08 09:00:00+01", isCompleted: false }),
];

/** A fake answers per call index, so a sweep can be handed a page at a time. */
type Canned<T> = T | ((call: number) => T);

function resolve<T>(canned: Canned<T | LivespaceError>, call: number): T {
  const value =
    typeof canned === "function"
      ? (canned as (call: number) => T | LivespaceError)(call)
      : canned;
  if (value instanceof LivespaceError) throw value;
  return value;
}

function dealPage(rows: DealRecord[], hasMore = false): ListPage<DealRecord> {
  return { items: rows, hasMore, rawCount: rows.length };
}

function taskPage(rows: TaskRecord[], hasMore = false): ListPage<TaskRecord> {
  return { items: rows, hasMore, rawCount: rows.length };
}

function feedPage(rows: WallEntry[], hasMore = false): CrmFeedPage {
  return { items: rows, hasMore, rawCount: rows.length };
}

interface Recorded {
  method: string;
  opts: Record<string, unknown>;
}

interface Canning {
  deals?: Record<string, Canned<ListPage<DealRecord> | LivespaceError>>;
  tasks?: Canned<ListPage<TaskRecord> | LivespaceError>;
  feed?: Canned<CrmFeedPage | LivespaceError>;
  processes?: ProcessInfo[] | LivespaceError;
  asOf?: number;
  stale?: boolean;
}

/**
 * The fakes implement exactly the methods the windows call and RECORD every
 * options object they were handed - the limit discipline and the shared signal
 * are part of the contract, not implementation details.
 */
function fakeRecords(canned: Canning) {
  const calls: Recorded[] = [];
  const countOf = (method: string, status?: string): number =>
    calls.filter(
      (entry) =>
        entry.method === method && (status === undefined || entry.opts["status"] === status),
    ).length;
  const fetchers = {
    listDeals: async (opts: Record<string, unknown>): Promise<ListPage<DealRecord>> => {
      const status = String(opts["status"]);
      const call = countOf("listDeals", status);
      calls.push({ method: "listDeals", opts });
      return resolve(canned.deals?.[status] ?? dealPage([]), call);
    },
    listTasks: async (opts: Record<string, unknown>): Promise<ListPage<TaskRecord>> => {
      const call = countOf("listTasks");
      calls.push({ method: "listTasks", opts });
      return resolve(canned.tasks ?? taskPage([]), call);
    },
  } as unknown as RecordFetchers;
  return { fetchers, calls };
}

function fakeActivity(canned: Canning) {
  const calls: Recorded[] = [];
  const fetchers = {
    crmFeed: async (opts: Record<string, unknown>): Promise<CrmFeedPage> => {
      const call = calls.length;
      calls.push({ method: "crmFeed", opts });
      return resolve(canned.feed ?? feedPage([]), call);
    },
  } as unknown as ActivityFetchers;
  return { fetchers, calls };
}

function fakeMetadata(canned: Canning) {
  const calls: Array<{ section: string; opts: unknown }> = [];
  const service = {
    get: async (section: string, opts?: { signal?: AbortSignal }) => {
      calls.push({ section, opts });
      const processes = canned.processes ?? PROCESSES;
      if (processes instanceof LivespaceError) throw processes;
      return { data: processes, asOf: canned.asOf ?? 1000, stale: canned.stale ?? false };
    },
  } as unknown as MetadataService;
  return { service, calls };
}

interface Fakes {
  records: ReturnType<typeof fakeRecords>;
  activity: ReturnType<typeof fakeActivity>;
  metadata: ReturnType<typeof fakeMetadata>;
}

function fakes(canned: Canning = {}): Fakes {
  return {
    records: fakeRecords(canned),
    activity: fakeActivity(canned),
    metadata: fakeMetadata(canned),
  };
}

function run(
  world: Fakes,
  args: AnalyzeArgs,
  opts: { signal?: AbortSignal } = {},
): Promise<ToolRunResult> {
  return runAnalyze(
    world.records.fetchers,
    world.activity.fetchers,
    world.metadata.service,
    args,
    opts,
  );
}

function errorsOf(result: ToolRunResult): ToolError[] {
  return result.structured["errors"] as ToolError[];
}

function envelopeOf(result: ToolRunResult, key: string): Record<string, unknown> {
  return result.structured[key] as Record<string, unknown>;
}

function optsOf(calls: Recorded[], index: number): Record<string, unknown> {
  return calls[index]?.opts as Record<string, unknown>;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

/** Parses the payload and pins which envelope key it does (and does not) carry. */
function expectEnvelope(result: ToolRunResult, key: string | null): void {
  const parsed = analyzeToolConfig.outputSchema.safeParse(result.structured);
  expect(parsed.success).toBe(true);
  expect(parsed.data as Record<string, unknown>).toEqual(result.structured);
  for (const envelope of ENVELOPE_KEYS) {
    expect(Object.hasOwn(result.structured, envelope)).toBe(envelope === key);
  }
}

describe("analyzeToolConfig", () => {
  test("is read-only, idempotent, and closed-world", () => {
    expect(analyzeToolConfig.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  test("the input schema is a plain object at the JSON Schema root", () => {
    const json = z.toJSONSchema(analyzeToolConfig.inputSchema) as Record<string, unknown>;
    expect(json["type"]).toBe("object");
    // A union root would emit `oneOf` and stop being a valid MCP inputSchema.
    expect(json["oneOf"]).toBeUndefined();
  });

  test("the description promises only the breakdowns the schema carries", () => {
    // `byUser` exists on the FEED envelope only: a TaskRecord has no assignee,
    // so a per-user task breakdown would be a promise nothing can keep.
    const description = analyzeToolConfig.description.replace(/\s+/gu, " ");
    expect(description).toContain(
      "counts feed entries by type and by author, and tasks by type and completion",
    );
    expect(description).not.toContain("tasks by type and by user");
  });

  test("the budget is one minute of wall clock", () => {
    expect(ANALYZE_BUDGET_MS).toBe(60_000);
  });

  const accepted: Array<[string, unknown]> = [
    ["a bare pipeline_summary", { analysis: "pipeline_summary" }],
    ["a scoped pipeline_summary", { analysis: "pipeline_summary", processId: "proc-a" }],
    ["a stage_conversion", { analysis: "stage_conversion", processId: "proc-a" }],
    [
      "an activity_summary period",
      { analysis: "activity_summary", dateFrom: "2026-01-01", dateTo: "2026-01-31" },
    ],
    [
      "a scoped forecast_vs_realization",
      {
        analysis: "forecast_vs_realization",
        processId: "proc-a",
        dateFrom: "2026-01-01",
        dateTo: "2026-01-31",
      },
    ],
  ];

  for (const [label, args] of accepted) {
    test(`input schema accepts ${label}`, () => {
      expect(analyzeToolConfig.inputSchema.safeParse(args).success).toBe(true);
    });
  }

  const rejected: Array<[string, unknown]> = [
    ["a missing analysis", { processId: "proc-a" }],
    ["an unknown analysis", { analysis: "bogus" }],
    ["an unknown top-level key", { analysis: "pipeline_summary", bogus: 1 }],
    ["an unpadded date", { analysis: "activity_summary", dateFrom: "2026-8-6" }],
    ["a datetime date", { analysis: "activity_summary", dateFrom: "2026-08-06 00:00" }],
    ["an empty processId", { analysis: "pipeline_summary", processId: "" }],
    ["a 65-char processId", { analysis: "pipeline_summary", processId: "p".repeat(65) }],
  ];

  for (const [label, args] of rejected) {
    test(`input schema rejects ${label}`, () => {
      expect(analyzeToolConfig.inputSchema.safeParse(args).success).toBe(false);
    });
  }
});

describe("runAnalyze argument rules", () => {
  const cases: Array<[string, AnalyzeArgs, string]> = [
    [
      "a period on pipeline_summary",
      { analysis: "pipeline_summary", dateFrom: "2026-01-01", dateTo: "2026-01-31" },
      "Drop dateFrom and dateTo",
    ],
    [
      "stage_conversion without a process",
      { analysis: "stage_conversion" },
      "Pass processId",
    ],
    [
      "a period on stage_conversion",
      {
        analysis: "stage_conversion",
        processId: "proc-a",
        dateFrom: "2026-01-01",
        dateTo: "2026-01-31",
      },
      "Drop dateFrom and dateTo",
    ],
    [
      "a process scope on activity_summary",
      {
        analysis: "activity_summary",
        processId: "proc-a",
        dateFrom: "2026-01-01",
        dateTo: "2026-01-31",
      },
      "Drop processId",
    ],
    [
      "activity_summary without a period",
      { analysis: "activity_summary" },
      "needs both dateFrom and dateTo",
    ],
    [
      "forecast_vs_realization without a period",
      { analysis: "forecast_vs_realization" },
      "needs both dateFrom and dateTo",
    ],
    [
      "forecast_vs_realization with half a period",
      { analysis: "forecast_vs_realization", dateFrom: "2026-01-01" },
      "needs both dateFrom and dateTo",
    ],
    [
      "a period that runs backwards",
      { analysis: "activity_summary", dateFrom: "2026-01-31", dateTo: "2026-01-01" },
      "must not be later than dateTo",
    ],
  ];

  for (const [label, args, fragment] of cases) {
    test(`rejects ${label} without fetching anything`, async () => {
      const world = fakes();

      const result = await run(world, args);

      expect(world.records.calls).toHaveLength(0);
      expect(world.activity.calls).toHaveLength(0);
      expect(world.metadata.calls).toHaveLength(0);
      expect(result.isError).toBe(true);
      const entry = errorsOf(result)[0] as ToolError;
      expect(entry.code).toBe("BAD_PARAMS");
      expect(entry.hint).toContain(fragment);
      expect(result.structured).toEqual({
        analysis: args.analysis,
        assumptions: [],
        errors: [entry],
      });
      expect(result.text).toBe(`analyze ${args.analysis} failed: BAD_PARAMS.`);
      expectEnvelope(result, null);
    });
  }
});

describe("runAnalyze calendar dates", () => {
  // The shape regex accepts any two digits, so "2026-13-01" reaches `dayAfter`,
  // where `new Date(NaN).toISOString()` throws a raw RangeError - off the
  // {code, message, hint} contract entirely. These dates never get that far.
  const impossible = ["2026-00-01", "2026-13-01", "2026-01-32", "2026-02-31", "2026-02-29"];
  const outOfRange = ["1899-12-31", "2101-01-01"];
  const periodAnalyses = ["activity_summary", "forecast_vs_realization"] as const;

  function argsWith(
    analysis: (typeof periodAnalyses)[number],
    field: "dateFrom" | "dateTo",
    value: string,
  ): AnalyzeArgs {
    return field === "dateFrom"
      ? { analysis, dateFrom: value, dateTo: "2026-01-31" }
      : { analysis, dateFrom: "2026-01-01", dateTo: value };
  }

  const cases: Array<[string, AnalyzeArgs, string]> = [];
  for (const analysis of periodAnalyses) {
    for (const field of ["dateFrom", "dateTo"] as const) {
      for (const value of impossible) {
        cases.push([
          `${analysis} with ${field} ${value}`,
          argsWith(analysis, field, value),
          `${field} is not a real calendar date`,
        ]);
      }
      for (const value of outOfRange) {
        cases.push([
          `${analysis} with ${field} ${value}`,
          argsWith(analysis, field, value),
          `${field} is outside the supported range`,
        ]);
      }
    }
  }

  for (const [label, args, fragment] of cases) {
    test(`rejects ${label} without fetching anything`, async () => {
      const world = fakes();

      const result = await run(world, args);

      expect(world.records.calls).toHaveLength(0);
      expect(world.activity.calls).toHaveLength(0);
      expect(world.metadata.calls).toHaveLength(0);
      expect(result.isError).toBe(true);
      const entry = errorsOf(result)[0] as ToolError;
      expect(entry.code).toBe("BAD_PARAMS");
      expect(entry.hint).toContain(fragment);
      expect(result.structured).toEqual({
        analysis: args.analysis,
        assumptions: [],
        errors: [entry],
      });
      expectEnvelope(result, null);
    });
  }

  // The month ends, the leap day and both range boundaries are real days and
  // must reach the fetchers untouched.
  for (const date of ["2026-02-28", "2024-02-29", "2026-01-31", "1900-01-01", "2100-12-31"]) {
    test(`accepts ${date} and goes on fetching`, async () => {
      const world = fakes({ feed: feedPage(FEED_ENTRIES), tasks: taskPage(TASK_ROWS) });

      const result = await run(world, {
        analysis: "activity_summary",
        dateFrom: date,
        dateTo: date,
      });

      expect(world.activity.calls).toHaveLength(1);
      expect(world.records.calls).toHaveLength(1);
      expect(result.isError).toBe(false);
      expectEnvelope(result, "activitySummary");
    });
  }

  test("a task fetcher that throws synchronously settles instead of escaping", async () => {
    // The window fetchers are awaited inside `Promise.allSettled`, so a
    // SYNCHRONOUS throw would escape the settle, orphan the in-flight feed
    // promise and let Bun kill the process on the later rejection.
    const boom = new LivespaceError(
      "UPSTREAM_ERROR",
      "Livespace reported a general API error (500).",
      "Retry once; if it persists, reduce the request size.",
    );
    const records = {
      listTasks: (): Promise<ListPage<TaskRecord>> => {
        throw boom;
      },
    } as unknown as RecordFetchers;
    const world = fakes({ feed: feedPage(FEED_ENTRIES) });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    let result: ToolRunResult;
    try {
      result = await runAnalyze(
        records,
        world.activity.fetchers,
        world.metadata.service,
        { analysis: "activity_summary", dateFrom: "2026-01-01", dateTo: "2026-01-31" },
      );
      await new Promise((done) => setTimeout(done, 0));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(unhandled).toEqual([]);
    // The feed leg was awaited and its answer carried into the partial.
    expect(world.activity.calls).toHaveLength(1);
    const envelope = envelopeOf(result, "activitySummary");
    expect(envelope["feed"]).toEqual({
      ...summarizeFeed(FEED_ENTRIES, PERIOD),
      basedOn: { entries: { fetched: 2, truncated: false } },
    });
    expect(envelope["tasks"]).toBeUndefined();
    expect(errorsOf(result)).toEqual([
      {
        code: "UPSTREAM_ERROR",
        message: "Livespace reported a general API error (500).",
        hint: "Retry once; if it persists, reduce the request size.",
      },
    ]);
    expect(result.isError).toBe(false);
  });
});

describe("runAnalyze dictionary handling", () => {
  const unknownScope: Array<[string, AnalyzeArgs]> = [
    ["stage_conversion", { analysis: "stage_conversion", processId: "proc-gone" }],
    [
      "forecast_vs_realization",
      {
        analysis: "forecast_vs_realization",
        processId: "proc-gone",
        dateFrom: "2026-01-01",
        dateTo: "2026-01-31",
      },
    ],
  ];

  for (const [label, args] of unknownScope) {
    test(`${label} with an unknown processId answers NOT_FOUND before fetching`, async () => {
      const world = fakes();

      const result = await run(world, args);

      expect(world.records.calls).toHaveLength(0);
      expect(result.isError).toBe(true);
      expect(errorsOf(result)).toEqual([
        {
          code: "NOT_FOUND",
          message: "Process not found.",
          hint: 'Call crm_metadata (sections: ["processes"]) for valid process ids.',
        },
      ]);
      expect(result.text).toBe(`analyze ${args.analysis} failed: NOT_FOUND.`);
      expectEnvelope(result, null);
    });
  }

  test("a failing dictionary read fails the call before any deal is fetched", async () => {
    const world = fakes({
      processes: new LivespaceError(
        "UPSTREAM_ERROR",
        "Livespace reported a general API error (500).",
        "Retry once; if it persists, reduce the request size.",
      ),
    });

    const result = await run(world, { analysis: "pipeline_summary" });

    expect(world.metadata.calls).toHaveLength(1);
    expect(world.records.calls).toHaveLength(0);
    expect(result.isError).toBe(true);
    expect(errorsOf(result)[0]?.code).toBe("UPSTREAM_ERROR");
    expect(result.text).toBe("analyze pipeline_summary failed: UPSTREAM_ERROR.");
    expectEnvelope(result, null);
  });
});

describe("runAnalyze pipeline_summary", () => {
  test("answers with the swept window, the dictionary freshness and basedOn", async () => {
    const world = fakes({ deals: { open: dealPage(OPEN_DEALS) } });

    const result = await run(world, { analysis: "pipeline_summary" });

    expect(result.structured["analysis"]).toBe("pipeline_summary");
    expect(envelopeOf(result, "pipelineSummary")).toEqual({
      ...summarizePipeline(OPEN_DEALS, PROCESSES),
      processesDictionary: { asOf: 1000, stale: false },
      basedOn: { deals: { fetched: 3, truncated: false } },
    });
    expect(result.structured["assumptions"]).toEqual([
      "Aggregates cover only the fetched window; check basedOn.truncated.",
      "A null sum means the rows mix currencies; see currencies.",
      "Deals with no stage are counted under unassigned.",
      "Stage names and order come from the cached processes dictionary; a stage added since the last refresh lands under unassigned.",
    ]);
    expect(errorsOf(result)).toEqual([]);
    expect(result.isError).toBe(false);
    expect(result.text).toBe(
      "analyze pipeline_summary: 3 open deals across 2 processes (truncated: false).",
    );

    // An unscoped sweep sends NO processId key, an explicit limit, and the
    // combined signal of this call.
    const opts = optsOf(world.records.calls, 0);
    expect(Object.keys(opts).sort()).toEqual(["limit", "offset", "signal", "status"]);
    expect(opts["status"]).toBe("open");
    expect(opts["limit"]).toBe(100);
    expect(opts["offset"]).toBe(0);
    expect(opts["signal"]).toBeInstanceOf(AbortSignal);
  });

  test("a scoped call answers about that process only", async () => {
    const world = fakes({ deals: { open: dealPage(SCOPED_DEALS) } });

    const result = await run(world, { analysis: "pipeline_summary", processId: "proc-a" });

    expect(envelopeOf(result, "pipelineSummary")).toEqual({
      ...summarizePipeline(SCOPED_DEALS, [PROCESSES[0] as ProcessInfo]),
      processesDictionary: { asOf: 1000, stale: false },
      basedOn: { deals: { fetched: 2, truncated: false } },
    });
    expect(optsOf(world.records.calls, 0)["processId"]).toBe("proc-a");
    expect(result.text).toBe(
      "analyze pipeline_summary: 2 open deals across 1 processes (truncated: false).",
    );
  });
});

describe("runAnalyze stage_conversion", () => {
  test("sweeps one window per status and shares one signal", async () => {
    const world = fakes({
      deals: {
        open: dealPage(SCOPED_DEALS),
        won: dealPage(WON_DEALS),
        lost: dealPage(LOST_DEALS),
      },
    });

    const result = await run(world, { analysis: "stage_conversion", processId: "proc-a" });

    const statuses = world.records.calls.map((call) => call.opts["status"]);
    expect([...statuses].sort()).toEqual(["lost", "open", "won"]);
    const signals = world.records.calls.map((call) => call.opts["signal"]);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(new Set(signals).size).toBe(1);
    for (const call of world.records.calls) {
      expect(call.opts["processId"]).toBe("proc-a");
      expect(call.opts["limit"]).toBe(100);
    }

    expect(envelopeOf(result, "stageConversion")).toEqual({
      ...summarizeStageConversion(
        SCOPED_DEALS,
        WON_DEALS,
        LOST_DEALS,
        PROCESSES[0] as ProcessInfo,
        false,
      ),
      processesDictionary: { asOf: 1000, stale: false },
      basedOn: {
        open: { fetched: 2, truncated: false },
        won: { fetched: 1, truncated: false },
        lost: { fetched: 1, truncated: false },
      },
    });
    expect(result.structured["assumptions"]).toEqual([
      "Aggregates cover only the fetched window; check basedOn.truncated.",
      "The API keeps no stage history: conversion is a point-in-time estimate from current stage positions.",
      "A deal at or past a stage is assumed to have passed through it.",
      "Deals with no stage are excluded from reached counts and listed under unassigned.",
      "If basedOn reports truncation, conversion ratios are withheld (null).",
      "Stage names and order come from the cached processes dictionary; a stage added since the last refresh lands under unassigned.",
    ]);
    expect(result.text).toBe(
      "analyze stage_conversion: 2 stages; open 2, won 1, lost 1 (truncated: false).",
    );
    expect(result.isError).toBe(false);
  });

  test("one truncated window truncates the whole answer", async () => {
    const world = fakes({
      deals: {
        open: dealPage(SCOPED_DEALS),
        // A window that fills every page and still claims more.
        won: { items: WON_DEALS, hasMore: true, rawCount: 100 },
        lost: dealPage(LOST_DEALS),
      },
    });

    const result = await run(world, { analysis: "stage_conversion", processId: "proc-a" });

    expect(envelopeOf(result, "stageConversion")).toEqual({
      ...summarizeStageConversion(
        SCOPED_DEALS,
        WON_DEALS,
        LOST_DEALS,
        PROCESSES[0] as ProcessInfo,
        true,
      ),
      processesDictionary: { asOf: 1000, stale: false },
      basedOn: {
        open: { fetched: 2, truncated: false },
        won: { fetched: 1, truncated: true },
        lost: { fetched: 1, truncated: false },
      },
    });
    expect(result.text).toBe(
      "analyze stage_conversion: 2 stages; open 2, won 1, lost 1 (truncated: true).",
    );
  });

  test("a failing window fails the call and stops its siblings", async () => {
    const rateLimited = new LivespaceError(
      "RATE_LIMITED",
      "Livespace is throttling this key.",
      "Retry in a moment.",
    );
    const world = fakes({
      deals: {
        open: dealPage(SCOPED_DEALS),
        won: dealPage(WON_DEALS),
        lost: rateLimited,
      },
    });

    const result = await run(world, { analysis: "stage_conversion", processId: "proc-a" });

    expect(result.isError).toBe(true);
    expect(errorsOf(result)).toEqual([
      {
        code: "RATE_LIMITED",
        message: "Livespace is throttling this key.",
        hint: "Retry in a moment.",
      },
    ]);
    expect(result.text).toBe("analyze stage_conversion failed: RATE_LIMITED.");
    expectEnvelope(result, null);
    // The siblings must stop paging for a call that has already failed.
    const signal = optsOf(world.records.calls, 0)["signal"] as AbortSignal;
    expect(signal.aborted).toBe(true);
  });
});

describe("runAnalyze activity_summary", () => {
  test("answers from both sources and widens only the task bound", async () => {
    const world = fakes({ feed: feedPage(FEED_ENTRIES), tasks: taskPage(TASK_ROWS) });

    const result = await run(world, {
      analysis: "activity_summary",
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
    });

    const feedOpts = optsOf(world.activity.calls, 0);
    expect(feedOpts["signal"]).toBeInstanceOf(AbortSignal);
    expect(feedOpts).toStrictEqual({
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
      limit: 200,
      offset: 0,
      signal: feedOpts["signal"],
    });
    const taskOpts = optsOf(world.records.calls, 0);
    expect(taskOpts).toStrictEqual({
      page: 1,
      dateFrom: "2026-01-01",
      // `datesPeriod.to` is exclusive upstream, so the sweep widens it.
      dateTo: dayAfter("2026-01-31"),
      signal: taskOpts["signal"],
    });

    expect(envelopeOf(result, "activitySummary")).toEqual({
      period: { from: "2026-01-01", to: "2026-01-31" },
      feed: {
        ...summarizeFeed(FEED_ENTRIES, PERIOD),
        basedOn: { entries: { fetched: 2, truncated: false } },
      },
      tasks: {
        ...summarizeTasks(TASK_ROWS, PERIOD),
        basedOn: { tasks: { fetched: 2, truncated: false } },
      },
    });
    expect(result.structured["assumptions"]).toEqual([
      "Aggregates cover only the fetched window; check basedOn.truncated.",
      "Feed and task sources are independent; one may fail without the other.",
      "Tasks are bucketed by date_from; the upstream to-exclusive filter is widened and re-filtered locally.",
    ]);
    expect(errorsOf(result)).toEqual([]);
    expect(result.isError).toBe(false);
    expect(result.text).toBe(
      "analyze activity_summary: feed 2 entries, tasks 2 (truncated: false).",
    );
    expect(world.metadata.calls).toHaveLength(0);
  });

  test("a failing feed still answers from the tasks", async () => {
    const world = fakes({
      feed: new LivespaceError(
        "UPSTREAM_ERROR",
        "Livespace reported a general API error (500).",
        "Retry once; if it persists, reduce the request size.",
      ),
      tasks: taskPage(TASK_ROWS),
    });

    const result = await run(world, {
      analysis: "activity_summary",
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
    });

    const envelope = envelopeOf(result, "activitySummary");
    expect(envelope["feed"]).toBeUndefined();
    expect(envelope["tasks"]).toEqual({
      ...summarizeTasks(TASK_ROWS, PERIOD),
      basedOn: { tasks: { fetched: 2, truncated: false } },
    });
    expect(errorsOf(result)).toHaveLength(1);
    expect(errorsOf(result)[0]?.code).toBe("UPSTREAM_ERROR");
    expect(result.isError).toBe(false);
    expect(result.text).toBe(
      "analyze activity_summary: feed -, tasks 2 (truncated: false). Errors: 1.",
    );
  });

  test("both sources failing fails the call with both entries", async () => {
    const upstream = new LivespaceError(
      "UPSTREAM_ERROR",
      "Livespace reported a general API error (500).",
      "Retry once; if it persists, reduce the request size.",
    );
    const world = fakes({ feed: upstream, tasks: upstream });

    const result = await run(world, {
      analysis: "activity_summary",
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
    });

    expect(result.isError).toBe(true);
    expect(errorsOf(result)).toHaveLength(2);
    expectEnvelope(result, null);
    expect(result.text).toBe("analyze activity_summary failed: UPSTREAM_ERROR.");
  });
});

describe("runAnalyze forecast_vs_realization", () => {
  test("echoes the period and reports both sides over three windows", async () => {
    const world = fakes({
      deals: {
        open: dealPage(FORECAST_DEALS),
        won: dealPage(WON_DEALS),
        lost: dealPage(LOST_DEALS),
      },
    });

    const result = await run(world, {
      analysis: "forecast_vs_realization",
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
    });

    expect(envelopeOf(result, "forecastVsRealization")).toEqual({
      period: { from: "2026-01-01", to: "2026-01-31" },
      ...summarizeForecast(FORECAST_DEALS, WON_DEALS, LOST_DEALS, PERIOD, false),
      basedOn: {
        open: { fetched: 2, truncated: false },
        won: { fetched: 1, truncated: false },
        lost: { fetched: 1, truncated: false },
      },
    });
    expect(result.structured["assumptions"]).toEqual([
      "Aggregates cover only the fetched window; check basedOn.truncated.",
      "A null sum means the rows mix currencies; see currencies.",
      "Forecast buckets open deals by date_end; realization buckets closed deals by status_change_date (date part).",
      "weightedValueSum multiplies value by probability/100 (a 0-100 percentage) and skips rows missing either or out of range.",
      "If basedOn reports truncation, period sums are withheld (null).",
    ]);
    expect(result.isError).toBe(false);
    expect(result.text).toBe(
      "analyze forecast_vs_realization: forecast 1 deals, won 1, lost 1 in period (truncated: false).",
    );
    // No process scope, so the dictionary is never read.
    expect(world.metadata.calls).toHaveLength(0);
  });
});

/**
 * Runs one analyze call under a clock that sits past the budget from its SECOND
 * read on. Read #1 is the runner's own `deadlineAt = Date.now() + BUDGET`; every
 * later read is a sweep checking that deadline before a page. A future change
 * that reads the clock BEFORE computing deadlineAt breaks these tests loudly,
 * which is the intended alarm rather than a mystery.
 */
async function pastTheBudget<T>(scenario: () => Promise<T>): Promise<T> {
  const realNow = Date.now;
  const base = realNow();
  let reads = 0;
  Date.now = (): number => {
    reads += 1;
    return reads === 1 ? base : base + ANALYZE_BUDGET_MS + 1_000;
  };
  try {
    return await scenario();
  } finally {
    Date.now = realNow;
  }
}

describe("analyze budget wiring", () => {
  // These pin the deadline INTO the option builders. `basedOn.truncated` is
  // true with or without it - a sweep that pages to its cap truncates too - so
  // only the call count tells the two worlds apart.
  test("pipeline_summary hands the deadline to the deal sweep", async () => {
    const world = fakes({
      deals: { open: { items: OPEN_DEALS, hasMore: true, rawCount: 100 } },
    });

    const result = await pastTheBudget(() => run(world, { analysis: "pipeline_summary" }));

    // Five pages without the wiring.
    expect(world.records.calls).toHaveLength(1);
    expect(envelopeOf(result, "pipelineSummary")["basedOn"]).toEqual({
      deals: { fetched: 3, truncated: true },
    });
  });

  test("activity_summary hands the deadline to both sweeps", async () => {
    const world = fakes({
      feed: { items: FEED_ENTRIES, hasMore: true, rawCount: 200 },
      tasks: { items: TASK_ROWS, hasMore: true, rawCount: 50 },
    });

    const result = await pastTheBudget(() =>
      run(world, {
        analysis: "activity_summary",
        dateFrom: "2026-01-01",
        dateTo: "2026-01-31",
      }),
    );

    // Five feed pages and ten task pages without the wiring.
    expect(world.activity.calls).toHaveLength(1);
    expect(world.records.calls).toHaveLength(1);
    const envelope = envelopeOf(result, "activitySummary");
    expect((envelope["feed"] as Record<string, unknown>)["basedOn"]).toEqual({
      entries: { fetched: 2, truncated: true },
    });
    expect((envelope["tasks"] as Record<string, unknown>)["basedOn"]).toEqual({
      tasks: { fetched: 2, truncated: true },
    });
  });
});

describe("runAnalyze cancellation", () => {
  test("a caller who already walked away gets no work and no result", async () => {
    const controller = new AbortController();
    controller.abort();
    const world = fakes({ deals: { open: dealPage(OPEN_DEALS) } });

    const error = await rejection(
      run(world, { analysis: "pipeline_summary" }, { signal: controller.signal }),
    );

    expect(error).toBeInstanceOf(LivespaceError);
    expect((error as LivespaceError).code).toBe("CANCELLED");
    expect(world.metadata.calls).toHaveLength(0);
    expect(world.records.calls).toHaveLength(0);
  });

  test("a window cancelled mid-flight rejects instead of answering", async () => {
    const controller = new AbortController();
    const world = fakes({
      deals: {
        open: dealPage(SCOPED_DEALS),
        won: dealPage(WON_DEALS),
        lost: () => {
          controller.abort();
          return cancelledError();
        },
      },
    });

    const error = await rejection(
      run(
        world,
        { analysis: "stage_conversion", processId: "proc-a" },
        { signal: controller.signal },
      ),
    );

    expect(error).toBeInstanceOf(LivespaceError);
    expect((error as LivespaceError).code).toBe("CANCELLED");
  });

  test("activity_summary rejects when every source was cancelled", async () => {
    const world = fakes({ feed: cancelledError(), tasks: cancelledError() });

    const error = await rejection(
      run(world, {
        analysis: "activity_summary",
        dateFrom: "2026-01-01",
        dateTo: "2026-01-31",
      }),
    );

    expect(error).toBeInstanceOf(LivespaceError);
    expect((error as LivespaceError).code).toBe("CANCELLED");
  });

  test("activity_summary reports no partial answer for an abandoned request", async () => {
    const controller = new AbortController();
    const world = fakes({
      feed: feedPage(FEED_ENTRIES),
      tasks: () => {
        controller.abort();
        return cancelledError();
      },
    });

    const error = await rejection(
      run(
        world,
        { analysis: "activity_summary", dateFrom: "2026-01-01", dateTo: "2026-01-31" },
        { signal: controller.signal },
      ),
    );

    expect(error).toBeInstanceOf(LivespaceError);
    expect((error as LivespaceError).code).toBe("CANCELLED");
  });
});

describe("analyze output discipline", () => {
  const upstream = new LivespaceError(
    "UPSTREAM_ERROR",
    "Livespace reported a general API error (500).",
    "Retry once; if it persists, reduce the request size.",
  );

  const variants: Array<[string, () => Promise<ToolRunResult>, string | null]> = [
    [
      "pipeline_summary",
      () => run(fakes({ deals: { open: dealPage(OPEN_DEALS) } }), { analysis: "pipeline_summary" }),
      "pipelineSummary",
    ],
    [
      "pipeline_summary scoped",
      () =>
        run(fakes({ deals: { open: dealPage(SCOPED_DEALS) } }), {
          analysis: "pipeline_summary",
          processId: "proc-a",
        }),
      "pipelineSummary",
    ],
    [
      "stage_conversion",
      () =>
        run(
          fakes({
            deals: {
              open: dealPage(SCOPED_DEALS),
              won: dealPage(WON_DEALS),
              lost: dealPage(LOST_DEALS),
            },
          }),
          { analysis: "stage_conversion", processId: "proc-a" },
        ),
      "stageConversion",
    ],
    [
      "stage_conversion truncated",
      () =>
        run(
          fakes({
            deals: {
              open: { items: SCOPED_DEALS, hasMore: true, rawCount: 100 },
              won: dealPage(WON_DEALS),
              lost: dealPage(LOST_DEALS),
            },
          }),
          { analysis: "stage_conversion", processId: "proc-a" },
        ),
      "stageConversion",
    ],
    [
      "activity_summary from both sources",
      () =>
        run(fakes({ feed: feedPage(FEED_ENTRIES), tasks: taskPage(TASK_ROWS) }), {
          analysis: "activity_summary",
          dateFrom: "2026-01-01",
          dateTo: "2026-01-31",
        }),
      "activitySummary",
    ],
    [
      "activity_summary from the feed only",
      () =>
        run(fakes({ feed: feedPage(FEED_ENTRIES), tasks: upstream }), {
          analysis: "activity_summary",
          dateFrom: "2026-01-01",
          dateTo: "2026-01-31",
        }),
      "activitySummary",
    ],
    [
      "activity_summary from the tasks only",
      () =>
        run(fakes({ feed: upstream, tasks: taskPage(TASK_ROWS) }), {
          analysis: "activity_summary",
          dateFrom: "2026-01-01",
          dateTo: "2026-01-31",
        }),
      "activitySummary",
    ],
    [
      "forecast_vs_realization",
      () =>
        run(
          fakes({
            deals: {
              open: dealPage(FORECAST_DEALS),
              won: dealPage(WON_DEALS),
              lost: dealPage(LOST_DEALS),
            },
          }),
          {
            analysis: "forecast_vs_realization",
            dateFrom: "2026-01-01",
            dateTo: "2026-01-31",
          },
        ),
      "forecastVsRealization",
    ],
    [
      "a rejected argument set",
      () => run(fakes(), { analysis: "stage_conversion" }),
      null,
    ],
    [
      "an unknown process",
      () => run(fakes(), { analysis: "stage_conversion", processId: "proc-gone" }),
      null,
    ],
    [
      "a failed window",
      () => run(fakes({ deals: { open: upstream } }), { analysis: "pipeline_summary" }),
      null,
    ],
  ];

  for (const [label, scenario, key] of variants) {
    test(`${label} survives the output schema unchanged`, async () => {
      const result = await scenario();
      expectEnvelope(result, key);
    });
  }

  test("the output schema rejects an unknown key", () => {
    expect(
      analyzeToolConfig.outputSchema.safeParse({
        analysis: "pipeline_summary",
        assumptions: [],
        errors: [],
        bogus: true,
      }).success,
    ).toBe(false);
  });

  test("the text channel carries counts and fixed wording only", async () => {
    const marker = "SYNTHETIC-MARKER";
    const marked: Canning = {
      processes: [processInfo("proc-a", ["a1", "a2"], marker)],
      deals: {
        open: dealPage([
          deal({
            id: "d1",
            processId: "proc-a",
            stageId: "a1",
            name: marker,
            processName: marker,
            stageName: marker,
            ownerName: marker,
            dateEnd: "2026-01-10",
          }),
        ]),
        won: dealPage([
          deal({ id: "w1", processId: "proc-a", stageId: "a2", status: "won", name: marker }),
        ]),
        lost: dealPage([
          deal({ id: "l1", processId: "proc-a", stageId: "a1", status: "lost", name: marker }),
        ]),
      },
      feed: feedPage([
        wallEntry({ date: "2026-01-05 08:00:00+01", type: marker, authorName: marker, text: marker }),
      ]),
      tasks: taskPage([
        task({ id: "t1", dateFrom: "2026-01-07 09:00:00+01", typeName: marker, title: marker }),
      ]),
    };

    const answers = await Promise.all([
      run(fakes(marked), { analysis: "pipeline_summary" }),
      run(fakes(marked), { analysis: "stage_conversion", processId: "proc-a" }),
      run(fakes(marked), {
        analysis: "activity_summary",
        dateFrom: "2026-01-01",
        dateTo: "2026-01-31",
      }),
      run(fakes(marked), {
        analysis: "forecast_vs_realization",
        dateFrom: "2026-01-01",
        dateTo: "2026-01-31",
      }),
      // A failure path names the code and nothing else.
      run(fakes(marked), { analysis: "stage_conversion", processId: `proc-${marker}` }),
    ]);

    for (const answer of answers) {
      expect(answer.text).not.toContain(marker);
    }
    // The data channel still carries the names, typed as data.
    const pipeline = envelopeOf(answers[0] as ToolRunResult, "pipelineSummary");
    expect(JSON.stringify(pipeline)).toContain(marker);
  });
});
