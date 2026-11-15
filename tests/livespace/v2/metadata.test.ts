import { describe, expect, test } from "bun:test";
import { CallBudget } from "../../../src/livespace/v2/budget.js";
import { LivespaceV2Client } from "../../../src/livespace/v2/client.js";
import {
  createV2MetadataFetchers,
  CUSTOM_FIELD_OPTION_CAP,
  DICTIONARY_MAX_PAGES,
  DICTIONARY_PER_PAGE,
  findActingUser,
  V2_METADATA_SECTIONS,
  type V2MetadataFetchers,
  type V2MetadataSection,
} from "../../../src/livespace/v2/metadata.js";
import {
  routedV2Fetch,
  SYNTHETIC_V2_KEY,
  syntheticId,
  v2Envelope,
  v2Problem,
  type V2Call,
  type V2Handler,
} from "../../support/v2.js";

interface Harness {
  fetchers: V2MetadataFetchers;
  calls: V2Call[];
}

function harness(routes: Record<string, V2Handler | V2Handler[]>): Harness {
  const calls: V2Call[] = [];
  const client = new LivespaceV2Client(
    { subdomain: "synthetic", apiKey: SYNTHETIC_V2_KEY, dailyReserve: 0 },
    { fetchImpl: routedV2Fetch(routes, calls), sleep: async () => {}, random: () => 0 },
  );
  return { fetchers: createV2MetadataFetchers(client), calls };
}

/** One page of a list: the rows plus the paging block the API sends. */
function page(rows: unknown[], totalCount = rows.length, pageNo = 1): Response {
  return v2Envelope(rows, { page: pageNo, perPage: 500, totalCount });
}

function query(call: V2Call): Record<string, string> {
  return Object.fromEntries(new URL(call.url).searchParams.entries());
}

/** Every dictionary path a full crm_metadata read touches, answering empty. */
const GET_PATHS = [
  "/sales-processes",
  "/users",
  "/dictionaries/teams",
  "/dictionaries/person-groups",
  "/dictionaries/deal-groups",
  "/dictionaries/sources",
  "/dictionaries/positions",
  "/dictionaries/deal-reasons",
  "/dictionaries/tags",
  "/dictionaries/currencies",
  "/dictionaries/task-types",
  "/dictionaries/task-statuses",
  "/dictionaries/people/fields",
  "/dictionaries/companies/fields",
  "/dictionaries/deals/fields",
  "/dictionaries/tasks/fields",
] as const;

function emptyRoutes(): Record<string, V2Handler> {
  const routes: Record<string, V2Handler> = {
    "GET /users/me": () =>
      v2Envelope({ login: "synthetic-integration", timeZone: "Europe/Warsaw" }),
    "POST /products/searches": () => page([]),
  };
  for (const path of GET_PATHS) routes[`GET ${path}`] = () => page([]);
  return routes;
}

const SYNTHETIC_PROCESS = {
  id: syntheticId(10),
  name: "SYNTHETIC Process",
  selectable: true,
  isDefault: true,
  settings: {
    defaultLengthDays: 30,
    productRequired: true,
    autoclose: { trigger: "lastActivity", delayDays: 60, status: "lost", reason: null },
    afterWon: { canRemoveTaskTemplate: false, canChangeTaskTemplate: true },
    afterLost: { canRemoveTaskTemplate: false, canChangeTaskTemplate: true },
  },
  stages: [
    {
      id: syntheticId(12),
      name: "SYNTHETIC Second stage",
      description: null,
      sort: 2,
      duration: { enabled: false, days: 14 },
      steps: [],
    },
    {
      id: syntheticId(11),
      name: "SYNTHETIC First stage",
      description: "SYNTHETIC stage description",
      sort: 1,
      duration: { enabled: true, days: 7 },
      steps: [
        {
          id: syntheticId(14),
          name: "SYNTHETIC Later step",
          description: null,
          sort: 20,
          scales: 3,
          mandatory: { required: true, item: "note" },
          fieldBindings: [{ kind: "field" }, { kind: "field" }],
        },
        {
          id: syntheticId(13),
          name: "SYNTHETIC Earlier step",
          description: "SYNTHETIC step description",
          sort: 10,
          scales: 1,
          mandatory: { required: false, item: "none" },
          fieldBindings: [],
        },
      ],
    },
  ],
};

describe("section mapping", () => {
  test("lists all fifteen sections in a fixed order", () => {
    expect(V2_METADATA_SECTIONS).toEqual([
      "processes",
      "users",
      "teams",
      "contactGroups",
      "dealGroups",
      "sources",
      "positions",
      "dealReasons",
      "tags",
      "currencies",
      "taskTypes",
      "taskStatuses",
      "customFields",
      "products",
      "currentUser",
    ]);
  });

  test("processes: full config, stages and steps in their sort order", async () => {
    const { fetchers } = harness({ "GET /sales-processes": () => page([SYNTHETIC_PROCESS]) });
    const result = await fetchers.processes();
    expect(result.truncated).toBe(false);
    expect(result.data).toEqual([
      {
        id: syntheticId(10),
        name: "SYNTHETIC Process",
        selectable: true,
        isDefault: true,
        defaultLengthDays: 30,
        productRequired: true,
        autoclose: true,
        stages: [
          {
            id: syntheticId(11),
            name: "SYNTHETIC First stage",
            description: "SYNTHETIC stage description",
            durationDays: 7,
            steps: [
              {
                id: syntheticId(13),
                name: "SYNTHETIC Earlier step",
                description: "SYNTHETIC step description",
                weight: 1,
                required: false,
                requiredItem: "none",
                boundFields: 0,
              },
              {
                id: syntheticId(14),
                name: "SYNTHETIC Later step",
                description: null,
                weight: 3,
                required: true,
                requiredItem: "note",
                boundFields: 2,
              },
            ],
          },
          {
            id: syntheticId(12),
            name: "SYNTHETIC Second stage",
            description: null,
            durationDays: null,
            steps: [],
          },
        ],
      },
    ]);
  });

  test("processes: a switched-off process stays, marked not selectable", async () => {
    const { fetchers } = harness({
      "GET /sales-processes": () =>
        page([
          {
            id: syntheticId(10),
            name: "SYNTHETIC Off",
            selectable: false,
            isDefault: false,
            settings: { defaultLengthDays: null, productRequired: false, autoclose: null },
            stages: [],
          },
        ]),
    });
    expect((await fetchers.processes()).data).toEqual([
      {
        id: syntheticId(10),
        name: "SYNTHETIC Off",
        selectable: false,
        isDefault: false,
        defaultLengthDays: null,
        productRequired: false,
        autoclose: false,
        stages: [],
      },
    ]);
  });

  test("users: full name, e-mail and main team", async () => {
    const { fetchers } = harness({
      "GET /users": () =>
        page([
          {
            id: syntheticId(1),
            firstName: "SYNTHETIC",
            lastName: "Owner",
            email: "synthetic.owner@example.invalid",
            createdAt: "2026-01-01T00:00:00+00:00",
            team: { id: syntheticId(20), name: "SYNTHETIC Team" },
          },
          { id: syntheticId(2), firstName: null, lastName: "Solo", email: null, team: null },
        ]),
    });
    expect((await fetchers.users()).data).toEqual([
      {
        id: syntheticId(1),
        name: "SYNTHETIC Owner",
        email: "synthetic.owner@example.invalid",
        team: { id: syntheticId(20), name: "SYNTHETIC Team" },
      },
      { id: syntheticId(2), name: "Solo", email: "", team: null },
    ]);
  });

  test("teams: parent id, and the root marked not selectable", async () => {
    const { fetchers } = harness({
      "GET /dictionaries/teams": () =>
        page([
          { id: syntheticId(20), name: "SYNTHETIC Company", parent: null, level: 0, selectable: false },
          {
            id: syntheticId(21),
            name: "SYNTHETIC Sales",
            parent: { id: syntheticId(20), name: "SYNTHETIC Company" },
            level: 1,
            selectable: true,
          },
        ]),
    });
    expect((await fetchers.teams()).data).toEqual([
      { id: syntheticId(20), name: "SYNTHETIC Company", parentId: null, selectable: false },
      { id: syntheticId(21), name: "SYNTHETIC Sales", parentId: syntheticId(20) },
    ]);
  });

  test("contactGroups, dealGroups and positions: id and name", async () => {
    const row = (n: number, name: string) => ({ id: syntheticId(n), name, selectable: true });
    const { fetchers } = harness({
      "GET /dictionaries/person-groups": () => page([row(30, "SYNTHETIC Contact group")]),
      "GET /dictionaries/deal-groups": () => page([row(31, "SYNTHETIC Deal group")]),
      "GET /dictionaries/positions": () => page([row(32, "SYNTHETIC Position")]),
    });
    expect((await fetchers.contactGroups()).data).toEqual([
      { id: syntheticId(30), name: "SYNTHETIC Contact group" },
    ]);
    expect((await fetchers.dealGroups()).data).toEqual([
      { id: syntheticId(31), name: "SYNTHETIC Deal group" },
    ]);
    expect((await fetchers.positions()).data).toEqual([
      { id: syntheticId(32), name: "SYNTHETIC Position" },
    ]);
  });

  test("sources: ids, parent id and the retired marker", async () => {
    const { fetchers } = harness({
      "GET /dictionaries/sources": () =>
        page([
          { id: syntheticId(40), name: "SYNTHETIC Source", parent: null, selectable: true },
          {
            id: syntheticId(41),
            name: "SYNTHETIC Old source",
            parent: { id: syntheticId(40), name: "SYNTHETIC Source" },
            selectable: false,
          },
        ]),
    });
    expect((await fetchers.sources()).data).toEqual([
      { id: syntheticId(40), name: "SYNTHETIC Source", parentId: null },
      {
        id: syntheticId(41),
        name: "SYNTHETIC Old source",
        parentId: syntheticId(40),
        selectable: false,
      },
    ]);
  });

  test("dealReasons: kind per reason, an unknown kind is an unknown shape", async () => {
    const { fetchers } = harness({
      "GET /dictionaries/deal-reasons": [
        () =>
          page([
            { id: syntheticId(50), name: "SYNTHETIC Won reason", kind: "won", selectable: true },
            { id: syntheticId(51), name: "SYNTHETIC Lost reason", kind: "lost", selectable: false },
            { id: syntheticId(52), name: "SYNTHETIC Outdated reason", kind: "outdated", selectable: true },
          ]),
        () => page([{ id: syntheticId(53), name: "SYNTHETIC", kind: "paused", selectable: true }]),
      ],
    });
    expect((await fetchers.dealReasons()).data).toEqual([
      { id: syntheticId(50), name: "SYNTHETIC Won reason", kind: "won" },
      { id: syntheticId(51), name: "SYNTHETIC Lost reason", kind: "lost", selectable: false },
      { id: syntheticId(52), name: "SYNTHETIC Outdated reason", kind: "outdated" },
    ]);
    await expect(fetchers.dealReasons()).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });

  test("tags: plain names from one page, and a longer catalog says truncated", async () => {
    const { fetchers, calls } = harness({
      "GET /dictionaries/tags": [
        () => page(["SYNTHETIC vip", "SYNTHETIC VIP"]),
        () => page(["SYNTHETIC tag"], 501),
      ],
    });
    expect(await fetchers.tags()).toEqual({
      data: ["SYNTHETIC vip", "SYNTHETIC VIP"],
      truncated: false,
    });
    expect(await fetchers.tags()).toEqual({ data: ["SYNTHETIC tag"], truncated: true });
    expect(calls.length).toBe(2);
  });

  test("currencies: only the ones switched on, plus the default", async () => {
    const { fetchers } = harness({
      "GET /dictionaries/currencies": () =>
        page([
          { id: "PLN", name: "SYNTHETIC zloty", default: true, selectable: true },
          { id: "EUR", name: "SYNTHETIC euro", default: false, selectable: true },
          { id: "XTS", name: "SYNTHETIC off", default: false, selectable: false },
        ]),
    });
    expect((await fetchers.currencies()).data).toEqual([
      { id: "PLN", name: "SYNTHETIC zloty", isDefault: true },
      { id: "EUR", name: "SYNTHETIC euro", isDefault: false },
    ]);
  });

  test("taskTypes and taskStatuses: id, name and the retired marker", async () => {
    const { fetchers } = harness({
      "GET /dictionaries/task-types": () =>
        page([{ id: syntheticId(60), name: "SYNTHETIC Call", system: true, selectable: true }]),
      "GET /dictionaries/task-statuses": () =>
        page([{ id: syntheticId(61), name: "SYNTHETIC Done", color: null, selectable: false }]),
    });
    expect((await fetchers.taskTypes()).data).toEqual([
      { id: syntheticId(60), name: "SYNTHETIC Call" },
    ]);
    expect((await fetchers.taskStatuses()).data).toEqual([
      { id: syntheticId(61), name: "SYNTHETIC Done", selectable: false },
    ]);
  });

  test("customFields: four record kinds with options and group names", async () => {
    const field = (n: number, extra: Record<string, unknown>) => ({
      id: syntheticId(n),
      name: `SYNTHETIC field ${n}`,
      type: "text",
      group: null,
      required: false,
      readOnly: false,
      selectable: true,
      options: null,
      ...extra,
    });
    const { fetchers, calls } = harness({
      "GET /dictionaries/people/fields": () =>
        page([field(70, { group: { id: syntheticId(79), name: "SYNTHETIC Group" } })]),
      "GET /dictionaries/companies/fields": () =>
        page([
          field(71, {
            type: "select",
            required: true,
            options: [
              { id: syntheticId(72), name: "SYNTHETIC Option A" },
              { id: syntheticId(73), name: "SYNTHETIC Option B" },
            ],
          }),
        ]),
      "GET /dictionaries/deals/fields": () =>
        page([field(74, { readOnly: true, selectable: false })]),
      "GET /dictionaries/tasks/fields": () => page([]),
    });
    const result = await fetchers.customFields();
    expect(result.truncated).toBe(false);
    expect(result.data).toEqual({
      person: [
        {
          id: syntheticId(70),
          name: "SYNTHETIC field 70",
          type: "text",
          group: "SYNTHETIC Group",
          required: false,
          readOnly: false,
          filterable: true,
          options: [],
        },
      ],
      company: [
        {
          id: syntheticId(71),
          name: "SYNTHETIC field 71",
          type: "select",
          group: null,
          required: true,
          readOnly: false,
          filterable: true,
          options: [
            { id: syntheticId(72), name: "SYNTHETIC Option A" },
            { id: syntheticId(73), name: "SYNTHETIC Option B" },
          ],
        },
      ],
      deal: [
        {
          id: syntheticId(74),
          name: "SYNTHETIC field 74",
          type: "text",
          group: null,
          required: false,
          readOnly: true,
          filterable: true,
          selectable: false,
          options: [],
        },
      ],
      task: [],
    });
    expect(calls.length).toBe(4);
  });

  test("a choice field with a very long option list is cut and says so", async () => {
    const options = Array.from({ length: CUSTOM_FIELD_OPTION_CAP + 7 }, (_, i) => ({
      id: syntheticId(9000 + i),
      name: `SYNTHETIC option ${i}`,
    }));
    const { fetchers } = harness({
      ...emptyRoutes(),
      "GET /dictionaries/deals/fields": () =>
        page([
          {
            id: syntheticId(1),
            name: "SYNTHETIC long select",
            type: "select",
            group: null,
            required: false,
            readOnly: false,
            selectable: true,
            options,
          },
          {
            id: syntheticId(2),
            name: "SYNTHETIC short select",
            type: "select",
            group: null,
            required: false,
            readOnly: false,
            selectable: true,
            options: options.slice(0, CUSTOM_FIELD_OPTION_CAP),
          },
        ]),
    });
    const [long, short] = (await fetchers.customFields()).data.deal;
    expect(long?.options.length).toBe(CUSTOM_FIELD_OPTION_CAP);
    expect(long?.optionsTruncated).toBe(true);
    expect(short?.options.length).toBe(CUSTOM_FIELD_OPTION_CAP);
    expect(short && "optionsTruncated" in short).toBe(false);
    expect(CUSTOM_FIELD_OPTION_CAP).toBe(200);
  });

  test("custom fields of numeric and date type are not filterable", async () => {
    const types = [
      "text", "textarea", "numeric", "integer", "date", "date_time",
      "checkbox", "select", "radio", "multiselect", "multicheckbox", "future_type",
    ];
    const { fetchers } = harness({
      ...emptyRoutes(),
      "GET /dictionaries/deals/fields": () =>
        page(
          types.map((type, index) => ({
            id: syntheticId(100 + index),
            name: `SYNTHETIC ${type}`,
            type,
            group: null,
            required: false,
            readOnly: false,
            selectable: true,
            options: null,
          })),
        ),
    });
    const fields = (await fetchers.customFields()).data.deal;
    expect(Object.fromEntries(fields.map((f) => [f.type, f.filterable]))).toEqual({
      text: true,
      textarea: true,
      numeric: false,
      integer: false,
      date: false,
      date_time: false,
      checkbox: true,
      select: true,
      radio: true,
      multiselect: true,
      multicheckbox: true,
      future_type: false,
    });
  });

  test("products: a search sent as a read, id, name and sku", async () => {
    const { fetchers, calls } = harness({
      "POST /products/searches": [
        () => v2Problem(503, "service-unavailable"),
        () =>
          page([
            {
              id: syntheticId(80),
              name: "SYNTHETIC Product",
              sku: "SYN-1",
              defaultPrice: 100,
              priceLocked: false,
              group: null,
            },
            { id: syntheticId(81), name: "SYNTHETIC No sku", sku: null, defaultPrice: null },
          ]),
      ],
    });
    expect(await fetchers.products()).toEqual({
      data: [
        { id: syntheticId(80), name: "SYNTHETIC Product", sku: "SYN-1" },
        { id: syntheticId(81), name: "SYNTHETIC No sku", sku: null },
      ],
      truncated: false,
    });
    // `write: false`: the 503 was retried like any read, with the same body.
    expect(calls.length).toBe(2);
    expect(calls.map((call) => JSON.parse(call.body ?? "{}"))).toEqual([
      { page: 1, perPage: 500 },
      { page: 1, perPage: 500 },
    ]);
  });

  test("products stop at two pages and say truncated", async () => {
    const full = Array.from({ length: 500 }, (_, i) => ({
      id: syntheticId(1000 + i),
      name: "SYNTHETIC",
      sku: null,
    }));
    const { fetchers, calls } = harness({
      "POST /products/searches": () => page(full, 1300),
    });
    const result = await fetchers.products();
    expect(result.truncated).toBe(true);
    expect(result.data.length).toBe(1000);
    expect(calls.map((call) => JSON.parse(call.body ?? "{}").page)).toEqual([1, 2]);
  });

  test("currentUser: the integration user, acting user left to the service", async () => {
    const { fetchers } = harness({
      "GET /users/me": () =>
        v2Envelope({
          id: syntheticId(1),
          login: "synthetic-integration",
          firstName: "SYNTHETIC",
          lastName: "Integration",
          email: "synthetic.integration@example.invalid",
          timeZone: "Europe/Warsaw",
          language: "pl",
          tenantLanguage: "pl",
        }),
    });
    expect(await fetchers.currentUser()).toEqual({
      data: { integrationLogin: "synthetic-integration", timeZone: "Europe/Warsaw" },
      truncated: false,
    });
  });
});

describe("load discipline", () => {
  test("every dictionary request carries perPage 500", async () => {
    const { fetchers, calls } = harness(emptyRoutes());
    for (const section of V2_METADATA_SECTIONS) await fetchers[section]();
    const lists = calls.filter((call) => call.route !== "GET /users/me");
    // 12 single lists, four custom field lists and the product search.
    expect(lists.length).toBe(17);
    for (const call of lists) {
      const sent = call.method === "GET" ? query(call) : JSON.parse(call.body ?? "{}");
      expect(Number(sent.perPage)).toBe(DICTIONARY_PER_PAGE);
      expect(Number(sent.page)).toBe(1);
    }
    expect(DICTIONARY_PER_PAGE).toBe(500);
  });

  test("page loops stop at four pages and say truncated", async () => {
    const full = Array.from({ length: 500 }, (_, i) => ({
      id: syntheticId(2000 + i),
      name: "SYNTHETIC",
      selectable: true,
    }));
    const { fetchers, calls } = harness({
      "GET /dictionaries/positions": () => page(full, 2600),
    });
    const result = await fetchers.positions();
    expect(result.truncated).toBe(true);
    expect(result.data.length).toBe(2000);
    expect(calls.map((call) => query(call)["page"])).toEqual(["1", "2", "3", "4"]);
    expect(DICTIONARY_MAX_PAGES).toBe(4);
  });

  test("a list that fits is read to its end and is not truncated", async () => {
    const full = Array.from({ length: 500 }, (_, i) => ({
      id: syntheticId(3000 + i),
      name: "SYNTHETIC",
      selectable: true,
    }));
    const { fetchers, calls } = harness({
      "GET /dictionaries/positions": [
        () => page(full, 620, 1),
        () => page(full.slice(0, 120), 620, 2),
      ],
    });
    const result = await fetchers.positions();
    expect(result.truncated).toBe(false);
    expect(result.data.length).toBe(620);
    expect(calls.length).toBe(2);
  });

  test("an empty page before the announced total ends the loop as truncated", async () => {
    const { fetchers, calls } = harness({
      "GET /dictionaries/positions": [
        () => page([{ id: syntheticId(1), name: "SYNTHETIC", selectable: true }], 900, 1),
        () => page([], 900, 2),
      ],
    });
    const result = await fetchers.positions();
    expect(result.truncated).toBe(true);
    expect(calls.length).toBe(2);
  });

  test("without a total the loop goes on only after a full page", async () => {
    const short = harness({
      "GET /dictionaries/positions": () =>
        v2Envelope([{ id: syntheticId(1), name: "SYNTHETIC", selectable: true }]),
    });
    expect((await short.fetchers.positions()).truncated).toBe(false);
    expect(short.calls.length).toBe(1);

    const full = Array.from({ length: 500 }, (_, i) => ({
      id: syntheticId(5000 + i),
      name: "SYNTHETIC",
      selectable: true,
    }));
    const long = harness({
      "GET /dictionaries/positions": [
        () => v2Envelope(full),
        () => v2Envelope(full.slice(0, 3)),
      ],
    });
    const result = await long.fetchers.positions();
    expect(result).toMatchObject({ truncated: false });
    expect(result.data.length).toBe(503);
    expect(long.calls.map((call) => query(call)["page"])).toEqual(["1", "2"]);
  });

  test("every page spends the call budget, and a spent budget stops the loop", async () => {
    const full = Array.from({ length: 500 }, (_, i) => ({
      id: syntheticId(4000 + i),
      name: "SYNTHETIC",
      selectable: true,
    }));
    const { fetchers, calls } = harness({
      "GET /dictionaries/positions": () => page(full, 2000),
    });
    const budget = new CallBudget(3);
    await expect(fetchers.positions({ budget })).rejects.toMatchObject({
      code: "CALL_BUDGET_EXCEEDED",
    });
    expect(calls.length).toBe(3);
    expect(budget.used).toBe(3);
  });

  test("processes fall back to the deprecated path on 404 once", async () => {
    const { fetchers, calls } = harness({
      "GET /sales-processes": () => v2Problem(404, "not-found"),
      "GET /dictionaries/processes": () => page([SYNTHETIC_PROCESS]),
    });
    expect((await fetchers.processes()).data.length).toBe(1);
    expect((await fetchers.processes()).data.length).toBe(1);
    expect(calls.map((call) => call.route)).toEqual([
      "GET /sales-processes",
      "GET /dictionaries/processes",
      "GET /dictionaries/processes",
    ]);
  });

  test("a fallback that fails too leaves the current route in place", async () => {
    const { fetchers, calls } = harness({
      "GET /sales-processes": [
        () => v2Problem(404, "not-found"),
        () => page([SYNTHETIC_PROCESS]),
      ],
      "GET /dictionaries/processes": () => v2Problem(404, "not-found"),
    });
    await expect(fetchers.processes()).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await fetchers.processes()).data.length).toBe(1);
    expect(calls.map((call) => call.route)).toEqual([
      "GET /sales-processes",
      "GET /dictionaries/processes",
      "GET /sales-processes",
    ]);
  });

  test("a remembered fallback route that disappears goes back to the current one", async () => {
    const { fetchers, calls } = harness({
      "GET /sales-processes": [
        () => v2Problem(404, "not-found"),
        () => page([SYNTHETIC_PROCESS]),
        () => page([SYNTHETIC_PROCESS]),
      ],
      "GET /dictionaries/processes": [
        () => page([SYNTHETIC_PROCESS]),
        () => v2Problem(404, "not-found"),
      ],
    });
    await fetchers.processes();
    expect((await fetchers.processes()).data.length).toBe(1);
    await fetchers.processes();
    expect(calls.map((call) => call.route)).toEqual([
      "GET /sales-processes",
      "GET /dictionaries/processes",
      "GET /dictionaries/processes",
      "GET /sales-processes",
      "GET /sales-processes",
    ]);
  });

  test("a process failure other than 404 does not switch paths", async () => {
    const { fetchers, calls } = harness({
      "GET /sales-processes": [
        () => v2Problem(403, "insufficient-scope"),
        () => page([SYNTHETIC_PROCESS]),
      ],
      "GET /dictionaries/processes": () => page([]),
    });
    await expect(fetchers.processes()).rejects.toMatchObject({ code: "INSUFFICIENT_SCOPE" });
    expect((await fetchers.processes()).data.length).toBe(1);
    expect(calls.map((call) => call.route)).toEqual([
      "GET /sales-processes",
      "GET /sales-processes",
    ]);
  });

  test("the caller's signal reaches the request", async () => {
    const { fetchers, calls } = harness(emptyRoutes());
    const controller = new AbortController();
    controller.abort();
    await expect(fetchers.users({ signal: controller.signal })).rejects.toMatchObject({
      code: "CANCELLED",
    });
    expect(calls.length).toBe(0);
  });
});

describe("unknown shapes fail with fixed wording", () => {
  const cases: [V2MetadataSection, string, unknown][] = [
    ["users", "GET /users", { not: "a list" }],
    ["users", "GET /users", [{ name: "SYNTHETIC row without an id" }]],
    ["teams", "GET /dictionaries/teams", [{ id: 7, name: "SYNTHETIC numeric id" }]],
    ["positions", "GET /dictionaries/positions", ["SYNTHETIC bare string"]],
    ["tags", "GET /dictionaries/tags", [{ id: syntheticId(1), name: "SYNTHETIC object tag" }]],
    ["processes", "GET /sales-processes", [{ id: syntheticId(1), name: "SYNTHETIC", stages: "none" }]],
    ["products", "POST /products/searches", null],
    ["currentUser", "GET /users/me", ["SYNTHETIC"]],
  ];
  for (const [section, route, data] of cases) {
    test(`${section}: ${JSON.stringify(data).slice(0, 40)}`, async () => {
      const { fetchers } = harness({ ...emptyRoutes(), [route]: () => v2Envelope(data) });
      const failure = await fetchers[section]().then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({ code: "UPSTREAM_ERROR" });
      expect(String((failure as Error).message)).not.toContain("SYNTHETIC");
    });
  }
});

describe("findActingUser", () => {
  const users = [
    { id: syntheticId(1), name: "SYNTHETIC One", email: "Synthetic.One@Example.invalid", team: null },
    { id: syntheticId(2), name: "SYNTHETIC Two", email: "", team: null },
  ];

  test("the acting user resolves by case-insensitive e-mail", () => {
    expect(findActingUser(users, "synthetic.one@example.INVALID")).toEqual({
      id: syntheticId(1),
      name: "SYNTHETIC One",
      email: "Synthetic.One@Example.invalid",
    });
    expect(findActingUser(users, "  synthetic.one@example.invalid ")).not.toBeNull();
  });

  test("no match, a partial match and an empty e-mail resolve to nobody", () => {
    expect(findActingUser(users, "synthetic.three@example.invalid")).toBeNull();
    expect(findActingUser(users, "synthetic.one@example")).toBeNull();
    expect(findActingUser(users, "")).toBeNull();
  });
});
