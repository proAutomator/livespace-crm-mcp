import { describe, expect, test } from "bun:test";
import { LivespaceError } from "../../../src/livespace/errors.js";
import { CallBudget } from "../../../src/livespace/v2/budget.js";
import { LivespaceV2Client } from "../../../src/livespace/v2/client.js";
import {
  createV2TimelineReader,
  TIMELINE_TEXT_LIMIT,
  type TimelineReader,
} from "../../../src/livespace/v2/timeline.js";
import {
  routedV2Fetch,
  SYNTHETIC_V2_KEY,
  syntheticId,
  v2Envelope,
  v2Problem,
  type V2Call,
  type V2Handler,
} from "../../support/v2.js";

function harness(routes: Record<string, V2Handler | V2Handler[]>): {
  reader: TimelineReader;
  calls: V2Call[];
} {
  const calls: V2Call[] = [];
  const client = new LivespaceV2Client(
    { subdomain: "synthetic", apiKey: SYNTHETIC_V2_KEY, dailyReserve: 0 },
    { fetchImpl: routedV2Fetch(routes, calls), sleep: async () => {}, random: () => 0 },
  );
  return { reader: createV2TimelineReader(client), calls };
}

const DEAL = syntheticId(301);
const author = { id: syntheticId(801), name: "SYNTHETIC Author" };

function list(rows: unknown[], totalCount = rows.length): Response {
  return v2Envelope(rows, { page: 1, perPage: 5, totalCount });
}

const read = (budget = new CallBudget(10)) => ({ limit: 5, budget });

describe("record timeline lists", () => {
  test("notes map to entries with flattened, capped text", async () => {
    const { reader, calls } = harness({
      [`GET /deals/${DEAL}/notes`]: () =>
        list(
          [
            {
              id: syntheticId(951),
              content: `<p>SYNTHETIC <b>note</b> &amp; more</p>${"x".repeat(TIMELINE_TEXT_LIMIT)}`,
              visibility: "all",
              tags: ["synthetic-tag"],
              date: "2026-02-01T09:00:00Z",
              createdAt: "2026-02-01T09:00:01Z",
              createdBy: author,
              updatedAt: "2026-02-01T09:00:01Z",
              url: "https://synthetic.livespace.io/SYNTHETIC/note",
            },
          ],
          12,
        ),
    });
    const budget = new CallBudget(10);
    const result = await reader.recordEntries("deal", DEAL, "note", read(budget));
    expect(result.totalCount).toBe(12);
    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0]!;
    expect(entry).toMatchObject({
      type: "note",
      id: syntheticId(951),
      date: "2026-02-01T09:00:00Z",
      author,
      textTruncated: true,
      visibility: "all",
      tags: ["synthetic-tag"],
      url: "https://synthetic.livespace.io/SYNTHETIC/note",
    });
    expect(entry.text.startsWith("SYNTHETIC note & more")).toBe(true);
    expect(entry.text).toHaveLength(TIMELINE_TEXT_LIMIT);
    expect(entry.text).not.toContain("<");
    // Every list names its page and page size.
    expect(Object.fromEntries(new URL(calls[0]!.url).searchParams.entries())).toEqual({
      page: "1",
      perPage: "5",
    });
    expect(budget.used).toBe(1);
  });

  test("calls map direction, duration and the call note", async () => {
    const { reader } = harness({
      [`GET /people/${syntheticId(101)}/calls`]: () =>
        list([
          {
            id: syntheticId(961),
            date: "2026-02-02T09:00:00Z",
            createdAt: "2026-02-02T09:05:00Z",
            createdBy: null,
            number: "+48 500 000 001",
            duration: 125,
            direction: "outgoing",
            note: "SYNTHETIC call note",
            visibility: "forMe",
            recordingUrl: null,
            recordingExpiresOn: null,
          },
        ]),
    });
    const result = await reader.recordEntries("person", syntheticId(101), "call", read());
    expect(result.entries).toEqual([
      {
        type: "call",
        id: syntheticId(961),
        date: "2026-02-02T09:00:00Z",
        author: null,
        text: "SYNTHETIC call note",
        textTruncated: false,
        direction: "outgoing",
        visibility: "forMe",
        durationSeconds: 125,
        url: null,
      },
    ]);
  });

  test("e-mails map subject, sender and a flattened body", async () => {
    const { reader } = harness({
      [`GET /companies/${syntheticId(201)}/emails`]: () =>
        list([
          {
            id: syntheticId(971),
            from: "synthetic.sender@example.test",
            to: ["synthetic.person@example.test"],
            cc: [],
            subject: "SYNTHETIC subject",
            content: "<div>SYNTHETIC <i>body</i></div>",
            direction: "incoming",
            inReplyTo: null,
            url: null,
            date: "2026-02-03T09:00:00Z",
            createdAt: "2026-02-03T09:00:00Z",
          },
        ]),
    });
    const result = await reader.recordEntries("company", syntheticId(201), "email", read());
    expect(result.entries).toEqual([
      {
        type: "email",
        id: syntheticId(971),
        date: "2026-02-03T09:00:00Z",
        author: null,
        text: "SYNTHETIC body",
        textTruncated: false,
        direction: "incoming",
        subject: "SYNTHETIC subject",
        from: "synthetic.sender@example.test",
        url: null,
      },
    ]);
  });

  test("a missing scope and an unknown shape surface as fixed errors", async () => {
    const { reader } = harness({
      [`GET /deals/${DEAL}/emails`]: () => v2Problem(403, "insufficient-scope"),
      [`GET /deals/${DEAL}/notes`]: () => v2Envelope({ notes: [] }),
    });
    const scope = await reader
      .recordEntries("deal", DEAL, "email", read())
      .catch((error: unknown) => error);
    expect(scope).toBeInstanceOf(LivespaceError);
    expect((scope as LivespaceError).code).toBe("INSUFFICIENT_SCOPE");
    const shape = await reader
      .recordEntries("deal", DEAL, "note", read())
      .catch((error: unknown) => error);
    expect((shape as LivespaceError).code).toBe("UPSTREAM_ERROR");
  });

  test("the limit is a page size from 1 to 500", async () => {
    const { reader, calls } = harness({});
    for (const limit of [0, 501]) {
      await expect(
        reader.recordEntries("deal", DEAL, "note", { limit, budget: new CallBudget(5) }),
      ).rejects.toBeInstanceOf(RangeError);
    }
    expect(calls).toHaveLength(0);
  });
});
