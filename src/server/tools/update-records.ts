import {
  inputRequired,
  type InputRequiredResult,
  type RequestStateCodec,
  type ServerContext,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { cancelledError } from "../../livespace/errors.js";
import type {
  RecordDataMap,
  RecordFetchers,
  RecordKind,
} from "../../livespace/records.js";
import {
  normalizeWriteTimestamp,
  type CompanyUpdate,
  type DealUpdate,
  type PersonUpdate,
  type TaskUpdate,
  type WriteCallOptions,
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
  CONFIRM_INPUT_KEY,
  PLAN_BUDGET_EXPIRED,
  WRITE_BATCH_CAP,
  WRITE_BUDGET_MS,
  WRITE_CONFIRMATION_DESCRIPTION,
  WRITE_CONFIRM_PARAMETER_DESCRIPTION,
  WRITE_PREVIEW_HINT,
  type ExecutableItem,
  type ItemResult,
  type WriteItemPlan,
  type WriteState,
} from "./write-support.js";

/**
 * `update_records` - edit persons, companies, deals and tasks by id, one
 * bounded batch per call, written only after a human said yes.
 *
 * It shares `create_records`' confirmation machinery and adds the three things
 * an edit needs that a create does not:
 *
 * 1. **Every target is read before it is written.** The plan carries the values
 *    as they stand, so what a human approves is an actual change and not a
 *    guess; an id that answers nothing is `blocked` with NOT_FOUND and is never
 *    written. The same read is what closes the TOCTOU window: between the
 *    preview and the write the plan is rebuilt, and a record that moved
 *    underneath it goes back for a fresh confirmation.
 * 2. **Only what was named travels.** Livespace edits MERGE (probe evidence 4),
 *    so an unsent field is left alone rather than blanked - and an item that
 *    names no field at all is refused instead of sent as an empty write.
 * 3. **Ambiguity does nothing.** The same id twice in one kind is a BAD_PARAMS,
 *    not a race between two edits of one record (docs/security.md par. 5).
 *
 * The echo lies here as it does on create (evidence 2), so each written record
 * is re-read and compared: an item reports `before` -> `after`, the fields that
 * did not stick, or that the check itself was unavailable - never an error for
 * a write that landed.
 *
 * The text channel and the approval prompt carry counts and fixed wording only:
 * a before-value is a CRM-authored string, and those stay in
 * `structuredContent` where the schema types them as data (par. 4).
 *
 * Nothing here is cached: record data never is (par. 8), so this module must
 * never import the server cache.
 */

export const UPDATE_RECORDS_TOOL = "update_records";

/** Contact channels per person - the same bound the create tool uses. */
const MAX_CONTACT_CHANNELS = 5;

/**
 * The years a task date may fall in. The bound is not about data - it keeps a
 * year like 9999 from reaching a filter no upstream would understand.
 */
const DATE_MIN = "1900-01-01";
const DATE_MAX = "2100-12-31";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/u;

const idSchema = z.string().min(1).max(64);

const personItemSchema = z.strictObject({
  id: idSchema.describe("Person id from search_crm or get_records."),
  firstname: z.string().min(1).max(200).optional().describe("New given name."),
  lastname: z.string().max(200).optional().describe("New family name."),
  emails: z
    .array(z.string().min(3).max(320))
    .max(MAX_CONTACT_CHANNELS)
    .optional()
    .describe("E-mail addresses to store; an empty list changes nothing."),
  phones: z
    .array(z.string().min(3).max(40))
    .max(MAX_CONTACT_CHANNELS)
    .optional()
    .describe("Phone numbers to store; an empty list changes nothing."),
  note: z.string().max(5000).optional().describe("Free-text note stored on the person."),
  companyId: idSchema.optional().describe("Company to link the person to (from search_crm)."),
});

const companyItemSchema = z.strictObject({
  id: idSchema.describe("Company id from search_crm or get_records."),
  name: z.string().min(1).max(300).optional().describe("New company name."),
  nip: z.string().max(20).optional().describe("Tax id."),
});

const dealItemSchema = z.strictObject({
  id: idSchema.describe("Deal id from search_crm or get_records."),
  name: z.string().min(1).max(300).optional().describe("New deal name."),
  status: z
    .enum(["open", "won", "lost"])
    .optional()
    .describe("Deal status; this is NOT the process stage."),
});

const taskItemSchema = z.strictObject({
  id: idSchema.describe("Task id from get_records."),
  title: z.string().min(1).max(300).optional().describe("New task title."),
  date: z
    .string()
    .regex(DATE_PATTERN)
    .optional()
    .describe('When it is due: "YYYY-MM-DD" or "YYYY-MM-DD HH:MM:SS".'),
  description: z.string().max(5000).optional().describe("Task description."),
  isCompleted: z.boolean().optional().describe("Whether the task is done."),
});

const inputSchema = z.strictObject({
  persons: z
    .array(personItemSchema)
    .max(WRITE_BATCH_CAP)
    .optional()
    .describe("Persons to update."),
  companies: z
    .array(companyItemSchema)
    .max(WRITE_BATCH_CAP)
    .optional()
    .describe("Companies to update."),
  deals: z.array(dealItemSchema).max(WRITE_BATCH_CAP).optional().describe("Deals to update."),
  tasks: z.array(taskItemSchema).max(WRITE_BATCH_CAP).optional().describe("Tasks to update."),
  dryRun: z
    .boolean()
    .optional()
    .describe("Return the plan and write nothing; cannot be combined with confirm."),
  confirm: z
    .boolean()
    .optional()
    .describe(WRITE_CONFIRM_PARAMETER_DESCRIPTION),
});

// One static shape with optional keys per kind - never a union. A union of
// look-alike item shapes would let one kind validate as another and silently
// strip the fields it does not know (the M3 lesson).
const summarySchema = z.strictObject({
  id: z.string(),
  firstname: z.string().optional(),
  lastname: z.string().optional(),
  emails: z.array(z.string()).optional(),
  phones: z.array(z.string()).optional(),
  note: z.string().optional(),
  companyId: z.string().optional(),
  name: z.string().optional(),
  nip: z.string().optional(),
  status: z.string().optional(),
  title: z.string().optional(),
  date: z.string().optional(),
  description: z.string().optional(),
  isCompleted: z.boolean().optional(),
});

/**
 * A record as it stands, cut to the fields this item speaks about plus the one
 * that names it. `before` carries the id too; `after` is the same cut of the
 * re-read, so the pair lines up field by field.
 */
const valuesSchema = z.strictObject({
  id: z.string().optional(),
  name: z.string().optional(),
  title: z.string().optional(),
  emails: z.array(z.string()).optional(),
  phones: z.array(z.string()).optional(),
  note: z.string().optional(),
  companyId: z.string().nullable().optional(),
  nip: z.string().optional(),
  status: z.string().optional(),
  date: z.string().optional(),
  description: z.string().optional(),
  isCompleted: z.boolean().optional(),
});

const planItemSchema = z.strictObject({
  index: z.number(),
  action: z.string(),
  kind: z.string(),
  status: z.enum(["update", "blocked"]),
  summary: summarySchema,
  before: valuesSchema.optional(),
  error: toolErrorSchema.optional(),
});

const resultItemSchema = z.strictObject({
  index: z.number(),
  action: z.string(),
  kind: z.string(),
  // An update never skips a duplicate: it names the record it edits.
  status: z.enum(["ok", "error", "unknown_outcome", "not_attempted"]),
  id: z.string().optional(),
  resolvedByReread: z.boolean().optional(),
  verification: z.enum(["verified", "unavailable"]).optional(),
  unappliedFields: z.array(z.string()).optional(),
  before: valuesSchema.optional(),
  after: valuesSchema.optional(),
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

export type UpdateRecordsArgs = z.output<typeof inputSchema>;

type PersonItem = z.output<typeof personItemSchema>;
type CompanyItem = z.output<typeof companyItemSchema>;
type DealItem = z.output<typeof dealItemSchema>;
type TaskItem = z.output<typeof taskItemSchema>;

/** A write tool returns a normal result, or asks the client for a human's yes. */
export type UpdateRecordsResult = ToolRunResult | InputRequiredResult;

export interface UpdateRecordsDeps {
  writes: WriteFetchers;
  /** Targets are read before the write and again after it. */
  records: Pick<RecordFetchers, "getRecord">;
  codec: RequestStateCodec<WriteState>;
}

export const updateRecordsToolConfig = {
  title: "Update CRM Records",
  description: `Update persons, companies, deals or tasks by id - at most 10 items per call
across all four arrays. Edits merge upstream, so a field you do not send is
left alone, and an item that names no field at all is refused.
${WRITE_CONFIRMATION_DESCRIPTION}
Every target is read before the write, so the plan shows the current values, and
read again after it, so each item reports before and after plus the fields
that did not stick (unappliedFields) - or that the check was unavailable. A
deal update takes name and status (open, won, lost) only; status is NOT the
process stage, and stages, budget and tags are not editable here. The same id
may not appear twice within one kind.`,
  inputSchema,
  outputSchema,
  annotations: {
    readOnlyHint: false,
    // An update overwrites values that were there before - the honest hint.
    destructiveHint: true,
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
      title: "Update these records",
      description: "Approve the write. Anything else leaves the CRM untouched.",
    },
  },
  required: ["confirm"],
};

function badParams(hint: string): ToolError {
  return {
    code: "BAD_PARAMS",
    message: "These update_records arguments cannot be combined.",
    hint,
  };
}

function recordNotFound(): ToolError {
  return {
    code: "NOT_FOUND",
    message: "Record not found.",
    hint: "The id does not exist or the API key's user cannot see it - take ids from search_crm or get_records.",
  };
}

/**
 * A refused call carries no plan and no results - there is nothing to qualify.
 * The text names the code; the hint travels in the structured channel.
 */
function failed(error: ToolError): ToolRunResult {
  return {
    text: `${UPDATE_RECORDS_TOOL} failed: ${error.code}.`,
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

/** Trimmed, non-empty, de-duplicated - what actually travels upstream. */
function channels(values: string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed === "" || seen.has(trimmed)) continue;
    seen.add(trimmed);
    kept.push(trimmed);
  }
  return kept;
}

/**
 * The fields an item actually changes: everything the caller named except the
 * id, which says WHICH record rather than what about it changes. An empty array
 * never reaches this - it is dropped while the payload is built, because
 * against a merging endpoint it cannot express "clear these" (evidence 4).
 */
function sentFields(input: object): Record<string, unknown> {
  const sent: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "id" || value === undefined) continue;
    sent[key] = value;
  }
  return sent;
}

/**
 * One item, mapped and ready: which record, what changes, and the single
 * dispatch that applies it. Built before anything is read, so the argument
 * rules can see the real field set.
 */
interface PreparedItem {
  index: number;
  action: string;
  kind: RecordKind;
  id: string;
  sent: Record<string, unknown>;
  perform(writes: WriteFetchers, opts: WriteCallOptions): Promise<void>;
}

function preparePerson(item: PersonItem, index: number): PreparedItem {
  const emails = item.emails === undefined ? [] : channels(item.emails);
  const phones = item.phones === undefined ? [] : channels(item.phones);
  const input: PersonUpdate = {
    id: item.id,
    ...(item.firstname === undefined ? {} : { firstname: item.firstname }),
    ...(item.lastname === undefined ? {} : { lastname: item.lastname }),
    ...(emails.length === 0 ? {} : { emails }),
    ...(phones.length === 0 ? {} : { phones }),
    ...(item.note === undefined ? {} : { note: item.note }),
    ...(item.companyId === undefined ? {} : { companyId: item.companyId }),
  };
  return {
    index,
    action: "update_person",
    kind: "person",
    id: item.id,
    sent: sentFields(input),
    perform: (writes, opts) => writes.updatePerson(input, opts),
  };
}

function prepareCompany(item: CompanyItem, index: number): PreparedItem {
  const input: CompanyUpdate = {
    id: item.id,
    ...(item.name === undefined ? {} : { name: item.name }),
    ...(item.nip === undefined ? {} : { nip: item.nip }),
  };
  return {
    index,
    action: "update_company",
    kind: "company",
    id: item.id,
    sent: sentFields(input),
    perform: (writes, opts) => writes.updateCompany(input, opts),
  };
}

function prepareDeal(item: DealItem, index: number): PreparedItem {
  const input: DealUpdate = {
    id: item.id,
    ...(item.name === undefined ? {} : { name: item.name }),
    ...(item.status === undefined ? {} : { status: item.status }),
  };
  return {
    index,
    action: "update_deal",
    kind: "deal",
    id: item.id,
    sent: sentFields(input),
    perform: (writes, opts) => writes.updateDeal(input, opts),
  };
}

function prepareTask(item: TaskItem, index: number): PreparedItem {
  // The scalar `date` is the only date key that persists upstream, and it is
  // normalized here so the re-read comparison has an exact value to compare.
  const date = item.date === undefined ? undefined : normalizeWriteTimestamp(item.date);
  const input: TaskUpdate = {
    id: item.id,
    ...(item.title === undefined ? {} : { title: item.title }),
    ...(date === null || date === undefined ? {} : { date }),
    ...(item.description === undefined ? {} : { description: item.description }),
    // `false` is a value, not an absence: re-opening a task must survive this.
    ...(item.isCompleted === undefined ? {} : { isCompleted: item.isCompleted }),
  };
  return {
    index,
    action: "update_task",
    kind: "task",
    id: item.id,
    sent: sentFields(input),
    perform: (writes, opts) => writes.updateTask(input, opts),
  };
}

/** Declaration order - persons, companies, deals, tasks - numbered globally. */
function prepareItems(args: UpdateRecordsArgs): PreparedItem[] {
  const items: PreparedItem[] = [];
  for (const item of args.persons ?? []) items.push(preparePerson(item, items.length));
  for (const item of args.companies ?? []) items.push(prepareCompany(item, items.length));
  for (const item of args.deals ?? []) items.push(prepareDeal(item, items.length));
  for (const item of args.tasks ?? []) items.push(prepareTask(item, items.length));
  return items;
}

/**
 * Cross-field rules live here rather than in the schema: a zod refinement would
 * turn every combination mistake into a protocol-level validation error, while a
 * returned `{code, message, hint}` tells the model how to fix the call.
 */
function argumentHint(args: UpdateRecordsArgs, items: readonly PreparedItem[]): string | null {
  if (items.length === 0) {
    return "Send at least one item in persons, companies, deals or tasks.";
  }
  if (items.length > WRITE_BATCH_CAP) {
    return `One call writes at most ${WRITE_BATCH_CAP} records in total (this one has ${items.length}). Split the batch.`;
  }
  // Ids are per kind upstream, so a person and a deal may share a string; two
  // edits of ONE record in one call are the ambiguity par. 5 refuses.
  const seen = new Set<string>();
  for (const item of items) {
    const key = `${item.kind}:${item.id}`;
    if (seen.has(key)) {
      return `The same ${item.kind} id appears twice. Send one item per record and put every change in it.`;
    }
    seen.add(key);
  }
  for (const [index, task] of (args.tasks ?? []).entries()) {
    if (task.date === undefined) continue;
    const hint = dateHint(task.date);
    if (hint !== null) return `tasks[${index}]: ${hint}`;
  }
  for (const item of items) {
    if (Object.keys(item.sent).length === 0) {
      return `The ${item.kind} at index ${item.index} names no field to change. Send the fields to update beside the id.`;
    }
  }
  return null;
}

/** The record field a value is read back from, per kind, per sent field. */
const RECORD_SOURCES: { [K in RecordKind]: Record<string, string> } = {
  person: {
    emails: "emails",
    phones: "phones",
    note: "note",
    companyId: "companyId",
  },
  company: { name: "name", nip: "nip" },
  deal: { name: "name", status: "status" },
  task: {
    title: "title",
    description: "description",
    // The write key is `date`; the record reads it back as `dateFrom`.
    date: "dateFrom",
    isCompleted: "isCompleted",
  },
};

/** What the record calls itself. A person's name is composed upstream. */
const LABEL_FIELD: { [K in RecordKind]: string } = {
  person: "name",
  company: "name",
  deal: "name",
  task: "title",
};

/**
 * The record cut to this item: the field that names it, plus every sent field
 * the record can answer for. `firstname` and `lastname` have no counterpart -
 * upstream composes them into `name`, which is exactly why the label is always
 * carried: it is what a name edit visibly changes.
 */
function project(
  kind: RecordKind,
  sent: Record<string, unknown>,
  record: Record<string, unknown>,
): Record<string, unknown> {
  const view: Record<string, unknown> = {};
  const label = LABEL_FIELD[kind];
  if (record[label] !== undefined) view[label] = record[label];
  const sources = RECORD_SOURCES[kind];
  for (const field of Object.keys(sent)) {
    const source = sources[field];
    if (source === undefined) continue;
    view[field] = record[source];
  }
  return view;
}

interface PlannedBatch {
  items: WriteItemPlan[];
  executable: ExecutableItem[];
}

/**
 * Reads every target, in declaration order, and turns it into a plan item.
 *
 * The reads run here and nowhere else: a preview and the execute round that
 * follows it build the same plan the same way, which is what makes comparing
 * their digests meaningful - a record edited by someone else in between shows
 * up as a different `before` and sends the batch back for a fresh yes.
 *
 * They are upstream calls like any other, so they answer to the call's budget
 * and to a rate-limited upstream: once either says stop, the remaining items
 * are blocked with that reason and no further read is issued. A preview never
 * reaches the executor, where those rules used to live alone.
 */
async function buildPlan(
  deps: UpdateRecordsDeps,
  prepared: readonly PreparedItem[],
  signal: AbortSignal | undefined,
  deadlineAt: number,
): Promise<PlannedBatch> {
  const opts: WriteCallOptions = signal === undefined ? {} : { signal };
  const items: WriteItemPlan[] = [];
  const executable: ExecutableItem[] = [];
  let halt: ToolError | undefined;

  for (const entry of prepared) {
    const base = { index: entry.index, action: entry.action, kind: entry.kind };
    const summary = { id: entry.id, ...entry.sent };
    const block = (error: ToolError): void => {
      items.push({ ...base, status: "blocked", summary, error });
      executable.push({ ...base, status: "blocked", error });
    };

    // Between items, in this order - never mid-read, the same rule the
    // executor follows.
    if (halt === undefined) {
      if (signal?.aborted) throw cancelledError();
      if (Date.now() >= deadlineAt) halt = PLAN_BUDGET_EXPIRED;
    }
    if (halt !== undefined) {
      block(halt);
      continue;
    }

    let record: RecordDataMap[RecordKind] | null;
    try {
      record = await deps.records.getRecord(entry.kind, entry.id, opts);
    } catch (error) {
      // A target we could not read is a target we will not write over.
      const reason = toEntry(error, signal);
      // The upstream said stop: this item is blocked and so is every one
      // after it - none of them is read at all.
      if (reason.code === "RATE_LIMITED") halt = reason;
      block(reason);
      continue;
    }
    if (record === null) {
      block(recordNotFound());
      continue;
    }

    const stored = record as unknown as Record<string, unknown>;
    const before = { id: entry.id, ...project(entry.kind, entry.sent, stored) };
    items.push({ ...base, status: "update", summary, before });
    executable.push({
      ...base,
      status: "update",
      id: entry.id,
      sent: entry.sent,
      before,
      view: (value) => project(entry.kind, entry.sent, value),
      perform: async (callOpts) => {
        await entry.perform(deps.writes, callOpts);
        return entry.id;
      },
    });
  }
  return { items, executable };
}

interface PlanCounts {
  persons: number;
  companies: number;
  deals: number;
  tasks: number;
  total: number;
}

function planCounts(items: readonly WriteItemPlan[]): PlanCounts {
  const of = (kind: string): number => items.filter((item) => item.kind === kind).length;
  return {
    persons: of("person"),
    companies: of("company"),
    deals: of("deal"),
    tasks: of("task"),
    total: items.length,
  };
}

/** Counts and fixed wording only - no name, id or field value (par. 4). */
function previewLine(counts: PlanCounts): string {
  return (
    `${UPDATE_RECORDS_TOOL} preview: ${counts.total} item(s) ` +
    `(${counts.persons} persons, ${counts.companies} companies, ${counts.deals} deals, ${counts.tasks} tasks). ` +
    `${WRITE_PREVIEW_HINT}`
  );
}

/** The string a HUMAN approves. Same rule, and it is ours end to end. */
function approvalMessage(counts: PlanCounts): string {
  return (
    `Update ${counts.total} CRM record(s) ` +
    `(${counts.persons} persons, ${counts.companies} companies, ${counts.deals} deals, ${counts.tasks} tasks). ` +
    `Approve?`
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

/** The item arrays alone: flipping `confirm` or `dryRun` is not a new batch. */
function itemArgs(args: UpdateRecordsArgs): Record<string, unknown> {
  return {
    persons: args.persons,
    companies: args.companies,
    deals: args.deals,
    tasks: args.tasks,
  };
}

function executedText(results: readonly ItemResult[], planned: number): string {
  const counts = countResults(results);
  const attempted = counts.ok + counts.error + counts.unknownOutcome;
  return (
    `${UPDATE_RECORDS_TOOL}: attempted ${attempted} of ${planned} - ` +
    `ok ${counts.ok}, errors ${counts.error}, ` +
    `unknown ${counts.unknownOutcome}, not attempted ${counts.notAttempted}.`
  );
}

export async function runUpdateRecords(
  deps: UpdateRecordsDeps,
  args: UpdateRecordsArgs,
  opts: WriteToolOptions = {},
): Promise<UpdateRecordsResult> {
  // One wall clock for the whole call, plan reads included - the client's
  // request timeout does not stop counting while we are planning.
  const deadlineAt = Date.now() + WRITE_BUDGET_MS;
  const prepared = prepareItems(args);
  const hint = argumentHint(args, prepared);
  if (hint !== null) return failed(badParams(hint));
  const signal = opts.signal;
  // A caller who walked away before the first call gets no work and no result.
  if (signal?.aborted) throw cancelledError();

  const argsHash = await hashArgs(itemArgs(args));
  const state = readWriteState(opts.ctx);
  const decision = decideConfirm({
    tool: UPDATE_RECORDS_TOOL,
    argsHash,
    confirm: args.confirm,
    dryRun: args.dryRun,
    state,
    elicitedConfirm: readElicitedConfirm(opts.ctx),
    clientSupportsElicitation: clientSupportsElicitation(opts.ctx),
    allowUnboundWriteConfirmation: opts.allowUnboundWriteConfirmation,
  });
  // A refused confirmation costs nothing upstream: it is decided before the
  // first read.
  if (!("mode" in decision)) return failed(decision);

  const batch = await buildPlan(deps, prepared, signal, deadlineAt);
  const digest = await hashArgs(batch.items);

  if (decision.mode === "input-required") {
    const wire = await deps.codec.mint(
      { tool: UPDATE_RECORDS_TOOL, argsHash, previewDigest: digest, jti: newJti() },
      opts.ctx as ServerContext,
    );
    return inputRequired({
      inputRequests: {
        [CONFIRM_INPUT_KEY]: inputRequired.elicit({
          message: approvalMessage(planCounts(batch.items)),
          requestedSchema: CONFIRM_FORM,
        }),
      },
      requestState: wire,
    });
  }
  if (decision.mode === "declined") return previewResult(batch.items, { declined: true });
  if (decision.mode === "preview") {
    return previewResult(batch.items, { requiresConfirmation: args.dryRun !== true });
  }
  // The preview is a promise about records that may have moved since. When the
  // rebuilt plan no longer matches the one that was approved, nothing is
  // written and the fresh plan goes back for a fresh confirmation.
  if (state !== undefined && digest !== state.previewDigest) {
    return previewResult(batch.items, { requiresConfirmation: true, recordsChanged: true });
  }

  const results = await executePlan({ records: deps.records }, batch.executable, {
    ...(signal === undefined ? {} : { signal }),
    deadlineAt,
  });
  return {
    text: executedText(results, batch.items.length),
    structured: { results, counts: countResults(results), errors: [] },
    isError: isBatchError(results),
  };
}
