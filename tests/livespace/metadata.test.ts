import { describe, expect, test } from "bun:test";
import { LivespaceError } from "../../src/livespace/errors.js";
import {
  createMetadataFetchers,
  METADATA_SECTIONS,
  type MetadataSection,
} from "../../src/livespace/metadata.js";

const UNEXPECTED_SHAPE = "Livespace returned an unexpected shape for this dictionary.";

function fakeClient(responses: Record<string, unknown>) {
  const calls: Array<{ module: string; method: string; opts?: unknown }> = [];
  return {
    calls,
    client: {
      call: (async (
        module: string,
        method: string,
        _params?: unknown,
        opts?: unknown,
      ) => {
        calls.push({ module, method, opts });
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

function fetchersFor(responses: Record<string, unknown>) {
  const { client, calls } = fakeClient(responses);
  return { fetchers: createMetadataFetchers(client), calls };
}

// Synthetic ids everywhere: UUID-style, invented, never copied from a CRM.
const PROCESS_A = "aaaa1111-2222-3333-4444-55556666zz01";
const PROCESS_B = "bbbb1111-2222-3333-4444-55556666zz02";
const STAGE_A1 = "cccc1111-2222-3333-4444-55556666zz03";
const STAGE_A2 = "dddd1111-2222-3333-4444-55556666zz04";
const STEP_A1 = "eeee1111-2222-3333-4444-55556666zz05";
const STEP_A2 = "ffff1111-2222-3333-4444-55556666zz06";
const STAGE_B1 = "aaab1111-2222-3333-4444-55556666zz07";

describe("processes mapper", () => {
  test("maps ids from keys, nests stages and steps, preserves upstream order", async () => {
    const { fetchers } = fetchersFor({
      "Deal/process_getList": {
        [PROCESS_A]: {
          name: "Synthetic Process A",
          main_stages: {
            [STAGE_A1]: {
              name: "Synthetic Stage One",
              stages: {
                [STEP_A1]: { name: "Synthetic Step One" },
                [STEP_A2]: { name: "Synthetic Step Two" },
              },
            },
            [STAGE_A2]: { name: "Synthetic Stage Two", stages: [] },
          },
        },
        [PROCESS_B]: {
          name: "Synthetic Process B",
          main_stages: {
            [STAGE_B1]: { name: "Synthetic Stage Three" },
          },
        },
      },
    });

    const processes = await fetchers.processes();

    expect(processes).toEqual([
      {
        id: PROCESS_A,
        name: "Synthetic Process A",
        stages: [
          {
            id: STAGE_A1,
            name: "Synthetic Stage One",
            steps: [
              { id: STEP_A1, name: "Synthetic Step One" },
              { id: STEP_A2, name: "Synthetic Step Two" },
            ],
          },
          { id: STAGE_A2, name: "Synthetic Stage Two", steps: [] },
        ],
      },
      {
        id: PROCESS_B,
        name: "Synthetic Process B",
        stages: [{ id: STAGE_B1, name: "Synthetic Stage Three", steps: [] }],
      },
    ]);
    expect(processes.map((p) => p.id)).toEqual([PROCESS_A, PROCESS_B]);
  });

  test("main_stages serialized as an empty PHP array yields no stages", async () => {
    const { fetchers } = fetchersFor({
      "Deal/process_getList": {
        [PROCESS_A]: { name: "Synthetic Process A", main_stages: [] },
      },
    });

    expect(await fetchers.processes()).toEqual([
      { id: PROCESS_A, name: "Synthetic Process A", stages: [] },
    ]);
  });

  test("an empty process list maps to an empty array", async () => {
    const { fetchers } = fetchersFor({ "Deal/process_getList": [] });
    expect(await fetchers.processes()).toEqual([]);
  });
});

describe("users mapper", () => {
  test("maps teams, roles and name fallbacks, skipping id-less elements", async () => {
    const { fetchers } = fetchersFor({
      "Default/User_getAll": [
        {
          id: "user-synthetic-1",
          name: "Synthetic User One",
          email: "one@synthetic.example",
          structures: [
            {
              id: "team-synthetic-1",
              name: "Synthetic Team",
              roles: [{ id: "role-synthetic-1", name: "Synthetic Role" }],
            },
            { id: "team-synthetic-2", name: "Synthetic Team Two" },
            { name: "Synthetic Team Without Id" },
          ],
        },
        {
          id: 42,
          name: null,
          firstname: "Synthetic",
          lastname: "Two",
          email: "two@synthetic.example",
        },
        { name: "Synthetic Ghost", email: "ghost@synthetic.example" },
      ],
    });

    expect(await fetchers.users()).toEqual([
      {
        id: "user-synthetic-1",
        name: "Synthetic User One",
        email: "one@synthetic.example",
        teams: [
          { id: "team-synthetic-1", name: "Synthetic Team", roles: ["Synthetic Role"] },
          { id: "team-synthetic-2", name: "Synthetic Team Two", roles: [] },
        ],
      },
      {
        id: "42",
        name: "Synthetic Two",
        email: "two@synthetic.example",
        teams: [],
      },
    ]);
  });

  test("an empty user list maps to an empty array", async () => {
    const { fetchers } = fetchersFor({ "Default/User_getAll": [] });
    expect(await fetchers.users()).toEqual([]);
  });

  test("a record where an array was expected fails cleanly", async () => {
    const { fetchers } = fetchersFor({
      "Default/User_getAll": { "user-synthetic-1": "Synthetic User One" },
    });

    await expect(fetchers.users()).rejects.toThrow(LivespaceError);
    await expect(fetchers.users()).rejects.toThrow(UNEXPECTED_SHAPE);
  });
});

describe("record-shaped dictionaries", () => {
  test("contactGroups maps a record in upstream order", async () => {
    const { fetchers } = fetchersFor({
      "Contact/getGroupList": {
        "grp-synthetic-2": "Synthetic Zeta Group",
        "grp-synthetic-1": "Synthetic Alpha Group",
      },
    });

    expect(await fetchers.contactGroups()).toEqual([
      { id: "grp-synthetic-2", name: "Synthetic Zeta Group" },
      { id: "grp-synthetic-1", name: "Synthetic Alpha Group" },
    ]);
  });

  test("contactGroups tolerates the PHP empty-array form", async () => {
    const { fetchers } = fetchersFor({ "Contact/getGroupList": [] });
    expect(await fetchers.contactGroups()).toEqual([]);
  });

  test("contactGroups rejects a non-empty array with fixed wording only", async () => {
    const { fetchers } = fetchersFor({
      "Contact/getGroupList": ["Synthetic Group Name"],
    });

    const error = await fetchers.contactGroups().then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(LivespaceError);
    const livespaceError = error as LivespaceError;
    expect(livespaceError.code).toBe("UPSTREAM_ERROR");
    // Exact string: no upstream content is ever interpolated into the message.
    expect(livespaceError.message).toBe(UNEXPECTED_SHAPE);
    expect(livespaceError.hint).toBe(
      "Report it on the issue tracker; the API may have changed.",
    );
  });

  test("taskTypes and taskStatuses preserve upstream order, never alphabetical", async () => {
    const { fetchers } = fetchersFor({
      "Todo/getTypes": {
        "type-synthetic-1": "Synthetic Zebra Type",
        "type-synthetic-2": "Synthetic Alpha Type",
        "type-synthetic-3": "Synthetic Middle Type",
      },
      "Todo/getStatuses": {
        "status-synthetic-1": "Synthetic Open",
        "status-synthetic-2": "Synthetic Done",
        "status-synthetic-3": "Synthetic Aborted",
      },
    });

    expect((await fetchers.taskTypes()).map((t) => t.name)).toEqual([
      "Synthetic Zebra Type",
      "Synthetic Alpha Type",
      "Synthetic Middle Type",
    ]);
    expect(await fetchers.taskStatuses()).toEqual([
      { id: "status-synthetic-1", name: "Synthetic Open" },
      { id: "status-synthetic-2", name: "Synthetic Done" },
      { id: "status-synthetic-3", name: "Synthetic Aborted" },
    ]);
  });
});

describe("dealGroups tolerant mapper", () => {
  test("the PHP empty-array form maps to an empty array", async () => {
    const { fetchers } = fetchersFor({ "Deal/getGroupList": [] });
    expect(await fetchers.dealGroups()).toEqual([]);
  });

  test("the record form maps like the contact variant", async () => {
    const { fetchers } = fetchersFor({
      "Deal/getGroupList": {
        "dgrp-synthetic-1": "Synthetic Deal Group One",
        "dgrp-synthetic-2": "Synthetic Deal Group Two",
      },
    });

    expect(await fetchers.dealGroups()).toEqual([
      { id: "dgrp-synthetic-1", name: "Synthetic Deal Group One" },
      { id: "dgrp-synthetic-2", name: "Synthetic Deal Group Two" },
    ]);
  });

  test("the object-array form maps too, skipping id-less elements", async () => {
    const { fetchers } = fetchersFor({
      "Deal/getGroupList": [
        { id: "grp-synthetic-1", name: "Synthetic Group" },
        { name: "Synthetic Group Without Id" },
      ],
    });

    expect(await fetchers.dealGroups()).toEqual([
      { id: "grp-synthetic-1", name: "Synthetic Group" },
    ]);
  });

  test("a record of objects is an unknown shape", async () => {
    const { fetchers } = fetchersFor({
      "Deal/getGroupList": {
        "dgrp-synthetic-1": { name: "Synthetic Deal Group One" },
      },
    });

    const error = await fetchers.dealGroups().then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect((error as LivespaceError).code).toBe("UPSTREAM_ERROR");
    expect((error as LivespaceError).message).toBe(UNEXPECTED_SHAPE);
  });
});

describe("sources mapper", () => {
  test("passes strings through in order and drops non-strings", async () => {
    const { fetchers } = fetchersFor({
      "Default/getSourceList": [
        "Synthetic Referral",
        42,
        "Synthetic Cold Call",
        null,
      ],
    });

    expect(await fetchers.sources()).toEqual([
      "Synthetic Referral",
      "Synthetic Cold Call",
    ]);
  });

  test("an empty list maps to an empty array", async () => {
    const { fetchers } = fetchersFor({ "Default/getSourceList": [] });
    expect(await fetchers.sources()).toEqual([]);
  });

  test("a record here is an unknown shape", async () => {
    const { fetchers } = fetchersFor({
      "Default/getSourceList": { "src-synthetic-1": "Synthetic Referral" },
    });

    const error = await fetchers.sources().then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect((error as LivespaceError).code).toBe("UPSTREAM_ERROR");
    expect((error as LivespaceError).message).toBe(UNEXPECTED_SHAPE);
  });
});

describe("products mapper", () => {
  test("unwraps the array form and keeps the price as a string", async () => {
    const { fetchers } = fetchersFor({
      "Deal/product_getAll": {
        product: [
          {
            id: "prod-synthetic-1",
            name: "Synthetic Product One",
            sku: "SYNTH-001",
            default_price: "2500.00",
            change_price_by_user: true,
          },
          { id: "prod-synthetic-2", name: "Synthetic Product Two" },
          { name: "Synthetic Product Without Id" },
          { id: null, name: "Synthetic Null Id" },
        ],
      },
    });

    expect(await fetchers.products()).toEqual([
      {
        id: "prod-synthetic-1",
        name: "Synthetic Product One",
        sku: "SYNTH-001",
        defaultPrice: "2500.00",
      },
      {
        id: "prod-synthetic-2",
        name: "Synthetic Product Two",
        sku: "",
        defaultPrice: "",
      },
    ]);
  });

  test("unwraps the keyed-record PHP form", async () => {
    const { fetchers } = fetchersFor({
      "Deal/product_getAll": {
        product: {
          k1: {
            id: "prod-synthetic-1",
            name: "Synthetic Product One",
            sku: "SYNTH-001",
            default_price: "10.00",
          },
          k2: {
            id: "prod-synthetic-2",
            name: "Synthetic Product Two",
            sku: "SYNTH-002",
            default_price: "20.00",
          },
        },
      },
    });

    expect((await fetchers.products()).map((p) => p.id)).toEqual([
      "prod-synthetic-1",
      "prod-synthetic-2",
    ]);
  });

  test("empty and wrapper-less payloads map to an empty array", async () => {
    for (const canned of [[], {}, { product: [] }]) {
      const { fetchers } = fetchersFor({ "Deal/product_getAll": canned });
      expect(await fetchers.products()).toEqual([]);
    }
  });

  test("an unusable product wrapper is an unknown shape", async () => {
    const { fetchers } = fetchersFor({
      "Deal/product_getAll": { product: "Synthetic Product One" },
    });

    const error = await fetchers.products().then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect((error as LivespaceError).message).toBe(UNEXPECTED_SHAPE);
  });
});

describe("currentUser mapper", () => {
  const info = {
    login: "synthetic.user",
    email: "one@synthetic.example",
    firstname: "Synthetic",
    lastname: "User",
    name: "Synthetic User One",
    position: "Synthetic Position",
    app_settings: {
      has_spaces: true,
      permission: { contact_add: true, deal_add: false },
    },
    structures: [
      {
        id: "team-synthetic-1",
        name: "Synthetic Team",
        roles: [{ id: "role-synthetic-1", name: "Synthetic Role" }],
      },
    ],
  };

  const users = [
    { id: "user-synthetic-9", name: "Synthetic Other", email: "other@synthetic.example" },
    { id: "user-synthetic-1", name: "Synthetic User One", email: "one@synthetic.example" },
  ];

  test("resolves the id by exact email match against the user list", async () => {
    const { fetchers } = fetchersFor({
      "Default/User_getInfo": info,
      "Default/User_getAll": users,
    });

    expect(await fetchers.currentUser()).toEqual({
      id: "user-synthetic-1",
      name: "Synthetic User One",
      email: "one@synthetic.example",
      position: "Synthetic Position",
      permissions: { contact_add: true, deal_add: false },
      teams: [
        { id: "team-synthetic-1", name: "Synthetic Team", roles: ["Synthetic Role"] },
      ],
    });
  });

  test("no email match leaves the id null", async () => {
    const { fetchers } = fetchersFor({
      "Default/User_getInfo": info,
      "Default/User_getAll": [users[0]],
    });

    expect((await fetchers.currentUser()).id).toBeNull();
  });

  test("a failing user list still yields the current user with a null id", async () => {
    const { fetchers } = fetchersFor({
      "Default/User_getInfo": info,
      "Default/User_getAll": new LivespaceError(
        "PERMISSION_DENIED",
        "The API key's user lacks permission for this record or action (540).",
        "Use a record the key's user can access.",
        540,
      ),
    });

    const current = await fetchers.currentUser();
    expect(current.id).toBeNull();
    expect(current.name).toBe("Synthetic User One");
  });

  test("normalizes permission values and skips unrecognized ones", async () => {
    const { fetchers } = fetchersFor({
      "Default/User_getInfo": {
        ...info,
        app_settings: {
          permission: {
            a: true,
            b: false,
            c: 1,
            d: 0,
            e: "1",
            f: "0",
            g: "weird",
          },
        },
      },
      "Default/User_getAll": users,
    });

    expect((await fetchers.currentUser()).permissions).toEqual({
      a: true,
      b: false,
      c: true,
      d: false,
      e: true,
      f: false,
    });
  });

  test("absent app_settings yields no permissions", async () => {
    const { fetchers } = fetchersFor({
      "Default/User_getInfo": { name: "Synthetic User One", email: "one@synthetic.example" },
      "Default/User_getAll": users,
    });

    const current = await fetchers.currentUser();
    expect(current.permissions).toEqual({});
    expect(current.position).toBe("");
    expect(current.teams).toEqual([]);
  });
});

describe("endpoint table", () => {
  const allResponses: Record<string, unknown> = {
    "Deal/process_getList": {},
    "Default/User_getAll": [],
    "Contact/getGroupList": {},
    "Deal/getGroupList": [],
    "Default/getSourceList": [],
    "Todo/getTypes": {},
    "Todo/getStatuses": {},
    "Deal/product_getAll": {},
    "Default/User_getInfo": {},
  };

  const expected: Array<[MetadataSection, Array<[string, string]>]> = [
    ["processes", [["Deal", "process_getList"]]],
    ["users", [["Default", "User_getAll"]]],
    ["contactGroups", [["Contact", "getGroupList"]]],
    ["dealGroups", [["Deal", "getGroupList"]]],
    ["sources", [["Default", "getSourceList"]]],
    ["taskTypes", [["Todo", "getTypes"]]],
    ["taskStatuses", [["Todo", "getStatuses"]]],
    ["products", [["Deal", "product_getAll"]]],
    [
      "currentUser",
      [
        ["Default", "User_getInfo"],
        ["Default", "User_getAll"],
      ],
    ],
  ];

  test("the table covers every declared section", () => {
    expect(expected.map(([section]) => section)).toEqual([...METADATA_SECTIONS]);
  });

  for (const [section, endpoints] of expected) {
    test(`${section} calls the documented endpoints and forwards the signal`, async () => {
      const { fetchers, calls } = fetchersFor(allResponses);
      const signal = new AbortController().signal;

      await fetchers[section]({ signal });

      const seen = calls.map(({ module, method }) => [module, method]);
      expect(seen.sort()).toEqual([...endpoints].sort());
      for (const call of calls) {
        expect((call.opts as { signal?: AbortSignal }).signal).toBe(signal);
      }
    });
  }
});

describe("error propagation", () => {
  const permissionDenied = new LivespaceError(
    "PERMISSION_DENIED",
    "The API key's user lacks permission for this record or action (540).",
    "Use a record the key's user can access.",
    540,
  );

  for (const section of ["users", "taskTypes"] as const) {
    test(`${section} rejects with the client error unchanged`, async () => {
      const { fetchers } = fetchersFor({
        "Default/User_getAll": permissionDenied,
        "Todo/getTypes": permissionDenied,
      });

      const error = await fetchers[section]().then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBe(permissionDenied);
      expect((error as LivespaceError).code).toBe("PERMISSION_DENIED");
      expect((error as LivespaceError).hint).toBe(
        "Use a record the key's user can access.",
      );
      expect((error as LivespaceError).resultCode).toBe(540);
    });
  }
});
