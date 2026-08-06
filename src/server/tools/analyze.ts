import * as z from "zod/v4";
import type { ActivityFetchers } from "../../livespace/activity.js";
import {
  fetchDealWindow,
  fetchFeedWindow,
  fetchTaskWindow,
  summarizeFeed,
  summarizeForecast,
  summarizePipeline,
  summarizeStageConversion,
  summarizeTasks,
  type DealWindowOptions,
  type Period,
  type PeriodWindowOptions,
  type Window,
} from "../../livespace/aggregate.js";
import { cancelledError } from "../../livespace/errors.js";
import type { ProcessInfo } from "../../livespace/metadata.js";
import type { DealRecord, RecordFetchers } from "../../livespace/records.js";
import type { MetadataService, SectionResult } from "./crm-metadata.js";
import {
  toolErrorSchema,
  toToolError,
  type ToolError,
  type ToolRunResult,
} from "./tool-error.js";

/**
 * `analyze` - four named aggregations over bounded windows.
 *
 * Livespace has no aggregations and reports no totals, so every number here is
 * computed by this server over a window it swept itself. Four shapes of
 * discipline live here:
 *
 * 1. One analysis per call, chosen by a flat `analysis` enum, with one optional
 *    envelope key per analysis on a single output root. Neither schema is a
 *    union: a union inputSchema root emits `oneOf` without `"type": "object"`
 *    and is not a valid MCP inputSchema, and a union of look-alike output
 *    shapes would let one envelope validate as another and silently strip
 *    fields it does not know (M3 lesson).
 * 2. One budget, one abort. The runner fixes a deadline and owns an
 *    `AbortController` combined with the caller's signal; every sweep receives
 *    both, and a rejection inside a `Promise.all` group aborts the controller
 *    so the siblings stop paging for a call that has already failed.
 * 3. All-or-nothing per analysis, except `activity_summary`. A pipeline or
 *    forecast answer missing one status window would be a silently wrong
 *    number, so any failed deal window fails the call. Activity has two
 *    independent sources: one may fail while the other answers, carrying the
 *    error entry alongside (the M3 partial-results idiom).
 * 4. The markdown channel carries counts and fixed wording only. Process,
 *    stage, user and type names are CRM-authored, so they stay in
 *    `structuredContent` where the schema types them as data
 *    (docs/security.md par. 4).
 *
 * Nothing here is cached. Record data never is (docs/security.md par. 8); the
 * only cached input is the `processes` dictionary, read through the existing
 * `MetadataService`, and its `{asOf, stale}` freshness travels into the answer.
 */

const ANALYSES = [
  "pipeline_summary",
  "stage_conversion",
  "activity_summary",
  "forecast_vs_realization",
] as const;

type Analysis = (typeof ANALYSES)[number];

/**
 * Wall clock for ONE analyze call. A 100-row deal page measured 3-9 s upstream,
 * and a worst-case analysis is three windows of five pages through a two-slot
 * throttle - unbounded, that runs for many minutes. Sweeps stop at the deadline
 * and report `truncated`, which is a fact about the answer, not an error.
 */
export const ANALYZE_BUDGET_MS = 60_000;

const inputSchema = z.strictObject({
  analysis: z.enum(ANALYSES).describe("Which named aggregation to run."),
  processId: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      "Required for stage_conversion; optional scope for pipeline_summary and forecast_vs_realization; not accepted for activity_summary. Get ids from crm_metadata (processes).",
    ),
  dateFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/u)
    .optional()
    .describe(
      "Start of the period (YYYY-MM-DD, inclusive). Required for activity_summary and forecast_vs_realization; not accepted otherwise.",
    ),
  dateTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/u)
    .optional()
    .describe("End of the period (YYYY-MM-DD, inclusive). Required with dateFrom."),
});

const windowSchema = z.strictObject({ fetched: z.number(), truncated: z.boolean() });
const valueStatsSchema = z.strictObject({ sum: z.number().nullable(), missing: z.number() });
const countRowSchema = z.strictObject({ name: z.string(), count: z.number() });
const dictionarySchema = z.strictObject({ asOf: z.number(), stale: z.boolean() });
const periodSchema = z.strictObject({ from: z.string(), to: z.string() });

// Optional keys per analysis, never a union: exactly one envelope is present on
// a successful answer and none at all on a failed one.
const outputSchema = z.strictObject({
  analysis: z.string(),
  pipelineSummary: z
    .strictObject({
      processes: z.array(
        z.strictObject({
          processId: z.string(),
          processName: z.string(),
          stages: z.array(
            z.strictObject({
              stageId: z.string(),
              stageName: z.string(),
              position: z.number(),
              dealCount: z.number(),
              value: valueStatsSchema,
              avgProbability: z.number().nullable(),
              probabilityMissing: z.number(),
            }),
          ),
          unassigned: z.strictObject({ dealCount: z.number(), value: valueStatsSchema }),
          totals: z.strictObject({ dealCount: z.number(), value: valueStatsSchema }),
        }),
      ),
      currencies: z.array(z.string()),
      totalOpenDeals: z.number(),
      processesDictionary: dictionarySchema,
      basedOn: z.strictObject({ deals: windowSchema }),
    })
    .optional(),
  stageConversion: z
    .strictObject({
      processId: z.string(),
      processName: z.string(),
      stages: z.array(
        z.strictObject({
          stageId: z.string(),
          stageName: z.string(),
          position: z.number(),
          openCount: z.number(),
          lostCount: z.number(),
          wonCount: z.number(),
          reachedCount: z.number(),
          conversionFromPrevious: z.number().nullable(),
        }),
      ),
      outcomes: z.strictObject({
        openCount: z.number(),
        wonCount: z.number(),
        lostCount: z.number(),
      }),
      unassigned: z.strictObject({
        openCount: z.number(),
        wonCount: z.number(),
        lostCount: z.number(),
      }),
      processesDictionary: dictionarySchema,
      basedOn: z.strictObject({
        open: windowSchema,
        won: windowSchema,
        lost: windowSchema,
      }),
    })
    .optional(),
  activitySummary: z
    .strictObject({
      period: periodSchema,
      feed: z
        .strictObject({
          total: z.number(),
          byType: z.array(countRowSchema),
          byUser: z.array(countRowSchema),
          outOfPeriodCount: z.number(),
          basedOn: z.strictObject({ entries: windowSchema }),
        })
        .optional(),
      tasks: z
        .strictObject({
          total: z.number(),
          completedCount: z.number(),
          openCount: z.number(),
          byType: z.array(countRowSchema),
          outOfPeriodCount: z.number(),
          noDateCount: z.number(),
          basedOn: z.strictObject({ tasks: windowSchema }),
        })
        .optional(),
    })
    .optional(),
  forecastVsRealization: z
    .strictObject({
      period: periodSchema,
      forecast: z.strictObject({
        dealCount: z.number(),
        value: valueStatsSchema,
        weightedValueSum: z.number().nullable(),
        weightedMissing: z.number(),
        noDateEndCount: z.number(),
      }),
      realization: z.strictObject({
        won: z.strictObject({ dealCount: z.number(), value: valueStatsSchema }),
        lost: z.strictObject({ dealCount: z.number(), value: valueStatsSchema }),
        noStatusChangeDateCount: z.number(),
      }),
      currencies: z.array(z.string()),
      basedOn: z.strictObject({
        open: windowSchema,
        won: windowSchema,
        lost: windowSchema,
      }),
    })
    .optional(),
  assumptions: z.array(z.string()),
  errors: z.array(toolErrorSchema),
});

export type AnalyzeArgs = z.output<typeof inputSchema>;

export type AnalyzeResult = ToolRunResult;

export const analyzeToolConfig = {
  title: "Analyze CRM",
  description: `Run one named aggregation per call. "pipeline_summary" counts open deals per
process and stage and takes an optional processId scope; "stage_conversion"
needs processId and estimates stage-to-stage conversion inside it;
"activity_summary" needs dateFrom and dateTo (YYYY-MM-DD) and counts feed
entries and tasks by type and by user; "forecast_vs_realization" needs the
same period, weighs open deals due in it against the deals won and lost in
it, and takes an optional processId scope. Take process ids from
crm_metadata; never guess them. Notes: Livespace has no aggregations, so
every number is computed over a window this server fetched - up to 500
deals per status, 1000 feed entries and 500 tasks, and one call stops after
60 seconds - so read basedOn for what was fetched and whether it was cut
short; a truncated window withholds (nulls) period sums and conversion
ratios while the counts stay; sums skip deals with no value and count them
in value.missing, and a sum whose rows mix currencies is null (see
currencies); stage conversion is a point-in-time estimate from current stage
positions, because the API keeps no stage history; assumptions lists what
the answer took for granted.`,
  inputSchema,
  outputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
} as const;

const WINDOW_ASSUMPTION = "Aggregates cover only the fetched window; check basedOn.truncated.";

const CURRENCY_ASSUMPTION = "A null sum means the rows mix currencies; see currencies.";

const DICTIONARY_ASSUMPTION =
  "Stage names and order come from the cached processes dictionary; a stage added since the last refresh lands under unassigned.";

const ASSUMPTIONS: Record<Analysis, readonly string[]> = {
  pipeline_summary: [
    WINDOW_ASSUMPTION,
    CURRENCY_ASSUMPTION,
    "Deals with no stage are counted under unassigned.",
    DICTIONARY_ASSUMPTION,
  ],
  stage_conversion: [
    WINDOW_ASSUMPTION,
    "The API keeps no stage history: conversion is a point-in-time estimate from current stage positions.",
    "A deal at or past a stage is assumed to have passed through it.",
    "Deals with no stage are excluded from reached counts and listed under unassigned.",
    "If basedOn reports truncation, conversion ratios are withheld (null).",
    DICTIONARY_ASSUMPTION,
  ],
  activity_summary: [
    WINDOW_ASSUMPTION,
    "Feed and task sources are independent; one may fail without the other.",
    "Tasks are bucketed by date_from; the upstream to-exclusive filter is widened and re-filtered locally.",
  ],
  forecast_vs_realization: [
    WINDOW_ASSUMPTION,
    CURRENCY_ASSUMPTION,
    "Forecast buckets open deals by date_end; realization buckets closed deals by status_change_date (date part).",
    "weightedValueSum multiplies value by probability/100 (a 0-100 percentage) and skips rows missing either or out of range.",
    "If basedOn reports truncation, period sums are withheld (null).",
  ],
};

/** The budget and the abort wiring one analyze call shares across its sweeps. */
interface Budget {
  deadlineAt: number;
  /** The combined signal every window fetch and dictionary read receives. */
  signal: AbortSignal;
  controller: AbortController;
  /** The CALLER's signal - the only reliable cancellation state (M3 lesson). */
  caller: AbortSignal | undefined;
}

interface DealWindows {
  open: Window<DealRecord>;
  won: Window<DealRecord>;
  lost: Window<DealRecord>;
}

/**
 * Cross-field rules live here rather than in the schema: a zod refinement would
 * turn every combination mistake into a protocol-level validation error, while a
 * returned `{code, message, hint}` tells the model how to fix the call.
 */
function argumentHint(args: AnalyzeArgs): string | null {
  const analysis = args.analysis;
  const needsPeriod =
    analysis === "activity_summary" || analysis === "forecast_vs_realization";
  if (needsPeriod) {
    if (args.dateFrom === undefined || args.dateTo === undefined) {
      return `Analysis "${analysis}" needs both dateFrom and dateTo (YYYY-MM-DD) - the period is applied locally.`;
    }
  } else if (args.dateFrom !== undefined || args.dateTo !== undefined) {
    return `Analysis "${analysis}" reads the pipeline as it stands now. Drop dateFrom and dateTo, or ask for activity_summary or forecast_vs_realization.`;
  }
  if (analysis === "stage_conversion" && args.processId === undefined) {
    return 'Analysis "stage_conversion" runs on one process. Pass processId - take it from crm_metadata (sections: ["processes"]).';
  }
  if (analysis === "activity_summary" && args.processId !== undefined) {
    return "Activity is not scoped by process. Drop processId, or ask for pipeline_summary or forecast_vs_realization.";
  }
  if (
    args.dateFrom !== undefined &&
    args.dateTo !== undefined &&
    args.dateFrom > args.dateTo
  ) {
    return "dateFrom must not be later than dateTo. Swap them, or widen the period.";
  }
  return null;
}

function badParams(hint: string): ToolError {
  return {
    code: "BAD_PARAMS",
    message: "These analyze arguments cannot be combined.",
    hint,
  };
}

function processNotFound(): ToolError {
  return {
    code: "NOT_FOUND",
    message: "Process not found.",
    hint: 'Call crm_metadata (sections: ["processes"]) for valid process ids.',
  };
}

/**
 * A failed answer carries no envelope and no assumptions - there is nothing to
 * qualify. The text names the code and nothing else.
 */
function failed(analysis: Analysis, errors: [ToolError, ...ToolError[]]): AnalyzeResult {
  return {
    text: `analyze ${analysis} failed: ${errors[0].code}.`,
    structured: { analysis, assumptions: [], errors },
    isError: true,
  };
}

/**
 * The CANCELLED contract at every catch site: only the caller's signal STATE is
 * reliable (an abort surfaces as a DOMException, a plain Error or a bare string
 * reason), and a cancelled call NEVER returns a tool result - it rejects.
 */
function toEntry(error: unknown, budget: Budget): ToolError {
  if (budget.caller?.aborted) throw cancelledError();
  const entry = toToolError(error);
  if (entry.code === "CANCELLED") throw cancelledError();
  return entry;
}

/** What `basedOn` says about a window: how much came back, and was it cut. */
function windowStats(window: Window<unknown>): { fetched: number; truncated: boolean } {
  return { fetched: window.fetched, truncated: window.truncated };
}

function dealOptions(
  status: "open" | "won" | "lost",
  processId: string | undefined,
  budget: Budget,
): DealWindowOptions {
  const options: DealWindowOptions = {
    status,
    deadlineAt: budget.deadlineAt,
    signal: budget.signal,
  };
  // Absent, not undefined: an unscoped sweep sends no process filter at all.
  if (processId !== undefined) options.processId = processId;
  return options;
}

function periodOptions(period: Period, budget: Budget): PeriodWindowOptions {
  return {
    dateFrom: period.from,
    dateTo: period.to,
    deadlineAt: budget.deadlineAt,
    signal: budget.signal,
  };
}

type Resolved =
  | { dictionary: SectionResult<"processes">; scoped: ProcessInfo | undefined }
  | { error: ToolError };

/**
 * Reads the processes dictionary and resolves an optional scope. Both failures -
 * the read itself and an id nothing matches - end the call before a single
 * record is fetched, so a typo costs no upstream load.
 */
async function resolveProcesses(
  metadata: MetadataService,
  processId: string | undefined,
  budget: Budget,
): Promise<Resolved> {
  let dictionary: SectionResult<"processes">;
  try {
    dictionary = await metadata.get("processes", { signal: budget.signal });
  } catch (error) {
    return { error: toEntry(error, budget) };
  }
  if (processId === undefined) return { dictionary, scoped: undefined };
  const scoped = dictionary.data.find((process) => process.id === processId);
  if (scoped === undefined) return { error: processNotFound() };
  return { dictionary, scoped };
}

/**
 * The three status windows of one analysis. They run concurrently - the client
 * throttle (2 concurrent, 150 ms apart) is the upstream guard - and the first
 * rejection aborts the shared controller so the siblings stop paging.
 */
async function fetchStatusWindows(
  records: RecordFetchers,
  processId: string | undefined,
  budget: Budget,
): Promise<DealWindows> {
  try {
    const [open, won, lost] = await Promise.all([
      fetchDealWindow(records, dealOptions("open", processId, budget)),
      fetchDealWindow(records, dealOptions("won", processId, budget)),
      fetchDealWindow(records, dealOptions("lost", processId, budget)),
    ]);
    return { open, won, lost };
  } catch (error) {
    budget.controller.abort();
    throw error;
  }
}

function anyTruncated(windows: DealWindows): boolean {
  return windows.open.truncated || windows.won.truncated || windows.lost.truncated;
}

function statusBasedOn(windows: DealWindows): Record<string, unknown> {
  return {
    open: windowStats(windows.open),
    won: windowStats(windows.won),
    lost: windowStats(windows.lost),
  };
}

async function pipelineAnswer(
  records: RecordFetchers,
  metadata: MetadataService,
  args: AnalyzeArgs,
  budget: Budget,
): Promise<AnalyzeResult> {
  const resolved = await resolveProcesses(metadata, args.processId, budget);
  if ("error" in resolved) return failed("pipeline_summary", [resolved.error]);

  let window: Window<DealRecord>;
  try {
    window = await fetchDealWindow(records, dealOptions("open", args.processId, budget));
  } catch (error) {
    return failed("pipeline_summary", [toEntry(error, budget)]);
  }

  // A scoped call answers about ONE process; an unscoped one about the whole
  // dictionary, in its emission order - which is the pipeline order.
  const summary = summarizePipeline(
    window.rows,
    resolved.scoped === undefined ? resolved.dictionary.data : [resolved.scoped],
  );
  return {
    text: `analyze pipeline_summary: ${summary.totalOpenDeals} open deals across ${summary.processes.length} processes (truncated: ${window.truncated}).`,
    structured: {
      analysis: "pipeline_summary",
      pipelineSummary: {
        ...summary,
        processesDictionary: {
          asOf: resolved.dictionary.asOf,
          stale: resolved.dictionary.stale,
        },
        basedOn: { deals: windowStats(window) },
      },
      assumptions: [...ASSUMPTIONS.pipeline_summary],
      errors: [],
    },
    isError: false,
  };
}

async function conversionAnswer(
  records: RecordFetchers,
  metadata: MetadataService,
  args: AnalyzeArgs,
  budget: Budget,
): Promise<AnalyzeResult> {
  const resolved = await resolveProcesses(metadata, args.processId, budget);
  if ("error" in resolved) return failed("stage_conversion", [resolved.error]);
  // `argumentHint` already refused a stage_conversion without a processId, so
  // the scope is resolved here.
  const process = resolved.scoped as ProcessInfo;

  let windows: DealWindows;
  try {
    windows = await fetchStatusWindows(records, args.processId, budget);
  } catch (error) {
    return failed("stage_conversion", [toEntry(error, budget)]);
  }

  const truncated = anyTruncated(windows);
  const summary = summarizeStageConversion(
    windows.open.rows,
    windows.won.rows,
    windows.lost.rows,
    process,
    truncated,
  );
  const { openCount, wonCount, lostCount } = summary.outcomes;
  return {
    text: `analyze stage_conversion: ${summary.stages.length} stages; open ${openCount}, won ${wonCount}, lost ${lostCount} (truncated: ${truncated}).`,
    structured: {
      analysis: "stage_conversion",
      stageConversion: {
        ...summary,
        processesDictionary: {
          asOf: resolved.dictionary.asOf,
          stale: resolved.dictionary.stale,
        },
        basedOn: statusBasedOn(windows),
      },
      assumptions: [...ASSUMPTIONS.stage_conversion],
      errors: [],
    },
    isError: false,
  };
}

async function activityAnswer(
  records: RecordFetchers,
  activity: ActivityFetchers,
  args: AnalyzeArgs,
  budget: Budget,
): Promise<AnalyzeResult> {
  // `argumentHint` already refused an activity_summary without both dates.
  const period: Period = { from: args.dateFrom as string, to: args.dateTo as string };
  // Two independent sources, so neither aborts the other: one failing feed must
  // not cost the task counts.
  const [feed, tasks] = await Promise.allSettled([
    fetchFeedWindow(activity, periodOptions(period, budget)),
    fetchTaskWindow(records, periodOptions(period, budget)),
  ]);

  const feedError = feed.status === "rejected" ? toToolError(feed.reason) : undefined;
  const taskError = tasks.status === "rejected" ? toToolError(tasks.reason) : undefined;
  // A partial answer for a request nobody is waiting for is worse than none.
  if (budget.caller?.aborted) throw cancelledError();
  if (feedError !== undefined && taskError !== undefined) {
    if (feedError.code === "CANCELLED" && taskError.code === "CANCELLED") {
      throw cancelledError();
    }
    return failed("activity_summary", [feedError, taskError]);
  }

  const envelope: Record<string, unknown> = {
    period: { from: period.from, to: period.to },
  };
  let truncated = false;
  let feedText = "feed -";
  let taskText = "tasks -";
  if (feed.status === "fulfilled") {
    const summary = summarizeFeed(feed.value.rows, period);
    envelope["feed"] = { ...summary, basedOn: { entries: windowStats(feed.value) } };
    truncated = truncated || feed.value.truncated;
    feedText = `feed ${summary.total} entries`;
  }
  if (tasks.status === "fulfilled") {
    const summary = summarizeTasks(tasks.value.rows, period);
    envelope["tasks"] = { ...summary, basedOn: { tasks: windowStats(tasks.value) } };
    truncated = truncated || tasks.value.truncated;
    taskText = `tasks ${summary.total}`;
  }

  // At most one entry survives to here - both failing is a failed answer above.
  const errors = [feedError, taskError].filter(
    (entry): entry is ToolError => entry !== undefined,
  );
  const tail = errors.length > 0 ? ` Errors: ${errors.length}.` : "";
  return {
    text: `analyze activity_summary: ${feedText}, ${taskText} (truncated: ${truncated}).${tail}`,
    structured: {
      analysis: "activity_summary",
      activitySummary: envelope,
      assumptions: [...ASSUMPTIONS.activity_summary],
      errors,
    },
    isError: false,
  };
}

async function forecastAnswer(
  records: RecordFetchers,
  metadata: MetadataService,
  args: AnalyzeArgs,
  budget: Budget,
): Promise<AnalyzeResult> {
  // The dictionary is read only to validate a scope: the forecast envelope
  // carries no stage names, so an unscoped call needs no dictionary at all.
  if (args.processId !== undefined) {
    const resolved = await resolveProcesses(metadata, args.processId, budget);
    if ("error" in resolved) return failed("forecast_vs_realization", [resolved.error]);
  }
  // `argumentHint` already refused a forecast without both dates.
  const period: Period = { from: args.dateFrom as string, to: args.dateTo as string };

  let windows: DealWindows;
  try {
    windows = await fetchStatusWindows(records, args.processId, budget);
  } catch (error) {
    return failed("forecast_vs_realization", [toEntry(error, budget)]);
  }

  const truncated = anyTruncated(windows);
  const summary = summarizeForecast(
    windows.open.rows,
    windows.won.rows,
    windows.lost.rows,
    period,
    truncated,
  );
  const counts = `forecast ${summary.forecast.dealCount} deals, won ${summary.realization.won.dealCount}, lost ${summary.realization.lost.dealCount} in period`;
  return {
    text: `analyze forecast_vs_realization: ${counts} (truncated: ${truncated}).`,
    structured: {
      analysis: "forecast_vs_realization",
      forecastVsRealization: {
        period: { from: period.from, to: period.to },
        ...summary,
        basedOn: statusBasedOn(windows),
      },
      assumptions: [...ASSUMPTIONS.forecast_vs_realization],
      errors: [],
    },
    isError: false,
  };
}

export async function runAnalyze(
  records: RecordFetchers,
  activity: ActivityFetchers,
  metadata: MetadataService,
  args: AnalyzeArgs,
  opts: { signal?: AbortSignal } = {},
): Promise<AnalyzeResult> {
  const hint = argumentHint(args);
  if (hint !== null) return failed(args.analysis, [badParams(hint)]);
  // A caller who walked away before the first fetch gets no work and no result.
  if (opts.signal?.aborted) throw cancelledError();

  const controller = new AbortController();
  const budget: Budget = {
    deadlineAt: Date.now() + ANALYZE_BUDGET_MS,
    signal: opts.signal
      ? AbortSignal.any([opts.signal, controller.signal])
      : controller.signal,
    controller,
    caller: opts.signal,
  };

  if (args.analysis === "pipeline_summary") {
    return pipelineAnswer(records, metadata, args, budget);
  }
  if (args.analysis === "stage_conversion") {
    return conversionAnswer(records, metadata, args, budget);
  }
  if (args.analysis === "activity_summary") {
    return activityAnswer(records, activity, args, budget);
  }
  return forecastAnswer(records, metadata, args, budget);
}
