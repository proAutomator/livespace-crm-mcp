import {
  inputRequired,
  type InputRequiredResult,
  type RequestStateCodec,
  type ServerContext,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { cancelledError } from "../../livespace/errors.js";
import type { RecordFetchers } from "../../livespace/records.js";
import {
  normalizeWriteTimestamp,
  type CallWrite,
  type NoteTargetKind,
  type WriteFetchers,
} from "../../livespace/writes.js";
import { readWriteState, type WriteToolOptions } from "./create-records.js";
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
  ACTIVITY_BATCH_CAP,
  CONFIRM_INPUT_KEY,
  VERIFICATION_UNAVAILABLE,
  WRITE_BUDGET_MS,
  type ActivityWriteItem,
  type ItemResult,
  type WriteItemPlan,
  type WriteState,
} from "./write-support.js";

/**
 * `log_activities` - notes on a person, company or deal, and phone calls on a
 * person, one bounded batch per call, written only after a human said yes.
 *
 * It shares the confirmation machinery of the other two write tools and differs
 * in what it can promise afterwards:
 *
 * 1. **The wall is the evidence, not the echo.** A note answers with a
 *    `wall_item_id` and a call answers with a copy of the input (probe evidence
 *    2), so neither proves anything landed. After the batch, each target
 *    record's wall is read ONCE - not once per item - and every applied item
 *    reports whether it showed up there. A wall that does not answer leaves the
 *    item `ok` with `verification: "unavailable"`: a read can never un-apply a
 *    write (docs/security.md par. 5).
 * 2. **Notes are public and the tool says so.** `access`, `is_public` and
 *    `visibility` are all ignored upstream - everything lands public - so no
 *    visibility parameter is invented here and the description warns instead.
 * 3. **Each kind has its own endpoint.** A company id sent to `addContactNote`
 *    answers 420 (evidence 15); the routing lives in the write fetchers and is
 *    pinned there.
 * 4. **An activity cannot be edited or taken back.** There is no update path
 *    for a wall entry in the tool surface, which is why nothing is written
 *    before it has been previewed and approved.
 *
 * The text channel and the approval prompt carry counts and fixed wording only:
 * a note body is a model- or CRM-authored string, and those stay in
 * `structuredContent` where the schema types them as data (par. 4).
 *
 * Nothing here is cached: record data never is (par. 8), so this module must
 * never import the server cache.
 */

export const LOG_ACTIVITIES_TOOL = "log_activities";

/**
 * The years a call date may fall in. The bound is not about data - it keeps a
 * year like 9999 from reaching a filter no upstream would understand.
 */
const DATE_MIN = "1900-01-01";
const DATE_MAX = "2100-12-31";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/u;

const idSchema = z.string().min(1).max(64);

const noteItemSchema = z.strictObject({
  kind: z
    .enum(["person", "company", "deal"])
    .describe("Which kind of record the note is logged on."),
  id: idSchema.describe("Record id from search_crm or get_records."),
  note: z
    .string()
    .min(1)
    .max(5000)
    .describe("The note text; everyone who can see the record can read it."),
});

const callItemSchema = z.strictObject({
  personId: idSchema.describe("The person the call is logged on (from search_crm)."),
  phone: z.string().min(3).max(40).describe("The number that was called or called in."),
  direction: z.enum(["incoming", "outgoing"]).describe("Who called whom."),
  note: z.string().max(5000).optional().describe("What the call was about."),
  date: z
    .string()
    .regex(DATE_PATTERN)
    .optional()
    .describe(
      'When it happened: "YYYY-MM-DD" or "YYYY-MM-DD HH:MM:SS". Send it - it is what makes the call verifiable afterwards.',
    ),
});

const inputSchema = z.strictObject({
  notes: z
    .array(noteItemSchema)
    .max(ACTIVITY_BATCH_CAP)
    .optional()
    .describe("Notes to log on records."),
  calls: z
    .array(callItemSchema)
    .max(ACTIVITY_BATCH_CAP)
    .optional()
    .describe("Phone calls to log on persons."),
  dryRun: z
    .boolean()
    .optional()
    .describe("Return the plan and write nothing; cannot be combined with confirm."),
  confirm: z
    .boolean()
    .optional()
    .describe("Execute the previewed plan on clients that cannot prompt a human."),
});

// One static summary shape with optional keys per kind - never a union. A union
// of look-alike item shapes would let one kind validate as another and silently
// strip the fields it does not know (the M3 lesson).
const summarySchema = z.strictObject({
  id: z.string().optional(),
  note: z.string().optional(),
  personId: z.string().optional(),
  phone: z.string().optional(),
  direction: z.string().optional(),
  date: z.string().optional(),
});

const planItemSchema = z.strictObject({
  index: z.number(),
  action: z.string(),
  kind: z.string(),
  // An activity has no target to look up at plan time, so it is never blocked
  // and never a duplicate: it is written, or it fails while being written.
  status: z.enum(["note", "call"]),
  summary: summarySchema,
});

const resultItemSchema = z.strictObject({
  index: z.number(),
  action: z.string(),
  kind: z.string(),
  status: z.enum(["ok", "error", "unknown_outcome", "not_attempted"]),
  /** The wall entry id, when the endpoint reported one. */
  id: z.string().optional(),
  verification: z.enum(["verified", "unavailable"]).optional(),
  error: toolErrorSchema.optional(),
});

const countsSchema = z.strictObject({
  ok: z.number(),
  skippedDuplicate: z.number(),
  error: z.number(),
  unknownOutcome: z.number(),
  notAttempted: z.number(),
});

// Optional keys on one root, never a union: a preview carries `plan`, an
// executed batch carries `results` and `counts`, and a refused call carries
// neither. `errors` is always present.
const outputSchema = z.strictObject({
  plan: z.array(planItemSchema).optional(),
  requiresConfirmation: z.literal(true).optional(),
  declined: z.literal(true).optional(),
  recordsChanged: z.literal(true).optional(),
  results: z.array(resultItemSchema).optional(),
  counts: countsSchema.optional(),
  errors: z.array(toolErrorSchema),
});

export type LogActivitiesArgs = z.output<typeof inputSchema>;

type NoteItem = z.output<typeof noteItemSchema>;
type CallItem = z.output<typeof callItemSchema>;

/** A write tool returns a normal result, or asks the client for a human's yes. */
export type LogActivitiesResult = ToolRunResult | InputRequiredResult;

/**
 * One wall entry, cut to what a verification pass needs.
 *
 * `id` is optional because the mapped wall entry does not carry its row id
 * today: when a reader supplies one the match is exact, otherwise the type and
 * the text decide.
 */
export interface WallVerifyEntry {
  type: string;
  text: string;
  date: string;
  id?: string;
}

/** The read side of verification: one wall per record, entries as data. */
export interface WallReader {
  recordWall(opts: {
    kind: NoteTargetKind;
    id: string;
    signal?: AbortSignal;
  }): Promise<{ entries: readonly WallVerifyEntry[] }>;
}

export interface LogActivitiesDeps {
  writes: WriteFetchers;
  /**
   * The executor's contract: a record write is re-read through it. No activity
   * item ever is - the wall pass below answers for those in one read per record
   * instead of one per item - but the dependency is real and stays declared.
   */
  records: Pick<RecordFetchers, "getRecord">;
  activity: WallReader;
  codec: RequestStateCodec<WriteState>;
}

export const logActivitiesToolConfig = {
  title: "Log CRM Activities",
  description: `Log notes on a person, company or deal and phone calls on a person - at most
15 items per call across both arrays. Nothing is written until a human
approves: a plain call answers with a plan (so does dryRun), clients that can
prompt get a confirmation prompt, and clients that cannot execute the
previewed plan by re-calling with confirm: true. Notes are PUBLIC - Livespace
ignores every visibility parameter, so anyone who can see the record can read
them; never log anything that should stay private. A call takes the number,
the direction (incoming or outgoing), an optional note and an optional date
("YYYY-MM-DD HH:MM:SS") - send that date, it is what the call is verified by.
After the batch each target record's wall is read once, and every logged item
reports whether it showed up there (verification) - a check that could not run
never turns an applied write into an error. Ids come from search_crm or
get_records; this tool creates no records, and a logged activity cannot be
edited or removed here.`,
  inputSchema,
  outputSchema,
  annotations: {
    readOnlyHint: false,
    // An activity is added beside what is already there; nothing is overwritten.
    destructiveHint: false,
    idempotentHint: false,
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
      title: "Log these activities",
      description: "Approve the write. Anything else leaves the CRM untouched.",
    },
  },
  required: ["confirm"],
};

/** The CRM's own wall type names, as the API spells them. */
const NOTE_ENTRY_TYPE = "notatka";
const CALL_ENTRY_TYPE = "telefon";

/**
 * How much of a note is compared against a wall entry. The wall flattens the
 * markup and cuts the text at 500 characters, so only a head can be matched;
 * this one is well under that cut and long enough to identify a note.
 */
const NOTE_MATCH_PREFIX = 200;

function badParams(hint: string): ToolError {
  return {
    code: "BAD_PARAMS",
    message: "These log_activities arguments cannot be combined.",
    hint,
  };
}

/**
 * A refused call carries no plan and no results - there is nothing to qualify.
 * The text names the code; the hint travels in the structured channel.
 */
function failed(error: ToolError): ToolRunResult {
  return {
    text: `${LOG_ACTIVITIES_TOOL} failed: ${error.code}.`,
    structured: { errors: [error] },
    isError: true,
  };
}

/**
 * The CANCELLED contract at every catch site: only the caller's signal STATE is
 * reliable (an abort surfaces as a DOMException, a plain Error or a bare string
 * reason), and a cancelled call NEVER returns a tool result - it rejects.
 */
function throwIfCancelled(error: unknown, signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw cancelledError();
  if (toToolError(error).code === "CANCELLED") throw cancelledError();
}

/**
 * Whether a shape-valid "YYYY-MM-DD" is a day that actually exists. The NaN
 * guard comes FIRST: `new Date("2026-13-01T00:00:00Z")` is an invalid date and
 * calling `toISOString()` on it throws, so the round-trip cannot be the test.
 * Rolling months ("2026-02-31" -> March 3) fail the round-trip instead.
 */
function isCalendarDate(value: string): boolean {
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms)) return false;
  return new Date(ms).toISOString().slice(0, 10) === value;
}

function dateHint(value: string): string | null {
  const day = value.slice(0, 10);
  if (!isCalendarDate(day)) {
    return "date is not a real calendar date. Send an existing day, for example 2026-01-31.";
  }
  if (day < DATE_MIN || day > DATE_MAX) {
    return `date is outside the supported range. Send a date between ${DATE_MIN} and ${DATE_MAX}.`;
  }
  return null;
}

/**
 * Cross-field rules live here rather than in the schema: a zod refinement would
 * turn every combination mistake into a protocol-level validation error, while a
 * returned `{code, message, hint}` tells the model how to fix the call.
 */
function argumentHint(args: LogActivitiesArgs): string | null {
  const total = (args.notes?.length ?? 0) + (args.calls?.length ?? 0);
  if (total === 0) return "Send at least one item in notes or calls.";
  if (total > ACTIVITY_BATCH_CAP) {
    return `One call logs at most ${ACTIVITY_BATCH_CAP} activities in total (this one has ${total}). Split the batch.`;
  }
  for (const [index, call] of (args.calls ?? []).entries()) {
    if (call.date === undefined) continue;
    const hint = dateHint(call.date);
    if (hint !== null) return `calls[${index}]: ${hint}`;
  }
  return null;
}

interface WallTarget {
  kind: NoteTargetKind;
  id: string;
}

/**
 * One planned activity: what the preview shows, the single dispatch that writes
 * it, the record whose wall proves it landed, and how to recognise it there.
 */
interface PlannedActivity {
  plan: WriteItemPlan;
  item: ActivityWriteItem;
  target: WallTarget;
  matches(entry: WallVerifyEntry): boolean;
}

function collapse(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function isEntryType(entry: WallVerifyEntry, wanted: string): boolean {
  return entry.type.trim().toLowerCase() === wanted;
}

function planNote(
  deps: LogActivitiesDeps,
  item: NoteItem,
  index: number,
): PlannedActivity {
  const base = { index, action: "log_note", kind: item.kind };
  const summary = { id: item.id, note: item.note };
  const head = collapse(item.note).slice(0, NOTE_MATCH_PREFIX);
  return {
    plan: { ...base, status: "note", summary },
    item: {
      ...base,
      status: "note",
      perform: async (opts) =>
        (await deps.writes.addNote(item.kind, item.id, item.note, opts)).wallItemId,
    },
    target: { kind: item.kind, id: item.id },
    // The wall echoes the note as its own text; anything else on the record is
    // a different entry, whoever wrote it.
    matches: (entry) =>
      head !== "" && isEntryType(entry, NOTE_ENTRY_TYPE) && collapse(entry.text).includes(head),
  };
}

function planCall(
  deps: LogActivitiesDeps,
  item: CallItem,
  index: number,
): PlannedActivity {
  const base = { index, action: "log_call", kind: "person" };
  // A call's date persists exactly as sent (probe evidence 12e), which is what
  // makes it the one field the wall can be searched by.
  const date = item.date === undefined ? null : normalizeWriteTimestamp(item.date);
  const input: CallWrite = {
    phone: item.phone,
    direction: item.direction,
    ...(item.note === undefined ? {} : { note: item.note }),
    ...(date === null ? {} : { date }),
  };
  return {
    plan: { ...base, status: "call", summary: { personId: item.personId, ...input } },
    item: {
      ...base,
      status: "call",
      perform: async (opts) => {
        await deps.writes.addCall(item.personId, input, opts);
        // The endpoint reports no wall item id for a call.
        return null;
      },
    },
    target: { kind: "person", id: item.personId },
    matches: (entry) =>
      date !== null &&
      isEntryType(entry, CALL_ENTRY_TYPE) &&
      normalizeWriteTimestamp(entry.date) === date,
  };
}

/**
 * Builds the plan in declaration order - notes, then calls - and numbers the
 * items globally, so a result lines up with the batch that was sent. Nothing
 * upstream is touched: an activity names its target rather than looking one up,
 * which is why a preview and the execute round that follows it produce the same
 * plan and the same digest.
 */
function buildPlan(deps: LogActivitiesDeps, args: LogActivitiesArgs): PlannedActivity[] {
  const planned: PlannedActivity[] = [];
  for (const item of args.notes ?? []) planned.push(planNote(deps, item, planned.length));
  for (const item of args.calls ?? []) planned.push(planCall(deps, item, planned.length));
  return planned;
}

interface PlanCounts {
  notes: number;
  calls: number;
  total: number;
}

function planCounts(items: readonly WriteItemPlan[]): PlanCounts {
  const notes = items.filter((item) => item.status === "note").length;
  return { notes, calls: items.length - notes, total: items.length };
}

/** Counts and fixed wording only - no name, id or note body (par. 4). */
function previewLine(counts: PlanCounts): string {
  return (
    `${LOG_ACTIVITIES_TOOL} preview: ${counts.total} item(s) ` +
    `(${counts.notes} notes, ${counts.calls} calls). ` +
    `Re-call with confirm: true to execute.`
  );
}

/** The string a HUMAN approves. Same rule, and it is ours end to end. */
function approvalMessage(counts: PlanCounts): string {
  return (
    `Log ${counts.total} activit(y/ies) ` +
    `(${counts.notes} notes, ${counts.calls} calls). Approve?`
  );
}

interface PreviewFlags {
  requiresConfirmation?: boolean;
  declined?: boolean;
  recordsChanged?: boolean;
}

function previewResult(items: readonly WriteItemPlan[], flags: PreviewFlags): ToolRunResult {
  const lines = [previewLine(planCounts(items))];
  if (flags.declined === true) lines.push(DECLINED_LINE);
  if (flags.recordsChanged === true) lines.push(CHANGED_LINE);
  return {
    text: lines.join("\n"),
    structured: {
      plan: items,
      ...(flags.requiresConfirmation === true ? { requiresConfirmation: true } : {}),
      ...(flags.declined === true ? { declined: true } : {}),
      ...(flags.recordsChanged === true ? { recordsChanged: true } : {}),
      errors: [],
    },
    isError: false,
  };
}

function targetKey(target: WallTarget): string {
  return `${target.kind}:${target.id}`;
}

/** A wall read is never allowed to fail an applied write, so it fails quietly. */
async function readWall(
  deps: LogActivitiesDeps,
  target: WallTarget,
  signal: AbortSignal | undefined,
): Promise<readonly WallVerifyEntry[] | null> {
  try {
    const page = await deps.activity.recordWall({
      kind: target.kind,
      id: target.id,
      ...(signal === undefined ? {} : { signal }),
    });
    return page.entries;
  } catch (error) {
    // A cancelled call returns nothing at all, not even a verified batch.
    throwIfCancelled(error, signal);
    return null;
  }
}

function carries(
  planned: PlannedActivity,
  entry: WallVerifyEntry,
  wallItemId: string | undefined,
): boolean {
  // The id the write reported is the exact match when the reader carries ids.
  if (wallItemId !== undefined && entry.id !== undefined && entry.id === wallItemId) {
    return true;
  }
  return planned.matches(entry);
}

/**
 * Verification, one read per DISTINCT target record: fifteen notes on one deal
 * cost one wall read, not fifteen.
 *
 * Only applied items are looked for. An item whose wall did not answer, or
 * whose entry is not on the page, stays `ok` and reports the check as
 * unavailable - the write landed either way, and re-sending it would duplicate
 * an entry that cannot be taken back.
 */
async function verifyOnWalls(
  deps: LogActivitiesDeps,
  planned: readonly PlannedActivity[],
  results: readonly ItemResult[],
  signal: AbortSignal | undefined,
): Promise<ItemResult[]> {
  const applied = results.filter((result) => result.status === "ok");
  if (applied.length === 0) return [...results];

  const byIndex = new Map(planned.map((entry) => [entry.plan.index, entry]));
  const walls = new Map<string, readonly WallVerifyEntry[] | null>();
  for (const result of applied) {
    const entry = byIndex.get(result.index);
    if (entry === undefined) continue;
    const key = targetKey(entry.target);
    if (walls.has(key)) continue;
    walls.set(key, await readWall(deps, entry.target, signal));
  }

  return results.map((result) => {
    if (result.status !== "ok") return result;
    const entry = byIndex.get(result.index);
    if (entry === undefined) return result;
    const wall = walls.get(targetKey(entry.target)) ?? null;
    if (wall !== null && wall.some((row) => carries(entry, row, result.id))) {
      return { ...result, verification: "verified" };
    }
    return { ...result, verification: "unavailable", error: VERIFICATION_UNAVAILABLE };
  });
}

/** The item arrays alone: flipping `confirm` or `dryRun` is not a new batch. */
function itemArgs(args: LogActivitiesArgs): Record<string, unknown> {
  return { notes: args.notes, calls: args.calls };
}

function executedText(results: readonly ItemResult[], planned: number): string {
  const counts = countResults(results);
  const attempted = counts.ok + counts.error + counts.unknownOutcome;
  return (
    `${LOG_ACTIVITIES_TOOL}: attempted ${attempted} of ${planned} - ` +
    `ok ${counts.ok}, errors ${counts.error}, ` +
    `unknown ${counts.unknownOutcome}, not attempted ${counts.notAttempted}.`
  );
}

export async function runLogActivities(
  deps: LogActivitiesDeps,
  args: LogActivitiesArgs,
  opts: WriteToolOptions = {},
): Promise<LogActivitiesResult> {
  // One wall clock for the whole call - the client's request timeout does not
  // stop counting while the batch is being written.
  const deadlineAt = Date.now() + WRITE_BUDGET_MS;
  const hint = argumentHint(args);
  if (hint !== null) return failed(badParams(hint));
  const signal = opts.signal;
  // A caller who walked away before the first call gets no work and no result.
  if (signal?.aborted) throw cancelledError();

  const argsHash = await hashArgs(itemArgs(args));
  const state = readWriteState(opts.ctx);
  const decision = decideConfirm({
    tool: LOG_ACTIVITIES_TOOL,
    argsHash,
    confirm: args.confirm,
    dryRun: args.dryRun,
    state,
    elicitedConfirm: readElicitedConfirm(opts.ctx),
    clientSupportsElicitation: clientSupportsElicitation(opts.ctx),
  });
  // A refused confirmation costs nothing upstream: it is decided before the
  // first write.
  if (!("mode" in decision)) return failed(decision);

  const planned = buildPlan(deps, args);
  const items = planned.map((entry) => entry.plan);
  const digest = await hashArgs(items);

  if (decision.mode === "input-required") {
    const wire = await deps.codec.mint(
      { tool: LOG_ACTIVITIES_TOOL, argsHash, previewDigest: digest, jti: newJti() },
      opts.ctx as ServerContext,
    );
    return inputRequired({
      inputRequests: {
        [CONFIRM_INPUT_KEY]: inputRequired.elicit({
          message: approvalMessage(planCounts(items)),
          requestedSchema: CONFIRM_FORM,
        }),
      },
      requestState: wire,
    });
  }
  if (decision.mode === "declined") return previewResult(items, { declined: true });
  if (decision.mode === "preview") {
    return previewResult(items, { requiresConfirmation: args.dryRun !== true });
  }
  // The plan a human approved is the plan that runs. An activity plan is built
  // from the arguments alone, so a digest that no longer matches means the
  // batch is not the one that was shown - and an entry, once logged, cannot be
  // taken back.
  if (state !== undefined && digest !== state.previewDigest) {
    return previewResult(items, { requiresConfirmation: true, recordsChanged: true });
  }

  const written = await executePlan(
    { records: deps.records },
    planned.map((entry) => entry.item),
    { ...(signal === undefined ? {} : { signal }), deadlineAt },
  );
  const results = await verifyOnWalls(deps, planned, written, signal);
  return {
    text: executedText(results, items.length),
    structured: { results, counts: countResults(results), errors: [] },
    isError: isBatchError(results),
  };
}
