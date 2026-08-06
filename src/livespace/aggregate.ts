import type { ActivityFetchers, CrmFeedOptions, WallEntry } from "./activity.js";
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
 */
export function fetchTaskWindow(
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
