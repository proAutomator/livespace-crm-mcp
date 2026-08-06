import { describe, expect, test } from "bun:test";
import type { ActivityFetchers, CrmFeedPage, WallEntry } from "../../src/livespace/activity.js";
import {
  dayAfter,
  DEAL_WINDOW_MAX_PAGES,
  DEAL_WINDOW_PAGE,
  fetchDealWindow,
  fetchFeedWindow,
  fetchTaskWindow,
  FEED_WINDOW_MAX_PAGES,
  FEED_WINDOW_PAGE,
  TASK_WINDOW_MAX_PAGES,
} from "../../src/livespace/aggregate.js";
import { LivespaceError } from "../../src/livespace/errors.js";
import type {
  DealRecord,
  ListPage,
  RecordFetchers,
  TaskRecord,
} from "../../src/livespace/records.js";
import { deal, task, wallEntry } from "../support/records.js";

// Every value below is invented. No CRM data, no sandbox values (AGENTS.md).

/** `Todo/getTodoObjects` answers with fixed 50-row pages (M4 probe fact). */
const TASK_PAGE = 50;

/** A fake answers per call index, so a sweep can be handed a page at a time. */
type Answer<P> = (call: number) => P | LivespaceError;

function dealRows(start: number, count: number): DealRecord[] {
  return Array.from({ length: count }, (_value, index) =>
    deal({ id: `d${start + index}`, name: `Synthetic Deal ${start + index}` }),
  );
}

function taskRows(start: number, count: number): TaskRecord[] {
  return Array.from({ length: count }, (_value, index) =>
    task({ id: `t${start + index}`, title: `Synthetic Task ${start + index}` }),
  );
}

function feedRows(start: number, count: number): WallEntry[] {
  return Array.from({ length: count }, (_value, index) =>
    wallEntry({ text: `Synthetic feed entry ${start + index}` }),
  );
}

function fullDealPage(call: number): ListPage<DealRecord> {
  return {
    items: dealRows(call * DEAL_WINDOW_PAGE + 1, DEAL_WINDOW_PAGE),
    hasMore: true,
    rawCount: DEAL_WINDOW_PAGE,
  };
}

function fullFeedPage(call: number): CrmFeedPage {
  return {
    items: feedRows(call * FEED_WINDOW_PAGE + 1, FEED_WINDOW_PAGE),
    hasMore: true,
    rawCount: FEED_WINDOW_PAGE,
  };
}

function fullTaskPage(call: number): ListPage<TaskRecord> {
  return {
    items: taskRows(call * TASK_PAGE + 1, TASK_PAGE),
    hasMore: true,
    rawCount: TASK_PAGE,
  };
}

/**
 * The fakes implement exactly the method the sweep calls and RECORD every
 * options object they were handed - the limit discipline is part of the
 * contract, not an implementation detail (docs/security.md par. 10 item 8).
 */
function fakeDeals(answer: Answer<ListPage<DealRecord>>) {
  const options: Array<Record<string, unknown>> = [];
  const fetchers = {
    listDeals: async (opts: Record<string, unknown>): Promise<ListPage<DealRecord>> => {
      const page = answer(options.length);
      options.push(opts);
      if (page instanceof LivespaceError) throw page;
      return page;
    },
  } as unknown as RecordFetchers;
  return { fetchers, options };
}

function fakeTasks(answer: Answer<ListPage<TaskRecord>>) {
  const options: Array<Record<string, unknown>> = [];
  const fetchers = {
    listTasks: async (opts: Record<string, unknown>): Promise<ListPage<TaskRecord>> => {
      const page = answer(options.length);
      options.push(opts);
      if (page instanceof LivespaceError) throw page;
      return page;
    },
  } as unknown as RecordFetchers;
  return { fetchers, options };
}

function fakeFeed(answer: Answer<CrmFeedPage>) {
  const options: Array<Record<string, unknown>> = [];
  const fetchers = {
    crmFeed: async (opts: Record<string, unknown>): Promise<CrmFeedPage> => {
      const page = answer(options.length);
      options.push(opts);
      if (page instanceof LivespaceError) throw page;
      return page;
    },
  } as unknown as ActivityFetchers;
  return { fetchers, options };
}

describe("fetchDealWindow", () => {
  test("concatenates pages in order until upstream reports no more", async () => {
    const { fetchers, options } = fakeDeals((call) =>
      call === 0
        ? fullDealPage(0)
        : { items: dealRows(101, 40), hasMore: false, rawCount: 40 },
    );
    const window = await fetchDealWindow(fetchers, { status: "open" });
    expect(window.rows.length).toBe(140);
    expect(window.rows[0]?.id).toBe("d1");
    expect(window.rows.at(-1)?.id).toBe("d140");
    expect(window.fetched).toBe(140);
    expect(window.truncated).toBe(false);
    // Pins the limit sent upstream and the offset chain, and that an unscoped
    // sweep carries NO processId key at all.
    expect(options).toStrictEqual([
      { status: "open", limit: 100, offset: 0, signal: undefined },
      { status: "open", limit: 100, offset: 100, signal: undefined },
    ]);
  });

  test("stops at the page cap and reports truncation", async () => {
    const { fetchers, options } = fakeDeals(fullDealPage);
    const window = await fetchDealWindow(fetchers, { status: "open" });
    expect(options.length).toBe(DEAL_WINDOW_MAX_PAGES);
    expect(options.at(-1)?.["offset"]).toBe(400);
    expect(window.fetched).toBe(500);
    expect(window.truncated).toBe(true);
  });

  test("drops a row an offset page re-delivered", async () => {
    const { fetchers } = fakeDeals((call) =>
      call === 0
        ? { items: dealRows(1, 3), hasMore: true, rawCount: 3 }
        : { items: dealRows(3, 2), hasMore: false, rawCount: 2 },
    );
    const window = await fetchDealWindow(fetchers, { status: "open" });
    expect(window.rows.map((row) => row.id)).toEqual(["d1", "d2", "d3", "d4"]);
    expect(window.fetched).toBe(4);
  });

  test("advances the cursor by the limit when upstream ignores it", async () => {
    // A limit-ignoring endpoint reports more raw rows than we asked for. The
    // cursor still moves by the window we asked for, so nothing is skipped.
    const { fetchers, options } = fakeDeals((call) =>
      call === 0
        ? { items: dealRows(1, 100), hasMore: true, rawCount: 150 }
        : { items: dealRows(101, 10), hasMore: false, rawCount: 10 },
    );
    await fetchDealWindow(fetchers, { status: "open" });
    expect(options.map((opts) => opts["offset"])).toEqual([0, 100]);
  });

  test("stops on an empty page that still claims more", async () => {
    const { fetchers, options } = fakeDeals(() => ({
      items: [],
      hasMore: true,
      rawCount: 0,
    }));
    const window = await fetchDealWindow(fetchers, { status: "open" });
    expect(options.length).toBe(1);
    expect(window.fetched).toBe(0);
    expect(window.truncated).toBe(false);
  });

  test("flags a window that filled every page, even if nothing is left upstream", async () => {
    // Upstream reports no totals, so a full last page claiming more is all we
    // know. The flag is deliberately conservative - do NOT "fix" it by spending
    // one more page to find out.
    const { fetchers } = fakeDeals((call) =>
      call === DEAL_WINDOW_MAX_PAGES - 1
        ? { items: dealRows(401, 100), hasMore: true, rawCount: 100 }
        : fullDealPage(call),
    );
    const window = await fetchDealWindow(fetchers, { status: "open" });
    expect(window.fetched).toBe(DEAL_WINDOW_PAGE * DEAL_WINDOW_MAX_PAGES);
    expect(window.truncated).toBe(true);
  });

  test("forwards the process scope, the status label and the signal", async () => {
    const { fetchers, options } = fakeDeals(() => ({
      items: dealRows(1, 2),
      hasMore: false,
      rawCount: 2,
    }));
    const signal = new AbortController().signal;
    await fetchDealWindow(fetchers, {
      status: "won",
      processId: "process-synthetic-501",
      signal,
    });
    expect(options).toStrictEqual([
      {
        status: "won",
        processId: "process-synthetic-501",
        limit: 100,
        offset: 0,
        signal,
      },
    ]);
  });

  test("runs the first page even past the deadline, then stops", async () => {
    const { fetchers, options } = fakeDeals(fullDealPage);
    const window = await fetchDealWindow(fetchers, {
      status: "open",
      deadlineAt: Date.now() - 1,
    });
    expect(options.length).toBe(1);
    expect(window.fetched).toBe(DEAL_WINDOW_PAGE);
    expect(window.truncated).toBe(true);
  });

  test("propagates an upstream error unchanged and stops paging", async () => {
    const upstream = new LivespaceError(
      "RATE_LIMITED",
      "Livespace is throttling this key.",
      "Retry in a moment.",
    );
    const { fetchers, options } = fakeDeals((call) =>
      call === 0 ? fullDealPage(0) : upstream,
    );
    const failure = fetchDealWindow(fetchers, { status: "lost" });
    await expect(failure).rejects.toBe(upstream);
    expect(options.length).toBe(2);
  });
});

describe("fetchFeedWindow", () => {
  test("sweeps pages of 200 and passes the dates through verbatim", async () => {
    const { fetchers, options } = fakeFeed((call) =>
      call < 2 ? fullFeedPage(call) : { items: feedRows(401, 10), hasMore: false, rawCount: 10 },
    );
    const window = await fetchFeedWindow(fetchers, {
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
    });
    expect(window.fetched).toBe(410);
    expect(window.rows.length).toBe(410);
    expect(window.truncated).toBe(false);
    expect(options).toStrictEqual([
      {
        dateFrom: "2026-01-01",
        dateTo: "2026-01-31",
        limit: 200,
        offset: 0,
        signal: undefined,
      },
      {
        dateFrom: "2026-01-01",
        dateTo: "2026-01-31",
        limit: 200,
        offset: 200,
        signal: undefined,
      },
      {
        dateFrom: "2026-01-01",
        dateTo: "2026-01-31",
        limit: 200,
        offset: 400,
        signal: undefined,
      },
    ]);
  });

  test("stops at the page cap and reports truncation", async () => {
    const { fetchers, options } = fakeFeed(fullFeedPage);
    const window = await fetchFeedWindow(fetchers, {
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
    });
    expect(options.length).toBe(FEED_WINDOW_MAX_PAGES);
    expect(window.fetched).toBe(FEED_WINDOW_PAGE * FEED_WINDOW_MAX_PAGES);
    expect(window.truncated).toBe(true);
  });
});

describe("fetchTaskWindow", () => {
  test("pages by number and widens the to-exclusive upstream bound", async () => {
    const { fetchers, options } = fakeTasks((call) =>
      call < 2 ? fullTaskPage(call) : { items: taskRows(101, 20), hasMore: false, rawCount: 20 },
    );
    const window = await fetchTaskWindow(fetchers, {
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
    });
    expect(window.fetched).toBe(120);
    expect(window.truncated).toBe(false);
    // `datesPeriod.to` is EXCLUSIVE at day granularity upstream, so the bound is
    // widened here and re-filtered locally by the summarizer. NO completed key:
    // the split happens locally too.
    expect(options).toStrictEqual([
      { page: 1, dateFrom: "2026-01-01", dateTo: "2026-02-01", signal: undefined },
      { page: 2, dateFrom: "2026-01-01", dateTo: "2026-02-01", signal: undefined },
      { page: 3, dateFrom: "2026-01-01", dateTo: "2026-02-01", signal: undefined },
    ]);
  });

  test("stops at the page cap and reports truncation", async () => {
    const { fetchers, options } = fakeTasks(fullTaskPage);
    const window = await fetchTaskWindow(fetchers, {
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
    });
    expect(options.length).toBe(TASK_WINDOW_MAX_PAGES);
    expect(window.fetched).toBe(TASK_PAGE * TASK_WINDOW_MAX_PAGES);
    expect(window.truncated).toBe(true);
  });

  test("drops a task id delivered on two pages", async () => {
    const { fetchers } = fakeTasks((call) =>
      call === 0
        ? { items: taskRows(1, 3), hasMore: true, rawCount: 3 }
        : { items: taskRows(3, 2), hasMore: false, rawCount: 2 },
    );
    const window = await fetchTaskWindow(fetchers, {
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
    });
    expect(window.rows.map((row) => row.id)).toEqual(["t1", "t2", "t3", "t4"]);
    expect(window.fetched).toBe(4);
  });
});

describe("dayAfter", () => {
  const cases: Array<{ input: string; expected: string }> = [
    { input: "2026-08-06", expected: "2026-08-07" },
    { input: "2026-08-31", expected: "2026-09-01" },
    { input: "2026-12-31", expected: "2027-01-01" },
    { input: "2028-02-28", expected: "2028-02-29" },
  ];

  for (const testCase of cases) {
    test(`${testCase.input} -> ${testCase.expected}`, () => {
      expect(dayAfter(testCase.input)).toBe(testCase.expected);
    });
  }
});
