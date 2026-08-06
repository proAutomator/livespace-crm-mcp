import { describe, expect, test } from "bun:test";
import { LivespaceError } from "../../src/livespace/errors.js";
import {
  ARG_KIND_TO_RECORD_KIND,
  asName,
  createRecordFetchers,
  mapCompany,
  mapDeal,
  mapPerson,
  mapTask,
  parseCommaDecimal,
  projectRecord,
  RECORD_KIND_TO_UPSTREAM_TYPE,
  RECORD_KINDS,
  type CompanyRecord,
  type DealRecord,
  type PersonRecord,
  type RecordFetchers,
  type TaskRecord,
} from "../../src/livespace/records.js";

const UNEXPECTED_SHAPE = "Livespace returned an unexpected shape for this record.";

// Every value below is invented. No CRM data, no sandbox values (AGENTS.md).
const PERSON_RAW = {
  id: "person-synthetic-001",
  // Set to a DIFFERENT value on purpose: the mapper must read `id`.
  contact_id: "contact-id-synthetic-999",
  name: "Synthetic Person One",
  email: "person.one@synthetic.example",
  phone: "+00 000 000 001",
  cell: "+00 000 000 002",
  company: "Synthetic Company Alpha",
  company_id: "company-synthetic-101",
  owner_name: "Synthetic Owner",
  owner_id: "user-synthetic-201",
  tags: ["alpha", "beta"],
  source_name: "Synthetic Source",
  note: "Synthetic note text",
  created: "2025-10-08 15:19:13+02",
  modified: "2025-11-02 09:00:00+02",
  last_active_date: "2025-11-03 12:30:00+02",
  deal_count: { all: 4, open: "2", won: 1, lost: 1, outdated: 0 },
  www: "https://alpha.synthetic.example",
  address_street: "Synthetic Street 1",
  address_street2: "Flat 2",
  address_city: "Synthetic City",
  address_postcode: "00-001",
  groups: [{ id: "group-synthetic-301", name: "Group One" }, { name: "Group Two" }],
};

const PERSON: PersonRecord = {
  id: "person-synthetic-001",
  name: "Synthetic Person One",
  email: "person.one@synthetic.example",
  phone: "+00 000 000 001",
  companyName: "Synthetic Company Alpha",
  companyId: "company-synthetic-101",
  ownerName: "Synthetic Owner",
  ownerId: "user-synthetic-201",
  tags: ["alpha", "beta"],
  source: "Synthetic Source",
  note: "Synthetic note text",
  created: "2025-10-08 15:19:13+02",
  modified: "2025-11-02 09:00:00+02",
  lastActiveDate: "2025-11-03 12:30:00+02",
  dealCount: { all: 4, open: 2, won: 1, lost: 1 },
  cell: "+00 000 000 002",
  www: "https://alpha.synthetic.example",
  address: "Synthetic Street 1, Flat 2, Synthetic City, 00-001",
  groups: ["Group One", "Group Two"],
};

const PERSON_EMPTY: PersonRecord = {
  id: "",
  name: "",
  email: "",
  phone: "",
  companyName: "",
  companyId: null,
  ownerName: "",
  ownerId: null,
  tags: [],
  source: "",
  note: "",
  created: "",
  modified: "",
  lastActiveDate: "",
  dealCount: null,
  cell: "",
  www: "",
  address: "",
  groups: [],
};

const COMPANY_RAW = {
  id: "company-synthetic-101",
  company_id: "company-id-synthetic-999",
  name: "Synthetic Company Alpha",
  nip: "0000000000",
  email: "office@alpha.synthetic.example",
  phone: "+00 000 000 003",
  owner_name: "Synthetic Owner",
  owner_id: "user-synthetic-201",
  tags: ["gamma"],
  source_name: "Synthetic Source",
  note: "Synthetic company note",
  created: "2025-09-01 08:00:00+02",
  modified: "2025-11-04 10:15:00+02",
  deal_count: { all: 7, open: 3, won: 2, lost: 2, outdated: 1 },
  www: "https://alpha.synthetic.example",
  address_street: "Synthetic Avenue 9",
  address_street2: "",
  address_city: "Synthetic City",
  address_postcode: "00-002",
  groups: ["Group Three"],
};

const COMPANY: CompanyRecord = {
  id: "company-synthetic-101",
  name: "Synthetic Company Alpha",
  nip: "0000000000",
  email: "office@alpha.synthetic.example",
  phone: "+00 000 000 003",
  ownerName: "Synthetic Owner",
  ownerId: "user-synthetic-201",
  tags: ["gamma"],
  source: "Synthetic Source",
  note: "Synthetic company note",
  created: "2025-09-01 08:00:00+02",
  modified: "2025-11-04 10:15:00+02",
  dealCount: { all: 7, open: 3, won: 2, lost: 2 },
  www: "https://alpha.synthetic.example",
  address: "Synthetic Avenue 9, Synthetic City, 00-002",
  groups: ["Group Three"],
};

const COMPANY_EMPTY: CompanyRecord = {
  id: "",
  name: "",
  nip: "",
  email: "",
  phone: "",
  ownerName: "",
  ownerId: null,
  tags: [],
  source: "",
  note: "",
  created: "",
  modified: "",
  dealCount: null,
  www: "",
  address: "",
  groups: [],
};

const DEAL_RAW = {
  id: "deal-synthetic-401",
  deal_id: "deal-id-synthetic-999",
  name: "Synthetic Deal One",
  status: "open",
  status_name: "Open",
  value: "1 234,50",
  currency: "PLN",
  probability: "5,00",
  process_id: "process-synthetic-501",
  process_name: "Synthetic Process",
  stage_id: "stage-synthetic-601",
  stage_name: "Synthetic Stage",
  substage_id: "substage-synthetic-701",
  substage_name: "Synthetic Substage",
  company_id: "company-synthetic-101",
  company_name: "Synthetic Company Alpha",
  contact_id: "person-synthetic-001",
  contact_name: "Synthetic Person One",
  owner_id: "user-synthetic-201",
  owner_name: "Synthetic Owner",
  date_end: "2025-12-13",
  created: "2025-10-01 11:00:00+02",
  modified: "2025-11-05 16:45:00+02",
  last_active_date: "2025-11-06 08:10:00+02",
  tags: ["delta"],
  source_name: "Synthetic Source",
  note: "Synthetic deal note",
  groups: [{ name: "Group Four" }],
  creator_name: "Synthetic Creator",
  status_change_date: "2025-11-05 16:45:00+02",
};

const DEAL: DealRecord = {
  id: "deal-synthetic-401",
  name: "Synthetic Deal One",
  status: "open",
  value: 1234.5,
  currency: "PLN",
  probability: 5,
  processId: "process-synthetic-501",
  processName: "Synthetic Process",
  stageId: "stage-synthetic-601",
  stageName: "Synthetic Stage",
  substageId: "substage-synthetic-701",
  substageName: "Synthetic Substage",
  companyId: "company-synthetic-101",
  companyName: "Synthetic Company Alpha",
  contactId: "person-synthetic-001",
  contactName: "Synthetic Person One",
  ownerId: "user-synthetic-201",
  ownerName: "Synthetic Owner",
  dateEnd: "2025-12-13",
  created: "2025-10-01 11:00:00+02",
  modified: "2025-11-05 16:45:00+02",
  lastActiveDate: "2025-11-06 08:10:00+02",
  tags: ["delta"],
  source: "Synthetic Source",
  note: "Synthetic deal note",
  groups: ["Group Four"],
  creatorName: "Synthetic Creator",
  statusChangeDate: "2025-11-05 16:45:00+02",
};

const DEAL_EMPTY: DealRecord = {
  id: "",
  name: "",
  status: "",
  value: null,
  currency: "",
  probability: null,
  processId: "",
  processName: "",
  stageId: "",
  stageName: "",
  substageId: "",
  substageName: "",
  companyId: null,
  companyName: "",
  contactId: null,
  contactName: "",
  ownerId: null,
  ownerName: "",
  dateEnd: "",
  created: "",
  modified: "",
  lastActiveDate: "",
  tags: [],
  source: "",
  note: "",
  groups: [],
  creatorName: "",
  statusChangeDate: "",
};

const TASK_RAW = {
  id: "task-synthetic-801",
  title: "Synthetic Task One",
  description: "Synthetic task description",
  type_id: "tasktype-synthetic-901",
  type_name: "Call",
  status_id: "taskstatus-synthetic-902",
  status_name: "Planned",
  is_completed: 0,
  is_private: 1,
  priority: "2",
  date_from: "2025-11-10 09:00:00+02",
  date_to: "2025-11-10 09:30:00+02",
  is_all_day: false,
  objects: [
    {
      object_type: "contact",
      object_id: "person-synthetic-001",
      object_name: "Synthetic Person One",
    },
    { object_type: "deal", object_id: 402, object_name: "Synthetic Deal Two" },
  ],
  created: "2025-11-01 07:00:00+02",
  modified: "2025-11-09 18:00:00+02",
  // Dynamic keys the mapper must ignore (probe evidence 6).
  role_1: "synthetic role",
  role_participant: { id: "user-synthetic-201" },
  invited: ["user-synthetic-202"],
};

const TASK: TaskRecord = {
  id: "task-synthetic-801",
  title: "Synthetic Task One",
  description: "Synthetic task description",
  typeId: "tasktype-synthetic-901",
  typeName: "Call",
  statusId: "taskstatus-synthetic-902",
  statusName: "Planned",
  isCompleted: false,
  isPrivate: true,
  priority: 2,
  dateFrom: "2025-11-10 09:00:00+02",
  dateTo: "2025-11-10 09:30:00+02",
  isAllDay: false,
  linkedRecords: [
    { kind: "contact", id: "person-synthetic-001", name: "Synthetic Person One" },
    { kind: "deal", id: "402", name: "Synthetic Deal Two" },
  ],
  created: "2025-11-01 07:00:00+02",
  modified: "2025-11-09 18:00:00+02",
};

const TASK_EMPTY: TaskRecord = {
  id: "",
  title: "",
  description: "",
  typeId: "",
  typeName: "",
  statusId: null,
  statusName: "",
  isCompleted: false,
  isPrivate: false,
  priority: 0,
  dateFrom: "",
  dateTo: "",
  isAllDay: false,
  linkedRecords: [],
  created: "",
  modified: "",
};

describe("kind vocabularies", () => {
  test("record kinds and their argument/upstream spellings", () => {
    expect(RECORD_KINDS).toEqual(["person", "company", "deal", "task"]);
    expect(ARG_KIND_TO_RECORD_KIND).toEqual({
      persons: "person",
      companies: "company",
      deals: "deal",
      tasks: "task",
    });
    // Tasks have no Contact-style `type` param upstream.
    expect(RECORD_KIND_TO_UPSTREAM_TYPE).toEqual({
      person: "contact",
      company: "company",
      deal: "deal",
    });
  });
});

describe("full-record mappers", () => {
  test("mapPerson on a fully populated raw record", () => {
    expect(mapPerson(PERSON_RAW)).toEqual(PERSON);
  });

  test("mapCompany on a fully populated raw record", () => {
    expect(mapCompany(COMPANY_RAW)).toEqual(COMPANY);
  });

  test("mapDeal parses comma decimals and reads `id`, not `deal_id`", () => {
    expect(mapDeal(DEAL_RAW)).toEqual(DEAL);
  });

  test("mapTask on a fully populated raw record", () => {
    expect(mapTask(TASK_RAW)).toEqual(TASK);
  });

  test("absent structures fall back to the empty conventions", () => {
    expect(mapPerson({ id: "person-synthetic-002" })).toEqual({
      ...PERSON_EMPTY,
      id: "person-synthetic-002",
    });
    expect(mapCompany({ id: "company-synthetic-102" })).toEqual({
      ...COMPANY_EMPTY,
      id: "company-synthetic-102",
    });
    expect(mapDeal({ id: "deal-synthetic-402" })).toEqual({
      ...DEAL_EMPTY,
      id: "deal-synthetic-402",
    });
    expect(mapTask({ id: "task-synthetic-802" })).toEqual({
      ...TASK_EMPTY,
      id: "task-synthetic-802",
    });
  });

  test("tags and groups tolerate objects, empty arrays and junk entries", () => {
    const mapped = mapPerson({
      id: "person-synthetic-003",
      tags: [{ name: "From Object" }, "From String", 7, null, { name: "" }],
      groups: [],
    });
    expect(mapped.tags).toEqual(["From Object", "From String"]);
    expect(mapped.groups).toEqual([]);
    // PHP serializes empty maps as `[]`; a non-array value is simply ignored.
    expect(mapCompany({ id: "company-synthetic-103", tags: {} }).tags).toEqual([]);
  });

  test("task linked records skip idless entries and nullable status maps to null", () => {
    const mapped = mapTask({
      id: "task-synthetic-803",
      status_id: null,
      status_name: null,
      objects: [
        { object_type: "company", object_id: "company-synthetic-101" },
        { object_type: "deal", object_name: "no id here" },
        "not an object",
      ],
    });
    expect(mapped.statusId).toBeNull();
    expect(mapped.statusName).toBe("");
    expect(mapped.linkedRecords).toEqual([
      { kind: "company", id: "company-synthetic-101", name: "" },
    ]);
  });

  test("address flattening skips empty parts", () => {
    expect(
      mapPerson({
        id: "person-synthetic-004",
        address_street: "Synthetic Street 5",
        address_street2: "",
        address_city: "",
        address_postcode: "00-003",
      }).address,
    ).toBe("Synthetic Street 5, 00-003");
    // The richer getAll/get shape carries an `addresses` array instead.
    expect(
      mapCompany({
        id: "company-synthetic-104",
        addresses: [{ street: "Synthetic Avenue 3", city: "Synthetic City" }],
      }).address,
    ).toBe("Synthetic Avenue 3, Synthetic City");
    expect(mapCompany({ id: "company-synthetic-105", addresses: [] }).address).toBe("");
  });

  test("dealCount coerces numeric strings, drops non-finite values, absent stays null", () => {
    expect(
      mapPerson({
        id: "person-synthetic-005",
        deal_count: { all: "9", open: "not a number", won: null, lost: 3 },
      }).dealCount,
    ).toEqual({ all: 9, open: 0, won: 0, lost: 3 });
    expect(mapPerson({ id: "person-synthetic-006" }).dealCount).toBeNull();
    expect(
      mapCompany({ id: "company-synthetic-106", deal_count: [] }).dealCount,
    ).toBeNull();
  });

  test("non-object or idless raw throws the fixed unexpected-shape error", () => {
    const cases: unknown[] = [null, undefined, "string", 7, [], { name: "no id" }, { id: "" }];
    for (const raw of cases) {
      for (const mapper of [mapPerson, mapCompany, mapDeal, mapTask]) {
        expect(() => mapper(raw)).toThrow(LivespaceError);
        try {
          mapper(raw);
          throw new Error("expected a throw");
        } catch (error) {
          const livespace = error as LivespaceError;
          expect(livespace.code).toBe("UPSTREAM_ERROR");
          expect(livespace.message).toBe(UNEXPECTED_SHAPE);
        }
      }
    }
  });
});

describe("asName", () => {
  test("passes strings through and turns everything else into an empty string", () => {
    expect(asName("Synthetic")).toBe("Synthetic");
    expect(asName("")).toBe("");
    for (const value of [null, undefined, 7, true, {}, [], { name: "x" }]) {
      expect(asName(value)).toBe("");
    }
  });
});

describe("parseCommaDecimal", () => {
  const cases: Array<[unknown, number | null]> = [
    ["5,00", 5],
    ["1 234,50", 1234.5],
    ["0", 0],
    ["-12,25", -12.25],
    [42, 42],
    [0, 0],
    [-1.5, -1.5],
    ["", null],
    ["   ", null],
    [null, null],
    [undefined, null],
    ["abc", null],
    ["1,234.50", null],
    [{}, null],
    [[], null],
    [true, null],
    [Number.NaN, null],
    [Number.POSITIVE_INFINITY, null],
  ];

  for (const [index, [input, expected]] of cases.entries()) {
    const label = typeof input === "number" ? String(input) : JSON.stringify(input);
    test(`case ${index}: ${label ?? String(input)} -> ${String(expected)}`, () => {
      expect(parseCommaDecimal(input)).toBe(expected);
    });
  }
});

describe("projectRecord", () => {
  test("person minimal", () => {
    expect(projectRecord("person", PERSON, "minimal")).toEqual({
      ...PERSON_EMPTY,
      id: PERSON.id,
      name: PERSON.name,
      email: PERSON.email,
      companyName: PERSON.companyName,
    });
  });

  test("person standard", () => {
    expect(projectRecord("person", PERSON, "standard")).toEqual({
      ...PERSON,
      cell: "",
      www: "",
      address: "",
      groups: [],
    });
  });

  test("person full", () => {
    expect(projectRecord("person", PERSON, "full")).toEqual(PERSON);
  });

  test("company minimal", () => {
    expect(projectRecord("company", COMPANY, "minimal")).toEqual({
      ...COMPANY_EMPTY,
      id: COMPANY.id,
      name: COMPANY.name,
      nip: COMPANY.nip,
      email: COMPANY.email,
    });
  });

  test("company standard", () => {
    expect(projectRecord("company", COMPANY, "standard")).toEqual({
      ...COMPANY,
      www: "",
      address: "",
      groups: [],
    });
  });

  test("company full", () => {
    expect(projectRecord("company", COMPANY, "full")).toEqual(COMPANY);
  });

  test("deal minimal", () => {
    expect(projectRecord("deal", DEAL, "minimal")).toEqual({
      ...DEAL_EMPTY,
      id: DEAL.id,
      name: DEAL.name,
      status: DEAL.status,
      value: DEAL.value,
      currency: DEAL.currency,
      stageName: DEAL.stageName,
      ownerName: DEAL.ownerName,
    });
  });

  test("deal standard", () => {
    expect(projectRecord("deal", DEAL, "standard")).toEqual({
      ...DEAL,
      groups: [],
      creatorName: "",
      statusChangeDate: "",
    });
  });

  test("deal full", () => {
    expect(projectRecord("deal", DEAL, "full")).toEqual(DEAL);
  });

  test("task minimal", () => {
    expect(projectRecord("task", TASK, "minimal")).toEqual({
      ...TASK_EMPTY,
      id: TASK.id,
      title: TASK.title,
      typeName: TASK.typeName,
      isCompleted: TASK.isCompleted,
      dateFrom: TASK.dateFrom,
    });
  });

  test("task standard equals full", () => {
    expect(projectRecord("task", TASK, "standard")).toEqual(TASK);
  });

  test("task full", () => {
    expect(projectRecord("task", TASK, "full")).toEqual(TASK);
  });

  test("projection never mutates the source record", () => {
    const source = { ...PERSON };
    projectRecord("person", source, "minimal");
    expect(source).toEqual(PERSON);
  });
});

interface FakeCall {
  module: string;
  method: string;
  params: Record<string, unknown>;
  opts?: unknown;
}

function fakeRecordClient(responses: Record<string, unknown>) {
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

function recordFetchersFor(responses: Record<string, unknown>) {
  const { client, calls } = fakeRecordClient(responses);
  return { fetchers: createRecordFetchers(client), calls };
}

function syntheticRows(count: number, prefix: string): Array<{ id: string; name: string }> {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${String(index).padStart(3, "0")}`,
    name: `Synthetic ${prefix} ${index}`,
  }));
}

describe("fetcher call table", () => {
  interface CallCase {
    name: string;
    responses: Record<string, unknown>;
    run: (fetchers: RecordFetchers, signal: AbortSignal) => Promise<unknown>;
    module: string;
    method: string;
    params: Record<string, unknown>;
  }

  const cases: CallCase[] = [
    {
      name: "listPersons without a name filter",
      responses: { "Contact/getAll": { contact: [] } },
      run: (fetchers, signal) => fetchers.listPersons({ limit: 20, offset: 0, signal }),
      module: "Contact",
      method: "getAll",
      params: { type: "contact", limit: 20, offset: 0 },
    },
    {
      name: "listPersons with a name filter",
      responses: { "Contact/getAll": { contact: [] } },
      run: (fetchers, signal) =>
        fetchers.listPersons({ limit: 5, offset: 10, namesLike: "Synthetic", signal }),
      module: "Contact",
      method: "getAll",
      params: {
        type: "contact",
        limit: 5,
        offset: 10,
        names: "Synthetic",
        condition: "like",
      },
    },
    {
      name: "listCompanies",
      responses: { "Contact/getAll": { company: [] } },
      run: (fetchers, signal) => fetchers.listCompanies({ limit: 20, offset: 0, signal }),
      module: "Contact",
      method: "getAll",
      params: { type: "company", limit: 20, offset: 0 },
    },
    {
      name: "listDeals defaults to the open status",
      responses: { "Deal/getAll": { deal: [] } },
      run: (fetchers, signal) => fetchers.listDeals({ limit: 20, offset: 0, signal }),
      module: "Deal",
      method: "getAll",
      params: { status: "open", limit: 20, offset: 0 },
    },
    {
      name: "listDeals with every optional filter",
      responses: { "Deal/getAll": { deal: [] } },
      run: (fetchers, signal) =>
        fetchers.listDeals({
          limit: 10,
          offset: 20,
          status: "all",
          processId: "process-synthetic-501",
          stageId: "stage-synthetic-601",
          ownerLogin: "owner.synthetic",
          modifiedFrom: "2025-11-01",
          namesLike: "Synthetic",
          signal,
        }),
      module: "Deal",
      method: "getAll",
      params: {
        status: "all",
        limit: 10,
        offset: 20,
        processes: "process-synthetic-501",
        stages: "stage-synthetic-601",
        owner_login: "owner.synthetic",
        modified: "2025-11-01",
        names: "Synthetic",
      },
    },
    {
      name: "listTasks with only a page",
      responses: { "Todo/getTodoObjects": { todo: [] } },
      run: (fetchers, signal) => fetchers.listTasks({ page: 2, signal }),
      module: "Todo",
      method: "getTodoObjects",
      // Stringly-typed upstream params; there is no limit parameter at all.
      params: { todo: { getWholeList: "0", page: "2" } },
    },
    {
      name: "listTasks with completed false and a date period",
      responses: { "Todo/getTodoObjects": { todo: [] } },
      run: (fetchers, signal) =>
        fetchers.listTasks({
          page: 1,
          completed: false,
          dateFrom: "2025-11-01",
          dateTo: "2025-11-30",
          signal,
        }),
      module: "Todo",
      method: "getTodoObjects",
      params: {
        todo: {
          getWholeList: "0",
          page: "1",
          isCompleted: "0",
          datesPeriod: { from: "2025-11-01", to: "2025-11-30" },
        },
      },
    },
    {
      name: "listTasks with completed true and only a start date",
      responses: { "Todo/getTodoObjects": { todo: [] } },
      run: (fetchers, signal) =>
        fetchers.listTasks({ page: 1, completed: true, dateFrom: "2025-11-01", signal }),
      module: "Todo",
      method: "getTodoObjects",
      params: {
        todo: {
          getWholeList: "0",
          page: "1",
          isCompleted: "1",
          datesPeriod: { from: "2025-11-01" },
        },
      },
    },
    {
      name: "searchPhrase",
      responses: { "Search/getResult": { deal: [] } },
      run: (fetchers, signal) =>
        fetchers.searchPhrase({ q: "synthetic", kind: "deal", limit: 5, signal }),
      module: "Search",
      method: "getResult",
      params: { q: "synthetic", object_type: "deal", limit: 5 },
    },
    {
      name: "getRecord person",
      responses: { "Contact/get": { contact: { id: "person-synthetic-001" } } },
      run: (fetchers, signal) =>
        fetchers.getRecord("person", "person-synthetic-001", { signal }),
      module: "Contact",
      method: "get",
      params: { type: "contact", id: "person-synthetic-001" },
    },
    {
      name: "getRecord company",
      responses: { "Contact/get": { company: { id: "company-synthetic-101" } } },
      run: (fetchers, signal) =>
        fetchers.getRecord("company", "company-synthetic-101", { signal }),
      module: "Contact",
      method: "get",
      params: { type: "company", id: "company-synthetic-101" },
    },
    {
      name: "getRecord deal",
      responses: { "Deal/get": { deal: { id: "deal-synthetic-401" } } },
      run: (fetchers, signal) =>
        fetchers.getRecord("deal", "deal-synthetic-401", { signal }),
      module: "Deal",
      method: "get",
      params: { id: "deal-synthetic-401" },
    },
    {
      name: "getRecord task",
      responses: { "Todo/get": { todo: { id: "task-synthetic-801" } } },
      run: (fetchers, signal) =>
        fetchers.getRecord("task", "task-synthetic-801", { signal }),
      module: "Todo",
      method: "get",
      params: { id: "task-synthetic-801" },
    },
  ];

  for (const testCase of cases) {
    test(`${testCase.name} sends exact params and forwards the signal`, async () => {
      const { fetchers, calls } = recordFetchersFor(testCase.responses);
      const signal = new AbortController().signal;

      await testCase.run(fetchers, signal);

      expect(calls).toHaveLength(1);
      const call = calls[0] as FakeCall;
      expect([call.module, call.method]).toEqual([testCase.module, testCase.method]);
      expect(call.params).toStrictEqual(testCase.params);
      expect((call.opts as { signal?: AbortSignal }).signal).toBe(signal);
    });
  }
});

describe("list fetchers", () => {
  test("persons unwrap the type-keyed wrapper and map full records", async () => {
    const { fetchers } = recordFetchersFor({
      "Contact/getAll": { contact: [PERSON_RAW] },
    });

    const page = await fetchers.listPersons({ limit: 20, offset: 0 });

    expect(page.items).toEqual([PERSON]);
    expect(page.rawCount).toBe(1);
    expect(page.hasMore).toBe(false);
  });

  test("companies unwrap their own wrapper key", async () => {
    const { fetchers } = recordFetchersFor({
      "Contact/getAll": { company: [COMPANY_RAW] },
    });

    const page = await fetchers.listCompanies({ limit: 20, offset: 0 });

    expect(page.items).toEqual([COMPANY]);
  });

  test("deals and tasks unwrap their wrappers", async () => {
    const { fetchers } = recordFetchersFor({
      "Deal/getAll": { deal: [DEAL_RAW] },
      "Todo/getTodoObjects": { todo: [TASK_RAW] },
    });

    expect((await fetchers.listDeals({ limit: 20, offset: 0 })).items).toEqual([DEAL]);
    expect((await fetchers.listTasks({ page: 1 })).items).toEqual([TASK]);
  });

  test("empty and PHP-style payloads produce an empty page", async () => {
    for (const payload of [{ contact: [] }, {}, [], null]) {
      const { fetchers } = recordFetchersFor({ "Contact/getAll": payload });
      const page = await fetchers.listPersons({ limit: 20, offset: 0 });
      expect(page).toEqual({ items: [], hasMore: false, rawCount: 0 });
    }
  });

  test("a wrapper for another type reads as an empty page", async () => {
    const { fetchers } = recordFetchersFor({
      "Contact/getAll": { contact: [PERSON_RAW] },
    });

    expect(await fetchers.listCompanies({ limit: 20, offset: 0 })).toEqual({
      items: [],
      hasMore: false,
      rawCount: 0,
    });
  });

  test("hasMore comes from the raw row count, not from the mapped items", async () => {
    const rows: unknown[] = [...syntheticRows(2, "person-synthetic"), { name: "no id" }];
    const { fetchers } = recordFetchersFor({ "Contact/getAll": { contact: rows } });

    const page = await fetchers.listPersons({ limit: 3, offset: 0 });

    expect(page.rawCount).toBe(3);
    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(true);
  });

  test("an upstream page that ignores the limit is sliced locally", async () => {
    const { fetchers } = recordFetchersFor({
      "Deal/getAll": { deal: syntheticRows(57, "deal-synthetic") },
    });

    const page = await fetchers.listDeals({ limit: 20, offset: 0 });

    expect(page.items).toHaveLength(20);
    expect(page.rawCount).toBe(57);
    expect(page.hasMore).toBe(true);
    expect(page.items[0]?.id).toBe("deal-synthetic-000");
    expect(page.items[19]?.id).toBe("deal-synthetic-019");
  });

  test("tasks page at exactly 50 rows report more, 49 do not", async () => {
    const full = recordFetchersFor({
      "Todo/getTodoObjects": { todo: syntheticRows(50, "task-synthetic") },
    });
    const short = recordFetchersFor({
      "Todo/getTodoObjects": { todo: syntheticRows(49, "task-synthetic") },
    });

    const fullPage = await full.fetchers.listTasks({ page: 1 });
    const shortPage = await short.fetchers.listTasks({ page: 2 });

    expect(fullPage.rawCount).toBe(50);
    expect(fullPage.items).toHaveLength(50);
    expect(fullPage.hasMore).toBe(true);
    expect(shortPage.rawCount).toBe(49);
    expect(shortPage.hasMore).toBe(false);
  });

  test("an unknown payload shape fails with the fixed message", async () => {
    const { fetchers } = recordFetchersFor({ "Contact/getAll": "not a payload" });

    const error = await fetchers.listPersons({ limit: 20, offset: 0 }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(LivespaceError);
    expect((error as LivespaceError).code).toBe("UPSTREAM_ERROR");
    expect((error as LivespaceError).message).toBe(UNEXPECTED_SHAPE);
  });
});

describe("searchPhrase", () => {
  const HITS = [
    {
      id: "deal-synthetic-401",
      name: "Synthetic Deal One",
      number: 1,
      icon: "deal",
      description: "Synthetic hit description",
      modified: "2025-11-05 16:45:00+02",
      details: {},
      term: "synthetic",
    },
    { id: 402, name: "Synthetic Deal Two" },
    { name: "hit without an id" },
  ];

  test("maps hits, coerces ids and keeps the pre-slice raw count", async () => {
    const { fetchers } = recordFetchersFor({ "Search/getResult": { deal: HITS } });

    const result = await fetchers.searchPhrase({ q: "synthetic", kind: "deal", limit: 2 });

    expect(result.rawCount).toBe(3);
    expect(result.hits).toEqual([
      {
        id: "deal-synthetic-401",
        name: "Synthetic Deal One",
        description: "Synthetic hit description",
        modified: "2025-11-05 16:45:00+02",
      },
      { id: "402", name: "Synthetic Deal Two", description: "", modified: "" },
    ]);
  });

  test("slices defensively when upstream returns more than the limit", async () => {
    const { fetchers } = recordFetchersFor({
      "Search/getResult": { contact: syntheticRows(9, "person-synthetic") },
    });

    const result = await fetchers.searchPhrase({ q: "synthetic", kind: "person", limit: 3 });

    expect(result.hits).toHaveLength(3);
    expect(result.rawCount).toBe(9);
  });

  test("an empty or absent wrapper yields no hits", async () => {
    const { fetchers } = recordFetchersFor({ "Search/getResult": [] });

    expect(await fetchers.searchPhrase({ q: "synthetic", kind: "company", limit: 5 })).toEqual({
      hits: [],
      rawCount: 0,
    });
  });
});

describe("getRecord", () => {
  test("unwraps and maps each kind", async () => {
    const { fetchers } = recordFetchersFor({
      "Contact/get": { contact: PERSON_RAW },
      "Deal/get": { deal: DEAL_RAW },
      "Todo/get": { todo: TASK_RAW },
    });

    expect(await fetchers.getRecord("person", PERSON.id)).toEqual(PERSON);
    expect(await fetchers.getRecord("deal", DEAL.id)).toEqual(DEAL);
    expect(await fetchers.getRecord("task", TASK.id)).toEqual(TASK);
  });

  test("companies accept the type-keyed wrapper", async () => {
    const { fetchers } = recordFetchersFor({ "Contact/get": { company: COMPANY_RAW } });

    expect(await fetchers.getRecord("company", COMPANY.id)).toEqual(COMPANY);
  });

  // Upstream conflates "does not exist" with "you cannot see it" (probe
  // evidence 11): 540 on contacts, 550 on deals and tasks.
  const notFound: Array<[string, number, string, string]> = [
    ["person", 540, "Contact/get", "person-synthetic-404"],
    ["company", 540, "Contact/get", "company-synthetic-404"],
    ["deal", 550, "Deal/get", "deal-synthetic-404"],
    ["task", 550, "Todo/get", "task-synthetic-404"],
  ];

  for (const [kind, resultCode, endpoint, id] of notFound) {
    test(`${kind} maps result ${resultCode} to null`, async () => {
      const { fetchers } = recordFetchersFor({
        [endpoint]: new LivespaceError(
          resultCode === 540 ? "PERMISSION_DENIED" : "BAD_PARAMS",
          "synthetic upstream failure",
          "synthetic hint",
          resultCode,
        ),
      });

      expect(await fetchers.getRecord(kind as "person", id)).toBeNull();
    });
  }

  test("other upstream errors propagate unchanged", async () => {
    const rateLimited = new LivespaceError(
      "RATE_LIMITED",
      "synthetic rate limit",
      "synthetic hint",
      429,
    );
    const { fetchers } = recordFetchersFor({ "Deal/get": rateLimited });

    const error = await fetchers.getRecord("deal", "deal-synthetic-401").then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBe(rateLimited);
  });

  test("a permission error on a list call still propagates", async () => {
    const denied = new LivespaceError(
      "PERMISSION_DENIED",
      "synthetic permission failure",
      "synthetic hint",
      540,
    );
    const { fetchers } = recordFetchersFor({ "Contact/getAll": denied });

    const error = await fetchers.listPersons({ limit: 20, offset: 0 }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBe(denied);
  });

  test("an unexpected payload for a single record fails loudly", async () => {
    const { fetchers } = recordFetchersFor({ "Deal/get": { deal: { name: "no id" } } });

    const error = await fetchers.getRecord("deal", "deal-synthetic-401").then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(LivespaceError);
    expect((error as LivespaceError).message).toBe(UNEXPECTED_SHAPE);
  });
});
