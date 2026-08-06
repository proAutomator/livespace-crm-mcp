import { describe, expect, test } from "bun:test";
import { errorFromEnvelope, LivespaceError } from "../../src/livespace/errors.js";
import {
  computeStepDiff,
  createDealStepReader,
  type DealStepState,
  type ProcessStagePlanEntry,
  type StepDiff,
} from "../../src/livespace/stage-moves.js";

/**
 * The step-diff math and the deal-sourced state reader, pinned against fakes.
 * Every value here is invented (AGENTS.md): no CRM data, no sandbox values, and
 * no call ever leaves the process.
 *
 * Every diff row asserts the WHOLE verdict with `toStrictEqual`, so the exact
 * flip key set is part of the contract: a stray step id - above all a `1` that
 * re-sends an already-checked step, or a `0` on a forward move - fails the row
 * instead of hiding inside a subset match.
 */

const PROCESS_ID = "process-synthetic-501";

/** The ONE pinned fixture: four stages of two steps each, in pipeline order. */
const STAGES: ProcessStagePlanEntry[] = [0, 1, 2, 3].map((index) => ({
  stageId: `stage-synthetic-${index}`,
  stageName: `Synthetic Stage ${index}`,
  steps: [`step-synthetic-${index}a`, `step-synthetic-${index}b`],
}));

/** The same pipeline with a stage nobody can be moved to: it holds no steps. */
const STAGES_WITH_EMPTY: ProcessStagePlanEntry[] = STAGES.map((entry, index) =>
  index === 2 ? { ...entry, steps: [] } : entry,
);

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

function target(
  position: number,
  stages: ProcessStagePlanEntry[] = STAGES,
  processId: string = PROCESS_ID,
): { processId: string; position: number; stages: ProcessStagePlanEntry[] } {
  return { processId, position, stages };
}

/** Every checked step of stages 0..position, as `Deal/get` reports them. */
function checkedThrough(position: number): Record<string, string[]> {
  const checked: Record<string, string[]> = {};
  for (const [index, entry] of STAGES.entries()) {
    if (index <= position) checked[entry.stageId] = [...entry.steps];
  }
  return checked;
}

describe("computeStepDiff - forward moves", () => {
  test("a fresh deal is checked all the way up, and only ever checked", () => {
    const diff = computeStepDiff(dealState(), target(2), false);

    expect(diff).toStrictEqual({
      kind: "move",
      direction: "forward",
      flips: {
        "step-synthetic-0a": 1,
        "step-synthetic-0b": 1,
        "step-synthetic-1a": 1,
        "step-synthetic-1b": 1,
        // The target stage is entered by its FIRST step: that is what makes it
        // the furthest checked one (probe evidence 1).
        "step-synthetic-2a": 1,
      },
      stepsChecked: 5,
      stepsUnchecked: 0,
    });
  });

  test("entering the pipeline costs exactly one check", () => {
    // A deal with nothing checked stands BEFORE the first stage (probe
    // evidence 1), so the first stage is a real move, not a no-op.
    expect(computeStepDiff(dealState(), target(0), false)).toStrictEqual({
      kind: "move",
      direction: "forward",
      flips: { "step-synthetic-0a": 1 },
      stepsChecked: 1,
      stepsUnchecked: 0,
    });
  });

  test("only the gaps travel - a checked step is never re-sent", () => {
    const diff = computeStepDiff(
      dealState({
        stageId: "stage-synthetic-1",
        checked: {
          "stage-synthetic-0": ["step-synthetic-0a"],
          "stage-synthetic-1": ["step-synthetic-1b"],
        },
      }),
      target(3),
      false,
    );

    expect(diff).toStrictEqual({
      kind: "move",
      direction: "forward",
      flips: {
        "step-synthetic-0b": 1,
        "step-synthetic-1a": 1,
        "step-synthetic-2a": 1,
        "step-synthetic-2b": 1,
        "step-synthetic-3a": 1,
      },
      stepsChecked: 5,
      stepsUnchecked: 0,
    });
  });

  test("a target that already holds a checked step is never topped up", () => {
    // A checked step inside the target stage IS the deal standing there
    // (probe evidence 1), so the deal is already where it was asked to go and
    // the first step is not re-sent.
    const diff = computeStepDiff(
      dealState({
        stageId: "stage-synthetic-2",
        checked: {
          ...checkedThrough(1),
          "stage-synthetic-2": ["step-synthetic-2a"],
        },
      }),
      target(2),
      false,
    );

    expect(diff).toStrictEqual({ kind: "unchanged" });
  });

  test("a deal already standing on the target stage does nothing", () => {
    const diff = computeStepDiff(
      dealState({ stageId: "stage-synthetic-3", checked: checkedThrough(3) }),
      target(3),
      false,
    );

    expect(diff).toStrictEqual({ kind: "unchanged" });
  });

  test("the backward flag changes nothing about a forward move", () => {
    const state = dealState();
    expect(computeStepDiff(state, target(1), true)).toStrictEqual(
      computeStepDiff(state, target(1), false),
    );
  });
});

describe("computeStepDiff - backward moves", () => {
  const atStageThree = dealState({
    stageId: "stage-synthetic-3",
    checked: { ...checkedThrough(2), "stage-synthetic-3": ["step-synthetic-3a"] },
  });

  test("a backward move without this deal's own permission is blocked", () => {
    expect(computeStepDiff(atStageThree, target(1), false)).toStrictEqual({
      kind: "blocked",
      reason: "backward-needs-flag",
    });
  });

  test("a backward move un-marks exactly the steps above the target", () => {
    const diff = computeStepDiff(atStageThree, target(1), true);

    expect(diff).toStrictEqual({
      kind: "move",
      direction: "backward",
      flips: {
        "step-synthetic-2a": 0,
        "step-synthetic-2b": 0,
        "step-synthetic-3a": 0,
      },
      stepsChecked: 0,
      stepsUnchecked: 3,
    });
  });

  test("a backward move into a stage holding nothing tops up its first step", () => {
    // The mixed map: without the top-up the deal would fall back to whatever
    // stage still holds a checked step, not to the one that was asked for.
    const diff = computeStepDiff(
      dealState({
        stageId: "stage-synthetic-3",
        checked: { "stage-synthetic-3": ["step-synthetic-3a"] },
      }),
      target(1),
      true,
    );

    expect(diff).toStrictEqual({
      kind: "move",
      direction: "backward",
      flips: { "step-synthetic-3a": 0, "step-synthetic-1a": 1 },
      stepsChecked: 1,
      stepsUnchecked: 1,
    });
  });
});

describe("computeStepDiff - guards", () => {
  test("a foreign process blocks before anything else is even considered", () => {
    // Precedence: a closed deal in the wrong process reports the wrong
    // process. Foreign step ids answer 420 upstream (probe evidence 3), so
    // this guard is what keeps the batch away from that.
    expect(
      computeStepDiff(
        dealState({ processId: "process-synthetic-599", status: "won" }),
        target(2),
        false,
      ),
    ).toStrictEqual({ kind: "blocked", reason: "wrong-process" });
  });

  test("a deal with no process at all is blocked, not guessed at", () => {
    expect(computeStepDiff(dealState({ processId: "" }), target(2), false)).toStrictEqual({
      kind: "blocked",
      reason: "wrong-process",
    });
    expect(
      computeStepDiff(dealState(), target(2, STAGES, ""), false),
    ).toStrictEqual({ kind: "blocked", reason: "wrong-process" });
  });

  const closedStatuses = ["won", "lost", "", "Open", "synthetic-status"];
  for (const status of closedStatuses) {
    test(`status ${JSON.stringify(status)} is not an open deal`, () => {
      expect(computeStepDiff(dealState({ status }), target(2), false)).toStrictEqual({
        kind: "blocked",
        reason: "closed-deal",
      });
    });
  }

  test("a stage id above the furthest checked step is ambiguity, and ambiguity does nothing", () => {
    expect(
      computeStepDiff(
        dealState({
          stageId: "stage-synthetic-3",
          checked: { "stage-synthetic-1": ["step-synthetic-1a"] },
        }),
        target(2),
        true,
      ),
    ).toStrictEqual({ kind: "blocked", reason: "state-conflict" });
  });

  test("a checked step the deal's own definition does not know blocks the move", () => {
    expect(
      computeStepDiff(
        dealState({
          stageId: "stage-synthetic-2",
          checked: { "stage-synthetic-2": ["step-synthetic-9z"] },
        }),
        target(3),
        false,
      ),
    ).toStrictEqual({ kind: "blocked", reason: "state-conflict" });
  });

  test("a stage id the deal's own definition does not know blocks the move", () => {
    expect(
      computeStepDiff(dealState({ stageId: "stage-synthetic-9" }), target(2), false),
    ).toStrictEqual({ kind: "blocked", reason: "state-conflict" });
  });

  test("a target stage the deal's own definition does not know blocks the move", () => {
    // The dictionary can be up to a TTL stale; the deal is the source of truth,
    // so a stage only the dictionary knows is a disagreement, not a target.
    const foreign: ProcessStagePlanEntry[] = [
      ...STAGES,
      {
        stageId: "stage-synthetic-9",
        stageName: "Synthetic Stage 9",
        steps: ["step-synthetic-9a"],
      },
    ];

    expect(computeStepDiff(dealState(), target(4, foreign), false)).toStrictEqual({
      kind: "blocked",
      reason: "state-conflict",
    });
  });

  test("a target stage holding no steps cannot be reached", () => {
    expect(
      computeStepDiff(
        dealState({ order: STAGES_WITH_EMPTY }),
        target(2, STAGES_WITH_EMPTY),
        false,
      ),
    ).toStrictEqual({ kind: "blocked", reason: "empty-target" });
  });

  test("a position outside the pipeline is an empty target, not a crash", () => {
    expect(computeStepDiff(dealState(), target(9), false)).toStrictEqual({
      kind: "blocked",
      reason: "empty-target",
    });
    expect(
      computeStepDiff(dealState({ order: [] }), target(0, []), false),
    ).toStrictEqual({ kind: "blocked", reason: "empty-target" });
  });

  test("a conflicting state is reported before an empty target", () => {
    expect(
      computeStepDiff(
        dealState({
          order: STAGES_WITH_EMPTY,
          checked: { "stage-synthetic-0": ["step-synthetic-9z"] },
        }),
        target(2, STAGES_WITH_EMPTY),
        false,
      ),
    ).toStrictEqual({ kind: "blocked", reason: "state-conflict" });
  });

  test("a closed deal is reported before its state is picked apart", () => {
    expect(
      computeStepDiff(
        dealState({
          status: "won",
          checked: { "stage-synthetic-0": ["step-synthetic-9z"] },
        }),
        target(2),
        false,
      ),
    ).toStrictEqual({ kind: "blocked", reason: "closed-deal" });
  });

  test("every verdict is plain JSON: nothing here survives a digest as {}", () => {
    const verdicts: StepDiff[] = [
      computeStepDiff(dealState(), target(2), false),
      computeStepDiff(dealState({ status: "won" }), target(2), false),
      computeStepDiff(
        dealState({ stageId: "stage-synthetic-3", checked: checkedThrough(3) }),
        target(1),
        true,
      ),
    ];

    for (const verdict of verdicts) {
      expect(JSON.parse(JSON.stringify(verdict))).toStrictEqual(verdict);
    }
  });
});

interface FakeCall {
  module: string;
  method: string;
  params: Record<string, unknown>;
  opts: { write?: boolean; signal?: AbortSignal };
}

function readerFor(canned: unknown) {
  const calls: FakeCall[] = [];
  const client = {
    call: (async (
      module: string,
      method: string,
      params?: Record<string, unknown>,
      opts?: unknown,
    ) => {
      calls.push({
        module,
        method,
        params: params ?? {},
        opts: (opts ?? {}) as FakeCall["opts"],
      });
      if (canned instanceof Error) throw canned;
      return canned;
    }) as never,
  };
  return { reader: createDealStepReader(client), calls };
}

const STAGES_ALL = Object.fromEntries(
  STAGES.map((entry) => [entry.stageId, entry.stageName]),
);

const SUBSTAGES_ALL = Object.fromEntries(
  STAGES.map((entry, index) => [
    entry.stageId,
    Object.fromEntries(entry.steps.map((step, at) => [step, `Synthetic Step ${index}${at}`])),
  ]),
);

const DEAL_STEPS_RAW = {
  deal: {
    id: "deal-synthetic-401",
    process_id: PROCESS_ID,
    status: "open",
    stage_id: "stage-synthetic-1",
    stage_name: "Synthetic Stage 1",
    substage_name: "Synthetic Step 1b",
    stages_all: STAGES_ALL,
    substages_all: SUBSTAGES_ALL,
    // CHECKED steps only (probe evidence 4).
    substages: {
      "stage-synthetic-0": {
        "step-synthetic-0a": "Synthetic Step 0a",
        "step-synthetic-0b": "Synthetic Step 0b",
      },
      "stage-synthetic-1": { "step-synthetic-1b": "Synthetic Step 1b" },
    },
  },
};

const DEAL_STEPS_STATE: DealStepState = {
  processId: PROCESS_ID,
  status: "open",
  stageId: "stage-synthetic-1",
  stageName: "Synthetic Stage 1",
  substageName: "Synthetic Step 1b",
  order: STAGES,
  checked: {
    "stage-synthetic-0": ["step-synthetic-0a", "step-synthetic-0b"],
    "stage-synthetic-1": ["step-synthetic-1b"],
  },
};

describe("readDealStepState", () => {
  test("the deal's own step map parses into plain-JSON state", async () => {
    const { reader, calls } = readerFor(DEAL_STEPS_RAW);
    const signal = new AbortController().signal;

    const state = await reader.readStepState("deal-synthetic-401", { signal });

    expect(state).toStrictEqual(DEAL_STEPS_STATE);
    // Plain containers only: a Map or a Set would hash to {} in the preview
    // digest and let two different plans share a confirmation.
    expect(JSON.parse(JSON.stringify(state))).toStrictEqual(state);
    expect(calls).toHaveLength(1);
    const call = calls[0] as FakeCall;
    expect([call.module, call.method]).toEqual(["Deal", "get"]);
    expect(call.params).toStrictEqual({ id: "deal-synthetic-401" });
    // Reading the state is a read: it may retry, and it carries the signal.
    expect(call.opts.write).not.toBe(true);
    expect(call.opts.signal).toBe(signal);
  });

  test("the parsed order is the emission order of the deal's own stages", async () => {
    const { reader } = readerFor(DEAL_STEPS_RAW);

    const state = await reader.readStepState("deal-synthetic-401");

    expect(state?.order.map((entry) => entry.stageId)).toEqual([
      "stage-synthetic-0",
      "stage-synthetic-1",
      "stage-synthetic-2",
      "stage-synthetic-3",
    ]);
  });

  test("PHP empty maps normalize at the outer level", async () => {
    const { reader } = readerFor({
      deal: {
        id: "deal-synthetic-402",
        process_id: PROCESS_ID,
        status: "open",
        stages_all: [],
        substages_all: [],
        substages: [],
      },
    });

    const state = await reader.readStepState("deal-synthetic-402");

    expect(state).toStrictEqual({
      processId: PROCESS_ID,
      status: "open",
      stageId: "",
      stageName: "",
      substageName: "",
      order: [],
      checked: {},
    });
  });

  test("PHP empty maps normalize at the inner level too", async () => {
    const { reader } = readerFor({
      deal: {
        id: "deal-synthetic-403",
        process_id: PROCESS_ID,
        status: "open",
        stages_all: { "stage-synthetic-0": "Synthetic Stage 0" },
        substages_all: { "stage-synthetic-0": [] },
        substages: { "stage-synthetic-0": [] },
      },
    });

    const state = await reader.readStepState("deal-synthetic-403");

    expect(state?.order).toStrictEqual([
      { stageId: "stage-synthetic-0", stageName: "Synthetic Stage 0", steps: [] },
    ]);
    expect(state?.checked).toStrictEqual({ "stage-synthetic-0": [] });
  });

  test("checked steps arriving as a bare array of ids are read too", async () => {
    const { reader } = readerFor({
      deal: {
        id: "deal-synthetic-404",
        process_id: PROCESS_ID,
        status: "open",
        stages_all: STAGES_ALL,
        substages_all: SUBSTAGES_ALL,
        substages: { "stage-synthetic-0": ["step-synthetic-0a", "", 7] },
      },
    });

    const state = await reader.readStepState("deal-synthetic-404");

    expect(state?.checked).toStrictEqual({
      "stage-synthetic-0": ["step-synthetic-0a"],
    });
  });

  test("a stage the deal lists no steps for still keeps its place in the order", async () => {
    const { reader } = readerFor({
      deal: {
        id: "deal-synthetic-405",
        process_id: PROCESS_ID,
        status: "open",
        stages_all: STAGES_ALL,
        // A step map for a stage nobody listed is not a stage: the order comes
        // from `stages_all` alone.
        substages_all: {
          "stage-synthetic-1": SUBSTAGES_ALL["stage-synthetic-1"],
          "stage-synthetic-9": { "step-synthetic-9a": "Synthetic Step 9a" },
        },
        substages: [],
      },
    });

    const state = await reader.readStepState("deal-synthetic-405");

    expect(state?.order).toStrictEqual([
      { stageId: "stage-synthetic-0", stageName: "Synthetic Stage 0", steps: [] },
      {
        stageId: "stage-synthetic-1",
        stageName: "Synthetic Stage 1",
        steps: ["step-synthetic-1a", "step-synthetic-1b"],
      },
      { stageId: "stage-synthetic-2", stageName: "Synthetic Stage 2", steps: [] },
      { stageId: "stage-synthetic-3", stageName: "Synthetic Stage 3", steps: [] },
    ]);
  });

  test("the deal status is carried verbatim, whatever it says", async () => {
    const { reader } = readerFor({
      deal: {
        id: "deal-synthetic-406",
        process_id: PROCESS_ID,
        status: "won",
        stages_all: STAGES_ALL,
        substages_all: SUBSTAGES_ALL,
        substages: [],
      },
    });

    expect((await reader.readStepState("deal-synthetic-406"))?.status).toBe("won");
  });

  test("an unwrapped payload is accepted as the deal itself", async () => {
    const { reader } = readerFor({
      id: "deal-synthetic-407",
      process_id: PROCESS_ID,
      status: "open",
      stage_id: "stage-synthetic-0",
      stages_all: STAGES_ALL,
      substages_all: SUBSTAGES_ALL,
      substages: [],
    });

    expect((await reader.readStepState("deal-synthetic-407"))?.stageId).toBe(
      "stage-synthetic-0",
    );
  });

  const notFound: Array<[string, number]> = [
    // A deal nobody can see and a deal that does not exist are the same answer
    // upstream (probe evidence 8): 550 on deals, 540 on the permission path.
    ["550", 550],
    ["540", 540],
  ];

  for (const [label, resultCode] of notFound) {
    test(`result code ${label} reads as absent, not as a failure`, async () => {
      const { reader } = readerFor(errorFromEnvelope(resultCode));

      expect(await reader.readStepState("deal-synthetic-999")).toBeNull();
    });
  }

  test("a rate-limited read propagates - it is not an absent deal", async () => {
    const limited = new LivespaceError(
      "RATE_LIMITED",
      "Livespace rate-limited the request (HTTP 429).",
      "Wait before retrying; reduce request frequency if it persists.",
    );
    const { reader } = readerFor(limited);

    expect(await rejection(reader.readStepState("deal-synthetic-401"))).toBe(limited);
  });

  test("every other upstream failure propagates too", async () => {
    const { reader } = readerFor(errorFromEnvelope(500));

    const error = await rejection(reader.readStepState("deal-synthetic-401"));

    expect((error as LivespaceError).code).toBe("UPSTREAM_ERROR");
  });

  test("a payload that is not a deal fails with fixed wording", async () => {
    const { reader } = readerFor("synthetic string payload");

    const error = await rejection(reader.readStepState("deal-synthetic-401"));

    expect(error).toBeInstanceOf(LivespaceError);
    expect((error as LivespaceError).code).toBe("UPSTREAM_ERROR");
    expect((error as LivespaceError).message).toBe(
      "Livespace returned an unexpected shape for this deal.",
    );
  });
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}
