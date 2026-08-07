import { describe, expect, test } from "bun:test";
import {
  isInputRequiredResult,
  type InputRequiredResult,
  type RequestStateCodec,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { errorFromEnvelope, LivespaceError } from "../../src/livespace/errors.js";
import type { ProcessInfo } from "../../src/livespace/metadata.js";
import type { RecordFetchers, RecordKind } from "../../src/livespace/records.js";
import type {
  CompanyWrite,
  DealWrite,
  PersonWrite,
  RecordPointer,
  TaskWrite,
  WriteFetchers,
} from "../../src/livespace/writes.js";
import {
  createRecordsToolConfig,
  runCreateRecords,
  type CreateRecordsArgs,
  type CreateRecordsDeps,
  type CreateRecordsResult,
} from "../../src/server/tools/create-records.js";
import type { MetadataService } from "../../src/server/tools/crm-metadata.js";
import type { ToolError, ToolRunResult } from "../../src/server/tools/tool-error.js";
import {
  PLAN_BUDGET_EXPIRED,
  WRITE_BUDGET_MS,
  type WriteState,
} from "../../src/server/tools/write-support.js";
import { company, deal, person, task } from "../support/records.js";

/**
 * `create_records` against fakes. Every value below is invented: no CRM data,
 * no sandbox values, and no call leaves the process (AGENTS.md).
 *
 * The marker below stands in for a CRM-authored name. It may live in
 * `structuredContent`, where the schema types it as data, and must never reach
 * the text channel or an approval prompt (docs/security.md par. 4).
 */
const NAME_MARKER = "synthetic-name-marker";

/** The same idea for an upstream response body, which may never travel at all. */
const ENVELOPE_MARKER = "synthetic-envelope-marker";

/** The literal envelope key, spelled out so a rename upstream fails loudly. */
const CAPS_KEY = "io.modelcontextprotocol/clientCapabilities";

const PROCESS_ID = "process-synthetic-501";

const PROCESSES: ProcessInfo[] = [
  { id: PROCESS_ID, name: "Synthetic Process", stages: [] },
];

const VALIDATION_420: ToolError = {
  code: "VALIDATION_ERROR",
  message: "Livespace rejected the request as invalid (420).",
  hint: "One or more field values are invalid for this method. Fix them and retry.",
};

const RATE_LIMITED = new LivespaceError(
  "RATE_LIMITED",
  "Livespace rate-limited the request (HTTP 429).",
  "Wait before retrying; reduce request frequency if it persists.",
);

type Answer<T> = T | LivespaceError;

interface Canning {
  createPerson?: (call: number, input: PersonWrite) => Answer<string>;
  createCompany?: (call: number, input: CompanyWrite) => Answer<string>;
  createDeal?: (call: number, input: DealWrite) => Answer<string>;
  createTask?: (call: number, input: TaskWrite) => Answer<string>;
  findPerson?: (email: string, call: number) => Answer<RecordPointer | null>;
  findCompany?: (name: string, call: number) => Answer<RecordPointer | null>;
  /** Re-read answers, keyed `kind:id`. An Error value is thrown. */
  records?: Record<string, unknown>;
  processes?: ProcessInfo[] | LivespaceError;
}

interface Recorded {
  method: string;
  input: unknown;
  opts: unknown;
}

function unwrap<T>(value: Answer<T>): T {
  if (value instanceof LivespaceError) throw value;
  return value;
}

/**
 * The fakes implement exactly the fetchers `create_records` may touch and
 * RECORD every call. The update, note and call fetchers throw: a create tool
 * that reaches for them is a bug, not a passing test.
 */
function fakeWorld(canned: Canning = {}) {
  const calls: Recorded[] = [];
  const push = (method: string, input: unknown, opts: unknown): number => {
    const call = calls.filter((entry) => entry.method === method).length;
    calls.push({ method, input, opts });
    return call;
  };
  const never =
    (method: string) =>
    async (): Promise<never> => {
      throw new Error(`create_records must never call ${method}`);
    };

  const writes = {
    createPerson: async (input: PersonWrite, opts?: unknown) => {
      const call = push("createPerson", input, opts);
      return {
        id: unwrap(canned.createPerson?.(call, input) ?? `person-synthetic-90${call + 1}`),
      };
    },
    createCompany: async (input: CompanyWrite, opts?: unknown) => {
      const call = push("createCompany", input, opts);
      return {
        id: unwrap(canned.createCompany?.(call, input) ?? `company-synthetic-90${call + 1}`),
      };
    },
    createDeal: async (input: DealWrite, opts?: unknown) => {
      const call = push("createDeal", input, opts);
      return {
        id: unwrap(canned.createDeal?.(call, input) ?? `deal-synthetic-90${call + 1}`),
      };
    },
    createTask: async (input: TaskWrite, opts?: unknown) => {
      const call = push("createTask", input, opts);
      return {
        id: unwrap(canned.createTask?.(call, input) ?? `task-synthetic-90${call + 1}`),
      };
    },
    findPersonByEmail: async (email: string, opts?: unknown) => {
      const call = push("findPersonByEmail", email, opts);
      return unwrap(canned.findPerson?.(email, call) ?? null);
    },
    findCompanyByName: async (name: string, opts?: unknown) => {
      const call = push("findCompanyByName", name, opts);
      return unwrap(canned.findCompany?.(name, call) ?? null);
    },
    updatePerson: never("updatePerson"),
    updateCompany: never("updateCompany"),
    updateDeal: never("updateDeal"),
    updateTask: never("updateTask"),
    addNote: never("addNote"),
    addCall: never("addCall"),
  } as unknown as WriteFetchers;

  const records = {
    getRecord: async (kind: RecordKind, id: string, opts?: unknown) => {
      push("getRecord", `${kind}:${id}`, opts);
      const answer = canned.records?.[`${kind}:${id}`];
      if (answer instanceof Error) throw answer;
      return answer ?? null;
    },
  } as unknown as RecordFetchers;

  const metadata = {
    get: async (section: string, opts?: unknown) => {
      push("metadata", section, opts);
      const processes = canned.processes ?? PROCESSES;
      if (processes instanceof LivespaceError) throw processes;
      return { data: processes, asOf: 1000, stale: false };
    },
  } as unknown as MetadataService;

  const minted: WriteState[] = [];
  const codec = {
    mint: async (payload: WriteState) => {
      minted.push(payload);
      return `synthetic-wire-${minted.length}`;
    },
    verify: async () => {
      throw new Error("verify belongs to the SDK seam, not to the tool");
    },
  } as unknown as RequestStateCodec<WriteState>;

  const deps: CreateRecordsDeps = { writes, records, metadata, codec };
  const inputs = (method: string): unknown[] =>
    calls.filter((entry) => entry.method === method).map((entry) => entry.input);
  const count = (method: string): number => inputs(method).length;
  const methods = (): string[] => calls.map((entry) => entry.method);
  return { deps, calls, minted, inputs, count, methods };
}

type World = ReturnType<typeof fakeWorld>;

interface CtxOptions {
  elicitation?: boolean;
  state?: WriteState;
  /** `true`/`false` are accepted answers; "decline" is a dismissed prompt. */
  confirm?: boolean | "decline";
}

function ctx(options: CtxOptions = {}): unknown {
  const responses =
    options.confirm === undefined
      ? undefined
      : options.confirm === "decline"
        ? { confirm: { action: "decline" } }
        : { confirm: { action: "accept", content: { confirm: options.confirm } } };
  return {
    mcpReq: {
      method: "tools/call",
      envelope: options.elicitation === true ? { [CAPS_KEY]: { elicitation: {} } } : {},
      ...(responses === undefined ? {} : { inputResponses: responses }),
      requestState: () => options.state,
    },
  };
}

function run(
  world: World,
  args: CreateRecordsArgs,
  opts: {
    signal?: AbortSignal;
    ctx?: unknown;
    allowUnboundWriteConfirmation?: boolean;
  } = {},
): Promise<CreateRecordsResult> {
  return runCreateRecords(world.deps, args, {
    allowUnboundWriteConfirmation: true,
    ...opts,
  });
}

function asRun(result: CreateRecordsResult): ToolRunResult {
  if (isInputRequiredResult(result)) {
    throw new Error("expected a tool result, got an input-required result");
  }
  return result;
}

function asInputRequired(result: CreateRecordsResult): InputRequiredResult {
  if (!isInputRequiredResult(result)) {
    throw new Error("expected an input-required result");
  }
  return result;
}

function planOf(result: ToolRunResult): Record<string, unknown>[] {
  return result.structured["plan"] as Record<string, unknown>[];
}

function resultsOf(result: ToolRunResult): Record<string, unknown>[] {
  return result.structured["results"] as Record<string, unknown>[];
}

function errorsOf(result: ToolRunResult): ToolError[] {
  return result.structured["errors"] as ToolError[];
}

function statusesOf(result: ToolRunResult): unknown[] {
  return resultsOf(result).map((entry) => entry["status"]);
}

/** Every answer the tool returns must validate against its own output schema. */
function expectPayload(result: ToolRunResult): void {
  const parsed = createRecordsToolConfig.outputSchema.safeParse(result.structured);
  expect(parsed.success).toBe(true);
  expect(parsed.data as Record<string, unknown>).toEqual(result.structured);
}

function elicitationMessageOf(result: InputRequiredResult): string {
  const requests = result.inputRequests as Record<string, { params: { message: string } }>;
  return requests["confirm"]?.params.message as string;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

/**
 * A clock that sits past the budget from its THIRD read on: read #1 mints the
 * deadline, read #2 is the first item's own check, and every check after that
 * finds the budget spent.
 */
async function budgetSpentAfterFirstItem<T>(scenario: () => Promise<T>): Promise<T> {
  const realNow = Date.now;
  const base = realNow();
  let reads = 0;
  Date.now = (): number => {
    reads += 1;
    return reads <= 2 ? base : base + WRITE_BUDGET_MS + 1_000;
  };
  try {
    return await scenario();
  } finally {
    Date.now = realNow;
  }
}

function personArg(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    firstname: "Synthetic",
    lastname: "Person One",
    emails: ["person.one@synthetic.example"],
    ...overrides,
  };
}

function args(value: Record<string, unknown>): CreateRecordsArgs {
  return value as unknown as CreateRecordsArgs;
}

/** Round one asks the human, round two carries the minted state back. */
async function twoRounds(world: World, call: CreateRecordsArgs): Promise<ToolRunResult> {
  const first = await run(world, call, { ctx: ctx({ elicitation: true }) });
  asInputRequired(first);
  const state = world.minted[0] as WriteState;
  return asRun(
    await run(world, call, { ctx: ctx({ elicitation: true, state, confirm: true }) }),
  );
}

describe("createRecordsToolConfig", () => {
  test("the annotations declare an honest, non-destructive write", () => {
    expect(createRecordsToolConfig.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  test("the input schema is a plain object at the JSON Schema root", () => {
    const json = z.toJSONSchema(createRecordsToolConfig.inputSchema) as Record<
      string,
      unknown
    >;
    expect(json["type"]).toBe("object");
    expect(json["oneOf"]).toBeUndefined();
  });

  test("the description names the batch cap and the confirmation flow", () => {
    const description = createRecordsToolConfig.description.replace(/\s+/gu, " ");
    expect(description).toContain("10 items per call");
    expect(description).toContain("confirm: true");
    expect(description).toContain("allowDuplicate");
  });
});

describe("the input schema", () => {
  const parse = (value: unknown): boolean =>
    createRecordsToolConfig.inputSchema.safeParse(value).success;

  test("the root object is strict", () => {
    expect(parse({ persons: [personArg()] })).toBe(true);
    expect(parse({ persons: [personArg()], notes: [] })).toBe(false);
  });

  test("an item may not carry an undeclared key", () => {
    expect(parse({ persons: [personArg({ tags: ["alpha"] })] })).toBe(false);
  });

  test("ten items in one array are accepted and eleven are not", () => {
    const ten = Array.from({ length: 10 }, () => personArg());
    expect(parse({ persons: ten })).toBe(true);
    expect(parse({ persons: [...ten, personArg()] })).toBe(false);
  });

  test("the per-array cap does not add up: the runner owns the total", () => {
    // Six plus five is eleven records and passes the schema; only the runner
    // sees the whole call.
    expect(
      parse({
        persons: Array.from({ length: 6 }, () => personArg()),
        companies: Array.from({ length: 5 }, () => ({ name: "Synthetic Company" })),
      }),
    ).toBe(true);
  });

  test("person bounds are enforced", () => {
    expect(parse({ persons: [personArg({ firstname: "" })] })).toBe(false);
    expect(parse({ persons: [personArg({ firstname: "x".repeat(201) })] })).toBe(false);
    expect(parse({ persons: [personArg({ lastname: "x".repeat(201) })] })).toBe(false);
    expect(parse({ persons: [personArg({ emails: ["ab"] })] })).toBe(false);
    expect(parse({ persons: [personArg({ emails: [`${"x".repeat(321)}`] })] })).toBe(false);
    expect(
      parse({
        persons: [
          personArg({
            emails: Array.from({ length: 6 }, (_, i) => `p${i}@synthetic.example`),
          }),
        ],
      }),
    ).toBe(false);
    expect(parse({ persons: [personArg({ phones: ["12"] })] })).toBe(false);
    expect(parse({ persons: [personArg({ note: "x".repeat(5001) })] })).toBe(false);
    expect(parse({ persons: [personArg({ companyId: "" })] })).toBe(false);
  });

  test("company and deal bounds are enforced", () => {
    expect(parse({ companies: [{ name: "" }] })).toBe(false);
    expect(parse({ companies: [{ name: "Synthetic", nip: "1".repeat(21) }] })).toBe(false);
    const line = { productName: "Synthetic Line", price: 10, amount: 1 };
    expect(
      parse({ deals: [{ name: "Synthetic Deal", companyId: "c1", budget: [line] }] }),
    ).toBe(true);
    expect(
      parse({
        deals: [
          {
            name: "Synthetic Deal",
            companyId: "c1",
            budget: Array.from({ length: 21 }, () => line),
          },
        ],
      }),
    ).toBe(false);
    expect(
      parse({
        deals: [
          { name: "Synthetic Deal", companyId: "c1", budget: [{ ...line, price: Infinity }] },
        ],
      }),
    ).toBe(false);
    expect(
      parse({
        deals: [{ name: "Synthetic Deal", companyId: "c1", budget: [{ ...line, amount: 0 }] }],
      }),
    ).toBe(false);
    expect(
      parse({
        deals: [
          {
            name: "Synthetic Deal",
            companyId: "c1",
            budget: [{ ...line, amount: 100_001 }],
          },
        ],
      }),
    ).toBe(false);
  });

  test("the task date takes a day or a timestamp and nothing else", () => {
    const accepted = ["2026-09-26", "2026-09-26 10:00", "2026-09-26 10:00:00"];
    for (const date of accepted) {
      expect(parse({ tasks: [{ title: "Synthetic Task", date }] })).toBe(true);
    }
    const refused = ["2026-9-6", "2026-09-26T10:00:00", "26-09-2026", "2026-09-26 10"];
    for (const date of refused) {
      expect(parse({ tasks: [{ title: "Synthetic Task", date }] })).toBe(false);
    }
  });
});

describe("argument rules", () => {
  test("a call with no items is refused", async () => {
    const world = fakeWorld();
    const result = asRun(await run(world, args({})));

    expect(result.isError).toBe(true);
    expect(result.text).toBe("create_records failed: BAD_PARAMS.");
    expect(errorsOf(result)[0]?.code).toBe("BAD_PARAMS");
    expect(world.calls).toEqual([]);
    expectPayload(result);
  });

  test("more than ten records across the four arrays is refused", async () => {
    const world = fakeWorld();
    const result = asRun(
      await run(
        world,
        args({
          persons: Array.from({ length: 6 }, () => personArg()),
          companies: Array.from({ length: 5 }, () => ({ name: "Synthetic Company" })),
        }),
      ),
    );

    expect(errorsOf(result)[0]?.code).toBe("BAD_PARAMS");
    expect(errorsOf(result)[0]?.hint).toContain("10");
    expect(world.calls).toEqual([]);
  });

  test("a deal needs exactly one of companyId and contactId", async () => {
    const world = fakeWorld();
    const both = asRun(
      await run(
        world,
        args({
          deals: [{ name: "Synthetic Deal", companyId: "c1", contactId: "p1" }],
        }),
      ),
    );
    const neither = asRun(await run(world, args({ deals: [{ name: "Synthetic Deal" }] })));

    expect(errorsOf(both)[0]?.code).toBe("BAD_PARAMS");
    expect(errorsOf(neither)[0]?.code).toBe("BAD_PARAMS");
    expect(world.calls).toEqual([]);
  });

  test("a budget line names exactly one product key", async () => {
    const world = fakeWorld();
    const both = asRun(
      await run(
        world,
        args({
          deals: [
            {
              name: "Synthetic Deal",
              companyId: "c1",
              budget: [
                { productId: "prod-1", productName: "Synthetic Line", price: 1, amount: 1 },
              ],
            },
          ],
        }),
      ),
    );
    const neither = asRun(
      await run(
        world,
        args({
          deals: [
            { name: "Synthetic Deal", companyId: "c1", budget: [{ price: 1, amount: 1 }] },
          ],
        }),
      ),
    );

    expect(errorsOf(both)[0]?.code).toBe("BAD_PARAMS");
    expect(errorsOf(neither)[0]?.code).toBe("BAD_PARAMS");
    expect(world.calls).toEqual([]);
  });

  test("a task date that is not a real day is refused", async () => {
    const world = fakeWorld();
    const result = asRun(
      await run(world, args({ tasks: [{ title: "Synthetic Task", date: "2026-02-31" }] })),
    );

    expect(errorsOf(result)[0]?.code).toBe("BAD_PARAMS");
    expect(world.calls).toEqual([]);
  });

  test("a task date outside the supported years is refused", async () => {
    const world = fakeWorld();
    const result = asRun(
      await run(world, args({ tasks: [{ title: "Synthetic Task", date: "1899-12-31" }] })),
    );

    expect(errorsOf(result)[0]?.code).toBe("BAD_PARAMS");
    expect(world.calls).toEqual([]);
  });

  test("an unknown processId is a NOT_FOUND that fetches nothing else", async () => {
    const world = fakeWorld();
    const result = asRun(
      await run(
        world,
        args({
          persons: [personArg()],
          deals: [
            { name: "Synthetic Deal", companyId: "c1", processId: "process-synthetic-none" },
          ],
        }),
      ),
    );

    expect(result.isError).toBe(true);
    expect(errorsOf(result)[0]).toEqual({
      code: "NOT_FOUND",
      message: "Process not found.",
      hint: 'Call crm_metadata (sections: ["processes"]) for valid process ids.',
    });
    // The dictionary was consulted; nothing else was.
    expect(world.methods()).toEqual(["metadata"]);
    expect(world.inputs("metadata")).toEqual(["processes"]);
    expectPayload(result);
  });

  test("a deal without a processId never reads the dictionary", async () => {
    const world = fakeWorld();
    await run(world, args({ deals: [{ name: "Synthetic Deal", companyId: "c1" }] }));

    expect(world.count("metadata")).toBe(0);
  });
});

describe("dedupe", () => {
  test("every e-mail is checked, normalized, and the first hit decides", async () => {
    const world = fakeWorld({
      findPerson: (email) =>
        email === "second@synthetic.example"
          ? { id: "person-synthetic-777", name: "Synthetic Person" }
          : null,
    });

    const result = asRun(
      await run(
        world,
        args({
          persons: [
            personArg({ emails: ["First@Synthetic.Example", " second@synthetic.example "] }),
          ],
        }),
      ),
    );

    expect(world.inputs("findPersonByEmail")).toEqual([
      "first@synthetic.example",
      "second@synthetic.example",
    ]);
    expect(planOf(result)[0]).toEqual({
      index: 0,
      action: "create_person",
      kind: "person",
      status: "skipped_duplicate",
      summary: {
        firstname: "Synthetic",
        lastname: "Person One",
        emails: ["First@Synthetic.Example", "second@synthetic.example"],
      },
      dedupe: { existingId: "person-synthetic-777" },
    });
  });

  test("a later item sharing an e-mail with an earlier one is skipped", async () => {
    const world = fakeWorld({
      createPerson: () => "person-synthetic-901",
      records: { "person:person-synthetic-901": person({ id: "person-synthetic-901" }) },
    });

    const result = asRun(
      await run(
        world,
        args({
          persons: [
            personArg({ emails: ["Dup@Synthetic.Example"] }),
            personArg({ firstname: "Second", emails: ["dup@synthetic.example"] }),
          ],
          confirm: true,
        }),
      ),
    );

    // One lookup only: the second item's identity was already claimed.
    expect(world.inputs("findPersonByEmail")).toEqual(["dup@synthetic.example"]);
    expect(world.count("createPerson")).toBe(1);
    expect(statusesOf(result)).toEqual(["ok", "skipped_duplicate"]);
    // The id is known only after the earlier item was created.
    expect(resultsOf(result)[1]?.["existingId"]).toBe("person-synthetic-901");
    expect(result.text).toBe(
      "create_records: attempted 1 of 2 - ok 1, skipped 1, errors 0, unknown 0, not attempted 0.",
    );
  });

  test("an in-batch duplicate of an item that failed reports no existing id", async () => {
    const world = fakeWorld({ createPerson: () => errorFromEnvelope(420) });

    const result = asRun(
      await run(
        world,
        args({
          persons: [
            personArg({ emails: ["dup@synthetic.example"] }),
            personArg({ firstname: "Second", emails: ["dup@synthetic.example"] }),
          ],
          confirm: true,
        }),
      ),
    );

    expect(statusesOf(result)).toEqual(["error", "skipped_duplicate"]);
    expect(resultsOf(result)[1]?.["existingId"]).toBeUndefined();
    expectPayload(result);
  });

  test("allowDuplicate creates without spending a lookup", async () => {
    const world = fakeWorld({
      findPerson: () => ({ id: "person-synthetic-777", name: "Synthetic Person" }),
      records: { "person:person-synthetic-901": person({ id: "person-synthetic-901" }) },
    });

    const result = asRun(
      await run(
        world,
        args({ persons: [personArg({ allowDuplicate: true })], confirm: true }),
      ),
    );

    expect(world.count("findPersonByEmail")).toBe(0);
    expect(world.count("createPerson")).toBe(1);
    expect(statusesOf(result)).toEqual(["ok"]);
  });

  test("a company matching an existing name is skipped", async () => {
    const world = fakeWorld({
      findCompany: () => ({ id: "company-synthetic-101", name: "Synthetic Company Alpha" }),
    });

    const result = asRun(
      await run(world, args({ companies: [{ name: " synthetic company alpha " }] })),
    );

    expect(world.inputs("findCompanyByName")).toEqual(["synthetic company alpha"]);
    expect(planOf(result)[0]?.["status"]).toBe("skipped_duplicate");
    expect(planOf(result)[0]?.["dedupe"]).toEqual({ existingId: "company-synthetic-101" });
  });

  test("a dedupe lookup that fails blocks the item instead of risking a duplicate", async () => {
    const world = fakeWorld({
      findPerson: () =>
        new LivespaceError(
          "UPSTREAM_ERROR",
          "Livespace reported a general API error (500).",
          "Retry once; if it persists, reduce the request size.",
        ),
    });

    const preview = asRun(await run(world, args({ persons: [personArg()] })));
    expect(planOf(preview)[0]?.["status"]).toBe("blocked");
    expect((planOf(preview)[0]?.["error"] as ToolError).code).toBe("UPSTREAM_ERROR");
    expectPayload(preview);

    const executed = asRun(
      await run(world, args({ persons: [personArg()], confirm: true })),
    );
    expect(world.count("createPerson")).toBe(0);
    expect(statusesOf(executed)).toEqual(["error"]);
    expect(executed.isError).toBe(true);
  });
});

describe("the confirmation flow", () => {
  test("a plain call previews and writes nothing", async () => {
    const world = fakeWorld();

    const result = asRun(
      await run(
        world,
        args({
          persons: [personArg()],
          companies: [{ name: "Synthetic Company Alpha" }],
        }),
      ),
    );

    expect(result.text).toBe(
      "create_records preview: 2 item(s) (1 persons, 1 companies, 0 deals, 0 tasks), 0 duplicate(s) skipped. Re-call with confirm: true to execute.",
    );
    expect(result.structured["requiresConfirmation"]).toBe(true);
    expect(result.structured["results"]).toBeUndefined();
    expect(planOf(result)).toEqual([
      {
        index: 0,
        action: "create_person",
        kind: "person",
        status: "create",
        summary: {
          firstname: "Synthetic",
          lastname: "Person One",
          emails: ["person.one@synthetic.example"],
        },
      },
      {
        index: 1,
        action: "create_company",
        kind: "company",
        status: "create",
        summary: { name: "Synthetic Company Alpha" },
      },
    ]);
    expect(world.count("createPerson")).toBe(0);
    expect(world.count("createCompany")).toBe(0);
    expect(errorsOf(result)).toEqual([]);
    expectPayload(result);
  });

  test("dryRun previews without claiming a confirmation is pending", async () => {
    const world = fakeWorld();

    const result = asRun(await run(world, args({ persons: [personArg()], dryRun: true })));

    expect(result.structured["requiresConfirmation"]).toBeUndefined();
    expect(world.count("createPerson")).toBe(0);
    expectPayload(result);
  });

  test("dryRun and confirm together are refused", async () => {
    const world = fakeWorld();

    const result = asRun(
      await run(world, args({ persons: [personArg()], dryRun: true, confirm: true })),
    );

    expect(errorsOf(result)[0]?.code).toBe("BAD_PARAMS");
    expect(world.calls).toEqual([]);
  });

  test("the arguments hash ignores confirm and dryRun", async () => {
    const world = fakeWorld();
    const capable = { ctx: ctx({ elicitation: true }) };

    await run(world, args({ persons: [personArg()] }), capable);
    await run(world, args({ persons: [personArg()], confirm: true }), capable);

    expect(world.minted).toHaveLength(2);
    expect(world.minted[0]?.argsHash).toBe(world.minted[1]?.argsHash as string);
    expect(world.minted[0]?.jti).not.toBe(world.minted[1]?.jti as string);
  });

  test("an elicitation-capable client is asked before anything is written", async () => {
    const world = fakeWorld({
      findPerson: (email) =>
        email === "dup@synthetic.example"
          ? { id: "person-synthetic-777", name: `Synthetic ${NAME_MARKER}` }
          : null,
    });

    const result = asInputRequired(
      await run(
        world,
        args({
          persons: [personArg(), personArg({ emails: ["dup@synthetic.example"] })],
        }),
        { ctx: ctx({ elicitation: true }) },
      ),
    );

    expect(result.requestState).toBe("synthetic-wire-1");
    expect(elicitationMessageOf(result)).toBe(
      "Create 2 CRM record(s) (2 persons, 0 companies, 0 deals, 0 tasks). 1 duplicate(s) will be skipped. Approve?",
    );
    // The approval string a human reads is ours: counts and kinds only.
    expect(JSON.stringify(result)).not.toContain(NAME_MARKER);
    expect(world.count("createPerson")).toBe(0);
    expect(world.minted[0]).toEqual({
      tool: "create_records",
      argsHash: expect.stringMatching(/^[0-9a-f]{64}$/u) as unknown as string,
      previewDigest: expect.stringMatching(/^[0-9a-f]{64}$/u) as unknown as string,
      jti: expect.stringMatching(/^[0-9a-f]{32}$/u) as unknown as string,
    });
  });

  test("the model cannot self-confirm on an elicitation-capable client", async () => {
    const world = fakeWorld();

    const result = await run(world, args({ persons: [personArg()], confirm: true }), {
      ctx: ctx({ elicitation: true }),
    });

    asInputRequired(result);
    expect(world.count("createPerson")).toBe(0);
  });

  test("a declined confirmation writes nothing and says so", async () => {
    const world = fakeWorld();
    const call = args({ persons: [personArg()] });
    asInputRequired(await run(world, call, { ctx: ctx({ elicitation: true }) }));
    const state = world.minted[0] as WriteState;

    const result = asRun(
      await run(world, call, { ctx: ctx({ elicitation: true, state, confirm: "decline" }) }),
    );

    expect(result.text).toBe(
      [
        "create_records preview: 1 item(s) (1 persons, 0 companies, 0 deals, 0 tasks), 0 duplicate(s) skipped. Re-call with confirm: true to execute.",
        "Confirmation was declined; nothing was written.",
      ].join("\n"),
    );
    expect(result.structured["declined"]).toBe(true);
    expect(world.count("createPerson")).toBe(0);
    expectPayload(result);
  });

  test("an accepted refusal is a decline, not an execute", async () => {
    const world = fakeWorld();
    const call = args({ persons: [personArg()] });
    asInputRequired(await run(world, call, { ctx: ctx({ elicitation: true }) }));
    const state = world.minted[0] as WriteState;

    const result = asRun(
      await run(world, call, { ctx: ctx({ elicitation: true, state, confirm: false }) }),
    );

    expect(result.structured["declined"]).toBe(true);
    expect(world.count("createPerson")).toBe(0);
  });

  test("an accepted confirmation executes the plan exactly once", async () => {
    const world = fakeWorld({
      createPerson: () => "person-synthetic-901",
      records: {
        "person:person-synthetic-901": person({
          id: "person-synthetic-901",
          emails: ["person.one@synthetic.example"],
        }),
      },
    });

    const result = await twoRounds(world, args({ persons: [personArg()] }));

    expect(world.count("createPerson")).toBe(1);
    expect(resultsOf(result)[0]).toEqual({
      index: 0,
      action: "create_person",
      kind: "person",
      status: "ok",
      id: "person-synthetic-901",
      verification: "verified",
    });
    expectPayload(result);
  });

  test("a replayed confirmation is refused and writes nothing", async () => {
    const world = fakeWorld({
      createPerson: () => "person-synthetic-901",
      records: { "person:person-synthetic-901": person({ id: "person-synthetic-901" }) },
    });
    const call = args({ persons: [personArg()] });
    await twoRounds(world, call);
    const state = world.minted[0] as WriteState;

    const replay = asRun(
      await run(world, call, { ctx: ctx({ elicitation: true, state, confirm: true }) }),
    );

    expect(errorsOf(replay)[0]?.code).toBe("BAD_PARAMS");
    expect(world.count("createPerson")).toBe(1);
  });

  test("records changed since the preview are never written blind", async () => {
    let hit = false;
    const world = fakeWorld({
      findPerson: () => (hit ? { id: "person-synthetic-777", name: "Synthetic" } : null),
    });
    const call = args({ persons: [personArg()] });
    asInputRequired(await run(world, call, { ctx: ctx({ elicitation: true }) }));
    const state = world.minted[0] as WriteState;
    // Someone created that person between the two rounds.
    hit = true;

    const result = asRun(
      await run(world, call, { ctx: ctx({ elicitation: true, state, confirm: true }) }),
    );

    expect(world.count("createPerson")).toBe(0);
    expect(result.text).toBe(
      [
        "create_records preview: 1 item(s) (1 persons, 0 companies, 0 deals, 0 tasks), 1 duplicate(s) skipped. Re-call with confirm: true to execute.",
        "Records changed since the preview; review and confirm again.",
      ].join("\n"),
    );
    expect(result.structured["recordsChanged"]).toBe(true);
    expect(result.structured["requiresConfirmation"]).toBe(true);
    expectPayload(result);
  });

  test("a confirmation minted for another tool is refused", async () => {
    const world = fakeWorld();
    const state: WriteState = {
      tool: "update_records",
      argsHash: "hash-synthetic-a",
      previewDigest: "digest-synthetic-a",
      jti: "jti-synthetic-other-tool",
    };

    const result = asRun(
      await run(world, args({ persons: [personArg()] }), {
        ctx: ctx({ elicitation: true, state, confirm: true }),
      }),
    );

    expect(errorsOf(result)[0]?.code).toBe("BAD_PARAMS");
    expect(world.calls).toEqual([]);
  });

  test("without elicitation the confirm argument is the execute trigger", async () => {
    const world = fakeWorld({
      createPerson: () => "person-synthetic-901",
      records: { "person:person-synthetic-901": person({ id: "person-synthetic-901" }) },
    });

    const result = asRun(
      await run(world, args({ persons: [personArg()], confirm: true }), { ctx: ctx() }),
    );

    expect(world.count("createPerson")).toBe(1);
    expect(statusesOf(result)).toEqual(["ok"]);
  });
});

describe("execution", () => {
  const fullBatch = (): CreateRecordsArgs =>
    args({
      persons: [personArg({ phones: ["+00 000 000 001"], companyId: "company-synthetic-101" })],
      companies: [{ name: "Synthetic Company Beta", nip: "0000000001" }],
      deals: [
        {
          name: "Synthetic Deal One",
          companyId: "company-synthetic-101",
          processId: PROCESS_ID,
          budget: [{ productName: "Synthetic Line", price: 100, amount: 2 }],
        },
      ],
      tasks: [{ title: "Synthetic Task One", date: "2026-09-26" }],
      confirm: true,
    });

  const world = (): World =>
    fakeWorld({
      createPerson: () => "person-synthetic-901",
      createCompany: () => "company-synthetic-901",
      createDeal: () => "deal-synthetic-901",
      createTask: () => "task-synthetic-901",
      records: {
        "person:person-synthetic-901": person({
          id: "person-synthetic-901",
          emails: ["person.one@synthetic.example"],
          phones: ["+00000000001"],
          companyId: "company-synthetic-101",
        }),
        "company:company-synthetic-901": company({
          id: "company-synthetic-901",
          name: "Synthetic Company Beta",
          nip: "0000000001",
        }),
        "deal:deal-synthetic-901": deal({ id: "deal-synthetic-901", name: "Synthetic Deal One", value: 200 }),
        "task:task-synthetic-901": task({
          id: "task-synthetic-901",
          title: "Synthetic Task One",
          dateFrom: "2026-09-26 00:00:00",
        }),
      },
    });

  test("items are written in declaration order and counted", async () => {
    const scenario = world();

    const result = asRun(await run(scenario, fullBatch()));

    expect(scenario.methods().filter((method) => method.startsWith("create"))).toEqual([
      "createPerson",
      "createCompany",
      "createDeal",
      "createTask",
    ]);
    expect(result.text).toBe(
      "create_records: attempted 4 of 4 - ok 4, skipped 0, errors 0, unknown 0, not attempted 0.",
    );
    expect(statusesOf(result)).toEqual(["ok", "ok", "ok", "ok"]);
    expect(result.structured["counts"]).toEqual({
      ok: 4,
      skippedDuplicate: 0,
      error: 0,
      unknownOutcome: 0,
      notAttempted: 0,
    });
    expect(result.isError).toBe(false);
    expectPayload(result);
  });

  test("the payloads carry the mapped fields, with the task date normalized", async () => {
    const scenario = world();

    await run(scenario, fullBatch());

    expect(scenario.inputs("createPerson")[0]).toEqual({
      firstname: "Synthetic",
      lastname: "Person One",
      emails: ["person.one@synthetic.example"],
      phones: ["+00 000 000 001"],
      companyId: "company-synthetic-101",
    });
    expect(scenario.inputs("createDeal")[0]).toEqual({
      name: "Synthetic Deal One",
      companyId: "company-synthetic-101",
      processId: PROCESS_ID,
      budget: [{ productName: "Synthetic Line", price: 100, amount: 2 }],
    });
    // A day becomes a full timestamp before it travels, so the re-read
    // comparison has something exact to compare.
    expect(scenario.inputs("createTask")[0]).toEqual({
      title: "Synthetic Task One",
      date: "2026-09-26 00:00:00",
    });
  });

  test("a field the CRM dropped is reported while the item stays ok", async () => {
    const scenario = fakeWorld({
      createPerson: () => "person-synthetic-901",
      records: {
        "person:person-synthetic-901": person({ id: "person-synthetic-901", emails: [] }),
      },
    });

    const result = asRun(
      await run(scenario, args({ persons: [personArg()], confirm: true })),
    );

    expect(resultsOf(result)[0]?.["status"]).toBe("ok");
    expect(resultsOf(result)[0]?.["unappliedFields"]).toEqual(["emails"]);
    expect(resultsOf(result)[0]?.["verification"]).toBe("verified");
  });

  test("a re-read that fails leaves the applied write ok and unverified", async () => {
    const scenario = fakeWorld({
      createPerson: () => "person-synthetic-901",
      records: { "person:person-synthetic-901": new Error("synthetic read failure") },
    });

    const result = asRun(
      await run(scenario, args({ persons: [personArg()], confirm: true })),
    );

    expect(resultsOf(result)[0]?.["status"]).toBe("ok");
    expect(resultsOf(result)[0]?.["verification"]).toBe("unavailable");
    expect(resultsOf(result)[0]?.["unappliedFields"]).toBeUndefined();
    expectPayload(result);
  });

  test("one rejected item does not stop its siblings, and the 420 body never travels", async () => {
    // The envelope a 420 arrives in carries upstream text. The client maps the
    // RESULT CODE and nothing else, so the body cannot reach the model
    // (docs/security.md par. 6) - this pins that it does not.
    const envelope = {
      status: false,
      result: 420,
      error: `invalid value for 'nip': ${ENVELOPE_MARKER}`,
    };
    const scenario = fakeWorld({
      createPerson: (call) =>
        call === 0 ? errorFromEnvelope(envelope.result) : "person-synthetic-902",
      records: { "person:person-synthetic-902": person({ id: "person-synthetic-902" }) },
    });

    const result = asRun(
      await run(
        scenario,
        args({
          persons: [
            personArg({ emails: ["one@synthetic.example"] }),
            personArg({ emails: ["two@synthetic.example"] }),
          ],
          confirm: true,
        }),
      ),
    );

    expect(statusesOf(result)).toEqual(["error", "ok"]);
    expect(resultsOf(result)[0]?.["error"]).toEqual(VALIDATION_420);
    const wire = `${result.text}\n${JSON.stringify(result.structured)}`;
    expect(envelope.error).toContain(ENVELOPE_MARKER);
    expect(wire).not.toContain(ENVELOPE_MARKER);
    expect(result.isError).toBe(false);
  });

  test("a batch whose every attempt failed is an error", async () => {
    const scenario = fakeWorld({ createPerson: () => errorFromEnvelope(420) });

    const result = asRun(
      await run(scenario, args({ persons: [personArg()], confirm: true })),
    );

    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      "create_records: attempted 1 of 1 - ok 0, skipped 0, errors 1, unknown 0, not attempted 0.",
    );
  });

  test("a rate-limited item leaves the rest not attempted", async () => {
    const scenario = fakeWorld({
      createPerson: (call) => (call === 1 ? RATE_LIMITED : `person-synthetic-90${call + 1}`),
      records: {
        "person:person-synthetic-901": person({ id: "person-synthetic-901" }),
      },
    });

    const result = asRun(
      await run(
        scenario,
        args({
          persons: [
            personArg({ emails: ["one@synthetic.example"] }),
            personArg({ emails: ["two@synthetic.example"] }),
            personArg({ emails: ["three@synthetic.example"] }),
          ],
          confirm: true,
        }),
      ),
    );

    expect(scenario.count("createPerson")).toBe(2);
    expect(statusesOf(result)).toEqual(["ok", "error", "not_attempted"]);
    expect(result.text).toBe(
      "create_records: attempted 2 of 3 - ok 1, skipped 0, errors 1, unknown 0, not attempted 1.",
    );
    expectPayload(result);
  });

  test("a rate-limited lookup stops the plan instead of asking again", async () => {
    // An upstream that said stop is not hammered - and the plan phase is where
    // it says it first, on a dryRun that never reaches the executor at all.
    const scenario = fakeWorld({ findPerson: () => RATE_LIMITED });

    const result = asRun(
      await run(
        scenario,
        args({
          persons: [
            personArg({ emails: ["one@synthetic.example"] }),
            personArg({ emails: ["two@synthetic.example"] }),
          ],
          companies: [{ name: "Synthetic Company Alpha" }],
          dryRun: true,
        }),
      ),
    );

    expect(scenario.count("findPersonByEmail")).toBe(1);
    expect(scenario.count("findCompanyByName")).toBe(0);
    expect(planOf(result).map((item) => item["status"])).toEqual([
      "blocked",
      "blocked",
      "blocked",
    ]);
    expect(planOf(result).map((item) => (item["error"] as ToolError).code)).toEqual([
      "RATE_LIMITED",
      "RATE_LIMITED",
      "RATE_LIMITED",
    ]);
    expect(result.isError).toBe(false);
    expectPayload(result);
  });

  test("the plan phase stops at the budget and blocks what it never reached", async () => {
    const scenario = fakeWorld();

    const result = asRun(
      await budgetSpentAfterFirstItem(() =>
        run(
          scenario,
          args({
            persons: [
              personArg({ emails: ["one@synthetic.example"] }),
              personArg({ emails: ["two@synthetic.example"] }),
            ],
            dryRun: true,
          }),
        ),
      ),
    );

    expect(scenario.count("findPersonByEmail")).toBe(1);
    expect(planOf(result).map((item) => item["status"])).toEqual(["create", "blocked"]);
    expect(planOf(result)[1]?.["error"]).toEqual(PLAN_BUDGET_EXPIRED);
    expect(result.isError).toBe(false);
    expectPayload(result);
  });

  test("a caller who walked away before the plan gets no work and no result", async () => {
    const scenario = fakeWorld();
    const controller = new AbortController();
    controller.abort();

    const error = await rejection(
      run(scenario, args({ persons: [personArg()], confirm: true }), {
        signal: controller.signal,
      }),
    );

    expect((error as LivespaceError).code).toBe("CANCELLED");
    expect(scenario.calls).toEqual([]);
  });

  test("an abort during a dedupe lookup rejects as CANCELLED", async () => {
    const controller = new AbortController();
    const scenario = fakeWorld({
      findPerson: () => {
        controller.abort();
        throw new Error("synthetic abort reason");
      },
    });

    const error = await rejection(
      run(scenario, args({ persons: [personArg()], confirm: true }), {
        signal: controller.signal,
      }),
    );

    expect((error as LivespaceError).code).toBe("CANCELLED");
    expect(scenario.count("createPerson")).toBe(0);
  });
});

describe("the text channel and the output schema", () => {
  test("no CRM-authored name reaches the text channel", async () => {
    const scenario = fakeWorld({
      findCompany: () => ({ id: "company-synthetic-101", name: `Company ${NAME_MARKER}` }),
      createPerson: () => "person-synthetic-901",
      records: { "person:person-synthetic-901": person({ id: "person-synthetic-901" }) },
    });
    const call = (extra: Record<string, unknown>): CreateRecordsArgs =>
      args({
        persons: [personArg({ firstname: `Synthetic ${NAME_MARKER}` })],
        companies: [{ name: `Company ${NAME_MARKER}` }],
        ...extra,
      });

    const preview = asRun(await run(scenario, call({})));
    const executed = asRun(await run(scenario, call({ confirm: true })));

    expect(preview.text).not.toContain(NAME_MARKER);
    expect(executed.text).not.toContain(NAME_MARKER);
    // The names are data, so they do travel in the structured channel.
    expect(JSON.stringify(preview.structured)).toContain(NAME_MARKER);
  });

  test("the output schema rejects a key nobody declared", () => {
    expect(createRecordsToolConfig.outputSchema.safeParse({ errors: [] }).success).toBe(true);
    expect(
      createRecordsToolConfig.outputSchema.safeParse({ errors: [], surprise: 1 }).success,
    ).toBe(false);
  });
});
