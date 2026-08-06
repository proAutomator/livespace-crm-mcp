import type { LivespaceClient } from "./client.js";
import { LivespaceError } from "./errors.js";
import { asName, asRecord, unexpectedShape } from "./shape.js";

/**
 * The step arithmetic behind `move_deals_to_stage`, and the reader that fetches
 * the state it runs on.
 *
 * Four facts from the live probes (2026-08-07, sandbox, recorded in the M7+M8
 * plan doc) decide everything here:
 *
 * 1. **The stage IS the furthest checked step.** There is no "set stage" call:
 *    a deal stands where its furthest checked process step stands, and a deal
 *    with nothing checked stands before the pipeline.
 * 2. **Step edits MERGE.** Only the flips are sent - a full map would re-send
 *    checked steps and un-check whatever it left out.
 * 3. **The DEAL is the source of truth**, not the cached dictionary. A deal
 *    carries its own `stages_all`/`substages_all`/`substages`, and the
 *    dictionary can be up to a TTL stale: numbering positions from a stale copy
 *    would move deals to the wrong place. The dictionary resolves the caller's
 *    stage id to a process and a position; everything else is read off the deal.
 * 4. **Foreign step ids answer 420.** A deal in another process is never
 *    diffed, so its steps are never sent.
 *
 * `computeStepDiff` is TOTAL: it never throws, and every refusal is a verdict
 * the caller can report. Ambiguity does nothing - a state whose stage id and
 * whose checked steps disagree is blocked rather than guessed at
 * (docs/security.md par. 5).
 *
 * Every container that leaves this module is plain JSON. A `Map` or a `Set`
 * would serialize to `{}` in the confirmation digest, and two different plans
 * would then hash alike.
 */

/** One pipeline stage: its id, its display name and its steps, in order. */
export interface ProcessStagePlanEntry {
  stageId: string;
  stageName: string;
  steps: string[];
}

/** A deal's own step state, as `Deal/get` reports it. */
export interface DealStepState {
  processId: string;
  /** The raw upstream label. Only the exact string "open" is an open deal. */
  status: string;
  stageId: string;
  stageName: string;
  substageName: string;
  /** ALL stages of the deal's process, in pipeline order. */
  order: ProcessStagePlanEntry[];
  /** Stage id -> the CHECKED step ids upstream reported under it. */
  checked: Record<string, string[]>;
}

export interface StageMoveTarget {
  processId: string;
  /** Index into `stages` - the dictionary's own numbering of the pipeline. */
  position: number;
  stages: ProcessStagePlanEntry[];
}

export type StepBlockReason =
  | "wrong-process"
  | "closed-deal"
  | "state-conflict"
  | "empty-target"
  | "backward-needs-flag";

export type StepDiff =
  | {
      kind: "move";
      direction: "forward" | "backward";
      /** Step id -> 1 (mark done) or 0 (un-mark). Never both for one step. */
      flips: Record<string, 0 | 1>;
      stepsChecked: number;
      stepsUnchecked: number;
    }
  | { kind: "unchanged" }
  | { kind: "blocked"; reason: StepBlockReason };

function blocked(reason: StepBlockReason): StepDiff {
  return { kind: "blocked", reason };
}

/**
 * The stage a step belongs to, by the DEAL's own definition. Linear: a process
 * is a handful of stages of a handful of steps, and an index would have to be a
 * Map or a prototype-safe record for ids we do not control.
 */
function positionOfStep(order: readonly ProcessStagePlanEntry[], stepId: string): number {
  for (const [index, entry] of order.entries()) {
    if (entry.steps.includes(stepId)) return index;
  }
  return -1;
}

function positionOfStage(order: readonly ProcessStagePlanEntry[], stageId: string): number {
  return order.findIndex((entry) => entry.stageId === stageId);
}

function isChecked(state: DealStepState, stepId: string): boolean {
  for (const steps of Object.values(state.checked)) {
    if (steps.includes(stepId)) return true;
  }
  return false;
}

/**
 * The minimal set of flips that moves ONE deal to a pipeline position.
 *
 * Guard precedence, and it is deliberate: a deal in the wrong process is
 * reported as such whatever else is true of it, a closed deal is reported
 * before its state is picked apart, and an ambiguous state is reported before
 * anything is computed from it.
 *
 * The direction is decided against the deal's CURRENT position, which is the
 * furthest of what its stage id says and what its checked steps say. Forward:
 * every unchecked step below the target is marked done, and the target is
 * entered by its first step. Backward (only with this deal's own permission):
 * every checked step above the target is un-marked, and the target is topped up
 * only when it holds no check of its own - otherwise the deal would fall back
 * to whatever stage still holds one.
 */
export function computeStepDiff(
  state: DealStepState,
  target: StageMoveTarget,
  allowBackward: boolean,
): StepDiff {
  // Fail closed: an unknown process, an empty one, or a mismatch all mean the
  // step ids are not this deal's to send.
  if (
    state.processId === "" ||
    target.processId === "" ||
    state.processId !== target.processId
  ) {
    return blocked("wrong-process");
  }
  if (state.status !== "open") return blocked("closed-deal");

  let furthestChecked = -1;
  for (const steps of Object.values(state.checked)) {
    for (const stepId of steps) {
      const at = positionOfStep(state.order, stepId);
      // A checked step the deal's own definition does not list: the two
      // answers cannot be reconciled, so nothing is sent.
      if (at === -1) return blocked("state-conflict");
      if (at > furthestChecked) furthestChecked = at;
    }
  }

  const stagePosition =
    state.stageId === "" ? -1 : positionOfStage(state.order, state.stageId);
  if (state.stageId !== "" && stagePosition === -1) return blocked("state-conflict");
  if (stagePosition >= 0 && furthestChecked >= 0 && stagePosition !== furthestChecked) {
    return blocked("state-conflict");
  }

  // The dictionary resolves the caller's stage id to a position in ITS copy of
  // the pipeline; the deal has to know that stage under the same id, and its
  // own numbering is what the diff runs on.
  const wanted = target.stages[target.position];
  const to = wanted === undefined ? -1 : positionOfStage(state.order, wanted.stageId);
  if (wanted !== undefined && to === -1) return blocked("state-conflict");

  const targetEntry = to === -1 ? undefined : state.order[to];
  const targetSteps = targetEntry?.steps ?? [];
  const firstStep = targetSteps[0];
  if (firstStep === undefined) return blocked("empty-target");

  const from = Math.max(stagePosition, furthestChecked);
  if (to === from) return { kind: "unchanged" };
  if (to < from && !allowBackward) return blocked("backward-needs-flag");

  const flips: Record<string, 0 | 1> = {};
  if (to > from) {
    for (const entry of state.order.slice(0, to)) {
      for (const stepId of entry.steps) {
        if (!isChecked(state, stepId)) flips[stepId] = 1;
      }
    }
  } else {
    for (const entry of state.order.slice(to + 1)) {
      for (const stepId of entry.steps) {
        if (isChecked(state, stepId)) flips[stepId] = 0;
      }
    }
  }
  // The one `1` a backward move may carry: without a check of its own the
  // target stage is not where the deal lands.
  if (!targetSteps.some((stepId) => isChecked(state, stepId))) flips[firstStep] = 1;

  const values = Object.values(flips);
  return {
    kind: "move",
    direction: to > from ? "forward" : "backward",
    flips,
    stepsChecked: values.filter((value) => value === 1).length,
    stepsUnchecked: values.filter((value) => value === 0).length,
  };
}

export interface DealStepReader {
  readStepState(
    dealId: string,
    opts?: { signal?: AbortSignal },
  ): Promise<DealStepState | null>;
}

/** Every shape failure in this module speaks about a deal. */
function badShape(): LivespaceError {
  return unexpectedShape("deal");
}

function idText(value: unknown): string {
  if (value === null || value === undefined || typeof value === "object") return "";
  return String(value);
}

/**
 * A step map, however PHP serialized it: an id-keyed record (the normal shape),
 * an empty `[]` (an empty map), or a bare list of ids. The KEY is the step id;
 * the value is the display name and is not read.
 */
function stepIds(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter(
      (entry): entry is string => typeof entry === "string" && entry !== "",
    );
  }
  const record = asRecord(value);
  if (record === null) return [];
  return Object.keys(record).filter((key) => key !== "");
}

/**
 * The deal's own pipeline: `stages_all` gives the order and the names,
 * `substages_all` the steps under each stage. Emission order IS pipeline order,
 * so nothing here sorts. A step map for a stage `stages_all` never mentioned is
 * not a stage - the order comes from `stages_all` alone.
 */
function flattenDealStages(data: Record<string, unknown>): ProcessStagePlanEntry[] {
  const stages = asRecord(data["stages_all"]) ?? {};
  const steps = asRecord(data["substages_all"]) ?? {};
  return Object.entries(stages).map(([stageId, name]) => ({
    stageId,
    stageName: asName(name),
    steps: stepIds(steps[stageId]),
  }));
}

function checkedSteps(value: unknown): Record<string, string[]> {
  const record = asRecord(value);
  if (record === null) return {};
  const checked: Record<string, string[]> = {};
  for (const [stageId, steps] of Object.entries(record)) checked[stageId] = stepIds(steps);
  return checked;
}

/**
 * Upstream conflates "does not exist" with "the key's user cannot see it", and
 * spells it 550 on deals and 540 on the permission path. Both read as absent;
 * nothing else does - a rate limit or a timeout is a failure the plan loop has
 * to see, not a deal that is not there.
 */
function isAbsent(error: unknown): boolean {
  return (
    error instanceof LivespaceError &&
    (error.resultCode === 540 || error.resultCode === 550)
  );
}

export function createDealStepReader(
  client: Pick<LivespaceClient, "call">,
): DealStepReader {
  return {
    readStepState: async (dealId, opts) => {
      try {
        const payload = await client.call(
          "Deal",
          "get",
          { id: dealId },
          { signal: opts?.signal },
        );
        const wrapper = asRecord(payload);
        const data = (wrapper === null ? null : asRecord(wrapper["deal"])) ?? wrapper;
        if (data === null) throw badShape();
        return {
          processId: idText(data["process_id"]),
          status: asName(data["status"]),
          stageId: idText(data["stage_id"]),
          stageName: asName(data["stage_name"]),
          substageName: asName(data["substage_name"]),
          order: flattenDealStages(data),
          checked: checkedSteps(data["substages"]),
        };
      } catch (error) {
        if (isAbsent(error)) return null;
        throw error;
      }
    },
  };
}
