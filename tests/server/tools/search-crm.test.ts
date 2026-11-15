import { describe, expect, test } from "bun:test";
import * as z from "zod/v4";
import { LivespaceError } from "../../../src/livespace/errors.js";
import { CALL_BUDGETS, CallBudget } from "../../../src/livespace/v2/budget.js";
import type { FilterNode } from "../../../src/livespace/v2/filters.js";
import { MEDIA_JSON, MEDIA_MINIMAL } from "../../../src/livespace/v2/media-types.js";
import {
  actingUserHint,
  type ActingUserLookup,
  type ActingUserState,
  type CustomFieldInfo,
  type CustomFieldKind,
} from "../../../src/livespace/v2/metadata.js";
import type {
  PhrasePage,
  PhraseQuery,
  ReadOptions,
  RecordReader,
  SearchPage,
  SearchQuery,
  V2Kind,
} from "../../../src/livespace/v2/records.js";
import type { MetadataService } from "../../../src/server/tools/crm-metadata.js";
import {
  runSearchCrm,
  searchCrmToolConfig,
  type SearchCrmArgs,
  type SearchCrmDeps,
} from "../../../src/server/tools/search-crm.js";
import { syntheticId } from "../../support/v2.js";
import { companyV2, dealV2, personV2, taskV2 } from "../../support/v2-records.js";

// Every value below is invented. No CRM data, no sandbox values (AGENTS.md).

const ACTING = {
  id: syntheticId(801),
  name: "SYNTHETIC Owner",
  email: "synthetic.owner@example.test",
};

interface SearchCall {
  kind: V2Kind;
  query: SearchQuery;
  opts: ReadOptions;
}

interface PhraseCall {
  query: PhraseQuery;
  opts: ReadOptions;
}

interface Harness {
  deps: SearchCrmDeps;
  searches: SearchCall[];
  phrases: PhraseCall[];
  sections: string[];
  actingLookups: number;
}

interface HarnessOptions {
  search?: (kind: V2Kind, query: SearchQuery) => SearchPage<unknown> | Promise<SearchPage<unknown>>;
  phrase?: (query: PhraseQuery) => PhrasePage | Promise<PhrasePage>;
  acting?: ActingUserLookup;
  timeZone?: string;
  customFields?: Partial<Record<CustomFieldKind, CustomFieldInfo[]>>;
  customFieldsTruncated?: boolean;
  metadataError?: unknown;
  writesEnabled?: boolean;
}

const FIXTURES = {
  person: personV2,
  company: companyV2,
  deal: dealV2,
  task: taskV2,
} as const;

function onePage(kind: V2Kind): SearchPage<unknown> {
  return { items: [FIXTURES[kind]()], totalCount: 1, totalCountExact: true };
}

function harness(options: HarnessOptions = {}): Harness {
  const searches: SearchCall[] = [];
  const phrases: PhraseCall[] = [];
  const sections: string[] = [];
  const state = { actingLookups: 0 };
  const records = {
    search: async (kind: V2Kind, query: SearchQuery, opts: ReadOptions) => {
      searches.push({ kind, query, opts });
      return options.search === undefined ? onePage(kind) : options.search(kind, query);
    },
    phrase: async (query: PhraseQuery, opts: ReadOptions) => {
      phrases.push({ query, opts });
      if (options.phrase === undefined) return { hits: [], totalCount: 0, rowCount: 0 };
      return options.phrase(query);
    },
  } as unknown as RecordReader;
  const metadata = {
    get: async (section: string) => {
      sections.push(section);
      if (options.metadataError !== undefined) throw options.metadataError;
      const data =
        section === "currentUser"
          ? {
              integrationLogin: "synthetic-integration",
              timeZone: options.timeZone ?? "Europe/Warsaw",
            }
          : { person: [], company: [], deal: [], task: [], ...options.customFields };
      return {
        data,
        asOf: 1_000,
        stale: false,
        truncated: section === "customFields" && options.customFieldsTruncated === true,
      };
    },
    actingUser: async () => {
      state.actingLookups += 1;
      return options.acting ?? { state: "resolved", user: ACTING };
    },
  } as unknown as MetadataService;
  return {
    deps: { records, metadata, writesEnabled: options.writesEnabled ?? false },
    searches,
    phrases,
    sections,
    get actingLookups() {
      return state.actingLookups;
    },
  };
}

const outputSchema = searchCrmToolConfig.outputSchema;

async function run(h: Harness, args: SearchCrmArgs, signal?: AbortSignal) {
  const result = await runSearchCrm(h.deps, args, signal === undefined ? {} : { signal });
  // Every answer must fit the declared output schema, errors included.
  expect(outputSchema.safeParse(result.structured).success).toBe(true);
  return result;
}

type Structured = z.output<typeof outputSchema>;

function structured(result: { structured: Record<string, unknown> }): Structured {
  return result.structured as Structured;
}

function filterOf(h: Harness, kind: V2Kind): FilterNode | undefined {
  return h.searches.find((call) => call.kind === kind)?.query.filter;
}

function field(overrides: Partial<CustomFieldInfo> & { id: string; type: string }): CustomFieldInfo {
  return {
    name: "SYNTHETIC field",
    group: null,
    required: false,
    readOnly: false,
    filterable: true,
    options: [],
    ...overrides,
  };
}

describe("search_crm arguments", () => {
  test("phrase and filters are two modes: exactly one per call", async () => {
    const h = harness();
    for (const args of [{}, { phrase: "SYNTHETIC", filters: {} }] as SearchCrmArgs[]) {
      const result = await run(h, args);
      expect(result.isError).toBe(true);
      expect(structured(result).errors[0]?.code).toBe("BAD_PARAMS");
    }
    expect(h.searches).toHaveLength(0);
    expect(h.phrases).toHaveLength(0);
  });

  test("notes are found by phrase only, tasks by filters only", async () => {
    const h = harness();
    const notes = await run(h, { kinds: ["notes"], filters: {} });
    expect(structured(notes).errors[0]).toMatchObject({ code: "BAD_PARAMS", kind: "notes" });
    const tasks = await run(h, { kinds: ["tasks"], phrase: "SYNTHETIC" });
    expect(structured(tasks).errors[0]).toMatchObject({ code: "BAD_PARAMS", kind: "tasks" });
    expect(h.searches).toHaveLength(0);
    expect(h.phrases).toHaveLength(0);
  });

  test("phrase mode takes no sort and no countOnly", async () => {
    const h = harness();
    for (const extra of [
      { sort: { field: "name", direction: "asc" } },
      { countOnly: true },
    ] as Partial<SearchCrmArgs>[]) {
      const result = await run(h, { phrase: "SYNTHETIC", ...extra });
      expect(structured(result).errors[0]?.code).toBe("BAD_PARAMS");
    }
    expect(h.phrases).toHaveLength(0);
  });

  test("a filter that does not apply to a kind is refused naming the kind", async () => {
    const cases: [SearchCrmArgs, string][] = [
      [{ filters: { status: "won" } }, "persons"],
      [{ kinds: ["companies"], filters: { processId: syntheticId(401) } }, "companies"],
      [{ kinds: ["persons"], filters: { stageIds: [syntheticId(411)] } }, "persons"],
      [{ kinds: ["companies"], filters: { companyId: syntheticId(201) } }, "companies"],
      [{ kinds: ["persons"], filters: { personId: syntheticId(101) } }, "persons"],
      [{ kinds: ["deals"], filters: { taxId: "0000000000" } }, "deals"],
      [{ kinds: ["tasks"], filters: { tags: ["synthetic-tag"] } }, "tasks"],
      [{ kinds: ["tasks"], filters: { groupIds: [syntheticId(703)] } }, "tasks"],
      [{ kinds: ["tasks"], filters: { sourceIds: [syntheticId(701)] } }, "tasks"],
      [{ kinds: ["tasks"], filters: { createdFrom: "2026-01-01" } }, "tasks"],
      [{ kinds: ["persons"], filters: { statusChangedFrom: "2026-01-01" } }, "persons"],
      [{ kinds: ["companies"], filters: { expectedCloseTo: "2026-01-01" } }, "companies"],
      [{ kinds: ["deals"], filters: { completed: true } }, "deals"],
      [{ kinds: ["deals"], filters: { overdue: true } }, "deals"],
      [{ kinds: ["persons"], filters: { dueFrom: "2026-01-01" } }, "persons"],
      [{ kinds: ["deals"], filters: { taskTypeIds: [syntheticId(711)] } }, "deals"],
      [
        { kinds: ["deals"], filters: { linkedTo: { kind: "deal", id: syntheticId(301) } } },
        "deals",
      ],
    ];
    for (const [args, kind] of cases) {
      const h = harness();
      const result = await run(h, args);
      expect(result.isError).toBe(true);
      const error = structured(result).errors[0];
      expect(error).toMatchObject({ code: "BAD_PARAMS", kind });
      expect(error?.hint).toContain(kind);
      expect(h.searches).toHaveLength(0);
    }
  });

  test("page above 1 needs exactly one kind in filter mode", async () => {
    const h = harness();
    const refused = await run(h, { filters: {}, page: 2 });
    expect(structured(refused).errors[0]?.code).toBe("BAD_PARAMS");
    expect(h.searches).toHaveLength(0);
    await run(h, { kinds: ["deals"], filters: {}, page: 2 });
    expect(h.searches[0]?.query.page).toBe(2);
  });

  test("a date that is not a real day, out of range or reversed is refused", async () => {
    for (const filters of [
      { createdFrom: "2026-02-30" },
      { updatedTo: "1899-12-31" },
      { createdFrom: "2026-03-01", createdTo: "2026-02-01" },
      { expectedCloseFrom: "2026-13-01" },
    ]) {
      const h = harness();
      const result = await run(h, { kinds: ["deals"], filters });
      expect(structured(result).errors[0]?.code).toBe("BAD_PARAMS");
      expect(h.searches).toHaveLength(0);
    }
  });

  test("sort outside the kind's sortable list is refused", async () => {
    const h = harness();
    const result = await run(h, {
      kinds: ["deals"],
      filters: {},
      sort: { field: "value", direction: "desc" },
    });
    expect(structured(result).errors[0]).toMatchObject({ code: "BAD_PARAMS", kind: "deals" });
    expect(structured(result).errors[0]?.hint).toContain("expectedCloseDate");
    // A field one kind sorts by is still refused for a kind that does not.
    const mixed = await run(h, {
      kinds: ["companies", "deals"],
      filters: {},
      sort: { field: "expectedCloseDate", direction: "asc" },
    });
    expect(structured(mixed).errors[0]).toMatchObject({ code: "BAD_PARAMS", kind: "companies" });
    expect(h.searches).toHaveLength(0);
  });

  test("a sortable field is sent as given, and name means lastName and title", async () => {
    const h = harness();
    await run(h, {
      kinds: ["persons", "companies", "deals", "tasks"],
      filters: {},
      sort: { field: "name", direction: "asc" },
    });
    expect(h.searches.map((call) => [call.kind, call.query.sort])).toEqual([
      ["person", { field: "lastName", direction: "asc" }],
      ["company", { field: "name", direction: "asc" }],
      ["deal", { field: "name", direction: "asc" }],
      ["task", { field: "title", direction: "asc" }],
    ]);
  });
});

describe("search_crm mine (Review Focus 1)", () => {
  test("mine without an acting user is refused, not empty", async () => {
    const states: ActingUserState[] = ["not_configured", "not_found", "list_truncated", "unknown"];
    for (const state of states) {
      const h = harness({ acting: { state, user: null } });
      const result = await run(h, { kinds: ["deals"], filters: { mine: true } });
      expect(result.isError).toBe(true);
      const error = structured(result).errors[0];
      expect(error?.code).toBe("NO_ACTING_USER");
      expect(error?.hint).toContain(actingUserHint(state) ?? "missing");
      // Nothing was searched: an empty "my deals" list would be a wrong answer.
      expect(h.searches).toHaveLength(0);
      expect(structured(result).results).toEqual({});
    }
  });

  test("mine maps to owners anyOf the acting user", async () => {
    const h = harness();
    await run(h, { filters: { mine: true, status: "all" }, kinds: ["deals"] });
    await run(h, { filters: { mine: true }, kinds: ["persons", "companies"] });
    for (const kind of ["deal", "person", "company"] as const) {
      expect(filterOf(h, kind)).toEqual({ field: "owners", operator: "anyOf", value: [ACTING.id] });
    }
  });

  test("mine on tasks maps to assignees anyOf, never to members", async () => {
    const h = harness();
    await run(h, { filters: { mine: true }, kinds: ["tasks"] });
    expect(filterOf(h, "task")).toEqual({
      field: "assignees",
      operator: "anyOf",
      value: [ACTING.id],
    });
  });

  test("mine adds the acting user to ownerIds once", async () => {
    const h = harness();
    await run(h, {
      kinds: ["companies"],
      filters: { mine: true, ownerIds: [syntheticId(802), ACTING.id] },
    });
    expect(filterOf(h, "company")).toEqual({
      field: "owners",
      operator: "anyOf",
      value: [syntheticId(802), ACTING.id],
    });
  });

  test("the acting user is not looked up when mine is not asked", async () => {
    const h = harness({ acting: { state: "unknown", user: null } });
    const result = await run(h, { kinds: ["deals"], filters: { ownerIds: [syntheticId(802)] } });
    expect(result.isError).toBe(false);
    expect(h.actingLookups).toBe(0);
  });
});

describe("search_crm filters", () => {
  const OPEN: FilterNode = { field: "status", operator: "eq", value: "open" };

  test("status defaults to open for deals and all includes outdated", async () => {
    const h = harness();
    await run(h, { kinds: ["deals"], filters: {} });
    expect(filterOf(h, "deal")).toEqual(OPEN);
    for (const status of ["won", "lost", "outdated"] as const) {
      const one = harness();
      await run(one, { kinds: ["deals"], filters: { status } });
      expect(filterOf(one, "deal")).toEqual({ field: "status", operator: "eq", value: status });
    }
    const all = harness();
    await run(all, { kinds: ["deals"], filters: { status: "all" } });
    expect(all.searches).toHaveLength(1);
    // No status condition at all: every status, outdated included.
    expect(filterOf(all, "deal")).toBeUndefined();
  });

  test("each filter maps to its v2 field and operator", async () => {
    const ids = [syntheticId(1), syntheticId(2)];
    const table: [SearchCrmArgs["kinds"], NonNullable<SearchCrmArgs["filters"]>, FilterNode][] = [
      [["deals"], { ownerIds: ids }, { field: "owners", operator: "anyOf", value: ids }],
      [["tasks"], { ownerIds: ids }, { field: "assignees", operator: "anyOf", value: ids }],
      [["deals"], { processId: ids[0]! }, { field: "process.id", operator: "eq", value: ids[0] }],
      [["deals"], { stageIds: ids }, { field: "currentStage.id", operator: "in", value: ids }],
      [["deals"], { companyId: ids[0]! }, { field: "company.id", operator: "eq", value: ids[0] }],
      [["persons"], { companyId: ids[0]! }, { field: "company.id", operator: "eq", value: ids[0] }],
      [["deals"], { personId: ids[0]! }, { field: "person.id", operator: "eq", value: ids[0] }],
      [["deals"], { nameContains: "SYN" }, { field: "name", operator: "contains", value: "SYN" }],
      [["companies"], { nameContains: "SYN" }, { field: "name", operator: "contains", value: "SYN" }],
      [["tasks"], { nameContains: "SYN" }, { field: "title", operator: "contains", value: "SYN" }],
      [
        ["persons"],
        { nameContains: "SYN" },
        {
          or: [
            { field: "firstName", operator: "contains", value: "SYN" },
            { field: "lastName", operator: "contains", value: "SYN" },
          ],
        },
      ],
      [["companies"], { taxId: "0000000000" }, { field: "taxId", operator: "eq", value: "0000000000" }],
      [
        ["persons"],
        { taxId: "0000000000" },
        { field: "company.taxId", operator: "eq", value: "0000000000" },
      ],
      [["persons"], { tags: ["a", "b"] }, { field: "tags", operator: "anyOf", value: ["a", "b"] }],
      [["companies"], { groupIds: ids }, { field: "groups", operator: "anyOf", value: ids }],
      [["persons"], { sourceIds: ids }, { field: "source.id", operator: "in", value: ids }],
      [["tasks"], { completed: false }, { field: "completed", operator: "eq", value: false }],
      [["tasks"], { overdue: true }, { field: "overdue", operator: "eq", value: true }],
      [["tasks"], { taskTypeIds: ids }, { field: "type.id", operator: "in", value: ids }],
      [
        ["tasks"],
        { linkedTo: { kind: "person", id: ids[0]! } },
        { field: "people.id", operator: "eq", value: ids[0] },
      ],
      [
        ["tasks"],
        { linkedTo: { kind: "company", id: ids[0]! } },
        { field: "companies.id", operator: "eq", value: ids[0] },
      ],
      [
        ["tasks"],
        { linkedTo: { kind: "deal", id: ids[0]! } },
        { field: "deals.id", operator: "eq", value: ids[0] },
      ],
    ];
    for (const [kinds, filters, expected] of table) {
      const h = harness();
      // `status: "all"` keeps the deal default out of the way of the one
      // condition under test.
      const deals = kinds?.[0] === "deals";
      const result = await run(h, {
        kinds: kinds!,
        filters: deals ? { ...filters, status: "all" } : filters,
      });
      expect(result.isError).toBe(false);
      expect(h.searches).toHaveLength(1);
      expect(h.searches[0]?.query.filter).toEqual(expected);
    }
  });

  test("several filters are joined with and, the deal status first", async () => {
    const h = harness();
    await run(h, {
      kinds: ["deals"],
      filters: { processId: syntheticId(401), tags: ["synthetic-tag"] },
    });
    expect(filterOf(h, "deal")).toEqual({
      and: [
        OPEN,
        { field: "process.id", operator: "eq", value: syntheticId(401) },
        { field: "tags", operator: "anyOf", value: ["synthetic-tag"] },
      ],
    });
  });

  test("day filters on datetime fields use the integration user's time zone", async () => {
    const h = harness({ timeZone: "Europe/Warsaw" });
    await run(h, {
      kinds: ["deals"],
      filters: {
        status: "all",
        createdFrom: "2026-03-29",
        createdTo: "2026-03-29",
        updatedFrom: "2026-10-25",
        statusChangedTo: "2026-01-31",
      },
    });
    expect(h.sections).toEqual(["currentUser"]);
    expect(filterOf(h, "deal")).toEqual({
      and: [
        {
          field: "createdAt",
          operator: "between",
          value: { from: "2026-03-29T00:00:00+01:00", to: "2026-03-29T23:59:59+02:00" },
        },
        { field: "updatedAt", operator: "gte", value: "2026-10-25T00:00:00+02:00" },
        { field: "statusChangedAt", operator: "lte", value: "2026-01-31T23:59:59+01:00" },
      ],
    });
  });

  test("date fields take bare days and need no time zone", async () => {
    const h = harness();
    await run(h, {
      kinds: ["deals"],
      filters: { status: "all", expectedCloseFrom: "2026-01-01", expectedCloseTo: "2026-03-31" },
    });
    await run(h, { kinds: ["tasks"], filters: { dueFrom: "2026-01-01", dueTo: "2026-01-31" } });
    await run(h, { kinds: ["tasks"], filters: { dueTo: "2026-01-31" } });
    expect(h.sections).toEqual([]);
    expect(h.searches.map((call) => call.query.filter)).toEqual([
      {
        field: "expectedCloseDate",
        operator: "between",
        value: { from: "2026-01-01", to: "2026-03-31" },
      },
      {
        and: [
          { field: "startsAt", operator: "gte", value: "2026-01-01" },
          { field: "startsAt", operator: "lte", value: "2026-01-31" },
        ],
      },
      { field: "startsAt", operator: "lte", value: "2026-01-31" },
    ]);
  });

  test("a time zone that cannot be read fails the call instead of shifting the days", async () => {
    const h = harness({ timeZone: "" });
    const result = await run(h, { kinds: ["persons"], filters: { createdFrom: "2026-01-01" } });
    expect(result.isError).toBe(true);
    expect(h.searches).toHaveLength(0);
  });
});

describe("search_crm custom field filters", () => {
  const TEXT = syntheticId(601);
  const CHOICE = syntheticId(602);
  const CHECK = syntheticId(603);
  const NUMERIC = syntheticId(604);
  const OPTION = syntheticId(611);
  const fields: CustomFieldInfo[] = [
    field({ id: TEXT, type: "text" }),
    field({ id: CHOICE, type: "select", options: [{ id: OPTION, name: "SYNTHETIC option" }] }),
    field({ id: CHECK, type: "checkbox" }),
    field({ id: NUMERIC, type: "numeric", filterable: false }),
  ];
  const withFields = () => harness({ customFields: { deal: fields } });
  const args = (
    customFields: NonNullable<NonNullable<SearchCrmArgs["filters"]>["customFields"]>,
  ): SearchCrmArgs => ({ kinds: ["deals"], filters: { status: "all", customFields } });

  test("each field type maps to additionalFields.<id> with its operator", async () => {
    const h = withFields();
    const result = await run(
      h,
      args([
        { fieldId: TEXT, operator: "contains", value: "SYN" },
        { fieldId: CHOICE, operator: "anyOf", value: [OPTION] },
        { fieldId: CHECK, operator: "eq", value: true },
        { fieldId: TEXT, operator: "isEmpty" },
      ]),
    );
    expect(result.isError).toBe(false);
    expect(h.sections).toEqual(["customFields"]);
    expect(filterOf(h, "deal")).toEqual({
      and: [
        { field: `additionalFields.${TEXT}`, operator: "contains", value: "SYN" },
        { field: `additionalFields.${CHOICE}`, operator: "anyOf", value: [OPTION] },
        { field: `additionalFields.${CHECK}`, operator: "eq", value: true },
        { field: `additionalFields.${TEXT}`, operator: "isEmpty" },
      ],
    });
  });

  test("custom field filters reject a non-filterable field from metadata", async () => {
    const h = withFields();
    const result = await run(h, args([{ fieldId: NUMERIC, operator: "eq", value: "1" }]));
    expect(result.isError).toBe(true);
    expect(structured(result).errors[0]).toMatchObject({ code: "BAD_PARAMS", kind: "deals" });
    expect(h.searches).toHaveLength(0);
  });

  test("an unknown field, a wrong operator, a wrong value and a foreign option are refused", async () => {
    const bad: Parameters<typeof args>[0][] = [
      [{ fieldId: syntheticId(699), operator: "eq", value: "SYN" }],
      [{ fieldId: TEXT, operator: "anyOf", value: ["SYN"] }],
      [{ fieldId: TEXT, operator: "eq" }],
      [{ fieldId: TEXT, operator: "isEmpty", value: "SYN" }],
      [{ fieldId: CHECK, operator: "eq", value: "true" }],
      [{ fieldId: CHOICE, operator: "eq", value: OPTION }],
      [{ fieldId: CHOICE, operator: "anyOf", value: [syntheticId(612)] }],
      [{ fieldId: CHOICE, operator: "anyOf", value: [] }],
    ];
    for (const customFields of bad) {
      const h = withFields();
      const result = await run(h, args(customFields));
      expect(structured(result).errors[0]?.code).toBe("BAD_PARAMS");
      expect(h.searches).toHaveLength(0);
    }
  });

  test("a refusal never repeats the field name or the value", async () => {
    const h = harness({
      customFields: {
        deal: [field({ id: NUMERIC, type: "numeric", filterable: false, name: "SYNTHETIC secret" })],
      },
    });
    const result = await run(
      h,
      args([{ fieldId: NUMERIC, operator: "eq", value: "SYNTHETIC value" }]),
    );
    const everything = JSON.stringify(result);
    expect(everything).not.toContain("SYNTHETIC secret");
    expect(everything).not.toContain("SYNTHETIC value");
  });

  test("custom field filters need exactly one kind", async () => {
    const h = withFields();
    const result = await run(h, {
      kinds: ["persons", "deals"],
      filters: { customFields: [{ fieldId: TEXT, operator: "isEmpty" }] },
    });
    expect(structured(result).errors[0]?.code).toBe("BAD_PARAMS");
    expect(h.searches).toHaveLength(0);
  });

  test("a truncated option list does not refuse an option it cannot see", async () => {
    const h = harness({
      customFields: {
        deal: [
          field({
            id: CHOICE,
            type: "multiselect",
            options: [{ id: OPTION, name: "SYNTHETIC option" }],
            optionsTruncated: true,
          }),
        ],
      },
    });
    const result = await run(
      h,
      args([{ fieldId: CHOICE, operator: "allOf", value: [syntheticId(612)] }]),
    );
    expect(result.isError).toBe(false);
  });
});

describe("search_crm paging, detail and counts", () => {
  test("every search sends an explicit page and perPage, 20 by default", async () => {
    const h = harness();
    await run(h, { filters: {} });
    expect(h.searches.map((call) => call.kind)).toEqual(["person", "company", "deal"]);
    for (const call of h.searches) {
      expect(call.query.page).toBe(1);
      expect(call.query.perPage).toBe(20);
    }
    const sized = harness();
    await run(sized, { kinds: ["deals"], filters: {}, perPage: 100, page: 3 });
    expect(sized.searches[0]?.query).toMatchObject({ page: 3, perPage: 100 });
  });

  test("the input schema caps perPage at 100 and refuses unknown keys", () => {
    const schema = searchCrmToolConfig.inputSchema;
    expect(schema.safeParse({ filters: {}, perPage: 100 }).success).toBe(true);
    expect(schema.safeParse({ filters: {}, perPage: 101 }).success).toBe(false);
    expect(schema.safeParse({ filters: {}, limit: 5 }).success).toBe(false);
    expect(schema.safeParse({ filters: { ownerLogin: "synthetic" } }).success).toBe(false);
    expect(
      schema.safeParse({ filters: { customFields: Array(11).fill({ fieldId: "a", operator: "isEmpty" }) } })
        .success,
    ).toBe(false);
  });

  test("countOnly sends perPage 1 and returns totalCount without items", async () => {
    const h = harness({
      search: () => ({ items: [dealV2()], totalCount: 41, totalCountExact: true }),
    });
    const result = await run(h, {
      kinds: ["deals"],
      filters: { stageIds: [syntheticId(411)] },
      countOnly: true,
    });
    expect(h.searches[0]?.query).toMatchObject({ page: 1, perPage: 1, media: MEDIA_MINIMAL });
    expect(structured(result).results.deals).toEqual({
      totalCount: 41,
      totalCountExact: true,
      returned: 0,
    });
    expect(result.text).toContain("deals: 41 total");
  });

  test("minimal detail reads minimal rows, standard and full read whole rows", async () => {
    const h = harness();
    await run(h, { kinds: ["deals"], filters: {}, detail: "minimal" });
    await run(h, { kinds: ["deals"], filters: {} });
    await run(h, { kinds: ["deals"], filters: {}, detail: "full" });
    expect(h.searches.map((call) => call.query.media)).toEqual([
      MEDIA_MINIMAL,
      MEDIA_JSON,
      MEDIA_JSON,
    ]);
  });

  test("items are cut to the detail level and the envelope carries the totals", async () => {
    const h = harness({
      search: (kind) => ({ items: [FIXTURES[kind]()], totalCount: 45, totalCountExact: true }),
    });
    const result = await run(h, { kinds: ["deals"], filters: {}, page: 2 });
    const deals = structured(result).results.deals;
    expect(deals).toMatchObject({
      totalCount: 45,
      totalCountExact: true,
      page: 2,
      perPage: 20,
      returned: 1,
      hasMore: true,
    });
    const item = deals?.items?.[0] as Record<string, unknown>;
    expect(item["id"]).toBe(syntheticId(301));
    expect("description" in item).toBe(false);
    expect("customFields" in item).toBe(false);
    expect(result.text).toContain("deals: 1 of 45 (page 2, more)");
  });

  test("hasMore is false on the last page and true under an inexact total", async () => {
    const last = harness({
      search: (kind) => ({ items: [FIXTURES[kind]()], totalCount: 21, totalCountExact: true }),
    });
    const lastResult = await run(last, { kinds: ["deals"], filters: {}, page: 2 });
    expect(structured(lastResult).results.deals?.hasMore).toBe(false);

    const inexact = harness({
      search: () => ({
        items: Array.from({ length: 20 }, () => dealV2()),
        totalCount: 10000,
        totalCountExact: false,
      }),
    });
    const inexactResult = await run(inexact, { kinds: ["deals"], filters: {}, page: 500 });
    expect(structured(inexactResult).results.deals?.hasMore).toBe(true);
  });

  test("no match carries a hint, a page past the end a different one", async () => {
    const none = harness({ search: () => ({ items: [], totalCount: 0, totalCountExact: true }) });
    const noneResult = await run(none, { kinds: ["deals"], filters: {} });
    const hint = structured(noneResult).results.deals?.hint ?? "";
    expect(hint).toContain("status");
    expect(noneResult.text).toContain(hint);
    expect(structured(noneResult).nextSteps).toBeUndefined();

    const past = harness({ search: () => ({ items: [], totalCount: 30, totalCountExact: true }) });
    const pastResult = await run(past, { kinds: ["deals"], filters: {}, page: 9 });
    expect(structured(pastResult).results.deals?.hint).toContain("past the last page");
  });

  test("a result with records carries fixed next steps", async () => {
    const h = harness();
    const result = await run(h, { kinds: ["deals"], filters: {} });
    const steps = structured(result).nextSteps ?? [];
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.length).toBeLessThanOrEqual(3);
    expect(steps.join(" ")).toContain("get_records");
  });
});

describe("search_crm phrase mode", () => {
  const hits: PhrasePage = {
    hits: [
      { kind: "person", id: syntheticId(101), name: "SYNTHETIC Person", url: null, company: null },
      { kind: "deal", id: syntheticId(301), name: "SYNTHETIC Deal", url: null, status: "open" },
      {
        kind: "note",
        id: syntheticId(951),
        name: "SYNTHETIC note text",
        textTruncated: false,
        url: null,
        createdAt: "2026-02-01T09:00:00Z",
        parent: { kind: "deal", id: syntheticId(301), name: "SYNTHETIC Deal" },
      },
    ],
    totalCount: 173,
    rowCount: 3,
  };

  test("phrase search joins the kinds into one request and caps perPage at 50", async () => {
    const h = harness({ phrase: () => hits });
    const result = await run(h, {
      phrase: "SYNTHETIC",
      kinds: ["persons", "deals", "notes"],
      perPage: 100,
      page: 2,
    });
    expect(h.phrases).toHaveLength(1);
    expect(h.phrases[0]?.query).toEqual({
      q: "SYNTHETIC",
      kinds: ["person", "deal", "note"],
      page: 2,
      perPage: 50,
    });
    const out = structured(result);
    expect(out.phrase).toEqual({ totalCount: 173, page: 2, perPage: 50, hasMore: true });
    expect(out.results.persons).toEqual({
      hits: [{ id: syntheticId(101), name: "SYNTHETIC Person", url: null, company: null }],
      returned: 1,
    });
    expect(out.results.deals?.hits?.[0]).toEqual({
      id: syntheticId(301),
      name: "SYNTHETIC Deal",
      url: null,
      status: "open",
    });
    expect(out.results.notes?.hits?.[0]).toMatchObject({
      id: syntheticId(951),
      parent: { kind: "deal", id: syntheticId(301) },
    });
    expect(result.text).toContain("phrase: 3 of 173 hits (page 2, more)");
  });

  test("the default phrase kinds are persons, companies and deals", async () => {
    const h = harness();
    const result = await run(h, { phrase: "SYNTHETIC" });
    expect(h.phrases[0]?.query.kinds).toEqual(["person", "company", "deal"]);
    expect(Object.keys(structured(result).results)).toEqual(["persons", "companies", "deals"]);
    // No hit at all: one hint about how the phrase search matches.
    expect(structured(result).phrase?.hint).toContain("prefix");
  });

  test("a failed phrase search is one error and an error result", async () => {
    const h = harness({
      phrase: () => {
        throw new LivespaceError("RATE_LIMITED", "SYNTHETIC limited", "SYNTHETIC wait");
      },
    });
    const result = await run(h, { phrase: "SYNTHETIC" });
    expect(result.isError).toBe(true);
    expect(structured(result).errors).toEqual([
      { code: "RATE_LIMITED", message: "SYNTHETIC limited", hint: "SYNTHETIC wait" },
    ]);
  });
});

describe("search_crm failures and channels", () => {
  test("one failing kind does not take the others down", async () => {
    const h = harness({
      search: (kind) => {
        if (kind === "company") {
          throw new LivespaceError(
            "INSUFFICIENT_SCOPE",
            "SYNTHETIC scope",
            "SYNTHETIC hint",
            undefined,
            undefined,
            false,
            { requestId: "0123456789abcdef0123456789abcdef", fields: ["/filter/field"] },
          );
        }
        return onePage(kind);
      },
    });
    const result = await run(h, { filters: {}, kinds: ["persons", "companies"] });
    expect(result.isError).toBe(false);
    const out = structured(result);
    expect(out.results.persons?.returned).toBe(1);
    expect(out.results.companies).toBeUndefined();
    expect(out.errors).toEqual([
      {
        kind: "companies",
        code: "INSUFFICIENT_SCOPE",
        message: "SYNTHETIC scope",
        hint: "SYNTHETIC hint",
        fields: ["/filter/field"],
        requestId: "0123456789abcdef0123456789abcdef",
      },
    ]);
    expect(result.text).toContain("search_crm (1/2 kinds ok)");
  });

  test("an unexpected failure never leaks its text", async () => {
    const h = harness({
      search: () => {
        throw new Error("SYNTHETIC upstream body with a secret");
      },
    });
    const result = await run(h, { kinds: ["deals"], filters: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC upstream body");
    expect(structured(result).errors[0]?.code).toBe("UPSTREAM_ERROR");
  });

  test("a failing dictionary read fails the call with its own error", async () => {
    const h = harness({
      metadataError: new LivespaceError("DAILY_BUDGET_LOW", "SYNTHETIC low", "SYNTHETIC wait"),
    });
    const result = await run(h, { kinds: ["deals"], filters: { createdFrom: "2026-01-01" } });
    expect(result.isError).toBe(true);
    expect(structured(result).errors[0]?.code).toBe("DAILY_BUDGET_LOW");
    expect(h.searches).toHaveLength(0);
  });

  test("a cancelled call throws instead of answering", async () => {
    const controller = new AbortController();
    const h = harness({
      search: () => {
        controller.abort();
        throw new Error("SYNTHETIC abort");
      },
    });
    await expect(
      runSearchCrm(h.deps, { kinds: ["deals"], filters: {} }, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
  });

  test("the text channel carries counts and fixed wording, never CRM text", async () => {
    const h = harness();
    const result = await run(h, { filters: {}, kinds: ["persons", "companies", "deals", "tasks"] });
    expect(result.text).not.toContain("SYNTHETIC");
    expect(result.text).toContain("persons: 1 of 1 (page 1)");
  });

  test("one request budget of the read size serves the whole call", async () => {
    const h = harness({
      customFields: { deal: [field({ id: syntheticId(601), type: "text" })] },
    });
    await run(h, {
      kinds: ["deals"],
      filters: {
        mine: true,
        createdFrom: "2026-01-01",
        customFields: [{ fieldId: syntheticId(601), operator: "isEmpty" }],
      },
    });
    const budget = h.searches[0]?.opts.budget;
    expect(budget).toBeInstanceOf(CallBudget);
    expect(budget?.max).toBe(CALL_BUDGETS.read);
  });

  test("the tool is annotated read-only and idempotent", () => {
    expect(searchCrmToolConfig.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });
});
