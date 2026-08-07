import {
  inputRequired,
  type InputRequiredResult,
  type RequestStateCodec,
  type ServerContext,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { cancelledError } from "../../livespace/errors.js";
import type { ProcessInfo } from "../../livespace/metadata.js";
import type { RecordFetchers } from "../../livespace/records.js";
import {
  computeStepDiff,
  type DealStepReader,
  type DealStepState,
  type StageMoveTarget,
  type StepBlockReason,
} from "../../livespace/stage-moves.js";
import type { WriteCallOptions, WriteFetchers } from "../../livespace/writes.js";
import { readWriteState, type WriteToolOptions } from "./create-records.js";
import type { MetadataService } from "./crm-metadata.js";
import {
  toolErrorSchema,
  toToolError,
  type ToolError,
  type ToolRunResult,
} from "./tool-error.js";
import {
  clientSupportsElicitation,
  countResults,
  decideConfirm,
  executePlan,
  hashArgs,
  isBatchError,
  newJti,
  readElicitedConfirm,
  CONFIRM_INPUT_KEY,
  PLAN_BUDGET_EXPIRED,
  WRITE_BATCH_CAP,
  WRITE_BUDGET_MS,
  type ExecutableItem,
  type ItemResult,
  type WriteItemPlan,
  type WriteState,
} from "./write-support.js";

/**
 * `move_deals_to_stage` - move deals along their pipeline by checking and
 * unchecking process steps, one bounded batch per call, written only after a
 * human said yes.
 *
 * It shares the confirmation machinery of the other write tools. What is its
 * own comes from the probe evidence behind the stage semantics (M7, recorded in
 * the plan doc) and from the critique panel:
 *
 * 1. **There is no "set stage" call.** A deal stands where its FURTHEST CHECKED
 *    step stands, so a move is a step edit: forward marks the intermediate
 *    steps as completed, backward un-marks them. That is a real cost - the
 *    checkboxes stop being evidence of work done - so the tool description says
 *    it in as many words and the preview counts exactly how many steps change.
 * 2. **The diff is computed from the DEAL, not from the dictionary.** Each deal
 *    is read first and its own step state decides the minimal set of flips; the
 *    cached dictionary is used for one thing only - resolving the caller's
 *    stage id to a process and a position - because it may be up to a TTL stale
 *    and mis-numbering a position would move deals to the wrong place.
 * 3. **Backward is permitted PER DEAL.** `allowBackwardDealIds` names the deals
 *    whose steps may be un-marked; a backward deal that is not on that list is
 *    blocked. There is no call-level blanket permission.
 * 4. **The guards fail closed.** A deal is movable only when its status is
 *    exactly "open" and its process matches the target stage's; a state whose
 *    stage id and whose checked steps disagree is blocked rather than guessed
 *    at (docs/security.md par. 5: ambiguity does nothing).
 * 5. **The claim a move makes is a POSITION.** Each moved deal is re-read and
 *    the stage it reached is compared with the one that was asked for - the
 *    steps themselves are not re-read, the stage upstream derived from them is.
 *
 * The text channel and the approval prompt carry counts and fixed wording only:
 * a stage name is a CRM-authored string and those stay in `structuredContent`,
 * where the schema types them as data (par. 4).
 *
 * Nothing here is cached: record data never is (par. 8), so this module must
 * never import the server cache.
 */

export const MOVE_DEALS_TO_STAGE_TOOL = "move_deals_to_stage";

/** Every item of this tool speaks about one deal moving. */
const MOVE_ACTION = "move_deal";

const idSchema = z.string().min(1).max(64);

const inputSchema = z.strictObject({
  dealIds: z
    .array(idSchema)
    .min(1)
    .max(WRITE_BATCH_CAP)
    .describe("Deals to move, from search_crm or get_records. All go to the same stage."),
  stageId: idSchema.describe(
    'Target pipeline stage, from crm_metadata (sections: ["processes"]).',
  ),
  allowBackwardDealIds: z
    .array(idSchema)
    .max(WRITE_BATCH_CAP)
    .optional()
    .describe(
      "Deals that may move BACKWARD, which un-marks their completed steps. Every id here must also be in dealIds.",
    ),
  dryRun: z
    .boolean()
    .optional()
    .describe("Return the plan and write nothing; cannot be combined with confirm."),
  confirm: z
    .boolean()
    .optional()
    .describe("Execute the previewed plan on clients that cannot prompt a human."),
});

/** Step id -> 1 (mark done) or 0 (un-mark). Never both for one step. */
const flipsSchema = z.record(z.string(), z.union([z.literal(0), z.literal(1)]));

/** Where a deal stands, as both the plan and the result report it. */
const stageValuesSchema = z.strictObject({
  stageId: z.string(),
  stageName: z.string(),
  substageName: z.string(),
});

/**
 * The plan item summary, and it is deliberately the FLIPS: the confirmation
 * digest is taken over these, so two batches that would send different step
 * edits can never hash alike. Step ids are data and live here; the text channel
 * and the approval prompt see counts only.
 */
const summarySchema = z.strictObject({
  dealId: z.string(),
  targetStageId: z.string(),
  flips: flipsSchema,
  stepsChecked: z.number(),
  stepsUnchecked: z.number(),
  before: stageValuesSchema.optional(),
});

const planItemSchema = z.strictObject({
  index: z.number(),
  action: z.string(),
  kind: z.string(),
  status: z.enum(["move", "unchanged", "blocked"]),
  summary: summarySchema,
  error: toolErrorSchema.optional(),
});

const resultItemSchema = z.strictObject({
  index: z.number(),
  action: z.string(),
  kind: z.string(),
  // A move never skips a duplicate: the same id twice is refused outright.
  status: z.enum(["ok", "error", "unknown_outcome", "not_attempted"]),
  id: z.string().optional(),
  /**
   * Whether THIS call moved the deal. Absent when the outcome is unknown: the
   * step edit went out and may have landed.
   */
  moved: z.boolean().optional(),
  stepsChecked: z.number().optional(),
  stepsUnchecked: z.number().optional(),
  resolvedByReread: z.boolean().optional(),
  verification: z.enum(["verified", "unavailable"]).optional(),
  unappliedFields: z.array(z.string()).optional(),
  before: stageValuesSchema.optional(),
  after: stageValuesSchema.optional(),
  error: toolErrorSchema.optional(),
});

/** What the whole batch would do, so a preview is readable without arithmetic. */
const aggregatesSchema = z.strictObject({
  forward: z.number(),
  backward: z.number(),
  unchangedCount: z.number(),
  stepsToCheck: z.number(),
  stepsToUncheck: z.number(),
});

const countsSchema = z.strictObject({
  ok: z.number(),
  skippedDuplicate: z.number(),
  error: z.number(),
  unknownOutcome: z.number(),
  notAttempted: z.number(),
});

// Optional keys on one root, never a union: a preview carries `plan` and
// `aggregates`, an executed batch carries `results` and `counts`, and a refused
// call carries neither. `errors` is always present.
const outputSchema = z.strictObject({
  plan: z.array(planItemSchema).optional(),
  aggregates: aggregatesSchema.optional(),
  requiresConfirmation: z.literal(true).optional(),
  declined: z.literal(true).optional(),
  recordsChanged: z.literal(true).optional(),
  results: z.array(resultItemSchema).optional(),
  counts: countsSchema.optional(),
  errors: z.array(toolErrorSchema),
});

export type MoveDealsToStageArgs = z.output<typeof inputSchema>;

/** A write tool returns a normal result, or asks the client for a human's yes. */
export type MoveDealsToStageResult = ToolRunResult | InputRequiredResult;

export interface MoveDealsToStageDeps {
  /** The deal's OWN step state - the only source the diff is computed from. */
  deals: DealStepReader;
  writes: WriteFetchers;
  /** A moved deal is re-read through this, to see which stage it reached. */
  records: Pick<RecordFetchers, "getRecord">;
  /** The dictionary that resolves the caller's stage id to a position. */
  metadata: MetadataService;
  codec: RequestStateCodec<WriteState>;
}

export const moveDealsToStageToolConfig = {
  title: "Move Deals To Stage",
  description: `Move deals to a pipeline stage - at most 10 deals per call, all to the same
stage. Livespace has no "set stage" call: a deal stands where its furthest
checked process step stands, so this tool checks and unchecks steps, which
means a forward move marks intermediate steps as completed and a backward move
un-marks them - the checkboxes stop being evidence of work done. Nothing is
written until a human approves: a plain call answers with a plan (so does
dryRun), clients that can prompt get a confirmation prompt, and clients that
cannot execute the previewed plan by re-calling with confirm: true. Each deal
is read first and its own steps decide the minimal set of flips, so a deal
already standing on the target stage is reported unchanged and nothing is sent
for it. A backward move happens only for deals listed in allowBackwardDealIds,
and every id listed there must also be in dealIds. A deal that is not open,
that belongs to another process, or whose stage and checked steps disagree is
blocked and never written. stageId comes from crm_metadata (processes); after
the write each moved deal is re-read and the stage it reached is compared with
the one that was asked for. Deal status (open, won, lost) is a different thing
and is changed with update_records.`,
  inputSchema,
  outputSchema,
  annotations: {
    readOnlyHint: false,
    // Steps are marked and un-marked: a move overwrites what was there before.
    destructiveHint: true,
    // Sending the same batch twice moves nothing the second time: the deal is
    // already standing where it was asked to stand.
    idempotentHint: true,
    openWorldHint: false,
  },
} as const;

const DECLINED_LINE = "Confirmation was declined; nothing was written.";

const CHANGED_LINE = "Records changed since the preview; review and confirm again.";

/** The elicitation form. Fixed wording, one boolean - no CRM string anywhere. */
const CONFIRM_FORM = {
  type: "object" as const,
  properties: {
    confirm: {
      type: "boolean" as const,
      title: "Move these deals",
      description: "Approve the write. Anything else leaves the CRM untouched.",
    },
  },
  required: ["confirm"],
};

/**
 * Why a single deal is not moved. Fixed wording, and every one of them names
 * the recovery: a blocked deal is a deal the caller can do something about.
 */
const BLOCK_REASONS: { [R in StepBlockReason]: ToolError } = {
  "wrong-process": {
    code: "BLOCKED",
    message: "This deal is not in the target stage's process.",
    hint: "Move it to a stage of its own process - get_records shows which process a deal is in.",
  },
  "closed-deal": {
    code: "BLOCKED",
    message: "This deal is not open, so its pipeline position cannot be moved.",
    hint: "Re-open it with update_records (status: open) first, if that is what you mean to do.",
  },
  "state-conflict": {
    code: "BLOCKED",
    message: "The deal's stage and its checked steps disagree, so no step edit is safe.",
    hint: "Fix the deal's steps in Livespace by hand; nothing was written for it.",
  },
  "empty-target": {
    code: "BLOCKED",
    message: "The target stage holds no process step this deal could stand on.",
    hint: 'Call crm_metadata (sections: ["processes"]) and pick a stage that has steps.',
  },
  "backward-needs-flag": {
    code: "BLOCKED",
    message: "This move is backward and the deal is not listed in allowBackwardDealIds.",
    hint: "Add the deal id to allowBackwardDealIds to un-mark the steps above the target stage.",
  },
};

function badParams(hint: string): ToolError {
  return {
    code: "BAD_PARAMS",
    message: "These move_deals_to_stage arguments cannot be combined.",
    hint,
  };
}

function emptyTarget(): ToolError {
  return {
    code: "BAD_PARAMS",
    message: "The target stage has no process steps.",
    hint: 'A deal stands on a checked step, so a stage without steps can hold none. Call crm_metadata (sections: ["processes"]) and pick a stage that has steps.',
  };
}

function stageNotFound(): ToolError {
  return {
    code: "NOT_FOUND",
    message: "Stage not found.",
    hint: 'Call crm_metadata (sections: ["processes"]) for valid stage ids.',
  };
}

function dealNotFound(): ToolError {
  return {
    code: "NOT_FOUND",
    message: "Deal not found.",
    hint: "The id does not exist or the API key's user cannot see it - take ids from search_crm or get_records.",
  };
}

/**
 * A refused call carries no plan and no results - there is nothing to qualify.
 * The text names the code; the hint travels in the structured channel.
 */
function failed(error: ToolError): ToolRunResult {
  return {
    text: `${MOVE_DEALS_TO_STAGE_TOOL} failed: ${error.code}.`,
    structured: { errors: [error] },
    isError: true,
  };
}

/**
 * The CANCELLED contract at every catch site: only the caller's signal STATE is
 * reliable (an abort surfaces as a DOMException, a plain Error or a bare string
 * reason), and a cancelled call NEVER returns a tool result - it rejects.
 */
function toEntry(error: unknown, signal: AbortSignal | undefined): ToolError {
  if (signal?.aborted) throw cancelledError();
  const entry = toToolError(error);
  if (entry.code === "CANCELLED") throw cancelledError();
  return entry;
}

/**
 * Cross-field rules live here rather than in the schema: a zod refinement would
 * turn every combination mistake into a protocol-level validation error, while a
 * returned `{code, message, hint}` tells the model how to fix the call.
 */
function argumentHint(args: MoveDealsToStageArgs): string | null {
  const wanted = new Set<string>();
  for (const dealId of args.dealIds) {
    // Two moves of one deal in one call is the ambiguity par. 5 refuses: the
    // second would be computed from a state the first has already changed.
    if (wanted.has(dealId)) {
      return "The same deal id appears twice. Send one entry per deal.";
    }
    wanted.add(dealId);
  }
  for (const dealId of args.allowBackwardDealIds ?? []) {
    if (!wanted.has(dealId)) {
      return "Every id in allowBackwardDealIds must also appear in dealIds - the backward permission is per deal, never a blanket one.";
    }
  }
  return null;
}

/**
 * The caller's stage id, resolved to a process and a position in the
 * dictionary's copy of the pipeline. The dictionary is used for THIS and
 * nothing else: it may be up to a TTL stale, so the deal's own definition is
 * what the diff runs on.
 *
 * A stage id shared by two processes is resolved to the first process that
 * lists it; upstream ids are unique, and a deal whose process does not match
 * what was resolved is blocked rather than moved.
 */
function findStage(
  processes: readonly ProcessInfo[],
  stageId: string,
): StageMoveTarget | null {
  for (const process of processes) {
    const position = process.stages.findIndex((stage) => stage.id === stageId);
    if (position === -1) continue;
    return {
      processId: process.id,
      position,
      stages: process.stages.map((stage) => ({
        stageId: stage.id,
        stageName: stage.name,
        steps: stage.steps.map((step) => step.id),
      })),
    };
  }
  return null;
}

async function resolveTarget(
  metadata: MetadataService,
  stageId: string,
  signal: AbortSignal | undefined,
): Promise<StageMoveTarget | ToolError> {
  let processes: readonly ProcessInfo[];
  try {
    const dictionary = await metadata.get(
      "processes",
      signal === undefined ? undefined : { signal },
    );
    processes = dictionary.data;
  } catch (error) {
    return toEntry(error, signal);
  }
  const target = findStage(processes, stageId);
  if (target === null) return stageNotFound();
  // The dictionary already knows the stage holds no step, so the whole call is
  // refused here rather than costing one read per deal to reach the same
  // verdict item by item.
  if ((target.stages[target.position]?.steps.length ?? 0) === 0) return emptyTarget();
  return target;
}

function text(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : String(value);
}

/** Where a deal stands, cut from the re-read record. */
function stageValues(record: Record<string, unknown>): Record<string, unknown> {
  return {
    stageId: text(record["stageId"]),
    stageName: text(record["stageName"]),
    substageName: text(record["substageName"]),
  };
}

function standing(state: DealStepState): Record<string, unknown> {
  return {
    stageId: state.stageId,
    stageName: state.stageName,
    substageName: state.substageName,
  };
}

interface Aggregates {
  forward: number;
  backward: number;
  unchangedCount: number;
  stepsToCheck: number;
  stepsToUncheck: number;
}

/** What the plan knows about an item that the executor does not report itself. */
interface MoveDetail {
  /** A move dispatches; an unchanged item is `ok` without one. */
  dispatches: boolean;
  before: Record<string, unknown>;
  stepsChecked: number;
  stepsUnchecked: number;
}

interface PlannedBatch {
  items: WriteItemPlan[];
  executable: ExecutableItem[];
  details: Map<number, MoveDetail>;
  aggregates: Aggregates;
  /**
   * Indices blocked because the BATCH stopped, not because of anything about
   * the deal itself: the read the upstream rate-limited, everything after it,
   * and everything the plan budget never reached. A per-deal verdict - wrong
   * process, closed deal, backward without the flag, a deal that does not
   * answer - is never in here. The two are counted apart because their
   * recoveries are opposite: fix the request, or wait and re-send smaller.
   */
  halted: Set<number>;
}

/**
 * Reads every deal, in the order they were named, and turns each one into a
 * plan item.
 *
 * The reads run here and nowhere else: a preview and the execute round that
 * follows it build the same plan the same way, which is what makes comparing
 * their digests meaningful - a deal whose steps someone else ticked in between
 * produces a different flip set and sends the batch back for a fresh yes.
 *
 * They are upstream calls like any other, so they answer to the call's budget
 * and to a rate-limited upstream: once either says stop, the remaining deals
 * carry that reason and no further read is issued. Those deals are recorded as
 * HALTED, not blocked - the counts keep the two apart.
 */
async function buildPlan(
  deps: MoveDealsToStageDeps,
  args: MoveDealsToStageArgs,
  target: StageMoveTarget,
  signal: AbortSignal | undefined,
  deadlineAt: number,
): Promise<PlannedBatch> {
  const opts: WriteCallOptions = signal === undefined ? {} : { signal };
  const allowBackward = new Set(args.allowBackwardDealIds ?? []);
  const items: WriteItemPlan[] = [];
  const executable: ExecutableItem[] = [];
  const details = new Map<number, MoveDetail>();
  const halted = new Set<number>();
  const aggregates: Aggregates = {
    forward: 0,
    backward: 0,
    unchangedCount: 0,
    stepsToCheck: 0,
    stepsToUncheck: 0,
  };
  let halt: ToolError | undefined;

  for (const [index, dealId] of args.dealIds.entries()) {
    const base = { index, action: MOVE_ACTION, kind: "deal" as const };
    const summary: Record<string, unknown> = {
      dealId,
      targetStageId: args.stageId,
      flips: {},
      stepsChecked: 0,
      stepsUnchecked: 0,
    };
    const block = (error: ToolError, before?: Record<string, unknown>): void => {
      items.push({
        ...base,
        status: "blocked",
        summary: before === undefined ? summary : { ...summary, before },
        error,
      });
      executable.push({ ...base, status: "blocked", error });
    };

    // Between items, in this order - never mid-read, the same rule the
    // executor follows.
    if (halt === undefined) {
      if (signal?.aborted) throw cancelledError();
      if (Date.now() >= deadlineAt) halt = PLAN_BUDGET_EXPIRED;
    }
    if (halt !== undefined) {
      // Nothing about THIS deal stopped it: the batch did.
      halted.add(index);
      block(halt);
      continue;
    }

    let state: DealStepState | null;
    try {
      state = await deps.deals.readStepState(dealId, opts);
    } catch (error) {
      // A deal we could not read is a deal we will not edit steps on.
      const reason = toEntry(error, signal);
      // The upstream said stop: this deal is blocked and so is every one after
      // it - none of them is read at all. The deal that took the refusal is
      // halted too; it is not the deal's fault either.
      if (reason.code === "RATE_LIMITED") {
        halt = reason;
        halted.add(index);
      }
      block(reason);
      continue;
    }
    if (state === null) {
      block(dealNotFound());
      continue;
    }

    const before = standing(state);
    const diff = computeStepDiff(state, target, allowBackward.has(dealId));
    if (diff.kind === "blocked") {
      block(BLOCK_REASONS[diff.reason], before);
      continue;
    }
    if (diff.kind === "unchanged") {
      aggregates.unchangedCount += 1;
      items.push({ ...base, status: "unchanged", summary: { ...summary, before } });
      // Nothing to dispatch and nothing to re-read: the deal already stands
      // where the caller asked it to stand.
      executable.push({ ...base, status: "unchanged", view: before });
      details.set(index, {
        dispatches: false,
        before,
        stepsChecked: 0,
        stepsUnchecked: 0,
      });
      continue;
    }

    if (diff.direction === "forward") aggregates.forward += 1;
    else aggregates.backward += 1;
    aggregates.stepsToCheck += diff.stepsChecked;
    aggregates.stepsToUncheck += diff.stepsUnchecked;
    items.push({
      ...base,
      status: "move",
      summary: {
        ...summary,
        flips: diff.flips,
        stepsChecked: diff.stepsChecked,
        stepsUnchecked: diff.stepsUnchecked,
        before,
      },
    });
    executable.push({
      ...base,
      status: "update",
      id: dealId,
      // The flips are what travels; the CLAIM is a position, and that is what
      // the re-read comparator checks.
      sent: { stageId: args.stageId },
      before,
      view: stageValues,
      perform: async (callOpts) => {
        await deps.writes.moveDealSteps(dealId, diff.flips, callOpts);
        return dealId;
      },
    });
    details.set(index, {
      dispatches: true,
      before,
      stepsChecked: diff.stepsChecked,
      stepsUnchecked: diff.stepsUnchecked,
    });
  }
  return { items, executable, details, aggregates, halted };
}

interface PlanCounts {
  total: number;
  forward: number;
  backward: number;
  unchanged: number;
  blocked: number;
  halted: number;
  stepsToCheck: number;
  stepsToUncheck: number;
}

/**
 * `blocked` counts per-deal verdicts only. A deal the batch never got to is
 * counted as `halted` instead - the two terms still add up to the plan, and
 * neither is read as the other.
 */
function planCounts(batch: PlannedBatch): PlanCounts {
  return {
    total: batch.items.length,
    forward: batch.aggregates.forward,
    backward: batch.aggregates.backward,
    unchanged: batch.aggregates.unchangedCount,
    blocked: batch.items.filter(
      (item) => item.status === "blocked" && !batch.halted.has(item.index),
    ).length,
    halted: batch.halted.size,
    stepsToCheck: batch.aggregates.stepsToCheck,
    stepsToUncheck: batch.aggregates.stepsToUncheck,
  };
}

/** Counts and fixed wording only - no deal id, stage name or step id (par. 4). */
function previewLine(counts: PlanCounts): string {
  return (
    `${MOVE_DEALS_TO_STAGE_TOOL} preview: ${counts.total} deal(s) - ` +
    `${counts.forward} forward, ${counts.backward} backward, ` +
    `${counts.unchanged} unchanged, ${counts.blocked} blocked, ${counts.halted} halted. ` +
    `${counts.stepsToCheck} step(s) to mark done, ${counts.stepsToUncheck} to un-mark. ` +
    `Re-call with confirm: true to execute.`
  );
}

/**
 * The string a HUMAN approves. Same rule, and it is ours end to end - and it
 * discloses the scale of what a yes does: how many checkboxes get marked as
 * completed work, and how many stop being marked.
 */
function approvalMessage(counts: PlanCounts): string {
  return (
    `Move ${counts.total} deal(s) to a pipeline stage: ` +
    `${counts.forward} forward, ${counts.backward} backward, ${counts.unchanged} unchanged. ` +
    `${counts.stepsToCheck} step(s) will be marked done, ` +
    `${counts.stepsToUncheck} step(s) un-marked. Approve?`
  );
}

interface PreviewFlags {
  requiresConfirmation?: boolean;
  declined?: boolean;
  recordsChanged?: boolean;
}

function previewResult(batch: PlannedBatch, flags: PreviewFlags): ToolRunResult {
  const counts = planCounts(batch);
  const lines = [previewLine(counts)];
  if (flags.declined === true) lines.push(DECLINED_LINE);
  if (flags.recordsChanged === true) lines.push(CHANGED_LINE);
  return {
    text: lines.join("\n"),
    structured: {
      plan: batch.items,
      aggregates: batch.aggregates,
      ...(flags.requiresConfirmation === true ? { requiresConfirmation: true } : {}),
      ...(flags.declined === true ? { declined: true } : {}),
      ...(flags.recordsChanged === true ? { recordsChanged: true } : {}),
      errors: [],
    },
    isError: false,
  };
}

/**
 * The executor reports what a write did; the plan knows what the write WAS.
 * `ItemResult` is not widened for that - each tool merges its own detail into
 * its own rows, exactly as `create_records` fills in duplicate ids.
 */
interface MoveResultRow extends ItemResult {
  moved?: boolean;
  stepsChecked?: number;
  stepsUnchecked?: number;
}

function mergeDetails(
  results: readonly ItemResult[],
  details: ReadonlyMap<number, MoveDetail>,
): MoveResultRow[] {
  return results.map((result) => {
    const detail = details.get(result.index);
    // A blocked deal has no state to speak about: its row carries the reason.
    if (detail === undefined) return result;
    return {
      ...result,
      // An item the budget or a halt never reached still says where the deal
      // stands - the executor had nothing to report for it.
      ...(result.before === undefined ? { before: detail.before } : {}),
      // "moved" is about THIS call: an unchanged deal is `ok` and was not
      // moved. An outcome the transport could not tell us about is exactly
      // that - the step edit went out and may have landed - so neither true nor
      // false is honest and the key is omitted, as `notify_user` omits
      // `dispatched`. The flip counts below stay: they come from the PLAN and
      // describe what was sent, which is true either way, and they are the only
      // recovery information an unknown row carries.
      ...(result.status === "unknown_outcome"
        ? {}
        : { moved: detail.dispatches && result.status === "ok" }),
      stepsChecked: detail.stepsChecked,
      stepsUnchecked: detail.stepsUnchecked,
    };
  });
}

/**
 * The executed line. The executor reports blocked and halted items alike as
 * errors - they carry the reason they could not run - so both are subtracted
 * from `attempted` and from `errors`: nothing was ever dispatched for them.
 *
 * They get their own terms rather than one shared bucket. "Blocked" is a
 * verdict about a deal and reads "change the request"; a halt is the upstream
 * or the clock stopping the batch and reads "wait and re-send smaller". Folding
 * a halt into `blocked` made a rate limit look like intentional gating, and
 * left the line saying `errors 0` next to `isError: true`.
 */
function executedText(
  rows: readonly MoveResultRow[],
  planned: number,
  blocked: number,
  halted: number,
): string {
  const counts = countResults(rows);
  const attempted = counts.ok + counts.error + counts.unknownOutcome - blocked - halted;
  const moved = rows.filter((row) => row.moved === true).length;
  const unchanged = rows.filter(
    (row) => row.status === "ok" && row.moved === false,
  ).length;
  return (
    `${MOVE_DEALS_TO_STAGE_TOOL}: attempted ${attempted} of ${planned} - ` +
    `moved ${moved}, unchanged ${unchanged}, blocked ${blocked}, halted ${halted}, ` +
    `errors ${counts.error - blocked - halted}, unknown ${counts.unknownOutcome}, ` +
    `not attempted ${counts.notAttempted}.`
  );
}

/** The batch alone: flipping `confirm` or `dryRun` is not a new batch. */
function itemArgs(args: MoveDealsToStageArgs): Record<string, unknown> {
  return {
    dealIds: args.dealIds,
    stageId: args.stageId,
    allowBackwardDealIds: args.allowBackwardDealIds,
  };
}

export async function runMoveDealsToStage(
  deps: MoveDealsToStageDeps,
  args: MoveDealsToStageArgs,
  opts: WriteToolOptions = {},
): Promise<MoveDealsToStageResult> {
  // One wall clock for the whole call, plan reads included - the client's
  // request timeout does not stop counting while we are planning.
  const deadlineAt = Date.now() + WRITE_BUDGET_MS;
  const hint = argumentHint(args);
  if (hint !== null) return failed(badParams(hint));
  const signal = opts.signal;
  // A caller who walked away before the first call gets no work and no result.
  if (signal?.aborted) throw cancelledError();

  const argsHash = await hashArgs(itemArgs(args));
  const state = readWriteState(opts.ctx);
  const decision = decideConfirm({
    tool: MOVE_DEALS_TO_STAGE_TOOL,
    argsHash,
    confirm: args.confirm,
    dryRun: args.dryRun,
    state,
    elicitedConfirm: readElicitedConfirm(opts.ctx),
    clientSupportsElicitation: clientSupportsElicitation(opts.ctx),
    allowUnboundWriteConfirmation: opts.allowUnboundWriteConfirmation,
  });
  // A refused confirmation costs nothing upstream: it is decided before the
  // dictionary is even read.
  if (!("mode" in decision)) return failed(decision);

  const target = await resolveTarget(deps.metadata, args.stageId, signal);
  if ("code" in target) return failed(target);

  const batch = await buildPlan(deps, args, target, signal, deadlineAt);
  const digest = await hashArgs(batch.items);

  if (decision.mode === "input-required") {
    const wire = await deps.codec.mint(
      { tool: MOVE_DEALS_TO_STAGE_TOOL, argsHash, previewDigest: digest, jti: newJti() },
      opts.ctx as ServerContext,
    );
    return inputRequired({
      inputRequests: {
        [CONFIRM_INPUT_KEY]: inputRequired.elicit({
          message: approvalMessage(planCounts(batch)),
          requestedSchema: CONFIRM_FORM,
        }),
      },
      requestState: wire,
    });
  }
  if (decision.mode === "declined") return previewResult(batch, { declined: true });
  if (decision.mode === "preview") {
    return previewResult(batch, { requiresConfirmation: args.dryRun !== true });
  }
  // The preview is a promise about deals that may have moved since. When the
  // rebuilt plan no longer matches the one that was approved - a sibling step
  // ticked upstream is enough - nothing is written and the fresh plan goes back
  // for a fresh confirmation.
  if (state !== undefined && digest !== state.previewDigest) {
    return previewResult(batch, { requiresConfirmation: true, recordsChanged: true });
  }

  const results = mergeDetails(
    await executePlan({ records: deps.records }, batch.executable, {
      ...(signal === undefined ? {} : { signal }),
      deadlineAt,
    }),
    batch.details,
  );
  const executed = planCounts(batch);
  return {
    text: executedText(results, batch.items.length, executed.blocked, executed.halted),
    structured: { results, counts: countResults(results), errors: [] },
    isError: isBatchError(results),
  };
}
