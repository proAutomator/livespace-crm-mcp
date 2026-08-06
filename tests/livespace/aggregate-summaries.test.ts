import { describe, expect, test } from "bun:test";
import type { WallEntry } from "../../src/livespace/activity.js";
import {
  inPeriod,
  type Period,
  summarizeFeed,
  summarizeForecast,
  summarizePipeline,
  summarizeStageConversion,
  summarizeTasks,
} from "../../src/livespace/aggregate.js";
import type { ProcessInfo } from "../../src/livespace/metadata.js";
import type { DealRecord, TaskRecord } from "../../src/livespace/records.js";
import { deal, task, wallEntry } from "../support/records.js";

// Every value below is invented. No CRM data, no sandbox values (AGENTS.md).

const JANUARY: Period = { from: "2026-01-01", to: "2026-01-31" };

function processInfo(id: string, stageIds: string[]): ProcessInfo {
  return {
    id,
    name: `Synthetic Process ${id}`,
    stages: stageIds.map((stageId) => ({
      id: stageId,
      name: `Synthetic Stage ${stageId}`,
      steps: [],
    })),
  };
}

function dealAt(
  id: string,
  processId: string,
  stageId: string,
  overrides: Partial<DealRecord> = {},
): DealRecord {
  return deal({ id, processId, stageId, ...overrides });
}

/** Freezes a fixture array and its rows, so any mutation would throw. */
function frozen<T>(rows: T[]): T[] {
  for (const row of rows) Object.freeze(row);
  Object.freeze(rows);
  return rows;
}

describe("inPeriod", () => {
  test("compares the day part only, on both date shapes", () => {
    expect(inPeriod("2026-01-15", JANUARY)).toBe(true);
    expect(inPeriod("2026-02-15", JANUARY)).toBe(false);
    expect(inPeriod("2026-01-15 09:30:00+01", JANUARY)).toBe(true);
    expect(inPeriod("2025-12-31 23:59:59+01", JANUARY)).toBe(false);
  });

  test("includes both ends and never an empty date", () => {
    expect(inPeriod("2026-01-01", JANUARY)).toBe(true);
    expect(inPeriod("2026-01-31 23:00:00+01", JANUARY)).toBe(true);
    expect(inPeriod("", JANUARY)).toBe(false);
  });
});

describe("summarizePipeline", () => {
  const processes = [processInfo("proc-a", ["a1", "a2"]), processInfo("proc-b", ["b1"])];

  test("lists every stage in pipeline order, empty ones included", () => {
    const deals = [
      dealAt("d1", "proc-a", "a1", { value: 100, probability: 10 }),
      dealAt("d2", "proc-a", "a2", { value: 250.5, probability: 10 }),
      dealAt("d3", "proc-a", "a1", { value: 49.5, probability: 10 }),
    ];
    expect(summarizePipeline(deals, processes)).toEqual({
      processes: [
        {
          processId: "proc-a",
          processName: "Synthetic Process proc-a",
          stages: [
            {
              stageId: "a1",
              stageName: "Synthetic Stage a1",
              position: 0,
              dealCount: 2,
              value: { sum: 149.5, missing: 0 },
              avgProbability: 10,
              probabilityMissing: 0,
            },
            {
              stageId: "a2",
              stageName: "Synthetic Stage a2",
              position: 1,
              dealCount: 1,
              value: { sum: 250.5, missing: 0 },
              avgProbability: 10,
              probabilityMissing: 0,
            },
          ],
          unassigned: { dealCount: 0, value: { sum: 0, missing: 0 } },
          totals: { dealCount: 3, value: { sum: 400, missing: 0 } },
        },
        {
          // A process nobody has deals in still shows its shape - that IS the
          // answer to "what does the pipeline look like".
          processId: "proc-b",
          processName: "Synthetic Process proc-b",
          stages: [
            {
              stageId: "b1",
              stageName: "Synthetic Stage b1",
              position: 0,
              dealCount: 0,
              value: { sum: 0, missing: 0 },
              avgProbability: null,
              probabilityMissing: 0,
            },
          ],
          unassigned: { dealCount: 0, value: { sum: 0, missing: 0 } },
          totals: { dealCount: 0, value: { sum: 0, missing: 0 } },
        },
      ],
      currencies: ["PLN"],
      totalOpenDeals: 3,
    });
  });

  test("counts a value-less deal as missing and rounds the sum", () => {
    const deals = [
      dealAt("d1", "proc-a", "a1", { value: 0.1 }),
      dealAt("d2", "proc-a", "a1", { value: 0.2 }),
      dealAt("d3", "proc-a", "a1", { value: null }),
    ];
    const stage = summarizePipeline(deals, processes).processes[0]?.stages[0];
    expect(stage?.dealCount).toBe(3);
    expect(stage?.value).toEqual({ sum: 0.3, missing: 1 });
  });

  test("withholds a stage sum whose rows mix currencies", () => {
    const deals = [
      dealAt("d1", "proc-a", "a1", { value: 100, currency: "PLN" }),
      dealAt("d2", "proc-a", "a1", { value: 50, currency: "EUR" }),
    ];
    const stage = summarizePipeline(deals, processes).processes[0]?.stages[0];
    expect(stage?.dealCount).toBe(2);
    expect(stage?.value).toEqual({ sum: null, missing: 0 });
  });

  test("totals run over their own rows, not over the stage sums", () => {
    // Stage A is all PLN and stage B all EUR: both stage sums are honest, and
    // their total does not exist. Adding sub-sums would have invented one.
    const deals = [
      dealAt("d1", "proc-a", "a1", { value: 100, currency: "PLN" }),
      dealAt("d2", "proc-a", "a2", { value: 50, currency: "EUR" }),
      dealAt("d3", "proc-a", "a2", { value: null, currency: "EUR" }),
    ];
    const summary = summarizePipeline(deals, processes);
    const process = summary.processes[0];
    expect(process?.stages[0]?.value).toEqual({ sum: 100, missing: 0 });
    expect(process?.stages[1]?.value).toEqual({ sum: 50, missing: 1 });
    expect(process?.totals).toEqual({
      dealCount: 3,
      value: { sum: null, missing: 1 },
    });
    expect(summary.currencies).toEqual(["EUR", "PLN"]);
  });

  test("a value-less row never joins the currency check", () => {
    const deals = [
      dealAt("d1", "proc-a", "a1", { value: 100, currency: "PLN" }),
      dealAt("d2", "proc-a", "a1", { value: 200, currency: "PLN" }),
      dealAt("d3", "proc-a", "a1", { value: null, currency: "" }),
    ];
    const summary = summarizePipeline(deals, processes);
    expect(summary.processes[0]?.stages[0]?.value).toEqual({ sum: 300, missing: 1 });
    expect(summary.currencies).toEqual(["", "PLN"]);
  });

  test("buckets stageless deals and unknown processes without guessing", () => {
    const deals = [
      dealAt("d1", "proc-a", "", { value: 10 }),
      dealAt("d2", "proc-a", "a-gone", { value: 20 }),
      dealAt("d3", "proc-x", "x1", { value: 30, processName: "Synthetic Process X" }),
      dealAt("d4", "proc-y", "y1", { value: 40, processName: "Synthetic Process Y" }),
      dealAt("d5", "proc-x", "x2", { value: 5, processName: "Synthetic Process X" }),
    ];
    const summary = summarizePipeline(deals, processes);
    expect(summary.processes.map((row) => row.processId)).toEqual([
      "proc-a",
      "proc-b",
      // Unknown processes trail the dictionary ones, in first-appearance order.
      "proc-x",
      "proc-y",
    ]);
    expect(summary.processes[0]?.unassigned).toEqual({
      dealCount: 2,
      value: { sum: 30, missing: 0 },
    });
    expect(summary.processes[2]).toEqual({
      processId: "proc-x",
      processName: "Synthetic Process X",
      stages: [],
      unassigned: { dealCount: 2, value: { sum: 35, missing: 0 } },
      totals: { dealCount: 2, value: { sum: 35, missing: 0 } },
    });
    expect(summary.processes[3]?.processName).toBe("Synthetic Process Y");
    expect(summary.totalOpenDeals).toBe(5);
  });

  test("averages the probabilities that exist and counts the rest", () => {
    const deals = [
      dealAt("d1", "proc-a", "a1", { probability: 10 }),
      dealAt("d2", "proc-a", "a1", { probability: 20 }),
      dealAt("d3", "proc-a", "a1", { probability: 25 }),
      dealAt("d4", "proc-a", "a1", { probability: null }),
      dealAt("d5", "proc-a", "a2", { probability: null }),
      dealAt("d6", "proc-a", "a2", { probability: null }),
    ];
    const stages = summarizePipeline(deals, processes).processes[0]?.stages;
    expect(stages?.[0]?.avgProbability).toBe(18.33);
    expect(stages?.[0]?.probabilityMissing).toBe(1);
    expect(stages?.[1]?.avgProbability).toBe(null);
    expect(stages?.[1]?.probabilityMissing).toBe(2);
  });
});

describe("summarizeStageConversion", () => {
  const process = processInfo("proc-a", ["s0", "s1", "s2"]);

  const open = [
    dealAt("o1", "proc-a", "s0"),
    dealAt("o2", "proc-a", "s0"),
    dealAt("o3", "proc-a", "s1"),
    dealAt("o4", "proc-a", "s2"),
  ];
  const won = [dealAt("w1", "proc-a", "s2", { status: "won" })];
  const lost = [dealAt("l1", "proc-a", "s1", { status: "lost" })];

  test("counts deals at and past each stage", () => {
    const conversion = summarizeStageConversion(open, won, lost, process, false);
    expect(conversion.processId).toBe("proc-a");
    expect(conversion.processName).toBe("Synthetic Process proc-a");
    expect(conversion.stages).toEqual([
      {
        stageId: "s0",
        stageName: "Synthetic Stage s0",
        position: 0,
        openCount: 2,
        lostCount: 0,
        wonCount: 0,
        reachedCount: 6,
        conversionFromPrevious: null,
      },
      {
        stageId: "s1",
        stageName: "Synthetic Stage s1",
        position: 1,
        openCount: 1,
        lostCount: 1,
        wonCount: 0,
        reachedCount: 4,
        conversionFromPrevious: 0.6667,
      },
      {
        stageId: "s2",
        stageName: "Synthetic Stage s2",
        position: 2,
        openCount: 1,
        lostCount: 0,
        wonCount: 1,
        reachedCount: 2,
        conversionFromPrevious: 0.5,
      },
    ]);
    expect(conversion.outcomes).toEqual({ openCount: 4, wonCount: 1, lostCount: 1 });
    expect(conversion.unassigned).toEqual({ openCount: 0, wonCount: 0, lostCount: 0 });
  });

  test("reports no conversion when nothing reached the previous stage", () => {
    const conversion = summarizeStageConversion([], [], [], process, false);
    expect(conversion.stages.map((row) => row.reachedCount)).toEqual([0, 0, 0]);
    expect(conversion.stages.map((row) => row.conversionFromPrevious)).toEqual([
      null,
      null,
      null,
    ]);
  });

  test("withholds every ratio when the fetch was truncated", () => {
    const full = summarizeStageConversion(open, won, lost, process, false);
    const cut = summarizeStageConversion(open, won, lost, process, true);
    expect(cut.stages.map((row) => row.conversionFromPrevious)).toEqual([null, null, null]);
    expect(cut.stages.map((row) => row.reachedCount)).toEqual(
      full.stages.map((row) => row.reachedCount),
    );
    expect(cut.stages.map((row) => row.openCount)).toEqual(
      full.stages.map((row) => row.openCount),
    );
    expect(cut.outcomes).toEqual(full.outcomes);
  });

  test("keeps unplaced deals out of the stage math but inside the outcomes", () => {
    const conversion = summarizeStageConversion(
      [...open, dealAt("o5", "proc-a", "")],
      [...won, dealAt("w2", "proc-a", "s-gone", { status: "won" })],
      // A deal from another process is defensive noise, counted as unplaced.
      [...lost, dealAt("l2", "proc-other", "s1", { status: "lost" })],
      process,
      false,
    );
    expect(conversion.stages.map((row) => row.reachedCount)).toEqual([6, 4, 2]);
    expect(conversion.stages[1]?.lostCount).toBe(1);
    expect(conversion.unassigned).toEqual({ openCount: 1, wonCount: 1, lostCount: 1 });
    expect(conversion.outcomes).toEqual({ openCount: 5, wonCount: 2, lostCount: 2 });
  });
});

describe("summarizeFeed", () => {
  test("drops out-of-period entries and counts them", () => {
    const entries = [
      wallEntry({ date: "2026-01-05 08:00:00+01" }),
      wallEntry({ date: "2026-01-31 23:30:00+01" }),
      wallEntry({ date: "2026-02-01 00:10:00+01" }),
      wallEntry({ date: "" }),
    ];
    const summary = summarizeFeed(entries, JANUARY);
    expect(summary.total).toBe(2);
    expect(summary.outOfPeriodCount).toBe(2);
  });

  test("orders byType by count desc, then plain code-unit name", () => {
    const types = ["email", "note", "", "note", "call"];
    const entries: WallEntry[] = types.map((type) =>
      wallEntry({ type, date: "2026-01-05 08:00:00+01" }),
    );
    expect(summarizeFeed(entries, JANUARY).byType).toEqual([
      { name: "note", count: 2 },
      { name: "", count: 1 },
      { name: "call", count: 1 },
      { name: "email", count: 1 },
    ]);
  });

  test("orders byUser by code unit, never by locale", () => {
    // Locale collation would put "adam" first and "Żaneta" next to "Zaneta";
    // code-unit order is the only order that does not depend on the machine.
    const authors = ["Żaneta Synthetic", "adam Synthetic", "Zaneta Synthetic", "Bogdan Synthetic"];
    const entries: WallEntry[] = authors.map((authorName) =>
      wallEntry({ authorName, date: "2026-01-05 08:00:00+01" }),
    );
    expect(summarizeFeed(entries, JANUARY).byUser).toEqual([
      { name: "Bogdan Synthetic", count: 1 },
      { name: "Zaneta Synthetic", count: 1 },
      { name: "adam Synthetic", count: 1 },
      { name: "Żaneta Synthetic", count: 1 },
    ]);
  });
});

describe("summarizeTasks", () => {
  test("splits the in-period tasks and counts what the filter dropped", () => {
    const tasks: TaskRecord[] = [
      task({ id: "t1", dateFrom: "2026-01-05 09:00:00+01", isCompleted: true, typeName: "call" }),
      task({ id: "t2", dateFrom: "2026-01-06 09:00:00+01", isCompleted: false, typeName: "call" }),
      task({ id: "t3", dateFrom: "2026-01-07 09:00:00+01", isCompleted: false, typeName: "" }),
      task({ id: "t4", dateFrom: "2026-02-02 09:00:00+01", isCompleted: false, typeName: "call" }),
      task({ id: "t5", dateFrom: "", isCompleted: true, typeName: "call" }),
    ];
    expect(summarizeTasks(tasks, JANUARY)).toEqual({
      total: 3,
      completedCount: 1,
      openCount: 2,
      byType: [
        { name: "call", count: 2 },
        { name: "", count: 1 },
      ],
      outOfPeriodCount: 1,
      noDateCount: 1,
    });
  });
});

describe("summarizeForecast", () => {
  const open = [
    dealAt("o1", "proc-a", "a1", { dateEnd: "2026-01-10", value: 100, probability: 50 }),
    dealAt("o2", "proc-a", "a1", { dateEnd: "2026-02-10", value: 400, probability: 50 }),
    dealAt("o3", "proc-a", "a1", { dateEnd: "", value: 300, probability: 50 }),
    dealAt("o4", "proc-a", "a1", { dateEnd: "2026-01-20", value: 200, probability: 150 }),
    dealAt("o5", "proc-a", "a1", { dateEnd: "2026-01-21", value: 50, probability: null }),
  ];
  const won = [
    dealAt("w1", "proc-a", "a2", {
      status: "won",
      statusChangeDate: "2026-01-15 12:00:00+01",
      value: 900,
    }),
    dealAt("w2", "proc-a", "a2", {
      status: "won",
      statusChangeDate: "2025-12-31 23:00:00+01",
      value: 111,
    }),
    dealAt("w3", "proc-a", "a2", { status: "won", statusChangeDate: "", value: 222 }),
  ];
  const lost = [
    dealAt("l1", "proc-a", "a1", {
      status: "lost",
      statusChangeDate: "2026-01-31 09:00:00+01",
      value: 80,
    }),
    dealAt("l2", "proc-a", "a1", { status: "lost", statusChangeDate: "", value: null }),
  ];

  test("buckets by date_end and status_change_date, weighting only usable rows", () => {
    expect(summarizeForecast(open, won, lost, JANUARY, false)).toEqual({
      forecast: {
        dealCount: 3,
        value: { sum: 350, missing: 0 },
        // Only o1 carries a value AND a probability inside [0, 100].
        weightedValueSum: 50,
        weightedMissing: 2,
        noDateEndCount: 1,
      },
      realization: {
        won: { dealCount: 1, value: { sum: 900, missing: 0 } },
        lost: { dealCount: 1, value: { sum: 80, missing: 0 } },
        noStatusChangeDateCount: 2,
      },
      currencies: ["PLN"],
    });
  });

  test("scopes the currency check to the rows that contribute", () => {
    const mixedWindow = [
      dealAt("o1", "proc-a", "a1", {
        dateEnd: "2026-01-10",
        value: 100,
        probability: 50,
        currency: "PLN",
      }),
      dealAt("o2", "proc-a", "a1", {
        dateEnd: "2026-03-01",
        value: 999,
        probability: 50,
        currency: "EUR",
      }),
    ];
    const scoped = summarizeForecast(mixedWindow, [], [], JANUARY, false);
    expect(scoped.forecast.value).toEqual({ sum: 100, missing: 0 });
    expect(scoped.forecast.weightedValueSum).toBe(50);
    expect(scoped.currencies).toEqual(["EUR", "PLN"]);

    const mixedInPeriod = [
      mixedWindow[0] as DealRecord,
      dealAt("o3", "proc-a", "a1", {
        dateEnd: "2026-01-11",
        value: 999,
        probability: 50,
        currency: "EUR",
      }),
    ];
    const mixed = summarizeForecast(mixedInPeriod, [], [], JANUARY, false);
    expect(mixed.forecast.value).toEqual({ sum: null, missing: 0 });
    expect(mixed.forecast.weightedValueSum).toBe(null);
  });

  test("withholds every period sum when the fetch was truncated", () => {
    const cut = summarizeForecast(open, won, lost, JANUARY, true);
    expect(cut.forecast.dealCount).toBe(3);
    expect(cut.forecast.value).toEqual({ sum: null, missing: 0 });
    expect(cut.forecast.weightedValueSum).toBe(null);
    expect(cut.forecast.weightedMissing).toBe(2);
    expect(cut.forecast.noDateEndCount).toBe(1);
    expect(cut.realization.won).toEqual({ dealCount: 1, value: { sum: null, missing: 0 } });
    expect(cut.realization.lost).toEqual({ dealCount: 1, value: { sum: null, missing: 0 } });
    expect(cut.realization.noStatusChangeDateCount).toBe(2);
  });
});

describe("aggregator purity", () => {
  const processes = [processInfo("proc-a", ["a1", "a2"])];
  const deals = frozen([
    dealAt("d1", "proc-a", "a1", { value: 100, probability: 10 }),
    dealAt("d2", "proc-a", "a2", { value: 200, probability: 20 }),
    dealAt("d3", "proc-a", "", { value: null }),
  ]);
  const entries = frozen([
    wallEntry({ date: "2026-01-05 08:00:00+01", type: "note" }),
    wallEntry({ date: "2026-02-05 08:00:00+01", type: "call" }),
  ]);
  const tasks = frozen([
    task({ id: "t1", dateFrom: "2026-01-05 09:00:00+01" }),
    task({ id: "t2", dateFrom: "" }),
  ]);

  test("answers the same thing twice and never touches its inputs", () => {
    const snapshot = structuredClone({ deals, entries, tasks });

    expect(summarizePipeline(deals, processes)).toEqual(summarizePipeline(deals, processes));
    expect(summarizeStageConversion(deals, [], [], processes[0] as ProcessInfo, false)).toEqual(
      summarizeStageConversion(deals, [], [], processes[0] as ProcessInfo, false),
    );
    expect(summarizeFeed(entries, JANUARY)).toEqual(summarizeFeed(entries, JANUARY));
    expect(summarizeTasks(tasks, JANUARY)).toEqual(summarizeTasks(tasks, JANUARY));
    expect(summarizeForecast(deals, [], [], JANUARY, false)).toEqual(
      summarizeForecast(deals, [], [], JANUARY, false),
    );

    expect({ deals, entries, tasks }).toEqual(snapshot);
  });
});
