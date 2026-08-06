import type { ActivityFetchers, CrmFeedOptions, WallEntry } from "./activity.js";
import type { ProcessInfo, ProcessStage } from "./metadata.js";
import type {
  DealListOptions,
  DealRecord,
  RecordFetchers,
  TaskListOptions,
  TaskRecord,
} from "./records.js";

/**
 * Bounded windows over the M4 fetchers - the input side of `analyze`.
 *
 * Livespace has no aggregations and reports no totals anywhere, so every number
 * `analyze` answers with is computed over a window this module swept itself.
 * Four rules shape every sweep:
 *
 * 1. Bounded. Each window has a fixed page size, a page cap, and a caller-owned
 *    wall-clock deadline checked before every page AFTER the first - the first
 *    page always runs, because a call that answers nothing is worse than one
 *    that answers late. A sweep that stopped with rows still upstream reports
 *    `truncated: true`, which is a fact about the answer, not an error.
 * 2. Deduped by record id. Offset paging over live data can re-deliver a row
 *    when rows shift between pages, and a double-counted deal corrupts a sum
 *    silently. `fetched` counts unique rows. The feed carries no record ids to
 *    dedupe on; there the offset chain is the guarantee.
 * 3. Nothing is cached. Record data never is (docs/security.md par. 8), so this
 *    module must never import the server cache.
 * 4. Explicit limits, with the one documented exception: `Todo/getTodoObjects`
 *    takes no limit and always answers with fixed 50-row pages, so
 *    `TASK_WINDOW_MAX_PAGES` is the only load control there (docs/security.md
 *    par. 3).
 *
 * Errors are left alone: whatever a fetcher throws reaches the caller intact,
 * and the tool layer maps it.
 */

/**
 * Window budgets. A 100-row deal page measured 3-9 s on the sandbox and gets
 * the M4.5 large-page timeout; the feed answers ~1.1 s per 200 light rows;
 * tasks come in fixed 50-row pages. The caps below are what one analysis may
 * spend per source before the answer is declared partial.
 */
export const DEAL_WINDOW_PAGE = 100;
export const DEAL_WINDOW_MAX_PAGES = 5;
export const FEED_WINDOW_PAGE = 200;
export const FEED_WINDOW_MAX_PAGES = 5;
export const TASK_WINDOW_MAX_PAGES = 10;

/** `Todo/getTodoObjects` answers with exactly 50 rows per page (M4 probe). */
const TASK_WINDOW_PAGE = 50;

const DAY_MS = 86_400_000;

/**
 * One swept window. `fetched` is the UNIQUE row count, so it can be compared
 * against a page budget; `truncated` says the window is a prefix of what
 * upstream holds.
 */
export interface Window<T> {
  rows: T[];
  fetched: number;
  truncated: boolean;
}

export interface DealWindowOptions {
  status: "open" | "won" | "lost";
  processId?: string;
  deadlineAt?: number;
  signal?: AbortSignal;
}

export interface PeriodWindowOptions {
  dateFrom: string;
  dateTo: string;
  deadlineAt?: number;
  signal?: AbortSignal;
}

/**
 * The day after a "YYYY-MM-DD" date, in UTC so month, year and leap-day ends
 * cross correctly and no local timezone can shift the result.
 */
export function dayAfter(date: string): string {
  const next = new Date(`${date}T00:00:00Z`).getTime() + DAY_MS;
  return new Date(next).toISOString().slice(0, 10);
}

/** One upstream page, in the shape `ListPage` and `CrmFeedPage` both have. */
interface WindowPage<T> {
  items: T[];
  hasMore: boolean;
  rawCount: number;
}

interface SweepPlan<T> {
  maxPages: number;
  /** Rows we ask for per page; the cursor never advances by more than this. */
  pageSize: number;
  deadlineAt: number | undefined;
  /** `null` for rows that carry no record id - the feed. */
  idOf: ((row: T) => string) | null;
  fetchPage(cursor: { offset: number; page: number }): Promise<WindowPage<T>>;
}

/**
 * The one place the window rules live: page cap, deadline, dedupe, cursor and
 * the truncation flag. Three sources share it so the rules cannot drift apart.
 *
 * `truncated` is deliberately conservative: a window that filled every page and
 * whose last page still claims more reports `truncated: true` even when nothing
 * is actually left upstream. Livespace reports no totals, so the only way to
 * know better would be to spend one more page on every full window - a worse
 * trade than an occasional over-cautious flag.
 */
async function sweep<T>(plan: SweepPlan<T>): Promise<Window<T>> {
  const rows: T[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let truncated = false;
  for (let page = 0; page < plan.maxPages; page += 1) {
    if (page > 0 && plan.deadlineAt !== undefined && Date.now() >= plan.deadlineAt) {
      truncated = true;
      break;
    }
    const result = await plan.fetchPage({ offset, page: page + 1 });
    for (const row of result.items) {
      if (plan.idOf !== null) {
        const id = plan.idOf(row);
        if (seen.has(id)) continue;
        seen.add(id);
      }
      rows.push(row);
    }
    // The `rawCount === 0` guard keeps a hasMore-true empty page from paging on
    // forever - an upstream that always claims more would never end the loop.
    if (!result.hasMore || result.rawCount === 0) break;
    // The M4 cursor rule: advance by the window we ASKED for at most, so an
    // endpoint that ignores the limit can neither skip rows nor loop forever.
    offset += Math.min(result.rawCount, plan.pageSize);
    if (page === plan.maxPages - 1) truncated = true;
  }
  return { rows, fetched: rows.length, truncated };
}

function dealId(row: DealRecord): string {
  return row.id;
}

function taskId(row: TaskRecord): string {
  return row.id;
}

/**
 * Deals for ONE status. `status: "all"` is never used: it hits the window cap
 * before it hits the data and hides the split every analysis needs anyway.
 * Date filtering is not attempted upstream - `Deal/getAll` accepts and IGNORES
 * every date parameter except `modified`, and `status_change_date` can be later
 * than `modified`, so a pre-filter would drop rows (probe 2026-08-06).
 */
export function fetchDealWindow(
  records: RecordFetchers,
  opts: DealWindowOptions,
): Promise<Window<DealRecord>> {
  return sweep({
    maxPages: DEAL_WINDOW_MAX_PAGES,
    pageSize: DEAL_WINDOW_PAGE,
    deadlineAt: opts.deadlineAt,
    idOf: dealId,
    fetchPage: ({ offset }) => {
      const options: DealListOptions = {
        status: opts.status,
        limit: DEAL_WINDOW_PAGE,
        offset,
        signal: opts.signal,
      };
      // Absent, not undefined: an unscoped sweep sends no process filter at all.
      if (opts.processId !== undefined) options.processId = opts.processId;
      return records.listDeals(options);
    },
  });
}

/**
 * The CRM-wide feed. `Wall/getList` honours its date range and is INCLUSIVE on
 * both ends (probe 2026-08-06), so the caller's dates go up verbatim; the
 * summarizer re-filters locally anyway, belt and braces.
 */
export function fetchFeedWindow(
  activity: ActivityFetchers,
  opts: PeriodWindowOptions,
): Promise<Window<WallEntry>> {
  return sweep({
    maxPages: FEED_WINDOW_MAX_PAGES,
    pageSize: FEED_WINDOW_PAGE,
    deadlineAt: opts.deadlineAt,
    idOf: null,
    fetchPage: ({ offset }) => {
      const options: CrmFeedOptions = {
        dateFrom: opts.dateFrom,
        dateTo: opts.dateTo,
        limit: FEED_WINDOW_PAGE,
        offset,
        signal: opts.signal,
      };
      return activity.crmFeed(options);
    },
  });
}

/**
 * Tasks. Two upstream quirks are handled here: pages are numbered rather than
 * offset (no limit parameter exists), and `datesPeriod.to` is EXCLUSIVE at day
 * granularity - so the upper bound goes up WIDENED by a day and the summarizer
 * re-filters to the documented inclusive period. No `completed` filter is sent:
 * the split is local, so one sweep answers both halves.
 *
 * `async` is load-bearing, not decoration: this is the one window that computes
 * something (`dayAfter`) before the first await, and callers put it straight
 * into a `Promise.allSettled([...])` argument list, where a synchronous throw
 * would escape the settle and orphan the sibling window.
 */
export async function fetchTaskWindow(
  records: RecordFetchers,
  opts: PeriodWindowOptions,
): Promise<Window<TaskRecord>> {
  const dateTo = dayAfter(opts.dateTo);
  return sweep({
    maxPages: TASK_WINDOW_MAX_PAGES,
    pageSize: TASK_WINDOW_PAGE,
    deadlineAt: opts.deadlineAt,
    idOf: taskId,
    fetchPage: ({ page }) => {
      const options: TaskListOptions = {
        page,
        dateFrom: opts.dateFrom,
        dateTo,
        signal: opts.signal,
      };
      return records.listTasks(options);
    },
  });
}

/**
 * The aggregators - the pure half of `analyze`: mapped records in, envelope
 * rows out. No I/O, no clock reads, no input touched, so the same window always
 * produces the same answer.
 *
 * Four rules of honesty run through all of them:
 *
 * 1. `null` means "not filled in", never zero. A row with no value stays out of
 *    the sum and is counted in `missing`; a row with no probability stays out
 *    of the average. Every aggregate says how many rows it skipped.
 * 2. A sum over mixed currencies is a lie, so it is `null` instead. The check
 *    covers only the rows that CONTRIBUTE (non-null value), and every scope
 *    runs it over its own rows - a total is never the sum of sub-sums, because
 *    two stages in different currencies each sum honestly while their total
 *    does not exist at all.
 * 3. A truncated window invalidates anything period-derived or cross-stage: the
 *    caller passes `truncated` and the affected numbers come back null. Counts
 *    stay - they are honest partials.
 * 4. Ordering is deterministic and locale-free: dictionary order where the
 *    pipeline defines one, otherwise count desc then name asc by PLAIN
 *    code-unit compare. `localeCompare` would make the output depend on the
 *    machine it ran on.
 */

export interface Period {
  from: string;
  to: string;
}

export interface ValueStats {
  sum: number | null;
  missing: number;
}

export interface StageSummaryRow {
  stageId: string;
  stageName: string;
  position: number;
  dealCount: number;
  value: ValueStats;
  avgProbability: number | null;
  probabilityMissing: number;
}

export interface ProcessSummary {
  processId: string;
  processName: string;
  stages: StageSummaryRow[];
  unassigned: { dealCount: number; value: ValueStats };
  totals: { dealCount: number; value: ValueStats };
}

export interface PipelineSummary {
  processes: ProcessSummary[];
  currencies: string[];
  totalOpenDeals: number;
}

export interface ConversionRow {
  stageId: string;
  stageName: string;
  position: number;
  openCount: number;
  lostCount: number;
  wonCount: number;
  reachedCount: number;
  conversionFromPrevious: number | null;
}

export interface StageConversion {
  processId: string;
  processName: string;
  stages: ConversionRow[];
  outcomes: { openCount: number; wonCount: number; lostCount: number };
  unassigned: { openCount: number; wonCount: number; lostCount: number };
}

export interface CountRow {
  name: string;
  count: number;
}

export interface FeedSummary {
  total: number;
  byType: CountRow[];
  byUser: CountRow[];
  outOfPeriodCount: number;
}

export interface TaskSummary {
  total: number;
  completedCount: number;
  openCount: number;
  byType: CountRow[];
  outOfPeriodCount: number;
  noDateCount: number;
}

export interface ForecastSide {
  dealCount: number;
  value: ValueStats;
  weightedValueSum: number | null;
  weightedMissing: number;
  noDateEndCount: number;
}

export interface RealizationSide {
  won: { dealCount: number; value: ValueStats };
  lost: { dealCount: number; value: ValueStats };
  noStatusChangeDateCount: number;
}

export interface ForecastVsRealization {
  forecast: ForecastSide;
  realization: RealizationSide;
  currencies: string[];
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** All a sum needs from a deal: what it is worth and in what. */
interface ValuedRow {
  value: number | null;
  currency: string;
}

/**
 * The one place money is added up. Rows with no value only raise `missing` -
 * they never join the sum and never join the currency check, because a row that
 * contributes nothing cannot make the result ambiguous. A scope with no
 * contributing rows sums to 0, which is a real answer: nothing is worth nothing.
 */
function valueStats(rows: readonly ValuedRow[]): ValueStats {
  const currencies = new Set<string>();
  let sum = 0;
  let missing = 0;
  for (const row of rows) {
    if (row.value === null) {
      missing += 1;
      continue;
    }
    currencies.add(row.currency);
    sum += row.value;
  }
  return { sum: currencies.size > 1 ? null : round2(sum), missing };
}

/** Withholds a sum a truncated window made meaningless, keeping its counts. */
function withheldSum(stats: ValueStats): ValueStats {
  return { sum: null, missing: stats.missing };
}

/** Distinct currencies over ALL rows, value-less ones included - `.sort()` is
 * a code-unit sort, which is the deterministic order we want. */
function distinctCurrencies(rows: readonly ValuedRow[]): string[] {
  return [...new Set(rows.map((row) => row.currency))].sort();
}

/**
 * Groups names into counted rows: count desc, then name asc by plain code-unit
 * compare. `localeCompare` is deliberately not used - it would order "adam"
 * before "Bogdan" on one machine and after it on another.
 */
function countRows(names: readonly string[]): CountRow[] {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  const rows = [...counts].map(([name, count]) => ({ name, count }));
  rows.sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count;
    if (a.name === b.name) return 0;
    return a.name < b.name ? -1 : 1;
  });
  return rows;
}

function averageProbability(rows: readonly DealRecord[]): {
  avgProbability: number | null;
  probabilityMissing: number;
} {
  let total = 0;
  let counted = 0;
  for (const row of rows) {
    if (row.probability === null) continue;
    total += row.probability;
    counted += 1;
  }
  return {
    avgProbability: counted === 0 ? null : round2(total / counted),
    probabilityMissing: rows.length - counted,
  };
}

/**
 * Whether a date falls inside a period, both ends included. Dates arrive either
 * as "YYYY-MM-DD" or as "YYYY-MM-DD HH:mm:ss+TZ", so only the day part is
 * compared: on an ISO day, lexicographic order IS chronological order and no
 * timezone can shift it. An empty date is never in period - it means the field
 * was never filled in.
 */
export function inPeriod(dateText: string, period: Period): boolean {
  const day = dateText.slice(0, 10);
  if (day === "") return false;
  return period.from <= day && day <= period.to;
}

function processSummary(
  processId: string,
  processName: string,
  stages: readonly ProcessStage[],
  rows: readonly DealRecord[],
): ProcessSummary {
  const stageIds = new Set(stages.map((stage) => stage.id));
  const summaryStages = stages.map((stage, position): StageSummaryRow => {
    const atStage = rows.filter((row) => row.stageId === stage.id);
    return {
      stageId: stage.id,
      stageName: stage.name,
      position,
      dealCount: atStage.length,
      value: valueStats(atStage),
      ...averageProbability(atStage),
    };
  });
  // An empty `stageId` is never a dictionary id, so the same test catches both
  // "no stage" and "a stage this dictionary does not know".
  const unassigned = rows.filter((row) => !stageIds.has(row.stageId));
  return {
    processId,
    processName,
    stages: summaryStages,
    unassigned: { dealCount: unassigned.length, value: valueStats(unassigned) },
    totals: { dealCount: rows.length, value: valueStats(rows) },
  };
}

/**
 * Open deals per process and stage. Every process of the dictionary is listed
 * in its emission order (which IS the pipeline order) with every stage, even at
 * zero deals: the shape of the pipeline is half the answer.
 */
export function summarizePipeline(
  deals: DealRecord[],
  processes: ProcessInfo[],
): PipelineSummary {
  // Map insertion order is first-appearance order, which the unknown-process
  // buckets below are ordered by.
  const byProcess = new Map<string, DealRecord[]>();
  for (const row of deals) {
    const bucket = byProcess.get(row.processId);
    if (bucket === undefined) byProcess.set(row.processId, [row]);
    else bucket.push(row);
  }
  const summaries = processes.map((process) =>
    processSummary(
      process.id,
      process.name,
      process.stages,
      byProcess.get(process.id) ?? [],
    ),
  );
  // A deal whose process is not in the dictionary must still be visible, so it
  // gets a trailing stageless bucket named after the deal's own row. Guessing
  // which known process it belongs to is not an option.
  const known = new Set(processes.map((process) => process.id));
  for (const [processId, rows] of byProcess) {
    if (known.has(processId)) continue;
    summaries.push(processSummary(processId, rows[0]?.processName ?? "", [], rows));
  }
  return {
    processes: summaries,
    currencies: distinctCurrencies(deals),
    totalOpenDeals: deals.length,
  };
}

/**
 * A point-in-time conversion estimate, because the API keeps NO stage history
 * (probe 2026-08-06: every history endpoint fails, and stage changes exist only
 * as free-text wall entries). All this can do is read current positions and
 * assume a deal at or past a stage passed through it.
 */
export function summarizeStageConversion(
  open: DealRecord[],
  won: DealRecord[],
  lost: DealRecord[],
  process: ProcessInfo,
  truncated: boolean,
): StageConversion {
  const positions = new Map(process.stages.map((stage, position) => [stage.id, position]));
  // -1 is "unplaced": no stage, a stage this process does not have, or - purely
  // defensive, the fetch is already scoped - a deal from another process.
  const positionOf = (row: DealRecord): number =>
    row.processId === process.id ? (positions.get(row.stageId) ?? -1) : -1;
  const placed = [...open, ...won, ...lost]
    .map(positionOf)
    .filter((position) => position >= 0);
  const countAt = (rows: readonly DealRecord[], position: number): number =>
    rows.filter((row) => positionOf(row) === position).length;
  const unplaced = (rows: readonly DealRecord[]): number =>
    rows.filter((row) => positionOf(row) < 0).length;

  const reached = process.stages.map(
    (_stage, position) => placed.filter((at) => at >= position).length,
  );
  const stages = process.stages.map((stage, position): ConversionRow => {
    const here = reached[position] ?? 0;
    const previous = position === 0 ? 0 : (reached[position - 1] ?? 0);
    return {
      stageId: stage.id,
      stageName: stage.name,
      position,
      openCount: countAt(open, position),
      lostCount: countAt(lost, position),
      wonCount: countAt(won, position),
      reachedCount: here,
      // Withheld on a truncated fetch: a ratio between two incomplete
      // populations is not an estimate, it is noise.
      conversionFromPrevious:
        truncated || position === 0 || previous === 0 ? null : round4(here / previous),
    };
  });

  return {
    processId: process.id,
    processName: process.name,
    stages,
    // Outcomes count every deal of the window, unplaced ones included; the
    // stage rows and the reached math do not.
    outcomes: { openCount: open.length, wonCount: won.length, lostCount: lost.length },
    unassigned: {
      openCount: unplaced(open),
      wonCount: unplaced(won),
      lostCount: unplaced(lost),
    },
  };
}

/**
 * The CRM feed over a period. The upstream range is honoured and inclusive on
 * both ends (probe 2026-08-06), so this local filter is belt and braces - and
 * it reports what it dropped, so a mismatch is visible instead of silent.
 */
export function summarizeFeed(entries: WallEntry[], period: Period): FeedSummary {
  const kept = entries.filter((entry) => inPeriod(entry.date, period));
  return {
    total: kept.length,
    byType: countRows(kept.map((entry) => entry.type)),
    byUser: countRows(kept.map((entry) => entry.authorName)),
    outOfPeriodCount: entries.length - kept.length,
  };
}

/**
 * Tasks over a period, bucketed by `dateFrom`. The window fetcher had to widen
 * the upstream bound by a day (`datesPeriod.to` is EXCLUSIVE), so the filter
 * here is what makes the documented period inclusive again.
 */
export function summarizeTasks(tasks: TaskRecord[], period: Period): TaskSummary {
  const kept: TaskRecord[] = [];
  let outOfPeriodCount = 0;
  let noDateCount = 0;
  for (const row of tasks) {
    if (row.dateFrom === "") {
      noDateCount += 1;
      continue;
    }
    if (!inPeriod(row.dateFrom, period)) {
      outOfPeriodCount += 1;
      continue;
    }
    kept.push(row);
  }
  const completedCount = kept.filter((row) => row.isCompleted).length;
  return {
    total: kept.length,
    completedCount,
    openCount: kept.length - completedCount,
    byType: countRows(kept.map((row) => row.typeName)),
    outOfPeriodCount,
    noDateCount,
  };
}

/**
 * What the period is expected to bring in against what it actually closed.
 * Both sides are filtered LOCALLY: `Deal/getAll` accepts every date parameter
 * and ignores all of them except `modified` (probe 2026-08-06).
 */
export function summarizeForecast(
  open: DealRecord[],
  won: DealRecord[],
  lost: DealRecord[],
  period: Period,
  truncated: boolean,
): ForecastVsRealization {
  const dueInPeriod = open.filter((row) => inPeriod(row.dateEnd, period));
  // An open deal with no end date can never fall in any period, so it is
  // reported separately instead of quietly widening the forecast.
  const noDateEndCount = open.filter((row) => row.dateEnd === "").length;

  // `probability` is a 0-100 percentage; a row parsing outside that range is
  // not multiplied into a forecast, it is counted as missing.
  const weightedRows: ValuedRow[] = [];
  let weightedMissing = 0;
  for (const row of dueInPeriod) {
    const { value, probability } = row;
    if (value === null || probability === null || probability < 0 || probability > 100) {
      weightedMissing += 1;
      continue;
    }
    weightedRows.push({ value: (value * probability) / 100, currency: row.currency });
  }
  const weighted = valueStats(weightedRows);

  const forecastValue = valueStats(dueInPeriod);
  const wonInPeriod = won.filter((row) => inPeriod(row.statusChangeDate, period));
  const lostInPeriod = lost.filter((row) => inPeriod(row.statusChangeDate, period));
  const wonValue = valueStats(wonInPeriod);
  const lostValue = valueStats(lostInPeriod);
  const noStatusChangeDateCount = [...won, ...lost].filter(
    (row) => row.statusChangeDate === "",
  ).length;

  return {
    forecast: {
      dealCount: dueInPeriod.length,
      value: truncated ? withheldSum(forecastValue) : forecastValue,
      weightedValueSum: truncated ? null : weighted.sum,
      weightedMissing,
      noDateEndCount,
    },
    realization: {
      won: {
        dealCount: wonInPeriod.length,
        value: truncated ? withheldSum(wonValue) : wonValue,
      },
      lost: {
        dealCount: lostInPeriod.length,
        value: truncated ? withheldSum(lostValue) : lostValue,
      },
      noStatusChangeDateCount,
    },
    currencies: distinctCurrencies([...open, ...won, ...lost]),
  };
}
