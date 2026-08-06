import { describe, expect, test } from "bun:test";
import {
  createActivityFetchers,
  stripHtml,
  WALL_ENTRY_CAP,
  type ActivityFetchers,
  type WallEntry,
} from "../../src/livespace/activity.js";
import { LivespaceError } from "../../src/livespace/errors.js";

const UNEXPECTED_SHAPE = "Livespace returned an unexpected shape for this activity.";

interface FakeCall {
  module: string;
  method: string;
  params: Record<string, unknown>;
  opts?: unknown;
}

function fakeActivityClient(responses: Record<string, unknown>) {
  const calls: FakeCall[] = [];
  return {
    calls,
    client: {
      call: (async (
        module: string,
        method: string,
        params?: Record<string, unknown>,
        opts?: unknown,
      ) => {
        calls.push({ module, method, params: params ?? {}, opts });
        const key = `${module}/${method}`;
        if (!(key in responses)) {
          throw new LivespaceError(
            "UPSTREAM_ERROR",
            `no synthetic response for ${key}`,
            "fixture gap",
          );
        }
        const canned = responses[key];
        if (canned instanceof LivespaceError) throw canned;
        return canned;
      }) as never,
    },
  };
}

function activityFetchersFor(responses: Record<string, unknown>) {
  const { client, calls } = fakeActivityClient(responses);
  return { fetchers: createActivityFetchers(client), calls };
}

// Every value below is invented. No CRM data, no sandbox values (AGENTS.md).
const WALL_RAW = {
  text: "<b>Synthetic</b> wall note",
  created: "2025-11-02 09:00:00+02",
  date: "2025-11-03 10:00:00+02",
  type_name: "activity",
  is_public: 1,
  comment_count: "2",
  comments: [],
  user_id: "user-synthetic-201",
  user_name: "Synthetic User",
};

const WALL_ENTRY: WallEntry = {
  type: "activity",
  text: "Synthetic wall note",
  textTruncated: false,
  date: "2025-11-03 10:00:00+02",
  authorName: "Synthetic User",
  isPublic: true,
  commentCount: 2,
  objectName: "",
  objectType: "",
};

const FEED_RAW = {
  // A NUMBER upstream, and never exposed: the feed id is useless to callers.
  id: 918273,
  type_name: "email",
  is_public: true,
  text: "<p>Synthetic feed body</p>",
  date: "2025-11-04 08:00:00+02",
  creator_login: "synthetic.login",
  creator_name: "Synthetic Creator",
  object_name: "Synthetic Company Alpha",
  object_type: "company",
  comments_count: 3,
  comments: [],
};

const FEED_ENTRY: WallEntry = {
  type: "email",
  text: "Synthetic feed body",
  textTruncated: false,
  date: "2025-11-04 08:00:00+02",
  authorName: "Synthetic Creator",
  isPublic: true,
  commentCount: 3,
  objectName: "Synthetic Company Alpha",
  objectType: "company",
};

function syntheticWallRows(count: number): unknown[] {
  return Array.from({ length: count }, (_, index) => ({
    ...WALL_RAW,
    text: `Synthetic wall note ${index}`,
  }));
}

describe("stripHtml", () => {
  const cases: Array<{ name: string; input: unknown; expected: string }> = [
    {
      name: "removes tags and keeps the surrounding text",
      input: '<a href="x">link</a> tail',
      expected: "link tail",
    },
    {
      // PINS the operation order: entities are decoded FIRST, so markup that
      // arrived escaped is stripped like any other markup.
      name: "decodes entities before stripping, so escaped markup cannot survive",
      input: "&lt;b&gt;bold&lt;/b&gt;",
      expected: "bold",
    },
    {
      // Single-pass decode: the `&lt;` produced by decoding `&amp;lt;` is NOT
      // decoded again, so a doubly escaped tag can never become a live one.
      name: "decodes in a single pass without cascading",
      input: "&amp;lt;script&amp;gt;",
      expected: "&lt;script&gt;",
    },
    {
      // Accepted cost of decode-then-strip: a tag-shaped span of plain prose is
      // removed. Pinned so the behaviour is a decision, not a surprise.
      name: "removes tag-shaped prose spans",
      input: "a < b and c > d",
      expected: "a d",
    },
    {
      name: "leaves a word boundary where a tag was",
      input: "<p>a</p><p>b</p>",
      expected: "a b",
    },
    {
      name: "keeps text after an unterminated tag start",
      input: "<scr<script>ipt>x",
      expected: "ipt>x",
    },
    {
      name: "decodes the five entities",
      input: "&quot;quoted&quot; &#39;single&#39; &amp; more",
      expected: "\"quoted\" 'single' & more",
    },
    {
      name: "collapses whitespace and trims",
      input: "  line one\n\n\tline two  ",
      expected: "line one line two",
    },
    { name: "non-string null", input: null, expected: "" },
    { name: "non-string number", input: 42, expected: "" },
    { name: "non-string object", input: { text: "x" }, expected: "" },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      expect(stripHtml(testCase.input)).toBe(testCase.expected);
    });
  }
});

describe("entry text truncation", () => {
  test("exactly 500 stripped characters are not truncated", async () => {
    const { fetchers } = activityFetchersFor({
      "Deal/getWall": { wall: [{ ...WALL_RAW, text: "a".repeat(500) }] },
    });
    const wall = await fetchers.recordWall({ kind: "deal", id: "deal-synthetic-401" });
    expect(wall.entries[0]?.text.length).toBe(500);
    expect(wall.entries[0]?.textTruncated).toBe(false);
  });

  test("501 stripped characters are cut to 500 and flagged", async () => {
    const { fetchers } = activityFetchersFor({
      "Deal/getWall": { wall: [{ ...WALL_RAW, text: "a".repeat(501) }] },
    });
    const wall = await fetchers.recordWall({ kind: "deal", id: "deal-synthetic-401" });
    expect(wall.entries[0]?.text.length).toBe(500);
    expect(wall.entries[0]?.textTruncated).toBe(true);
  });
});

describe("recordWall", () => {
  test("maps a contact wall entry in full", async () => {
    const { fetchers } = activityFetchersFor({ "Contact/getWall": { wall: [WALL_RAW] } });
    const wall = await fetchers.recordWall({ kind: "person", id: "person-synthetic-001" });
    expect(wall).toEqual({ entries: [WALL_ENTRY], truncated: false, totalEntries: 1 });
  });

  test("falls back to created when date is absent", async () => {
    const raw: Record<string, unknown> = { ...WALL_RAW };
    delete raw["date"];
    const { fetchers } = activityFetchersFor({ "Contact/getWall": { wall: [raw] } });
    const wall = await fetchers.recordWall({ kind: "person", id: "person-synthetic-001" });
    expect(wall.entries[0]?.date).toBe("2025-11-02 09:00:00+02");
  });

  test("normalizes is_public as a number and as a boolean", async () => {
    const { fetchers } = activityFetchersFor({
      "Contact/getWall": {
        wall: [
          { ...WALL_RAW, is_public: 0 },
          { ...WALL_RAW, is_public: false },
          { ...WALL_RAW, is_public: true },
          { ...WALL_RAW, is_public: "1" },
        ],
      },
    });
    const wall = await fetchers.recordWall({ kind: "company", id: "company-synthetic-101" });
    expect(wall.entries.map((entry) => entry.isPublic)).toEqual([
      false,
      false,
      true,
      true,
    ]);
  });

  test("reads the comments_count spelling too", async () => {
    const raw: Record<string, unknown> = { ...WALL_RAW, comments_count: 7 };
    delete raw["comment_count"];
    const { fetchers } = activityFetchersFor({ "Deal/getWall": { wall: [raw] } });
    const wall = await fetchers.recordWall({ kind: "deal", id: "deal-synthetic-401" });
    expect(wall.entries[0]?.commentCount).toBe(7);
  });

  test("caps entries locally and reports the raw total", async () => {
    const { fetchers } = activityFetchersFor({
      "Deal/getWall": { wall: syntheticWallRows(120) },
    });
    const wall = await fetchers.recordWall({ kind: "deal", id: "deal-synthetic-401" });
    expect(wall.entries.length).toBe(WALL_ENTRY_CAP);
    expect(wall.truncated).toBe(true);
    expect(wall.totalEntries).toBe(120);
  });

  test("a wall exactly at the cap is not truncated", async () => {
    const { fetchers } = activityFetchersFor({
      "Deal/getWall": { wall: syntheticWallRows(WALL_ENTRY_CAP) },
    });
    const wall = await fetchers.recordWall({ kind: "deal", id: "deal-synthetic-401" });
    expect(wall.entries.length).toBe(WALL_ENTRY_CAP);
    expect(wall.truncated).toBe(false);
    expect(wall.totalEntries).toBe(WALL_ENTRY_CAP);
  });

  test("tolerates the empty wrapper shapes", async () => {
    const shapes: unknown[] = [{ wall: [] }, {}, [], null];
    for (const payload of shapes) {
      const { fetchers } = activityFetchersFor({ "Contact/getWall": payload });
      const wall = await fetchers.recordWall({
        kind: "person",
        id: "person-synthetic-001",
      });
      expect(wall).toEqual({ entries: [], truncated: false, totalEntries: 0 });
    }
  });

  test("rejects a wrapper that is not a list", async () => {
    const { fetchers } = activityFetchersFor({ "Contact/getWall": { wall: "nope" } });
    const failure = fetchers.recordWall({ kind: "person", id: "person-synthetic-001" });
    await expect(failure).rejects.toThrow(UNEXPECTED_SHAPE);
  });
});

describe("crmFeed", () => {
  test("maps a feed item without exposing the numeric upstream id", async () => {
    const { fetchers } = activityFetchersFor({ "Wall/getList": { items: [FEED_RAW] } });
    const feed = await fetchers.crmFeed({
      dateFrom: "2025-11-01",
      dateTo: "2025-11-30",
      limit: 20,
      offset: 0,
    });
    expect(feed).toEqual({ items: [FEED_ENTRY], hasMore: false, rawCount: 1 });
    expect(JSON.stringify(feed.items)).not.toContain("918273");
  });

  test("returns the raw page unfiltered - the tool filters, not the fetcher", async () => {
    const rows = [
      { ...FEED_RAW, type_name: "email" },
      { ...FEED_RAW, type_name: "activity" },
      { ...FEED_RAW, type_name: "note" },
    ];
    const { fetchers } = activityFetchersFor({ "Wall/getList": { items: rows } });
    const feed = await fetchers.crmFeed({
      dateFrom: "2025-11-01",
      dateTo: "2025-11-30",
      limit: 20,
      offset: 0,
    });
    expect(feed.items.map((item) => item.type)).toEqual(["email", "activity", "note"]);
    expect(feed.rawCount).toBe(3);
  });

  test("slices defensively when upstream ignores the limit", async () => {
    const rows = Array.from({ length: 7 }, (_, index) => ({
      ...FEED_RAW,
      text: `Synthetic feed body ${index}`,
    }));
    const { fetchers } = activityFetchersFor({ "Wall/getList": { items: rows } });
    const feed = await fetchers.crmFeed({
      dateFrom: "2025-11-01",
      dateTo: "2025-11-30",
      limit: 3,
      offset: 0,
    });
    expect(feed.items.length).toBe(3);
    expect(feed.rawCount).toBe(7);
    expect(feed.hasMore).toBe(true);
  });

  test("hasMore is false below the limit", async () => {
    const { fetchers } = activityFetchersFor({ "Wall/getList": { items: [FEED_RAW] } });
    const feed = await fetchers.crmFeed({
      dateFrom: "2025-11-01",
      dateTo: "2025-11-30",
      limit: 2,
      offset: 0,
    });
    expect(feed.hasMore).toBe(false);
    expect(feed.rawCount).toBe(1);
  });

  test("tolerates the empty wrapper shapes", async () => {
    const shapes: unknown[] = [{ items: [] }, {}, [], null];
    for (const payload of shapes) {
      const { fetchers } = activityFetchersFor({ "Wall/getList": payload });
      const feed = await fetchers.crmFeed({
        dateFrom: "2025-11-01",
        dateTo: "2025-11-30",
        limit: 20,
        offset: 0,
      });
      expect(feed).toEqual({ items: [], hasMore: false, rawCount: 0 });
    }
  });
});

describe("fetcher call table", () => {
  interface CallCase {
    name: string;
    responses: Record<string, unknown>;
    run: (fetchers: ActivityFetchers, signal: AbortSignal) => Promise<unknown>;
    module: string;
    method: string;
    params: Record<string, unknown>;
  }

  const cases: CallCase[] = [
    {
      name: "recordWall for a person",
      responses: { "Contact/getWall": { wall: [] } },
      run: (fetchers, signal) =>
        fetchers.recordWall({ kind: "person", id: "person-synthetic-001", signal }),
      module: "Contact",
      method: "getWall",
      params: { type: "contact", id: "person-synthetic-001", limit: WALL_ENTRY_CAP },
    },
    {
      name: "recordWall for a company",
      responses: { "Contact/getWall": { wall: [] } },
      run: (fetchers, signal) =>
        fetchers.recordWall({ kind: "company", id: "company-synthetic-101", signal }),
      module: "Contact",
      method: "getWall",
      params: { type: "company", id: "company-synthetic-101", limit: WALL_ENTRY_CAP },
    },
    {
      name: "recordWall for a deal",
      responses: { "Deal/getWall": { wall: [] } },
      run: (fetchers, signal) =>
        fetchers.recordWall({ kind: "deal", id: "deal-synthetic-401", signal }),
      module: "Deal",
      method: "getWall",
      params: { type: "deal", id: "deal-synthetic-401", limit: WALL_ENTRY_CAP },
    },
    {
      name: "crmFeed",
      responses: { "Wall/getList": { items: [] } },
      run: (fetchers, signal) =>
        fetchers.crmFeed({
          dateFrom: "2025-11-01",
          dateTo: "2025-11-30",
          limit: 25,
          offset: 50,
          signal,
        }),
      module: "Wall",
      method: "getList",
      params: {
        date_from: "2025-11-01",
        date_to: "2025-11-30",
        limit: 25,
        offset: 50,
      },
    },
  ];

  for (const testCase of cases) {
    test(`${testCase.name} sends exact params and forwards the signal`, async () => {
      const { fetchers, calls } = activityFetchersFor(testCase.responses);
      const signal = new AbortController().signal;
      await testCase.run(fetchers, signal);
      expect(calls.length).toBe(1);
      const call = calls[0]!;
      expect(call.module).toBe(testCase.module);
      expect(call.method).toBe(testCase.method);
      expect(call.params).toStrictEqual(testCase.params);
      expect((call.opts as { signal?: AbortSignal }).signal).toBe(signal);
    });
  }
});

describe("upstream errors", () => {
  const upstream = new LivespaceError(
    "PERMISSION_DENIED",
    "The API key's user lacks permission for this record or action (540).",
    "Use a record the key's user can access.",
    540,
  );

  test("recordWall propagates a LivespaceError unchanged", async () => {
    const { fetchers } = activityFetchersFor({ "Deal/getWall": upstream });
    const failure = fetchers.recordWall({ kind: "deal", id: "deal-synthetic-401" });
    await expect(failure).rejects.toBe(upstream);
  });

  test("crmFeed propagates a LivespaceError unchanged", async () => {
    const { fetchers } = activityFetchersFor({ "Wall/getList": upstream });
    const failure = fetchers.crmFeed({
      dateFrom: "2025-11-01",
      dateTo: "2025-11-30",
      limit: 20,
      offset: 0,
    });
    await expect(failure).rejects.toBe(upstream);
  });
});
