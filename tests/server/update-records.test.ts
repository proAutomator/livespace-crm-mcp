import { describe, expect, test } from "bun:test";
import {
  isInputRequiredResult,
  type InputRequiredResult,
  type RequestStateCodec,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { errorFromEnvelope, LivespaceError } from "../../src/livespace/errors.js";
import type { RecordFetchers, RecordKind } from "../../src/livespace/records.js";
import type {
  CompanyUpdate,
  DealUpdate,
  PersonUpdate,
  TaskUpdate,
  WriteFetchers,
} from "../../src/livespace/writes.js";
import type { ToolError, ToolRunResult } from "../../src/server/tools/tool-error.js";
import {
  runUpdateRecords,
  updateRecordsToolConfig,
  type UpdateRecordsArgs,
  type UpdateRecordsDeps,
  type UpdateRecordsResult,
} from "../../src/server/tools/update-records.js";
import {
  PLAN_BUDGET_EXPIRED,
  WRITE_BUDGET_MS,
  type WriteState,
} from "../../src/server/tools/write-support.js";
import { company, deal, person, task } from "../support/records.js";

/**
 * `update_records` against fakes. Every value below is invented: no CRM data,
 * no sandbox values, and no call leaves the process (AGENTS.md).
 *
 * The marker stands in for a CRM-authored name - the kind of string a before
 * value is made of. It may live in `structuredContent`, where the schema types
 * it as data, and must never reach the text channel or an approval prompt
 * (docs/security.md par. 4).
 */
const NAME_MARKER = "synthetic-name-marker";

/** The same idea for an upstream response body, which may never travel at all. */
const ENVELOPE_MARKER = "synthetic-envelope-marker";

/** The literal envelope key, spelled out so a rename upstream fails loudly. */
const CAPS_KEY = "io.modelcontextprotocol/clientCapabilities";

const PERSON_ID = "person-synthetic-001";
const COMPANY_ID = "company-synthetic-101";
const DEAL_ID = "deal-synthetic-401";
const TASK_ID = "task-synthetic-801";

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

const UPSTREAM_ERROR = new LivespaceError(
  "UPSTREAM_ERROR",
  "Livespace reported a general API error (500).",
  "Retry once; if it persists, reduce the request size.",
);

type Answer = LivespaceError | undefined;

interface Canning {
  updatePerson?: (call: number, input: PersonUpdate) => Answer;
  updateCompany?: (call: number, input: CompanyUpdate) => Answer;
  updateDeal?: (call: number, input: DealUpdate) => Answer;
  updateTask?: (call: number, input: TaskUpdate) => Answer;
  /**
   * Re-read answers, keyed `kind:id`. An Error value is thrown; an ARRAY gives
   * one answer per call on that key (the last one repeats), which is how a plan
   * read that succeeds is paired with a follow-up read that does not.
   */
  records?: Record<string, unknown>;
  /** Runs before every read answer; throwing here is a read that failed. */
  onRead?: (key: string, call: number) => void;
}

interface Recorded {
  method: string;
  input: unknown;
  opts: unknown;
}

/**
 * The fakes implement exactly the fetchers `update_records` may touch and
 * RECORD every call. The create, note and call fetchers throw: an update tool
 * that reaches for them is a bug, not a passing test.
 */
function fakeWorld(canned: Canning = {}) {
  const calls: Recorded[] = [];
  const reads = new Map<string, number>();
  const push = (method: string, input: unknown, opts: unknown): number => {
    const call = calls.filter((entry) => entry.method === method).length;
    calls.push({ method, input, opts });
    return call;
  };
  const never =
    (method: string) =>
    async (): Promise<never> => {
      throw new Error(`update_records must never call ${method}`);
    };
  const raise = (value: Answer): void => {
    if (value !== undefined) throw value;
  };

  const writes = {
    // The call is recorded BEFORE the canned answer is consulted: `f?.(push())`
    // would skip the recording whenever no answer was canned.
    updatePerson: async (input: PersonUpdate, opts?: unknown) => {
      const call = push("updatePerson", input, opts);
      raise(canned.updatePerson?.(call, input));
    },
    updateCompany: async (input: CompanyUpdate, opts?: unknown) => {
      const call = push("updateCompany", input, opts);
      raise(canned.updateCompany?.(call, input));
    },
    updateDeal: async (input: DealUpdate, opts?: unknown) => {
      const call = push("updateDeal", input, opts);
      raise(canned.updateDeal?.(call, input));
    },
    updateTask: async (input: TaskUpdate, opts?: unknown) => {
      const call = push("updateTask", input, opts);
      raise(canned.updateTask?.(call, input));
    },
    createPerson: never("createPerson"),
    createCompany: never("createCompany"),
    createDeal: never("createDeal"),
    createTask: never("createTask"),
    addNote: never("addNote"),
    addCall: never("addCall"),
    findPersonByEmail: never("findPersonByEmail"),
    findCompanyByName: never("findCompanyByName"),
  } as unknown as WriteFetchers;

  const records = {
    getRecord: async (kind: RecordKind, id: string, opts?: unknown) => {
      const key = `${kind}:${id}`;
      push("getRecord", key, opts);
      const seen = reads.get(key) ?? 0;
      reads.set(key, seen + 1);
      canned.onRead?.(key, seen);
      const canning = canned.records?.[key];
      const answer = Array.isArray(canning)
        ? canning[Math.min(seen, canning.length - 1)]
        : canning;
      if (answer instanceof Error) throw answer;
      return answer ?? null;
    },
  } as unknown as RecordFetchers;

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

  const deps: UpdateRecordsDeps = { writes, records, codec };
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
  args: UpdateRecordsArgs,
  opts: { signal?: AbortSignal; ctx?: unknown } = {},
): Promise<UpdateRecordsResult> {
  return runUpdateRecords(world.deps, args, opts);
}

function asRun(result: UpdateRecordsResult): ToolRunResult {
  if (isInputRequiredResult(result)) {
    throw new Error("expected a tool result, got an input-required result");
  }
  return result;
}

function asInputRequired(result: UpdateRecordsResult): InputRequiredResult {
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
  const parsed = updateRecordsToolConfig.outputSchema.safeParse(result.structured);
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

function args(value: Record<string, unknown>): UpdateRecordsArgs {
  return value as unknown as UpdateRecordsArgs;
}

/** The four targets, each in the state a plan read would find them in. */
function world(canned: Canning = {}): World {
  return fakeWorld({
    ...canned,
    records: {
      [`person:${PERSON_ID}`]: person({ id: PERSON_ID }),
      [`company:${COMPANY_ID}`]: company({ id: COMPANY_ID }),
      [`deal:${DEAL_ID}`]: deal({ id: DEAL_ID }),
      [`task:${TASK_ID}`]: task({ id: TASK_ID }),
      ...canned.records,
    },
  });
}

/** Round one asks the human, round two carries the minted state back. */
async function twoRounds(scenario: World, call: UpdateRecordsArgs): Promise<ToolRunResult> {
  const first = await run(scenario, call, { ctx: ctx({ elicitation: true }) });
  asInputRequired(first);
  const state = scenario.minted[0] as WriteState;
  return asRun(
    await run(scenario, call, { ctx: ctx({ elicitation: true, state, confirm: true }) }),
  );
}

describe("updateRecordsToolConfig", () => {
  test("the annotations declare a destructive write", () => {
    expect(updateRecordsToolConfig.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  test("the input schema is a plain object at the JSON Schema root", () => {
    const json = z.toJSONSchema(updateRecordsToolConfig.inputSchema) as Record<
      string,
      unknown
    >;
    expect(json["type"]).toBe("object");
    expect(json["oneOf"]).toBeUndefined();
  });

  test("the description names the cap, the confirmation flow and the merge rule", () => {
    const description = updateRecordsToolConfig.description.replace(/\s+/gu, " ");
    expect(description).toContain("10 items per call");
    expect(description).toContain("confirm: true");
    expect(description).toContain("merge");
  });
});

describe("the input schema", () => {
  const parse = (value: unknown): boolean =>
    updateRecordsToolConfig.inputSchema.safeParse(value).success;

  test("the root object is strict", () => {
    expect(parse({ persons: [{ id: PERSON_ID, firstname: "Synthetic" }] })).toBe(true);
    expect(parse({ persons: [{ id: PERSON_ID, firstname: "Synthetic" }], notes: [] })).toBe(
      false,
    );
  });

  test("every item names an id and nothing undeclared", () => {
    expect(parse({ persons: [{ firstname: "Synthetic" }] })).toBe(false);
    expect(parse({ persons: [{ id: "", firstname: "Synthetic" }] })).toBe(false);
    expect(parse({ persons: [{ id: PERSON_ID, tags: ["alpha"] }] })).toBe(false);
    expect(parse({ deals: [{ id: DEAL_ID, budget: [] }] })).toBe(false);
    expect(parse({ tasks: [{ id: TASK_ID, priority: 2 }] })).toBe(false);
  });

  test("ten items in one array are accepted and eleven are not", () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({
      id: `person-synthetic-0${i}`,
      firstname: "Synthetic",
    }));
    expect(parse({ persons: ten })).toBe(true);
    expect(parse({ persons: [...ten, { id: "person-synthetic-99", firstname: "S" }] })).toBe(
      false,
    );
  });

  test("the per-array cap does not add up: the runner owns the total", () => {
    expect(
      parse({
        persons: Array.from({ length: 6 }, (_, i) => ({
          id: `person-synthetic-0${i}`,
          firstname: "Synthetic",
        })),
        companies: Array.from({ length: 5 }, (_, i) => ({
          id: `company-synthetic-0${i}`,
          name: "Synthetic Company",
        })),
      }),
    ).toBe(true);
  });

  test("person and company bounds are enforced", () => {
    expect(parse({ persons: [{ id: PERSON_ID, firstname: "" }] })).toBe(false);
    expect(parse({ persons: [{ id: PERSON_ID, firstname: "x".repeat(201) }] })).toBe(false);
    expect(parse({ persons: [{ id: PERSON_ID, lastname: "x".repeat(201) }] })).toBe(false);
    expect(parse({ persons: [{ id: PERSON_ID, emails: ["ab"] }] })).toBe(false);
    expect(
      parse({
        persons: [
          {
            id: PERSON_ID,
            emails: Array.from({ length: 6 }, (_, i) => `p${i}@synthetic.example`),
          },
        ],
      }),
    ).toBe(false);
    expect(parse({ persons: [{ id: PERSON_ID, phones: ["12"] }] })).toBe(false);
    expect(parse({ persons: [{ id: PERSON_ID, note: "x".repeat(5001) }] })).toBe(false);
    expect(parse({ companies: [{ id: COMPANY_ID, name: "" }] })).toBe(false);
    expect(parse({ companies: [{ id: COMPANY_ID, nip: "1".repeat(21) }] })).toBe(false);
  });

  test("a deal status is one of the three the API understands", () => {
    for (const status of ["open", "won", "lost"]) {
      expect(parse({ deals: [{ id: DEAL_ID, status }] })).toBe(true);
    }
    expect(parse({ deals: [{ id: DEAL_ID, status: "WON" }] })).toBe(false);
    expect(parse({ deals: [{ id: DEAL_ID, status: "archived" }] })).toBe(false);
  });

  test("the task date takes a day or a timestamp and nothing else", () => {
    const accepted = ["2026-09-26", "2026-09-26 10:00", "2026-09-26 10:00:00"];
    for (const date of accepted) {
      expect(parse({ tasks: [{ id: TASK_ID, date }] })).toBe(true);
    }
    const refused = ["2026-9-6", "2026-09-26T10:00:00", "26-09-2026", "2026-09-26 10"];
    for (const date of refused) {
      expect(parse({ tasks: [{ id: TASK_ID, date }] })).toBe(false);
    }
  });
});

describe("argument rules", () => {
  test("a call with no items is refused", async () => {
    const scenario = world();

    const result = asRun(await run(scenario, args({})));

    expect(result.isError).toBe(true);
    expect(result.text).toBe("update_records failed: BAD_PARAMS.");
    expect(errorsOf(result)[0]?.code).toBe("BAD_PARAMS");
    expect(scenario.calls).toEqual([]);
    expectPayload(result);
  });

  test("more than ten records across the four arrays is refused", async () => {
    const scenario = world();

    const result = asRun(
      await run(
        scenario,
        args({
          persons: Array.from({ length: 6 }, (_, i) => ({
            id: `person-synthetic-0${i}`,
            firstname: "Synthetic",
          })),
          companies: Array.from({ length: 5 }, (_, i) => ({
            id: `company-synthetic-0${i}`,
            name: "Synthetic Company",
          })),
        }),
      ),
    );

    expect(errorsOf(result)[0]?.code).toBe("BAD_PARAMS");
    expect(errorsOf(result)[0]?.hint).toContain("10");
    expect(scenario.calls).toEqual([]);
  });

  test("an item that changes nothing is refused", async () => {
    const scenario = world();

    const bare = asRun(await run(scenario, args({ persons: [{ id: PERSON_ID }] })));
    // An e-mail list that trims away to nothing is the same non-request: an
    // empty array cannot express "clear these" against a merging endpoint.
    const blank = asRun(
      await run(scenario, args({ persons: [{ id: PERSON_ID, emails: [] }] })),
    );

    expect(errorsOf(bare)[0]?.code).toBe("BAD_PARAMS");
    expect(errorsOf(blank)[0]?.code).toBe("BAD_PARAMS");
    expect(scenario.calls).toEqual([]);
  });

  test("the same id twice in one kind is refused rather than resolved", async () => {
    const scenario = world();

    const result = asRun(
      await run(
        scenario,
        args({
          persons: [
            { id: PERSON_ID, firstname: "Synthetic" },
            { id: PERSON_ID, lastname: "Person Two" },
          ],
        }),
      ),
    );

    expect(errorsOf(result)[0]?.code).toBe("BAD_PARAMS");
    expect(scenario.calls).toEqual([]);
  });

  test("the same id in two kinds is fine: ids are per record kind", async () => {
    const shared = "synthetic-shared-id";
    const scenario = fakeWorld({
      records: {
        [`person:${shared}`]: person({ id: shared }),
        [`deal:${shared}`]: deal({ id: shared }),
      },
    });

    const result = asRun(
      await run(
        scenario,
        args({
          persons: [{ id: shared, firstname: "Synthetic" }],
          deals: [{ id: shared, status: "won" }],
        }),
      ),
    );

    expect(errorsOf(result)).toEqual([]);
    expect(planOf(result).map((item) => item["status"])).toEqual(["update", "update"]);
  });

  test("a task date that is not a real day is refused", async () => {
    const scenario = world();

    const result = asRun(
      await run(scenario, args({ tasks: [{ id: TASK_ID, date: "2026-02-31" }] })),
    );

    expect(errorsOf(result)[0]?.code).toBe("BAD_PARAMS");
    expect(scenario.calls).toEqual([]);
  });

  test("a task date outside the supported years is refused", async () => {
    const scenario = world();

    const result = asRun(
      await run(scenario, args({ tasks: [{ id: TASK_ID, date: "1899-12-31" }] })),
    );

    expect(errorsOf(result)[0]?.code).toBe("BAD_PARAMS");
    expect(scenario.calls).toEqual([]);
  });
});

describe("the plan phase", () => {
  test("every target is read once, and the before-values cover the sent fields only", async () => {
    const scenario = world();

    const result = asRun(
      await run(
        scenario,
        args({
          persons: [{ id: PERSON_ID, emails: ["new.address@synthetic.example"] }],
          tasks: [{ id: TASK_ID, isCompleted: true }],
        }),
      ),
    );

    expect(scenario.inputs("getRecord")).toEqual([
      `person:${PERSON_ID}`,
      `task:${TASK_ID}`,
    ]);
    expect(planOf(result)).toEqual([
      {
        index: 0,
        action: "update_person",
        kind: "person",
        status: "update",
        summary: { id: PERSON_ID, emails: ["new.address@synthetic.example"] },
        before: {
          id: PERSON_ID,
          name: "Synthetic Person One",
          emails: ["person.one@synthetic.example"],
        },
      },
      {
        index: 1,
        action: "update_task",
        kind: "task",
        status: "update",
        summary: { id: TASK_ID, isCompleted: true },
        before: { id: TASK_ID, title: "Synthetic Task One", isCompleted: false },
      },
    ]);
    expectPayload(result);
  });

  test("a target that does not exist is blocked in the preview and never written", async () => {
    const scenario = fakeWorld({
      records: { [`company:${COMPANY_ID}`]: company({ id: COMPANY_ID }) },
    });
    const call = (extra: Record<string, unknown>): UpdateRecordsArgs =>
      args({
        persons: [{ id: "person-synthetic-missing", firstname: "Synthetic" }],
        companies: [{ id: COMPANY_ID, nip: "0000000002" }],
        ...extra,
      });

    const preview = asRun(await run(scenario, call({})));
    expect(planOf(preview)[0]).toEqual({
      index: 0,
      action: "update_person",
      kind: "person",
      status: "blocked",
      summary: { id: "person-synthetic-missing", firstname: "Synthetic" },
      error: {
        code: "NOT_FOUND",
        message: "Record not found.",
        hint: "The id does not exist or the API key's user cannot see it - take ids from search_crm or get_records.",
      },
    });
    expectPayload(preview);

    const executed = asRun(await run(scenario, call({ confirm: true })));
    expect(scenario.count("updatePerson")).toBe(0);
    expect(scenario.count("updateCompany")).toBe(1);
    expect(statusesOf(executed)).toEqual(["error", "ok"]);
    expect(resultsOf(executed)[0]?.["error"]).toEqual({
      code: "NOT_FOUND",
      message: "Record not found.",
      hint: "The id does not exist or the API key's user cannot see it - take ids from search_crm or get_records.",
    });
    expectPayload(executed);
  });

  test("a target read that fails blocks the item instead of writing blind", async () => {
    const scenario = fakeWorld({
      records: { [`person:${PERSON_ID}`]: UPSTREAM_ERROR },
    });

    const preview = asRun(
      await run(scenario, args({ persons: [{ id: PERSON_ID, firstname: "Synthetic" }] })),
    );
    expect(planOf(preview)[0]?.["status"]).toBe("blocked");
    expect((planOf(preview)[0]?.["error"] as ToolError).code).toBe("UPSTREAM_ERROR");

    const executed = asRun(
      await run(
        scenario,
        args({ persons: [{ id: PERSON_ID, firstname: "Synthetic" }], confirm: true }),
      ),
    );
    expect(scenario.count("updatePerson")).toBe(0);
    expect(statusesOf(executed)).toEqual(["error"]);
    expect(executed.isError).toBe(true);
  });
});

describe("the confirmation flow", () => {
  test("a plain call previews and writes nothing", async () => {
    const scenario = world();

    const result = asRun(
      await run(
        scenario,
        args({
          persons: [{ id: PERSON_ID, firstname: "Synthetic" }],
          deals: [{ id: DEAL_ID, status: "won" }],
        }),
      ),
    );

    expect(result.text).toBe(
      "update_records preview: 2 item(s) (1 persons, 0 companies, 1 deals, 0 tasks). Re-call with confirm: true to execute.",
    );
    expect(result.structured["requiresConfirmation"]).toBe(true);
    expect(result.structured["results"]).toBeUndefined();
    expect(scenario.count("updatePerson")).toBe(0);
    expect(scenario.count("updateDeal")).toBe(0);
    expect(errorsOf(result)).toEqual([]);
    expectPayload(result);
  });

  test("dryRun previews without claiming a confirmation is pending", async () => {
    const scenario = world();

    const result = asRun(
      await run(
        scenario,
        args({ persons: [{ id: PERSON_ID, firstname: "Synthetic" }], dryRun: true }),
      ),
    );

    expect(result.structured["requiresConfirmation"]).toBeUndefined();
    expect(scenario.count("updatePerson")).toBe(0);
    expectPayload(result);
  });

  test("dryRun and confirm together are refused", async () => {
    const scenario = world();

    const result = asRun(
      await run(
        scenario,
        args({
          persons: [{ id: PERSON_ID, firstname: "Synthetic" }],
          dryRun: true,
          confirm: true,
        }),
      ),
    );

    expect(errorsOf(result)[0]?.code).toBe("BAD_PARAMS");
    expect(scenario.calls).toEqual([]);
  });

  test("an elicitation-capable client is asked with counts and no CRM string", async () => {
    const scenario = fakeWorld({
      records: {
        [`person:${PERSON_ID}`]: person({ id: PERSON_ID, name: `Synthetic ${NAME_MARKER}` }),
        [`deal:${DEAL_ID}`]: deal({ id: DEAL_ID }),
        [`task:${TASK_ID}`]: task({ id: TASK_ID }),
      },
    });

    const result = asInputRequired(
      await run(
        scenario,
        args({
          persons: [{ id: PERSON_ID, firstname: "Synthetic" }],
          deals: [{ id: DEAL_ID, status: "won" }],
          tasks: [{ id: TASK_ID, isCompleted: true }],
        }),
        { ctx: ctx({ elicitation: true }) },
      ),
    );

    expect(result.requestState).toBe("synthetic-wire-1");
    expect(elicitationMessageOf(result)).toBe(
      "Update 3 CRM record(s) (1 persons, 0 companies, 1 deals, 1 tasks). Approve?",
    );
    // The approval string a human reads is ours: counts and kinds only.
    expect(JSON.stringify(result)).not.toContain(NAME_MARKER);
    expect(scenario.count("updatePerson")).toBe(0);
    expect(scenario.minted[0]).toEqual({
      tool: "update_records",
      argsHash: expect.stringMatching(/^[0-9a-f]{64}$/u) as unknown as string,
      previewDigest: expect.stringMatching(/^[0-9a-f]{64}$/u) as unknown as string,
      jti: expect.stringMatching(/^[0-9a-f]{32}$/u) as unknown as string,
    });
  });

  test("the model cannot self-confirm on an elicitation-capable client", async () => {
    const scenario = world();

    const result = await run(
      scenario,
      args({ persons: [{ id: PERSON_ID, firstname: "Synthetic" }], confirm: true }),
      { ctx: ctx({ elicitation: true }) },
    );

    asInputRequired(result);
    expect(scenario.count("updatePerson")).toBe(0);
  });

  test("a declined confirmation writes nothing and says so", async () => {
    const scenario = world();
    const call = args({ persons: [{ id: PERSON_ID, firstname: "Synthetic" }] });
    asInputRequired(await run(scenario, call, { ctx: ctx({ elicitation: true }) }));
    const state = scenario.minted[0] as WriteState;

    const result = asRun(
      await run(scenario, call, {
        ctx: ctx({ elicitation: true, state, confirm: "decline" }),
      }),
    );

    expect(result.text).toBe(
      [
        "update_records preview: 1 item(s) (1 persons, 0 companies, 0 deals, 0 tasks). Re-call with confirm: true to execute.",
        "Confirmation was declined; nothing was written.",
      ].join("\n"),
    );
    expect(result.structured["declined"]).toBe(true);
    expect(scenario.count("updatePerson")).toBe(0);
    expectPayload(result);
  });

  test("an accepted confirmation executes the plan exactly once", async () => {
    const scenario = world();

    const result = await twoRounds(
      scenario,
      args({ companies: [{ id: COMPANY_ID, nip: "0000000002" }] }),
    );

    expect(scenario.count("updateCompany")).toBe(1);
    expect(statusesOf(result)).toEqual(["ok"]);
    expectPayload(result);
  });

  test("a replayed confirmation is refused and writes nothing", async () => {
    const scenario = world();
    const call = args({ companies: [{ id: COMPANY_ID, nip: "0000000002" }] });
    await twoRounds(scenario, call);
    const state = scenario.minted[0] as WriteState;

    const replay = asRun(
      await run(scenario, call, { ctx: ctx({ elicitation: true, state, confirm: true }) }),
    );

    expect(errorsOf(replay)[0]?.code).toBe("BAD_PARAMS");
    expect(scenario.count("updateCompany")).toBe(1);
  });

  test("records changed since the preview are never written blind", async () => {
    const answers: Record<string, unknown> = {
      [`company:${COMPANY_ID}`]: company({ id: COMPANY_ID, name: "Synthetic Company Alpha" }),
    };
    const scenario = fakeWorld({ records: answers });
    const call = args({ companies: [{ id: COMPANY_ID, name: "Synthetic Company Beta" }] });
    asInputRequired(await run(scenario, call, { ctx: ctx({ elicitation: true }) }));
    const state = scenario.minted[0] as WriteState;
    // Someone renamed that company between the two rounds.
    answers[`company:${COMPANY_ID}`] = company({
      id: COMPANY_ID,
      name: "Synthetic Company Gamma",
    });

    const result = asRun(
      await run(scenario, call, { ctx: ctx({ elicitation: true, state, confirm: true }) }),
    );

    expect(scenario.count("updateCompany")).toBe(0);
    expect(result.text).toBe(
      [
        "update_records preview: 1 item(s) (0 persons, 1 companies, 0 deals, 0 tasks). Re-call with confirm: true to execute.",
        "Records changed since the preview; review and confirm again.",
      ].join("\n"),
    );
    expect(result.structured["recordsChanged"]).toBe(true);
    expect(result.structured["requiresConfirmation"]).toBe(true);
    expectPayload(result);
  });

  test("a confirmation minted for another tool is refused", async () => {
    const scenario = world();
    const state: WriteState = {
      tool: "create_records",
      argsHash: "hash-synthetic-a",
      previewDigest: "digest-synthetic-a",
      jti: "jti-synthetic-other-tool-update",
    };

    const result = asRun(
      await run(scenario, args({ persons: [{ id: PERSON_ID, firstname: "Synthetic" }] }), {
        ctx: ctx({ elicitation: true, state, confirm: true }),
      }),
    );

    expect(errorsOf(result)[0]?.code).toBe("BAD_PARAMS");
    expect(scenario.calls).toEqual([]);
  });

  test("without elicitation the confirm argument is the execute trigger", async () => {
    const scenario = world();

    const result = asRun(
      await run(
        scenario,
        args({ persons: [{ id: PERSON_ID, firstname: "Synthetic" }], confirm: true }),
        { ctx: ctx() },
      ),
    );

    expect(scenario.count("updatePerson")).toBe(1);
    expect(statusesOf(result)).toEqual(["ok"]);
  });
});

describe("execution", () => {
  test("only the fields that were sent travel, with the task date normalized", async () => {
    const scenario = world();

    await run(
      scenario,
      args({
        persons: [
          { id: PERSON_ID, firstname: "Synthetic", phones: [" +00 000 000 009 "] },
        ],
        tasks: [{ id: TASK_ID, date: "2026-09-26" }],
        confirm: true,
      }),
    );

    expect(scenario.inputs("updatePerson")[0]).toEqual({
      id: PERSON_ID,
      firstname: "Synthetic",
      phones: ["+00 000 000 009"],
    });
    expect(scenario.inputs("updateTask")[0]).toEqual({
      id: TASK_ID,
      date: "2026-09-26 00:00:00",
    });
  });

  test("a deal is moved to won by the status the caller named", async () => {
    const scenario = world();

    const result = asRun(
      await run(scenario, args({ deals: [{ id: DEAL_ID, status: "won" }], confirm: true })),
    );

    expect(scenario.inputs("updateDeal")).toEqual([{ id: DEAL_ID, status: "won" }]);
    expect(statusesOf(result)).toEqual(["ok"]);
    expect(result.text).toBe(
      "update_records: attempted 1 of 1 - ok 1, errors 0, unknown 0, not attempted 0.",
    );
  });

  test("re-opening a task sends the boolean it was given, false included", async () => {
    const scenario = fakeWorld({
      records: {
        [`task:${TASK_ID}`]: task({ id: TASK_ID, isCompleted: true }),
      },
    });

    const result = asRun(
      await run(
        scenario,
        args({ tasks: [{ id: TASK_ID, isCompleted: false }], confirm: true }),
      ),
    );

    // `false` is a value, not an absence: dropping it would silently turn a
    // re-open into a no-op write.
    expect(scenario.inputs("updateTask")).toEqual([{ id: TASK_ID, isCompleted: false }]);
    expect(resultsOf(result)[0]?.["unappliedFields"]).toEqual(["isCompleted"]);
    expect(statusesOf(result)).toEqual(["ok"]);
  });

  test("a before-after pair is reported, and a field the CRM dropped named", async () => {
    const scenario = fakeWorld({
      records: {
        [`company:${COMPANY_ID}`]: [
          company({ id: COMPANY_ID, nip: "0000000000" }),
          company({ id: COMPANY_ID, nip: "0000000000" }),
        ],
      },
    });

    const result = asRun(
      await run(
        scenario,
        args({ companies: [{ id: COMPANY_ID, nip: "0000000002" }], confirm: true }),
      ),
    );

    expect(resultsOf(result)[0]).toEqual({
      index: 0,
      action: "update_company",
      kind: "company",
      status: "ok",
      id: COMPANY_ID,
      before: { id: COMPANY_ID, name: "Synthetic Company Alpha", nip: "0000000000" },
      after: { name: "Synthetic Company Alpha", nip: "0000000000" },
      verification: "verified",
      unappliedFields: ["nip"],
    });
    expectPayload(result);
  });

  test("a name-only update whose outcome is unknown is never claimed as applied", async () => {
    // The dispatch's outcome is genuinely undetermined and the re-read can
    // compare nothing - a person's firstname is folded into a composed `name`
    // upstream. Reporting `ok` here would tell the model a rename landed when
    // the write may never have reached the CRM at all.
    const scenario = fakeWorld({
      updatePerson: () =>
        new LivespaceError(
          "WRITE_OUTCOME_UNKNOWN",
          "The write request failed mid-flight; Livespace may or may not have applied it.",
          "Re-read the affected records to verify the outcome before retrying.",
        ),
      records: { [`person:${PERSON_ID}`]: person({ id: PERSON_ID }) },
    });

    const result = asRun(
      await run(
        scenario,
        args({ persons: [{ id: PERSON_ID, firstname: "Anna" }], confirm: true }),
      ),
    );

    expect(statusesOf(result)).toEqual(["unknown_outcome"]);
    expect(result.structured["counts"]).toEqual({
      ok: 0,
      skippedDuplicate: 0,
      error: 0,
      unknownOutcome: 1,
      notAttempted: 0,
    });
    expect(result.isError).toBe(true);
    expectPayload(result);
  });

  test("an applied write with nothing comparable is ok but never verified", async () => {
    const scenario = fakeWorld({
      records: { [`person:${PERSON_ID}`]: person({ id: PERSON_ID }) },
    });

    const result = asRun(
      await run(
        scenario,
        args({ persons: [{ id: PERSON_ID, firstname: "Anna" }], confirm: true }),
      ),
    );

    expect(statusesOf(result)).toEqual(["ok"]);
    expect(resultsOf(result)[0]?.["verification"]).toBe("unavailable");
    expect(resultsOf(result)[0]?.["error"]).toEqual({
      code: "VERIFICATION_UNCHECKED",
      message: "The write was applied; the sent fields have no independent re-read check.",
      hint: "Re-read the record if you need proof; do not retry the write.",
    });
    expect(result.isError).toBe(false);
    expectPayload(result);
  });

  test("a re-read that fails leaves the applied write ok and unverified", async () => {
    const scenario = fakeWorld({
      records: {
        [`company:${COMPANY_ID}`]: [
          company({ id: COMPANY_ID }),
          new Error("synthetic read failure"),
        ],
      },
    });

    const result = asRun(
      await run(
        scenario,
        args({ companies: [{ id: COMPANY_ID, nip: "0000000002" }], confirm: true }),
      ),
    );

    expect(resultsOf(result)[0]?.["status"]).toBe("ok");
    expect(resultsOf(result)[0]?.["verification"]).toBe("unavailable");
    expect(resultsOf(result)[0]?.["unappliedFields"]).toBeUndefined();
    expect(resultsOf(result)[0]?.["after"]).toBeUndefined();
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
    const scenario = world({
      updateCompany: (call) => (call === 0 ? errorFromEnvelope(envelope.result) : undefined),
      records: {
        "company:company-synthetic-102": company({ id: "company-synthetic-102" }),
      },
    });

    const result = asRun(
      await run(
        scenario,
        args({
          companies: [
            { id: COMPANY_ID, nip: "0000000002" },
            { id: "company-synthetic-102", nip: "0000000003" },
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
    expectPayload(result);
  });

  test("a batch whose every attempt failed is an error", async () => {
    const scenario = world({ updateCompany: () => errorFromEnvelope(420) });

    const result = asRun(
      await run(
        scenario,
        args({ companies: [{ id: COMPANY_ID, nip: "0000000002" }], confirm: true }),
      ),
    );

    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      "update_records: attempted 1 of 1 - ok 0, errors 1, unknown 0, not attempted 0.",
    );
  });

  test("a rate-limited item leaves the rest not attempted", async () => {
    const scenario = world({
      updateCompany: (call) => (call === 1 ? RATE_LIMITED : undefined),
      records: {
        "company:company-synthetic-102": company({ id: "company-synthetic-102" }),
        "company:company-synthetic-103": company({ id: "company-synthetic-103" }),
      },
    });

    const result = asRun(
      await run(
        scenario,
        args({
          companies: [
            { id: COMPANY_ID, nip: "0000000002" },
            { id: "company-synthetic-102", nip: "0000000003" },
            { id: "company-synthetic-103", nip: "0000000004" },
          ],
          confirm: true,
        }),
      ),
    );

    expect(scenario.count("updateCompany")).toBe(2);
    expect(statusesOf(result)).toEqual(["ok", "error", "not_attempted"]);
    expect(result.text).toBe(
      "update_records: attempted 2 of 3 - ok 1, errors 1, unknown 0, not attempted 1.",
    );
    expect(result.structured["counts"]).toEqual({
      ok: 1,
      skippedDuplicate: 0,
      error: 1,
      unknownOutcome: 0,
      notAttempted: 1,
    });
    expectPayload(result);
  });

  test("a rate-limited target read stops the plan instead of reading again", async () => {
    // An upstream that said stop is not hammered - and the plan phase is where
    // it says it first, on a dryRun that never reaches the executor at all.
    const scenario = world({ records: { [`person:${PERSON_ID}`]: RATE_LIMITED } });

    const result = asRun(
      await run(
        scenario,
        args({
          persons: [{ id: PERSON_ID, firstname: "Anna" }],
          companies: [{ id: COMPANY_ID, nip: "0000000002" }],
          dryRun: true,
        }),
      ),
    );

    expect(scenario.count("getRecord")).toBe(1);
    expect(planOf(result).map((item) => item["status"])).toEqual(["blocked", "blocked"]);
    expect(planOf(result).map((item) => (item["error"] as ToolError).code)).toEqual([
      "RATE_LIMITED",
      "RATE_LIMITED",
    ]);
    expect(result.isError).toBe(false);
    expectPayload(result);
  });

  test("the plan phase stops at the budget and blocks what it never reached", async () => {
    const scenario = world({
      records: {
        [`person:${PERSON_ID}`]: person({ id: PERSON_ID }),
        [`company:${COMPANY_ID}`]: company({ id: COMPANY_ID }),
      },
    });

    const result = asRun(
      await budgetSpentAfterFirstItem(() =>
        run(
          scenario,
          args({
            persons: [{ id: PERSON_ID, firstname: "Anna" }],
            companies: [{ id: COMPANY_ID, nip: "0000000002" }],
            dryRun: true,
          }),
        ),
      ),
    );

    expect(scenario.inputs("getRecord")).toEqual([`person:${PERSON_ID}`]);
    expect(planOf(result).map((item) => item["status"])).toEqual(["update", "blocked"]);
    expect(planOf(result)[1]?.["error"]).toEqual(PLAN_BUDGET_EXPIRED);
    expect(result.isError).toBe(false);
    expectPayload(result);
  });

  test("a caller who walked away before the plan gets no work and no result", async () => {
    const scenario = world();
    const controller = new AbortController();
    controller.abort();

    const error = await rejection(
      run(scenario, args({ persons: [{ id: PERSON_ID, firstname: "S" }], confirm: true }), {
        signal: controller.signal,
      }),
    );

    expect((error as LivespaceError).code).toBe("CANCELLED");
    expect(scenario.calls).toEqual([]);
  });

  test("an abort during a plan read rejects as CANCELLED", async () => {
    const controller = new AbortController();
    // The read itself aborts: the plan phase must reject, not block the item.
    const scenario = fakeWorld({
      onRead: () => {
        controller.abort();
        throw new Error("synthetic abort reason");
      },
    });

    const error = await rejection(
      run(scenario, args({ persons: [{ id: PERSON_ID, firstname: "S" }], confirm: true }), {
        signal: controller.signal,
      }),
    );

    expect((error as LivespaceError).code).toBe("CANCELLED");
    expect(scenario.count("updatePerson")).toBe(0);
  });
});

describe("the text channel and the output schema", () => {
  test("no CRM-authored name reaches the text channel", async () => {
    const scenario = fakeWorld({
      records: {
        [`person:${PERSON_ID}`]: person({ id: PERSON_ID, name: `Synthetic ${NAME_MARKER}` }),
      },
    });
    const call = (extra: Record<string, unknown>): UpdateRecordsArgs =>
      args({
        persons: [{ id: PERSON_ID, firstname: `Synthetic ${NAME_MARKER}` }],
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
    expect(updateRecordsToolConfig.outputSchema.safeParse({ errors: [] }).success).toBe(true);
    expect(
      updateRecordsToolConfig.outputSchema.safeParse({ errors: [], surprise: 1 }).success,
    ).toBe(false);
  });
});
