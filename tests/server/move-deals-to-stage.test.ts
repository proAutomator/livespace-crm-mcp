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
  DealStepState,
  ProcessStagePlanEntry,
} from "../../src/livespace/stage-moves.js";
import type { StepFlips, WriteFetchers } from "../../src/livespace/writes.js";
import type { MetadataService } from "../../src/server/tools/crm-metadata.js";
import {
  moveDealsToStageToolConfig,
  runMoveDealsToStage,
  type MoveDealsToStageArgs,
  type MoveDealsToStageDeps,
  type MoveDealsToStageResult,
} from "../../src/server/tools/move-deals-to-stage.js";
import type { ToolError, ToolRunResult } from "../../src/server/tools/tool-error.js";
import {
  PLAN_BUDGET_EXPIRED,
  WRITE_BATCH_CAP,
  WRITE_BUDGET_MS,
  type WriteState,
} from "../../src/server/tools/write-support.js";
import { deal } from "../support/records.js";

/**
 * `move_deals_to_stage` against fakes. Every value below is invented: no CRM
 * data, no sandbox values, and no call leaves the process (AGENTS.md).
 *
 * The marker stands in for a CRM-authored stage name - the kind of string a
 * before-value is made of. It may live in `structuredContent`, where the schema
 * types it as data, and must never reach the text channel or an approval prompt
 * (docs/security.md par. 4).
 */
const NAME_MARKER = "synthetic-name-marker";

/** The same idea for an upstream response body, which may never travel at all. */
const ENVELOPE_MARKER = "synthetic-envelope-marker";

/** The literal envelope key, spelled out so a rename upstream fails loudly. */
const CAPS_KEY = "io.modelcontextprotocol/clientCapabilities";

const PROCESS_ID = "process-synthetic-501";
const OTHER_PROCESS_ID = "process-synthetic-502";

const DEAL_A = "deal-synthetic-401";
const DEAL_B = "deal-synthetic-402";
const DEAL_C = "deal-synthetic-403";

/** The pinned pipeline: four stages of two steps each, in pipeline order. */
const STAGES: ProcessStagePlanEntry[] = [0, 1, 2, 3].map((index) => ({
  stageId: `stage-synthetic-${index}`,
  stageName: `Synthetic Stage ${index}`,
  steps: [`step-synthetic-${index}a`, `step-synthetic-${index}b`],
}));

/** A stage nobody can be moved to: the dictionary lists it with no steps. */
const EMPTY_STAGE_ID = "stage-synthetic-empty";

const PROCESSES: ProcessInfo[] = [
  {
    id: OTHER_PROCESS_ID,
    name: "Synthetic Other Process",
    stages: [
      {
        id: "stage-synthetic-other-0",
        name: "Synthetic Other Stage 0",
        steps: [{ id: "step-synthetic-other-0a", name: "Synthetic Other Step 0a" }],
      },
    ],
  },
  {
    id: PROCESS_ID,
    name: "Synthetic Process",
    stages: [
      ...STAGES.map((entry) => ({
        id: entry.stageId,
        name: entry.stageName,
        steps: entry.steps.map((step) => ({ id: step, name: `Synthetic Step ${step}` })),
      })),
      { id: EMPTY_STAGE_ID, name: "Synthetic Empty Stage", steps: [] },
    ],
  },
];

const RATE_LIMITED = new LivespaceError(
  "RATE_LIMITED",
  "Livespace rate-limited the request (HTTP 429).",
  "Wait before retrying; reduce request frequency if it persists.",
);

const VALIDATION_420: ToolError = {
  code: "VALIDATION_ERROR",
  message: "Livespace rejected the request as invalid (420).",
  hint: "One or more field values are invalid for this method. Fix them and retry.",
};

const DEAL_NOT_FOUND: ToolError = {
  code: "NOT_FOUND",
  message: "Deal not found.",
  hint: "The id does not exist or the API key's user cannot see it - take ids from search_crm or get_records.",
};

function dealState(overrides: Partial<DealStepState> = {}): DealStepState {
  return {
    processId: PROCESS_ID,
    status: "open",
    stageId: "",
    stageName: "",
    substageName: "",
    order: STAGES,
    checked: {},
    ...overrides,
  };
}

/** Every checked step of stages 0..position, as `Deal/get` reports them. */
function checkedThrough(position: number): Record<string, string[]> {
  const checked: Record<string, string[]> = {};
  for (const [index, entry] of STAGES.entries()) {
    if (index <= position) checked[entry.stageId] = [...entry.steps];
  }
  return checked;
}

/** A deal standing on `position`, with every step below it checked. */
function standingAt(position: number): DealStepState {
  return dealState({
    stageId: `stage-synthetic-${position}`,
    stageName: `Synthetic Stage ${position}`,
    substageName: `Synthetic Step ${position}b`,
    checked: checkedThrough(position),
  });
}

/** The deal record a re-read returns once the move landed. */
function landedOn(id: string, position: number): ReturnType<typeof deal> {
  return deal({
    id,
    processId: PROCESS_ID,
    stageId: `stage-synthetic-${position}`,
    stageName: `Synthetic Stage ${position}`,
    substageId: `step-synthetic-${position}a`,
    substageName: `Synthetic Step ${position}a`,
  });
}

type Answer = LivespaceError | undefined;

interface Canning {
  /** Deal id -> the state a plan read finds. An Error throws; an ARRAY gives
   *  one answer per call on that id (the last one repeats). */
  states?: Record<string, unknown>;
  moveDealSteps?: (call: number, dealId: string, flips: StepFlips) => Answer;
  /** Re-read answers, keyed `deal:<id>`, with the same array semantics. */
  records?: Record<string, unknown>;
  processes?: unknown;
  /** Runs before every step-state answer; throwing here is a read that failed. */
  onRead?: (dealId: string, call: number) => void;
}

interface Recorded {
  method: string;
  input: unknown;
  opts: unknown;
}

/**
 * The fakes implement exactly the fetchers `move_deals_to_stage` may touch and
 * RECORD every call. Every other write fetcher throws: a stage move that
 * reaches for one is a bug, not a passing test.
 */
function fakeWorld(canned: Canning = {}) {
  const calls: Recorded[] = [];
  const seen = new Map<string, number>();
  const push = (method: string, input: unknown, opts: unknown): number => {
    const call = calls.filter((entry) => entry.method === method).length;
    calls.push({ method, input, opts });
    return call;
  };
  const answerFor = (
    table: Record<string, unknown> | undefined,
    key: string,
  ): unknown => {
    const at = seen.get(key) ?? 0;
    seen.set(key, at + 1);
    const canning = table?.[key];
    const answer = Array.isArray(canning)
      ? canning[Math.min(at, canning.length - 1)]
      : canning;
    if (answer instanceof Error) throw answer;
    return answer ?? null;
  };
  const never =
    (method: string) =>
    async (): Promise<never> => {
      throw new Error(`move_deals_to_stage must never call ${method}`);
    };

  const deals = {
    readStepState: async (dealId: string, opts?: unknown) => {
      const call = push("readStepState", dealId, opts);
      canned.onRead?.(dealId, call);
      return answerFor(canned.states, dealId) as DealStepState | null;
    },
  };

  const writes = {
    moveDealSteps: async (dealId: string, flips: StepFlips, opts?: unknown) => {
      const call = push("moveDealSteps", { dealId, flips }, opts);
      const answer = canned.moveDealSteps?.(call, dealId, flips);
      if (answer !== undefined) throw answer;
    },
    createPerson: never("createPerson"),
    createCompany: never("createCompany"),
    createDeal: never("createDeal"),
    createTask: never("createTask"),
    updatePerson: never("updatePerson"),
    updateCompany: never("updateCompany"),
    updateDeal: never("updateDeal"),
    updateTask: never("updateTask"),
    addNote: never("addNote"),
    addCall: never("addCall"),
    sendNotification: never("sendNotification"),
    findPersonByEmail: never("findPersonByEmail"),
    findCompanyByName: never("findCompanyByName"),
  } as unknown as WriteFetchers;

  const records = {
    getRecord: async (kind: RecordKind, id: string, opts?: unknown) => {
      const key = `${kind}:${id}`;
      push("getRecord", key, opts);
      return answerFor(canned.records, key);
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

  const deps: MoveDealsToStageDeps = { deals, writes, records, metadata, codec };
  const inputs = (method: string): unknown[] =>
    calls.filter((entry) => entry.method === method).map((entry) => entry.input);
  const count = (method: string): number => inputs(method).length;
  return { deps, calls, minted, inputs, count };
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

function args(value: Record<string, unknown>): MoveDealsToStageArgs {
  return value as unknown as MoveDealsToStageArgs;
}

function run(
  world: World,
  call: MoveDealsToStageArgs,
  opts: { signal?: AbortSignal; ctx?: unknown } = {},
): Promise<MoveDealsToStageResult> {
  return runMoveDealsToStage(world.deps, call, opts);
}

function asRun(result: MoveDealsToStageResult): ToolRunResult {
  if (isInputRequiredResult(result)) {
    throw new Error("expected a tool result, got an input-required result");
  }
  return result;
}

function asInputRequired(result: MoveDealsToStageResult): InputRequiredResult {
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
  const parsed = moveDealsToStageToolConfig.outputSchema.safeParse(result.structured);
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

/** Round one asks the human, round two carries the minted state back. */
async function twoRounds(
  scenario: World,
  call: MoveDealsToStageArgs,
): Promise<ToolRunResult> {
  const first = await run(scenario, call, { ctx: ctx({ elicitation: true }) });
  asInputRequired(first);
  const state = scenario.minted[0] as WriteState;
  return asRun(
    await run(scenario, call, { ctx: ctx({ elicitation: true, state, confirm: true }) }),
  );
}

describe("moveDealsToStageToolConfig", () => {
  test("the annotations declare a destructive, idempotent write", () => {
    expect(moveDealsToStageToolConfig.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  test("the input schema is a plain object at the JSON Schema root", () => {
    const json = z.toJSONSchema(moveDealsToStageToolConfig.inputSchema) as Record<
      string,
      unknown
    >;
    expect(json["type"]).toBe("object");
    expect(json["oneOf"]).toBeUndefined();
  });

  test("the description discloses the fabricated completion in fixed wording", () => {
    const description = moveDealsToStageToolConfig.description.replace(/\s+/gu, " ");
    expect(description).toContain(
      "a forward move marks intermediate steps as completed and a backward move un-marks them - the checkboxes stop being evidence of work done",
    );
    expect(description).toContain("10 deals per call");
    expect(description).toContain("confirm: true");
    expect(description).toContain("allowBackwardDealIds");
  });
});

describe("the input schema", () => {
  const parse = (value: unknown): boolean =>
    moveDealsToStageToolConfig.inputSchema.safeParse(value).success;

  test("the root object is strict and names both required arguments", () => {
    expect(parse({ dealIds: [DEAL_A], stageId: "stage-synthetic-2" })).toBe(true);
    expect(parse({ dealIds: [DEAL_A] })).toBe(false);
    expect(parse({ stageId: "stage-synthetic-2" })).toBe(false);
    expect(
      parse({ dealIds: [DEAL_A], stageId: "stage-synthetic-2", surprise: 1 }),
    ).toBe(false);
  });

  test("the batch cap is the shared constant, and one more id is refused", () => {
    const ids = Array.from({ length: WRITE_BATCH_CAP }, (_, i) => `deal-synthetic-4${i}`);
    expect(parse({ dealIds: ids, stageId: "stage-synthetic-2" })).toBe(true);
    expect(
      parse({ dealIds: [...ids, "deal-synthetic-499"], stageId: "stage-synthetic-2" }),
    ).toBe(false);
    expect(parse({ dealIds: [], stageId: "stage-synthetic-2" })).toBe(false);
  });

  test("ids and the stage id are bounded strings", () => {
    expect(parse({ dealIds: [""], stageId: "stage-synthetic-2" })).toBe(false);
    expect(parse({ dealIds: ["x".repeat(65)], stageId: "stage-synthetic-2" })).toBe(false);
    expect(parse({ dealIds: [DEAL_A], stageId: "" })).toBe(false);
    expect(parse({ dealIds: [DEAL_A], stageId: "x".repeat(65) })).toBe(false);
  });

  test("the backward permission is an optional, capped id list", () => {
    expect(
      parse({
        dealIds: [DEAL_A],
        stageId: "stage-synthetic-2",
        allowBackwardDealIds: [DEAL_A],
      }),
    ).toBe(true);
    expect(
      parse({
        dealIds: [DEAL_A],
        stageId: "stage-synthetic-2",
        allowBackwardDealIds: [],
      }),
    ).toBe(true);
    expect(
      parse({
        dealIds: [DEAL_A],
        stageId: "stage-synthetic-2",
        allowBackwardDealIds: Array.from(
          { length: WRITE_BATCH_CAP + 1 },
          (_, i) => `deal-synthetic-5${i}`,
        ),
      }),
    ).toBe(false);
    // No call-level blanket permission: a boolean is not an id list.
    expect(
      parse({ dealIds: [DEAL_A], stageId: "stage-synthetic-2", allowBackward: true }),
    ).toBe(false);
  });
});

describe("argument rules", () => {
  test("the same deal id twice is refused rather than raced", async () => {
    const scenario = fakeWorld();

    const result = asRun(
      await run(scenario, args({ dealIds: [DEAL_A, DEAL_A], stageId: "stage-synthetic-2" })),
    );

    expect(result.isError).toBe(true);
    expect(result.text).toBe("move_deals_to_stage failed: BAD_PARAMS.");
    expect(errorsOf(result)[0]?.code).toBe("BAD_PARAMS");
    expect(scenario.calls).toEqual([]);
    expectPayload(result);
  });

  test("a backward permission for a deal outside the batch is refused", async () => {
    const scenario = fakeWorld();

    const result = asRun(
      await run(
        scenario,
        args({
          dealIds: [DEAL_A],
          stageId: "stage-synthetic-2",
          allowBackwardDealIds: [DEAL_B],
        }),
      ),
    );

    expect(errorsOf(result)[0]?.code).toBe("BAD_PARAMS");
    expect(errorsOf(result)[0]?.hint).toContain("allowBackwardDealIds");
    expect(scenario.calls).toEqual([]);
  });

  test("a stage id no process knows is NOT_FOUND, and no deal is read", async () => {
    const scenario = fakeWorld({ states: { [DEAL_A]: standingAt(0) } });

    const result = asRun(
      await run(scenario, args({ dealIds: [DEAL_A], stageId: "stage-synthetic-999" })),
    );

    expect(result.isError).toBe(true);
    expect(errorsOf(result)[0]).toEqual({
      code: "NOT_FOUND",
      message: "Stage not found.",
      hint: 'Call crm_metadata (sections: ["processes"]) for valid stage ids.',
    });
    expect(scenario.count("readStepState")).toBe(0);
    expect(scenario.count("moveDealSteps")).toBe(0);
    expectPayload(result);
  });

  test("a target stage with no steps is refused before any deal is read", async () => {
    const scenario = fakeWorld({ states: { [DEAL_A]: standingAt(0) } });

    const result = asRun(
      await run(scenario, args({ dealIds: [DEAL_A], stageId: EMPTY_STAGE_ID })),
    );

    expect(errorsOf(result)[0]?.code).toBe("BAD_PARAMS");
    expect(errorsOf(result)[0]?.hint).toContain("steps");
    expect(scenario.count("metadata")).toBe(1);
    expect(scenario.count("readStepState")).toBe(0);
    expectPayload(result);
  });

  test("a metadata read that fails refuses the call instead of guessing", async () => {
    const scenario = fakeWorld({ processes: RATE_LIMITED });

    const result = asRun(
      await run(scenario, args({ dealIds: [DEAL_A], stageId: "stage-synthetic-2" })),
    );

    expect(errorsOf(result)[0]?.code).toBe("RATE_LIMITED");
    expect(scenario.count("readStepState")).toBe(0);
  });
});

describe("the plan phase", () => {
  test("each deal is read once, and the plan pins the flips it would send", async () => {
    const scenario = fakeWorld({
      states: { [DEAL_A]: dealState(), [DEAL_B]: standingAt(2) },
    });

    const result = asRun(
      await run(
        scenario,
        args({ dealIds: [DEAL_A, DEAL_B], stageId: "stage-synthetic-2" }),
      ),
    );

    expect(scenario.inputs("readStepState")).toEqual([DEAL_A, DEAL_B]);
    expect(planOf(result)).toEqual([
      {
        index: 0,
        action: "move_deal",
        kind: "deal",
        status: "move",
        summary: {
          dealId: DEAL_A,
          targetStageId: "stage-synthetic-2",
          flips: {
            "step-synthetic-0a": 1,
            "step-synthetic-0b": 1,
            "step-synthetic-1a": 1,
            "step-synthetic-1b": 1,
            "step-synthetic-2a": 1,
          },
          stepsChecked: 5,
          stepsUnchecked: 0,
          before: { stageId: "", stageName: "", substageName: "" },
        },
      },
      {
        index: 1,
        action: "move_deal",
        kind: "deal",
        status: "unchanged",
        summary: {
          dealId: DEAL_B,
          targetStageId: "stage-synthetic-2",
          flips: {},
          stepsChecked: 0,
          stepsUnchecked: 0,
          before: {
            stageId: "stage-synthetic-2",
            stageName: "Synthetic Stage 2",
            substageName: "Synthetic Step 2b",
          },
        },
      },
    ]);
    expect(result.structured["aggregates"]).toEqual({
      forward: 1,
      backward: 0,
      unchangedCount: 1,
      stepsToCheck: 5,
      stepsToUncheck: 0,
    });
    expect(scenario.count("moveDealSteps")).toBe(0);
    expectPayload(result);
  });

  test("a deal that does not answer is blocked and never written", async () => {
    const scenario = fakeWorld({ states: { [DEAL_A]: null } });

    const preview = asRun(
      await run(scenario, args({ dealIds: [DEAL_A], stageId: "stage-synthetic-2" })),
    );

    expect(planOf(preview)[0]).toEqual({
      index: 0,
      action: "move_deal",
      kind: "deal",
      status: "blocked",
      summary: {
        dealId: DEAL_A,
        targetStageId: "stage-synthetic-2",
        flips: {},
        stepsChecked: 0,
        stepsUnchecked: 0,
      },
      error: DEAL_NOT_FOUND,
    });
    expectPayload(preview);

    const executed = asRun(
      await run(
        scenario,
        args({ dealIds: [DEAL_A], stageId: "stage-synthetic-2", confirm: true }),
      ),
    );
    expect(scenario.count("moveDealSteps")).toBe(0);
    expect(statusesOf(executed)).toEqual(["error"]);
    expect(resultsOf(executed)[0]?.["error"]).toEqual(DEAL_NOT_FOUND);
  });

  test("a deal in another process is blocked, whatever else is true of it", async () => {
    const scenario = fakeWorld({
      states: {
        [DEAL_A]: { ...standingAt(0), processId: OTHER_PROCESS_ID },
      },
    });

    const result = asRun(
      await run(scenario, args({ dealIds: [DEAL_A], stageId: "stage-synthetic-2" })),
    );

    expect(planOf(result)[0]?.["status"]).toBe("blocked");
    expect((planOf(result)[0]?.["error"] as ToolError).message).toBe(
      "This deal is not in the target stage's process.",
    );
  });

  test("a deal whose status is not exactly open is blocked - the guard fails closed", async () => {
    for (const status of ["won", "lost", "", "Open", "synthetic-unknown"]) {
      const scenario = fakeWorld({
        states: { [DEAL_A]: { ...standingAt(0), status } },
      });

      const result = asRun(
        await run(
          scenario,
          args({ dealIds: [DEAL_A], stageId: "stage-synthetic-2", confirm: true }),
        ),
      );

      expect(statusesOf(result)).toEqual(["error"]);
      expect((resultsOf(result)[0]?.["error"] as ToolError).message).toBe(
        "This deal is not open, so its pipeline position cannot be moved.",
      );
      expect(scenario.count("moveDealSteps")).toBe(0);
    }
  });

  test("a stage id and a checked step that disagree block the deal instead of guessing", async () => {
    const scenario = fakeWorld({
      states: {
        [DEAL_A]: dealState({
          stageId: "stage-synthetic-3",
          stageName: "Synthetic Stage 3",
          checked: { "stage-synthetic-0": ["step-synthetic-0a"] },
        }),
      },
    });

    const result = asRun(
      await run(
        scenario,
        args({ dealIds: [DEAL_A], stageId: "stage-synthetic-2", confirm: true }),
      ),
    );

    expect((resultsOf(result)[0]?.["error"] as ToolError).message).toBe(
      "The deal's stage and its checked steps disagree, so no step edit is safe.",
    );
    expect(scenario.count("moveDealSteps")).toBe(0);
  });

  test("a backward move without this deal's own permission is blocked", async () => {
    const scenario = fakeWorld({ states: { [DEAL_A]: standingAt(3) } });

    const result = asRun(
      await run(scenario, args({ dealIds: [DEAL_A], stageId: "stage-synthetic-1" })),
    );

    expect(planOf(result)[0]?.["status"]).toBe("blocked");
    expect(planOf(result)[0]?.["error"]).toEqual({
      code: "BLOCKED",
      message: "This move is backward and the deal is not listed in allowBackwardDealIds.",
      hint: "Add the deal id to allowBackwardDealIds to un-mark the steps above the target stage.",
    });
    expect(scenario.count("moveDealSteps")).toBe(0);
  });

  test("a rate-limited read stops the plan instead of reading again", async () => {
    const scenario = fakeWorld({
      states: { [DEAL_A]: RATE_LIMITED, [DEAL_B]: standingAt(0) },
    });

    const result = asRun(
      await run(
        scenario,
        args({ dealIds: [DEAL_A, DEAL_B], stageId: "stage-synthetic-2", dryRun: true }),
      ),
    );

    expect(scenario.inputs("readStepState")).toEqual([DEAL_A]);
    expect(planOf(result).map((item) => item["status"])).toEqual(["blocked", "blocked"]);
    expect(planOf(result).map((item) => (item["error"] as ToolError).code)).toEqual([
      "RATE_LIMITED",
      "RATE_LIMITED",
    ]);
    expect(result.isError).toBe(false);
    expectPayload(result);
  });

  test("the plan phase stops at the budget and blocks what it never reached", async () => {
    const scenario = fakeWorld({
      states: { [DEAL_A]: dealState(), [DEAL_B]: dealState() },
    });

    const result = asRun(
      await budgetSpentAfterFirstItem(() =>
        run(
          scenario,
          args({ dealIds: [DEAL_A, DEAL_B], stageId: "stage-synthetic-2", dryRun: true }),
        ),
      ),
    );

    expect(scenario.inputs("readStepState")).toEqual([DEAL_A]);
    expect(planOf(result).map((item) => item["status"])).toEqual(["move", "blocked"]);
    expect(planOf(result)[1]?.["error"]).toEqual(PLAN_BUDGET_EXPIRED);
    expect(result.isError).toBe(false);
    expectPayload(result);
  });
});

describe("the confirmation flow", () => {
  test("a plain call previews with counts and writes nothing", async () => {
    const scenario = fakeWorld({
      states: {
        [DEAL_A]: dealState(),
        [DEAL_B]: standingAt(3),
        [DEAL_C]: standingAt(3),
      },
    });

    const result = asRun(
      await run(
        scenario,
        args({
          dealIds: [DEAL_A, DEAL_B, DEAL_C],
          stageId: "stage-synthetic-2",
          allowBackwardDealIds: [DEAL_B],
        }),
      ),
    );

    expect(result.text).toBe(
      "move_deals_to_stage preview: 3 deal(s) - 1 forward, 1 backward, 0 unchanged, 1 blocked. 5 step(s) to mark done, 2 to un-mark. Re-call with confirm: true to execute.",
    );
    expect(result.structured["requiresConfirmation"]).toBe(true);
    expect(result.structured["results"]).toBeUndefined();
    expect(scenario.count("moveDealSteps")).toBe(0);
    expectPayload(result);
  });

  test("dryRun previews without claiming a confirmation is pending", async () => {
    const scenario = fakeWorld({ states: { [DEAL_A]: dealState() } });

    const result = asRun(
      await run(
        scenario,
        args({ dealIds: [DEAL_A], stageId: "stage-synthetic-2", dryRun: true }),
      ),
    );

    expect(result.structured["requiresConfirmation"]).toBeUndefined();
    expect(scenario.count("moveDealSteps")).toBe(0);
    expectPayload(result);
  });

  test("dryRun and confirm together are refused", async () => {
    const scenario = fakeWorld({ states: { [DEAL_A]: dealState() } });

    const result = asRun(
      await run(
        scenario,
        args({
          dealIds: [DEAL_A],
          stageId: "stage-synthetic-2",
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
      states: {
        [DEAL_A]: dealState(),
        [DEAL_B]: {
          ...standingAt(3),
          stageName: `Synthetic Stage ${NAME_MARKER}`,
        },
        [DEAL_C]: standingAt(3),
      },
    });

    const result = asInputRequired(
      await run(
        scenario,
        args({
          dealIds: [DEAL_A, DEAL_B, DEAL_C],
          stageId: "stage-synthetic-2",
          allowBackwardDealIds: [DEAL_B],
        }),
        { ctx: ctx({ elicitation: true }) },
      ),
    );

    expect(result.requestState).toBe("synthetic-wire-1");
    expect(elicitationMessageOf(result)).toBe(
      "Move 3 deal(s) to a pipeline stage: 1 forward, 1 backward, 0 unchanged. 5 step(s) will be marked done, 2 step(s) un-marked. Approve?",
    );
    // The approval string a human reads is ours: counts and fixed wording only.
    expect(JSON.stringify(result)).not.toContain(NAME_MARKER);
    expect(scenario.count("moveDealSteps")).toBe(0);
    expect(scenario.minted[0]).toEqual({
      tool: "move_deals_to_stage",
      argsHash: expect.stringMatching(/^[0-9a-f]{64}$/u) as unknown as string,
      previewDigest: expect.stringMatching(/^[0-9a-f]{64}$/u) as unknown as string,
      jti: expect.stringMatching(/^[0-9a-f]{32}$/u) as unknown as string,
    });
  });

  test("the model cannot self-confirm on an elicitation-capable client", async () => {
    const scenario = fakeWorld({ states: { [DEAL_A]: dealState() } });

    const result = await run(
      scenario,
      args({ dealIds: [DEAL_A], stageId: "stage-synthetic-2", confirm: true }),
      { ctx: ctx({ elicitation: true }) },
    );

    asInputRequired(result);
    expect(scenario.count("moveDealSteps")).toBe(0);
  });

  test("a declined confirmation writes nothing and says so", async () => {
    const scenario = fakeWorld({ states: { [DEAL_A]: dealState() } });
    const call = args({ dealIds: [DEAL_A], stageId: "stage-synthetic-2" });
    asInputRequired(await run(scenario, call, { ctx: ctx({ elicitation: true }) }));
    const state = scenario.minted[0] as WriteState;

    const result = asRun(
      await run(scenario, call, {
        ctx: ctx({ elicitation: true, state, confirm: "decline" }),
      }),
    );

    expect(result.text).toBe(
      [
        "move_deals_to_stage preview: 1 deal(s) - 1 forward, 0 backward, 0 unchanged, 0 blocked. 5 step(s) to mark done, 0 to un-mark. Re-call with confirm: true to execute.",
        "Confirmation was declined; nothing was written.",
      ].join("\n"),
    );
    expect(result.structured["declined"]).toBe(true);
    expect(scenario.count("moveDealSteps")).toBe(0);
    expectPayload(result);
  });

  test("an accepted confirmation executes the plan exactly once", async () => {
    const scenario = fakeWorld({
      states: { [DEAL_A]: dealState() },
      records: { [`deal:${DEAL_A}`]: landedOn(DEAL_A, 2) },
    });

    const result = await twoRounds(
      scenario,
      args({ dealIds: [DEAL_A], stageId: "stage-synthetic-2" }),
    );

    expect(scenario.count("moveDealSteps")).toBe(1);
    expect(statusesOf(result)).toEqual(["ok"]);
    expectPayload(result);
  });

  test("a replayed confirmation is refused and writes nothing", async () => {
    const scenario = fakeWorld({
      states: { [DEAL_A]: dealState() },
      records: { [`deal:${DEAL_A}`]: landedOn(DEAL_A, 2) },
    });
    const call = args({ dealIds: [DEAL_A], stageId: "stage-synthetic-2" });
    await twoRounds(scenario, call);
    const state = scenario.minted[0] as WriteState;

    const replay = asRun(
      await run(scenario, call, { ctx: ctx({ elicitation: true, state, confirm: true }) }),
    );

    expect(errorsOf(replay)[0]?.code).toBe("BAD_PARAMS");
    expect(scenario.count("moveDealSteps")).toBe(1);
  });

  test("a sibling step checked between the rounds sends the batch back for a fresh yes", async () => {
    // The digest binds the actual flips: someone ticking one more step upstream
    // changes what this call would send, so the approved plan is no longer the
    // plan that would run.
    const scenario = fakeWorld({
      states: {
        [DEAL_A]: [
          dealState(),
          dealState({ checked: { "stage-synthetic-0": ["step-synthetic-0b"] } }),
        ],
      },
    });
    const call = args({ dealIds: [DEAL_A], stageId: "stage-synthetic-2" });
    asInputRequired(await run(scenario, call, { ctx: ctx({ elicitation: true }) }));
    const state = scenario.minted[0] as WriteState;

    const result = asRun(
      await run(scenario, call, { ctx: ctx({ elicitation: true, state, confirm: true }) }),
    );

    expect(scenario.count("moveDealSteps")).toBe(0);
    expect(result.structured["recordsChanged"]).toBe(true);
    expect(result.structured["requiresConfirmation"]).toBe(true);
    expect(result.text).toBe(
      [
        "move_deals_to_stage preview: 1 deal(s) - 1 forward, 0 backward, 0 unchanged, 0 blocked. 4 step(s) to mark done, 0 to un-mark. Re-call with confirm: true to execute.",
        "Records changed since the preview; review and confirm again.",
      ].join("\n"),
    );
    expectPayload(result);
  });

  test("a confirmation minted for another tool is refused", async () => {
    const scenario = fakeWorld({ states: { [DEAL_A]: dealState() } });
    const state: WriteState = {
      tool: "update_records",
      argsHash: "hash-synthetic-a",
      previewDigest: "digest-synthetic-a",
      jti: "jti-synthetic-other-tool-move",
    };

    const result = asRun(
      await run(scenario, args({ dealIds: [DEAL_A], stageId: "stage-synthetic-2" }), {
        ctx: ctx({ elicitation: true, state, confirm: true }),
      }),
    );

    expect(errorsOf(result)[0]?.code).toBe("BAD_PARAMS");
    expect(scenario.calls).toEqual([]);
  });
});

describe("execution", () => {
  test("a forward move sends only the gaps and reports before, after and the steps", async () => {
    const scenario = fakeWorld({
      states: { [DEAL_A]: standingAt(0) },
      records: { [`deal:${DEAL_A}`]: landedOn(DEAL_A, 2) },
    });

    const result = asRun(
      await run(
        scenario,
        args({ dealIds: [DEAL_A], stageId: "stage-synthetic-2", confirm: true }),
      ),
    );

    expect(scenario.inputs("moveDealSteps")).toEqual([
      {
        dealId: DEAL_A,
        flips: {
          "step-synthetic-1a": 1,
          "step-synthetic-1b": 1,
          "step-synthetic-2a": 1,
        },
      },
    ]);
    expect(resultsOf(result)[0]).toEqual({
      index: 0,
      action: "move_deal",
      kind: "deal",
      status: "ok",
      id: DEAL_A,
      moved: true,
      stepsChecked: 3,
      stepsUnchecked: 0,
      before: {
        stageId: "stage-synthetic-0",
        stageName: "Synthetic Stage 0",
        substageName: "Synthetic Step 0b",
      },
      after: {
        stageId: "stage-synthetic-2",
        stageName: "Synthetic Stage 2",
        substageName: "Synthetic Step 2a",
      },
      verification: "verified",
    });
    expect(result.text).toBe(
      "move_deals_to_stage: attempted 1 of 1 - moved 1, unchanged 0, blocked 0, errors 0, unknown 0, not attempted 0.",
    );
    expectPayload(result);
  });

  test("a backward move with the deal's own permission sends zeroes", async () => {
    const scenario = fakeWorld({
      states: { [DEAL_A]: standingAt(3) },
      records: { [`deal:${DEAL_A}`]: landedOn(DEAL_A, 1) },
    });

    const result = asRun(
      await run(
        scenario,
        args({
          dealIds: [DEAL_A],
          stageId: "stage-synthetic-1",
          allowBackwardDealIds: [DEAL_A],
          confirm: true,
        }),
      ),
    );

    expect(scenario.inputs("moveDealSteps")).toEqual([
      {
        dealId: DEAL_A,
        flips: {
          "step-synthetic-2a": 0,
          "step-synthetic-2b": 0,
          "step-synthetic-3a": 0,
          "step-synthetic-3b": 0,
        },
      },
    ]);
    expect(resultsOf(result)[0]?.["stepsUnchecked"]).toBe(4);
    expect(resultsOf(result)[0]?.["stepsChecked"]).toBe(0);
    expect(resultsOf(result)[0]?.["verification"]).toBe("verified");
    expectPayload(result);
  });

  test("a deal already standing on the target is ok without a single write", async () => {
    const scenario = fakeWorld({ states: { [DEAL_A]: standingAt(2) } });

    const result = asRun(
      await run(
        scenario,
        args({ dealIds: [DEAL_A], stageId: "stage-synthetic-2", confirm: true }),
      ),
    );

    expect(scenario.count("moveDealSteps")).toBe(0);
    // Nothing was dispatched, so nothing was re-read either.
    expect(scenario.count("getRecord")).toBe(0);
    expect(resultsOf(result)[0]).toEqual({
      index: 0,
      action: "move_deal",
      kind: "deal",
      status: "ok",
      moved: false,
      stepsChecked: 0,
      stepsUnchecked: 0,
      before: {
        stageId: "stage-synthetic-2",
        stageName: "Synthetic Stage 2",
        substageName: "Synthetic Step 2b",
      },
      after: {
        stageId: "stage-synthetic-2",
        stageName: "Synthetic Stage 2",
        substageName: "Synthetic Step 2b",
      },
    });
    expect(result.text).toBe(
      "move_deals_to_stage: attempted 1 of 1 - moved 0, unchanged 1, blocked 0, errors 0, unknown 0, not attempted 0.",
    );
    expect(result.isError).toBe(false);
    expectPayload(result);
  });

  test("a mixed batch moves the flagged deal and blocks the unflagged one", async () => {
    const scenario = fakeWorld({
      states: {
        [DEAL_A]: dealState(),
        [DEAL_B]: standingAt(3),
        [DEAL_C]: standingAt(3),
      },
      records: {
        [`deal:${DEAL_A}`]: landedOn(DEAL_A, 2),
        [`deal:${DEAL_B}`]: landedOn(DEAL_B, 2),
      },
    });

    const result = asRun(
      await run(
        scenario,
        args({
          dealIds: [DEAL_A, DEAL_B, DEAL_C],
          stageId: "stage-synthetic-2",
          allowBackwardDealIds: [DEAL_B],
          confirm: true,
        }),
      ),
    );

    expect(scenario.inputs("moveDealSteps")).toEqual([
      {
        dealId: DEAL_A,
        flips: {
          "step-synthetic-0a": 1,
          "step-synthetic-0b": 1,
          "step-synthetic-1a": 1,
          "step-synthetic-1b": 1,
          "step-synthetic-2a": 1,
        },
      },
      { dealId: DEAL_B, flips: { "step-synthetic-3a": 0, "step-synthetic-3b": 0 } },
    ]);
    expect(statusesOf(result)).toEqual(["ok", "ok", "error"]);
    expect(resultsOf(result)[2]?.["error"]).toEqual({
      code: "BLOCKED",
      message: "This move is backward and the deal is not listed in allowBackwardDealIds.",
      hint: "Add the deal id to allowBackwardDealIds to un-mark the steps above the target stage.",
    });
    expect(result.text).toBe(
      "move_deals_to_stage: attempted 2 of 3 - moved 2, unchanged 0, blocked 1, errors 0, unknown 0, not attempted 0.",
    );
    expectPayload(result);
  });

  test("a deal that did not reach the target names the field that did not stick", async () => {
    const scenario = fakeWorld({
      states: { [DEAL_A]: standingAt(0) },
      records: { [`deal:${DEAL_A}`]: landedOn(DEAL_A, 1) },
    });

    const result = asRun(
      await run(
        scenario,
        args({ dealIds: [DEAL_A], stageId: "stage-synthetic-2", confirm: true }),
      ),
    );

    expect(resultsOf(result)[0]?.["status"]).toBe("ok");
    expect(resultsOf(result)[0]?.["verification"]).toBe("verified");
    expect(resultsOf(result)[0]?.["unappliedFields"]).toEqual(["stageId"]);
    expectPayload(result);
  });

  test("a re-read that fails leaves the applied move ok and unverified", async () => {
    const scenario = fakeWorld({
      states: { [DEAL_A]: standingAt(0) },
      records: { [`deal:${DEAL_A}`]: new Error("synthetic read failure") },
    });

    const result = asRun(
      await run(
        scenario,
        args({ dealIds: [DEAL_A], stageId: "stage-synthetic-2", confirm: true }),
      ),
    );

    expect(resultsOf(result)[0]?.["status"]).toBe("ok");
    expect(resultsOf(result)[0]?.["verification"]).toBe("unavailable");
    expect(resultsOf(result)[0]?.["after"]).toBeUndefined();
    expect(resultsOf(result)[0]?.["moved"]).toBe(true);
    expectPayload(result);
  });

  test("the executed line splits blocked deals out of the error count", async () => {
    const envelope = {
      status: false,
      result: 420,
      error: `invalid step id: ${ENVELOPE_MARKER}`,
    };
    const scenario = fakeWorld({
      states: {
        [DEAL_A]: dealState(),
        [DEAL_B]: standingAt(3),
        [DEAL_C]: standingAt(0),
      },
      records: { [`deal:${DEAL_A}`]: landedOn(DEAL_A, 2) },
      moveDealSteps: (_call, dealId) =>
        dealId === DEAL_C ? errorFromEnvelope(envelope.result) : undefined,
    });

    const result = asRun(
      await run(
        scenario,
        args({
          dealIds: [DEAL_A, DEAL_B, DEAL_C],
          stageId: "stage-synthetic-2",
          confirm: true,
        }),
      ),
    );

    expect(statusesOf(result)).toEqual(["ok", "error", "error"]);
    expect(resultsOf(result)[2]?.["error"]).toEqual(VALIDATION_420);
    expect(result.text).toBe(
      "move_deals_to_stage: attempted 2 of 3 - moved 1, unchanged 0, blocked 1, errors 1, unknown 0, not attempted 0.",
    );
    // The envelope a 420 arrives in carries upstream text; the client maps the
    // RESULT CODE and nothing else (docs/security.md par. 6).
    const wire = `${result.text}\n${JSON.stringify(result.structured)}`;
    expect(envelope.error).toContain(ENVELOPE_MARKER);
    expect(wire).not.toContain(ENVELOPE_MARKER);
    expectPayload(result);
  });

  test("a batch whose every attempt failed is an error", async () => {
    const scenario = fakeWorld({
      states: { [DEAL_A]: dealState() },
      moveDealSteps: () => errorFromEnvelope(420),
    });

    const result = asRun(
      await run(
        scenario,
        args({ dealIds: [DEAL_A], stageId: "stage-synthetic-2", confirm: true }),
      ),
    );

    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      "move_deals_to_stage: attempted 1 of 1 - moved 0, unchanged 0, blocked 0, errors 1, unknown 0, not attempted 0.",
    );
  });

  test("a rate-limited move leaves the rest not attempted", async () => {
    const scenario = fakeWorld({
      states: {
        [DEAL_A]: dealState(),
        [DEAL_B]: dealState(),
        [DEAL_C]: dealState(),
      },
      records: { [`deal:${DEAL_A}`]: landedOn(DEAL_A, 2) },
      moveDealSteps: (call) => (call === 1 ? RATE_LIMITED : undefined),
    });

    const result = asRun(
      await run(
        scenario,
        args({
          dealIds: [DEAL_A, DEAL_B, DEAL_C],
          stageId: "stage-synthetic-2",
          confirm: true,
        }),
      ),
    );

    expect(scenario.count("moveDealSteps")).toBe(2);
    expect(statusesOf(result)).toEqual(["ok", "error", "not_attempted"]);
    expect(result.text).toBe(
      "move_deals_to_stage: attempted 2 of 3 - moved 1, unchanged 0, blocked 0, errors 1, unknown 0, not attempted 1.",
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

  test("a move whose outcome is unknown is resolved by the stage the deal reached", async () => {
    const scenario = fakeWorld({
      states: { [DEAL_A]: standingAt(0) },
      records: { [`deal:${DEAL_A}`]: landedOn(DEAL_A, 2) },
      moveDealSteps: () =>
        new LivespaceError(
          "WRITE_OUTCOME_UNKNOWN",
          "The write request failed mid-flight; Livespace may or may not have applied it.",
          "Re-read the affected records to verify the outcome before retrying.",
        ),
    });

    const result = asRun(
      await run(
        scenario,
        args({ dealIds: [DEAL_A], stageId: "stage-synthetic-2", confirm: true }),
      ),
    );

    expect(statusesOf(result)).toEqual(["ok"]);
    expect(resultsOf(result)[0]?.["resolvedByReread"]).toBe(true);
    expect(resultsOf(result)[0]?.["verification"]).toBe("verified");
    expectPayload(result);
  });

  test("a move whose outcome is unknown and never landed stays unknown", async () => {
    const scenario = fakeWorld({
      states: { [DEAL_A]: standingAt(0) },
      records: { [`deal:${DEAL_A}`]: landedOn(DEAL_A, 0) },
      moveDealSteps: () =>
        new LivespaceError(
          "WRITE_OUTCOME_UNKNOWN",
          "The write request failed mid-flight; Livespace may or may not have applied it.",
          "Re-read the affected records to verify the outcome before retrying.",
        ),
    });

    const result = asRun(
      await run(
        scenario,
        args({ dealIds: [DEAL_A], stageId: "stage-synthetic-2", confirm: true }),
      ),
    );

    expect(statusesOf(result)).toEqual(["unknown_outcome"]);
    expect(result.text).toBe(
      "move_deals_to_stage: attempted 1 of 1 - moved 0, unchanged 0, blocked 0, errors 0, unknown 1, not attempted 0.",
    );
    expectPayload(result);
  });
});

describe("cancellation", () => {
  test("a caller who walked away before the plan gets no work and no result", async () => {
    const scenario = fakeWorld({ states: { [DEAL_A]: dealState() } });
    const controller = new AbortController();
    controller.abort();

    const error = await rejection(
      run(scenario, args({ dealIds: [DEAL_A], stageId: "stage-synthetic-2", confirm: true }), {
        signal: controller.signal,
      }),
    );

    expect((error as LivespaceError).code).toBe("CANCELLED");
    expect(scenario.calls).toEqual([]);
  });

  test("an abort during a plan read rejects as CANCELLED", async () => {
    const controller = new AbortController();
    const scenario = fakeWorld({
      states: { [DEAL_A]: dealState() },
      onRead: () => {
        controller.abort();
        throw new Error("synthetic abort reason");
      },
    });

    const error = await rejection(
      run(scenario, args({ dealIds: [DEAL_A], stageId: "stage-synthetic-2", confirm: true }), {
        signal: controller.signal,
      }),
    );

    expect((error as LivespaceError).code).toBe("CANCELLED");
    expect(scenario.count("moveDealSteps")).toBe(0);
  });
});

describe("the text channel and the output schema", () => {
  test("no CRM-authored stage name reaches the text channel", async () => {
    const scenario = fakeWorld({
      states: {
        [DEAL_A]: dealState({
          stageId: "stage-synthetic-0",
          stageName: `Synthetic Stage ${NAME_MARKER}`,
          substageName: `Synthetic Step ${NAME_MARKER}`,
          checked: checkedThrough(0),
        }),
      },
      records: {
        [`deal:${DEAL_A}`]: landedOn(DEAL_A, 2),
      },
    });
    const call = (extra: Record<string, unknown>): MoveDealsToStageArgs =>
      args({ dealIds: [DEAL_A], stageId: "stage-synthetic-2", ...extra });

    const preview = asRun(await run(scenario, call({})));
    const executed = asRun(await run(scenario, call({ confirm: true })));

    expect(preview.text).not.toContain(NAME_MARKER);
    expect(executed.text).not.toContain(NAME_MARKER);
    // The names are data, so they do travel in the structured channel.
    expect(JSON.stringify(preview.structured)).toContain(NAME_MARKER);
  });

  test("the output schema rejects a key nobody declared", () => {
    expect(moveDealsToStageToolConfig.outputSchema.safeParse({ errors: [] }).success).toBe(
      true,
    );
    expect(
      moveDealsToStageToolConfig.outputSchema.safeParse({ errors: [], surprise: 1 }).success,
    ).toBe(false);
  });
});
