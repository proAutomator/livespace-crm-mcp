import { describe, expect, test } from "bun:test";
import { LivespaceError } from "../../../src/livespace/errors.js";
import { CallBudget } from "../../../src/livespace/v2/budget.js";
import { LivespaceV2Client } from "../../../src/livespace/v2/client.js";
import { where } from "../../../src/livespace/v2/filters.js";
import {
  MEDIA_JSON,
  MEDIA_MINIMAL,
} from "../../../src/livespace/v2/media-types.js";
import {
  createV2RecordReader,
  DEAL_LINE_PAGE,
  PHRASE_MAX_PER_PAGE,
  PHRASE_TEXT_LIMIT,
  projectRecord,
  type RecordReader,
} from "../../../src/livespace/v2/records.js";
import {
  routedV2Fetch,
  SYNTHETIC_V2_KEY,
  syntheticId,
  v2Envelope,
  v2Problem,
  type V2Call,
  type V2Handler,
} from "../../support/v2.js";
import {
  companyV2,
  dealV2,
  personV2,
  rawCompany,
  rawCompanyMinimal,
  rawDeal,
  rawDealMinimal,
  rawPerson,
  rawPersonMinimal,
  rawTask,
  rawTaskMinimal,
  SYNTHETIC_URL,
  taskV2,
} from "../../support/v2-records.js";

interface Harness {
  reader: RecordReader;
  calls: V2Call[];
}

function harness(routes: Record<string, V2Handler | V2Handler[]>): Harness {
  const calls: V2Call[] = [];
  const client = new LivespaceV2Client(
    { subdomain: "synthetic", apiKey: SYNTHETIC_V2_KEY, dailyReserve: 0 },
    { fetchImpl: routedV2Fetch(routes, calls), sleep: async () => {}, random: () => 0 },
  );
  return { reader: createV2RecordReader(client), calls };
}

const opts = () => ({ budget: new CallBudget(10) });

function searchPage(rows: unknown[], extra: Record<string, unknown> = {}): Response {
  return v2Envelope(rows, {
    page: 1,
    perPage: 20,
    totalCount: rows.length,
    totalCountExact: true,
    permissions: {},
    ...extra,
  });
}

const QUERY = { page: 1, perPage: 20, media: MEDIA_JSON } as const;

async function failure(run: () => Promise<unknown>): Promise<LivespaceError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof LivespaceError) return error;
    throw error;
  }
  throw new Error("expected a failure");
}

function query(call: V2Call): Record<string, string> {
  return Object.fromEntries(new URL(call.url).searchParams.entries());
}

describe("record mappers", () => {
  test("a full person row maps to the person record", async () => {
    const { reader } = harness({ "POST /people/searches": () => searchPage([rawPerson()]) });
    const page = await reader.search("person", QUERY, opts());
    expect(page.items).toEqual([personV2()]);
  });

  test("a minimal person row maps to the same interface with empty values", async () => {
    const { reader } = harness({
      "POST /people/searches": () => searchPage([rawPersonMinimal()]),
    });
    const [person] = (await reader.search("person", { ...QUERY, media: MEDIA_MINIMAL }, opts()))
      .items;
    expect(person).toEqual(
      personV2({
        position: null,
        owner: null,
        owners: [],
        emails: [],
        phones: [],
        tags: [],
        groups: [],
        source: null,
        description: null,
        lastActivity: null,
        createdAt: null,
        updatedAt: null,
        addresses: [],
        customFields: [],
      }),
    );
    expect(projectRecord("person", person!, "minimal")).toEqual({
      id: syntheticId(101),
      name: "SYNTHETIC Person",
      firstName: "SYNTHETIC",
      lastName: "Person",
      company: { id: syntheticId(201), name: "SYNTHETIC Company" },
      visibility: "public",
      url: SYNTHETIC_URL,
    });
  });

  test("a full and a minimal company row", async () => {
    const { reader } = harness({
      "POST /companies/searches": [
        () => searchPage([rawCompany()]),
        () => searchPage([rawCompanyMinimal()]),
      ],
    });
    expect((await reader.search("company", QUERY, opts())).items).toEqual([companyV2()]);
    const [minimal] = (
      await reader.search("company", { ...QUERY, media: MEDIA_MINIMAL }, opts())
    ).items;
    expect(projectRecord("company", minimal!, "minimal")).toEqual({
      id: syntheticId(201),
      name: "SYNTHETIC Company",
      visibility: "public",
      url: SYNTHETIC_URL,
    });
    expect(minimal!.taxId).toBeNull();
    expect(minimal!.websites).toEqual([]);
  });

  test("a full and a minimal deal row", async () => {
    const { reader } = harness({
      "POST /deals/searches": [
        () => searchPage([rawDeal()]),
        () => searchPage([rawDealMinimal()]),
      ],
    });
    expect((await reader.search("deal", QUERY, opts())).items).toEqual([dealV2()]);
    const [minimal] = (await reader.search("deal", { ...QUERY, media: MEDIA_MINIMAL }, opts()))
      .items;
    expect(projectRecord("deal", minimal!, "minimal")).toEqual({
      id: syntheticId(301),
      name: "SYNTHETIC Deal",
      status: "open",
      process: { id: syntheticId(401), name: "SYNTHETIC Process" },
      stage: { id: syntheticId(411), name: "SYNTHETIC Stage" },
      owner: { id: syntheticId(801), name: "SYNTHETIC Owner" },
      createdAt: "2026-01-02T09:00:00Z",
      updatedAt: "2026-02-03T10:30:00Z",
      visibility: "public",
      url: SYNTHETIC_URL,
    });
    expect(minimal!.value).toBeNull();
    expect(minimal!.currency).toBeNull();
  });

  test("a full and a minimal task row", async () => {
    const { reader } = harness({
      "POST /tasks/searches": [
        () => searchPage([rawTask()]),
        () => searchPage([rawTaskMinimal()]),
      ],
    });
    expect((await reader.search("task", QUERY, opts())).items).toEqual([taskV2()]);
    const [minimal] = (await reader.search("task", { ...QUERY, media: MEDIA_MINIMAL }, opts()))
      .items;
    expect(projectRecord("task", minimal!, "minimal")).toEqual({
      id: syntheticId(501),
      title: "SYNTHETIC Task",
      completed: false,
      dueType: "scheduled",
      startsAt: "2026-03-01T09:00:00Z",
      allDay: false,
      private: false,
      url: SYNTHETIC_URL,
    });
    expect(minimal!.priority).toBe("normal");
    expect(minimal!.assignees).toEqual([]);
  });

  test("a deal value keeps zero apart from null", async () => {
    const { reader } = harness({
      "POST /deals/searches": () =>
        searchPage([
          rawDeal({ budget: { value: 0, cost: null, currency: "PLN" } }),
          rawDeal({ id: syntheticId(302), budget: { value: null, cost: null, currency: "EUR" } }),
          rawDeal({ id: syntheticId(303), budget: null }),
        ]),
    });
    const { items } = await reader.search("deal", QUERY, opts());
    expect(items.map((deal) => [deal.value, deal.currency])).toEqual([
      [0, "PLN"],
      [null, "EUR"],
      [null, null],
    ]);
  });

  test("a reopened deal carries no stale reason", async () => {
    const won = { id: syntheticId(721), name: "SYNTHETIC won reason", note: "SYNTHETIC note" };
    const lost = { id: syntheticId(722), name: "SYNTHETIC lost reason", note: null };
    const { reader } = harness({
      "POST /deals/searches": () =>
        searchPage([
          rawDeal({ status: "open", wonReason: won, lostReason: lost }),
          rawDeal({ id: syntheticId(302), status: "won", wonReason: won, lostReason: lost }),
          rawDeal({ id: syntheticId(303), status: "lost", wonReason: won, lostReason: lost }),
          rawDeal({ id: syntheticId(304), status: "outdated", outdatedReason: null }),
        ]),
    });
    const { items } = await reader.search("deal", QUERY, opts());
    expect(items.map((deal) => deal.reason)).toEqual([
      null,
      { kind: "won", name: "SYNTHETIC won reason", note: "SYNTHETIC note" },
      { kind: "lost", name: "SYNTHETIC lost reason", note: null },
      null,
    ]);
  });

  test("a select custom field maps to option names", async () => {
    const field = (n: number, type: string, value: unknown) => ({
      id: syntheticId(n),
      group: { id: syntheticId(600), name: "SYNTHETIC Field Group" },
      name: `SYNTHETIC field ${n}`,
      type,
      value,
    });
    const option = (n: number) => ({ id: syntheticId(n), name: `SYNTHETIC option ${n}` });
    const { reader } = harness({
      "POST /people/searches": () =>
        searchPage([
          rawPerson({
            additionalFields: [
              field(611, "select", option(1)),
              field(612, "multiselect", [option(2), option(3)]),
              field(613, "checkbox", true),
              field(614, "numeric", 12.5),
              field(615, "text", null),
              field(616, "multicheckbox", []),
              field(617, "checkbox", false),
              field(618, "integer", 0),
            ],
          }),
        ]),
    });
    const [person] = (await reader.search("person", QUERY, opts())).items;
    expect(person!.customFields).toEqual([
      { id: syntheticId(611), name: "SYNTHETIC field 611", type: "select", value: "SYNTHETIC option 1" },
      {
        id: syntheticId(612),
        name: "SYNTHETIC field 612",
        type: "multiselect",
        value: ["SYNTHETIC option 2", "SYNTHETIC option 3"],
      },
      { id: syntheticId(613), name: "SYNTHETIC field 613", type: "checkbox", value: true },
      { id: syntheticId(614), name: "SYNTHETIC field 614", type: "numeric", value: 12.5 },
      // A field without an answer is left out; false and 0 are answers.
      { id: syntheticId(617), name: "SYNTHETIC field 617", type: "checkbox", value: false },
      { id: syntheticId(618), name: "SYNTHETIC field 618", type: "integer", value: 0 },
    ]);
  });

  test("missing nested refs map to null, not empty strings", async () => {
    const { reader } = harness({
      "POST /deals/searches": () =>
        searchPage([
          rawDeal({
            company: null,
            person: undefined,
            owner: null,
            process: null,
            currentStage: null,
            source: null,
            number: null,
            description: null,
            expectedCloseDate: null,
          }),
        ]),
    });
    const [deal] = (await reader.search("deal", QUERY, opts())).items;
    expect(deal).toMatchObject({
      company: null,
      person: null,
      owner: null,
      process: null,
      stage: null,
      source: null,
      number: null,
      description: null,
      expectedCloseDate: null,
    });
  });

  test("a task links persons, companies and deals and skips a link without an id", async () => {
    const { reader } = harness({
      "POST /tasks/searches": () =>
        searchPage([
          rawTask({
            people: [{ id: syntheticId(101), name: null }],
            companies: [{ id: syntheticId(201), name: "SYNTHETIC Company" }, { name: "no id" }],
            deals: [],
          }),
        ]),
    });
    const [task] = (await reader.search("task", QUERY, opts())).items;
    expect(task!.links).toEqual([
      { kind: "person", id: syntheticId(101), name: "" },
      { kind: "company", id: syntheticId(201), name: "SYNTHETIC Company" },
    ]);
  });

  test("a row without a string id is an unknown shape with fixed wording", async () => {
    const { reader } = harness({
      "POST /deals/searches": [
        () => searchPage([rawDeal({ id: 7, name: "SYNTHETIC leak" })]),
        () => v2Envelope({ rows: [] }),
      ],
    });
    for (let round = 0; round < 2; round += 1) {
      const error = await failure(() => reader.search("deal", QUERY, opts()));
      expect(error.code).toBe("UPSTREAM_ERROR");
      expect(error.message).not.toContain("SYNTHETIC");
    }
  });
});

describe("projectRecord", () => {
  test("full keeps every field", () => {
    expect(projectRecord("deal", dealV2(), "full")).toEqual(dealV2());
  });

  test("standard leaves out the fields only full carries", () => {
    const standard = projectRecord("deal", dealV2(), "standard");
    for (const key of ["owners", "groups", "source", "description", "probability", "customFields"]) {
      expect(key in standard).toBe(false);
    }
    expect(standard).toMatchObject({
      id: syntheticId(301),
      number: "1/2026",
      value: 12000,
      currency: "PLN",
      company: { id: syntheticId(201), name: "SYNTHETIC Company" },
      expectedCloseDate: "2026-03-31",
      tags: ["synthetic-tag"],
      reason: null,
    });

    const person = projectRecord("person", personV2(), "standard");
    expect("addresses" in person).toBe(false);
    expect("customFields" in person).toBe(false);
    expect(person.emails).toEqual(["synthetic.person@example.test"]);

    const company = projectRecord("company", companyV2(), "standard");
    expect("regon" in company).toBe(false);
    expect(company.taxId).toBe("0000000000");

    const task = projectRecord("task", taskV2(), "standard");
    expect("description" in task).toBe(false);
    expect(task.links).toHaveLength(2);
  });
});

describe("search", () => {
  test("sends the filter, the sort and an explicit page and perPage as a read", async () => {
    const { reader, calls } = harness({
      "POST /deals/searches": [
        () => v2Problem(503, "service-unavailable"),
        () => searchPage([rawDeal()], { totalCount: 41 }),
      ],
    });
    const budget = new CallBudget(10);
    const filter = where("status", "eq", "open");
    const page = await reader.search(
      "deal",
      {
        filter,
        sort: { field: "updatedAt", direction: "desc" },
        page: 3,
        perPage: 20,
        media: MEDIA_MINIMAL,
      },
      { budget },
    );
    expect(page.totalCount).toBe(41);
    expect(page.totalCountExact).toBe(true);
    // A search is a read sent as POST: the 503 was retried, not reported as
    // a write with an unknown outcome.
    expect(calls).toHaveLength(2);
    expect(budget.used).toBe(2);
    const call = calls[1]!;
    expect(JSON.parse(call.body ?? "")).toEqual({
      filter,
      sort: { field: "updatedAt", direction: "desc" },
      page: 3,
      perPage: 20,
    });
    expect(call.headers.get("accept")).toBe(MEDIA_MINIMAL);
  });

  test("each kind has its own search path and no filter key when none is given", async () => {
    const { reader, calls } = harness({
      "POST /people/searches": () => searchPage([]),
      "POST /companies/searches": () => searchPage([]),
      "POST /deals/searches": () => searchPage([]),
      "POST /tasks/searches": () => searchPage([]),
    });
    for (const kind of ["person", "company", "deal", "task"] as const) {
      await reader.search(kind, QUERY, opts());
    }
    expect(calls.map((call) => call.route)).toEqual([
      "POST /people/searches",
      "POST /companies/searches",
      "POST /deals/searches",
      "POST /tasks/searches",
    ]);
    for (const call of calls) {
      expect(JSON.parse(call.body ?? "")).toEqual({ page: 1, perPage: 20 });
      expect(call.headers.get("accept")).toBe(MEDIA_JSON);
    }
  });

  test("an inexact total is reported as such", async () => {
    const { reader } = harness({
      "POST /deals/searches": () =>
        searchPage([rawDeal()], { totalCount: 10000, totalCountExact: false }),
    });
    const page = await reader.search("deal", QUERY, opts());
    expect(page).toMatchObject({ totalCount: 10000, totalCountExact: false });
  });

  test("a filter over the contract limits is refused before any request", async () => {
    const { reader, calls } = harness({ "POST /deals/searches": () => searchPage([]) });
    const budget = new CallBudget(10);
    const error = await failure(() =>
      reader.search(
        "deal",
        { ...QUERY, filter: where("name", "contains", "S".repeat(256)) },
        { budget },
      ),
    );
    expect(error.code).toBe("BAD_PARAMS");
    expect(calls).toHaveLength(0);
    expect(budget.used).toBe(0);
  });

  test("a page size outside 1-500 is a programming error, not a request", async () => {
    const { reader, calls } = harness({ "POST /deals/searches": () => searchPage([]) });
    for (const perPage of [0, 501, 1.5]) {
      await expect(reader.search("deal", { ...QUERY, perPage }, opts())).rejects.toBeInstanceOf(
        RangeError,
      );
    }
    expect(calls).toHaveLength(0);
  });
});

describe("phrase", () => {
  const hits = [
    {
      id: syntheticId(101),
      type: "person",
      firstName: "SYNTHETIC",
      lastName: "Person",
      description: "SYNTHETIC description that stays out of the hit",
      company: { id: syntheticId(201), name: "SYNTHETIC Company" },
      owners: [],
      url: SYNTHETIC_URL,
    },
    {
      id: syntheticId(201),
      type: "company",
      name: "SYNTHETIC Company",
      tin: "0000000000",
      regon: null,
      description: null,
      owners: [],
      url: null,
    },
    {
      id: syntheticId(301),
      type: "deal",
      name: "SYNTHETIC Deal",
      status: "open",
      number: "1/2026",
      createdAt: "2026-01-02T09:00:00Z",
      company: null,
      person: { id: syntheticId(101), name: null },
      owners: [],
      url: SYNTHETIC_URL,
    },
    {
      id: syntheticId(951),
      type: "note",
      content: `<p>SYNTHETIC <b>note</b> ${"x".repeat(PHRASE_TEXT_LIMIT)}</p>`,
      tags: ["synthetic-tag"],
      createdAt: "2026-02-01T09:00:00Z",
      referer: { id: syntheticId(301), type: "deal", name: "SYNTHETIC Deal" },
      url: null,
    },
    { id: syntheticId(961), type: "space", name: "SYNTHETIC Space", owners: [], url: null },
    { id: syntheticId(962), type: "user", firstName: "SYNTHETIC", lastName: "User", url: null },
  ];

  test("joins types with commas, caps perPage at 50 and maps each hit type", async () => {
    const { reader, calls } = harness({
      "GET /search": () => v2Envelope(hits, { page: 2, perPage: 50, totalCount: 73 }),
    });
    const result = await reader.phrase(
      { q: "SYNTHETIC", kinds: ["person", "company", "deal", "note"], page: 2, perPage: 100 },
      opts(),
    );
    expect(query(calls[0]!)).toEqual({
      q: "SYNTHETIC",
      types: "person,company,deal,note",
      page: "2",
      perPage: String(PHRASE_MAX_PER_PAGE),
    });
    expect(PHRASE_MAX_PER_PAGE).toBe(50);
    expect(result.totalCount).toBe(73);
    expect(result.rowCount).toBe(6);
    expect(result.hits).toEqual([
      {
        kind: "person",
        id: syntheticId(101),
        name: "SYNTHETIC Person",
        url: SYNTHETIC_URL,
        company: { id: syntheticId(201), name: "SYNTHETIC Company" },
      },
      {
        kind: "company",
        id: syntheticId(201),
        name: "SYNTHETIC Company",
        url: null,
        taxId: "0000000000",
      },
      {
        kind: "deal",
        id: syntheticId(301),
        name: "SYNTHETIC Deal",
        url: SYNTHETIC_URL,
        status: "open",
        company: null,
        person: { id: syntheticId(101), name: "" },
      },
      {
        kind: "note",
        id: syntheticId(951),
        name: `SYNTHETIC note ${"x".repeat(PHRASE_TEXT_LIMIT)}`.slice(0, PHRASE_TEXT_LIMIT),
        textTruncated: true,
        url: null,
        createdAt: "2026-02-01T09:00:00Z",
        parent: { kind: "deal", id: syntheticId(301), name: "SYNTHETIC Deal" },
      },
    ]);
  });

  test("a hit list that is not a list is an unknown shape", async () => {
    const { reader } = harness({ "GET /search": () => v2Envelope({ hits: [] }) });
    const error = await failure(() =>
      reader.phrase({ q: "SYNTHETIC", kinds: ["person"], page: 1, perPage: 20 }, opts()),
    );
    expect(error.code).toBe("UPSTREAM_ERROR");
  });
});

describe("get", () => {
  test("reads one record by its encoded id with the asked media type", async () => {
    const id = syntheticId(301);
    const { reader, calls } = harness({
      [`GET /deals/${id}`]: () => v2Envelope(rawDeal()),
      [`GET /people/${syntheticId(101)}`]: () => v2Envelope(rawPersonMinimal()),
    });
    expect(await reader.get("deal", id, opts())).toEqual(dealV2());
    expect(calls[0]!.headers.get("accept")).toBe(MEDIA_JSON);
    const person = await reader.get("person", syntheticId(101), {
      ...opts(),
      media: MEDIA_MINIMAL,
    });
    expect(person?.name).toBe("SYNTHETIC Person");
    expect(calls[1]!.headers.get("accept")).toBe(MEDIA_MINIMAL);
  });

  test("an unknown or invisible record is null, any other failure is thrown", async () => {
    const id = syntheticId(301);
    const { reader } = harness({
      [`GET /deals/${id}`]: [
        () => v2Problem(404, "not-found"),
        () => v2Problem(403, "insufficient-scope"),
      ],
    });
    expect(await reader.get("deal", id, opts())).toBeNull();
    const error = await failure(() => reader.get("deal", id, opts()));
    expect(error.code).toBe("INSUFFICIENT_SCOPE");
  });

  test("an id cannot add a path segment", async () => {
    const { reader, calls } = harness({});
    await reader.get("deal", "a/b?c=d", opts()).catch(() => undefined);
    expect(calls[0]!.route).toBe("GET /deals/a%2Fb%3Fc%3Dd");
    const error = await failure(() => reader.get("deal", "..", opts()));
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(calls).toHaveLength(1);
  });
});

describe("deal process, product lines and budget", () => {
  const id = syntheticId(301);

  test("the process maps stages in position order with their steps", async () => {
    const stage = (n: number, position: number, state: string, completed: boolean) => ({
      id: syntheticId(410 + n),
      name: `SYNTHETIC Stage ${n}`,
      position,
      state,
      completedAt: state === "completed" ? "2026-01-20T12:00:00Z" : null,
      steps: [
        { id: syntheticId(420 + n), name: `SYNTHETIC Step ${n}`, required: n === 2, completed },
      ],
    });
    const { reader, calls } = harness({
      [`GET /deals/${id}/process`]: [
        () =>
          v2Envelope({
            process: { id: syntheticId(401), name: "SYNTHETIC Process" },
            currentStage: { id: syntheticId(412), name: "SYNTHETIC Stage 2" },
            stages: [stage(2, 2, "current", false), stage(1, 1, "completed", true), stage(3, 3, "pending", false)],
          }),
        () => v2Problem(404, "not-found"),
      ],
    });
    const process = await reader.dealProcess(id, opts());
    expect(process).toEqual({
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
        {
          id: syntheticId(413),
          name: "SYNTHETIC Stage 3",
          position: 3,
          state: "pending",
          completedAt: null,
          steps: [{ id: syntheticId(423), name: "SYNTHETIC Step 3", required: false, completed: false }],
        },
      ],
    });
    expect(await reader.dealProcess(id, opts())).toBeNull();
    expect(calls[0]!.route).toBe(`GET /deals/${id}/process`);
  });

  test("an unknown stage state is an unknown shape", async () => {
    const { reader } = harness({
      [`GET /deals/${id}/process`]: () =>
        v2Envelope({
          process: null,
          currentStage: null,
          stages: [{ id: syntheticId(411), name: "S", position: 1, state: "SYNTHETIC", steps: [] }],
        }),
    });
    const error = await failure(() => reader.dealProcess(id, opts()));
    expect(error.code).toBe("UPSTREAM_ERROR");
  });

  test("product lines map with an explicit page size and their total", async () => {
    const { reader, calls } = harness({
      [`GET /deals/${id}/products`]: () =>
        v2Envelope(
          [
            {
              id: syntheticId(431),
              product: { id: syntheticId(441), name: "SYNTHETIC Product" },
              quantity: 3,
              unitPrice: 100.5,
              totalValue: 271.35,
              currency: "PLN",
              value: 301.5,
              discount: { type: "percent", amount: 10 },
              marginPercent: null,
              marginValue: 0,
              isForecast: true,
              date: "2026-03-01",
              description: "SYNTHETIC line",
              createdAt: "2026-01-02T09:00:00Z",
              updatedAt: "2026-01-02T09:00:00Z",
            },
            {
              id: syntheticId(432),
              product: null,
              quantity: null,
              unitPrice: null,
              totalValue: 0,
              currency: "PLN",
              value: 0,
              discount: null,
              marginPercent: null,
              marginValue: 0,
              isForecast: false,
              date: null,
              description: null,
              createdAt: "2026-01-02T09:00:00Z",
              updatedAt: "2026-01-02T09:00:00Z",
            },
          ],
          { page: 1, perPage: DEAL_LINE_PAGE, totalCount: 140 },
        ),
    });
    const result = await reader.dealLines(id, opts());
    expect(query(calls[0]!)).toEqual({ page: "1", perPage: String(DEAL_LINE_PAGE) });
    expect(result.totalCount).toBe(140);
    expect(result.lines).toEqual([
      {
        id: syntheticId(431),
        product: { id: syntheticId(441), name: "SYNTHETIC Product" },
        quantity: 3,
        unitPrice: 100.5,
        value: 271.35,
        currency: "PLN",
        forecast: true,
        description: "SYNTHETIC line",
      },
      {
        id: syntheticId(432),
        product: null,
        quantity: null,
        unitPrice: null,
        value: 0,
        currency: "PLN",
        forecast: false,
        description: null,
      },
    ]);
  });

  test("the budget summary maps its four pairs, and a masked one is null", async () => {
    const { reader } = harness({
      [`GET /deals/${id}/budget`]: [
        () =>
          v2Envelope({
            currency: "PLN",
            revenue: { forecast: 1000, executed: 250.5 },
            cost: { forecast: 100, executed: 0 },
            margin: { forecast: 900, executed: 250.5 },
            quantity: { forecast: 4, executed: 1 },
          }),
        () => v2Envelope(null, { permissions: { accessLevel: "basic" } }),
      ],
    });
    expect(await reader.dealBudget(id, opts())).toEqual({
      currency: "PLN",
      revenue: { forecast: 1000, executed: 250.5 },
      cost: { forecast: 100, executed: 0 },
      margin: { forecast: 900, executed: 250.5 },
      quantity: { forecast: 4, executed: 1 },
    });
    expect(await reader.dealBudget(id, opts())).toBeNull();
  });
});
