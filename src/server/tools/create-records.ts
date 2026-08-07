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
  type BudgetLineWrite,
  type CompanyWrite,
  type DealWrite,
  type PersonWrite,
  type RecordPointer,
  type TaskWrite,
  type WriteCallOptions,
  type WriteFetchers,
} from "../../livespace/writes.js";
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
  type CreateResolution,
  type ExecutableItem,
  type ItemResult,
  type WriteItemPlan,
  type WriteState,
} from "./write-support.js";

/**
 * `create_records` - persons, companies, deals and tasks, one bounded batch per
 * call, written only after a human said yes.
 *
 * Four shapes of discipline live here:
 *
 * 1. **Nothing is written before it is shown.** A plain call answers with a
 *    plan; a client that can prompt gets the confirmation prompt (and the model
 *    cannot answer that prompt for the human); a client that cannot gets the
 *    documented `confirm: true` trigger. Between the preview and the write the
 *    plan is rebuilt and compared, so a batch never lands against records that
 *    changed underneath it (docs/security.md par. 5).
 * 2. **Duplicates are ours to find.** Livespace's own `__check_if_exists` does
 *    not dedupe (probe evidence 10), so a person is matched by exact e-mail and
 *    a company by exact name - against the CRM and against the earlier items of
 *    the same call. A hit skips the item and reports the id it found;
 *    `allowDuplicate` is the explicit way to create anyway.
 * 3. **The echo is not evidence.** Every write endpoint answers with a copy of
 *    the input plus an id whatever it stored, so each created record is re-read
 *    and compared. A write that landed stays `ok` even when the follow-up read
 *    fails - it just reports that the verification was unavailable.
 * 4. **The text channel and the approval prompt carry counts only.** Names,
 *    ids and field values are CRM- or model-authored strings; they stay in
 *    `structuredContent`, where the schema types them as data. A prompt a human
 *    approves is built from our own wording and nothing else
 *    (docs/security.md par. 4).
 *
 * Nothing here is cached: record data never is (par. 8), so this module must
 * never import the server cache. The only cached input is the `processes`
 * dictionary, read through the existing `MetadataService` to validate a deal's
 * process id before anything is written.
 */

export const CREATE_RECORDS_TOOL = "create_records";

/** Contact channels per person, and budget lines per deal. */
const MAX_CONTACT_CHANNELS = 5;
const MAX_BUDGET_LINES = 20;
const MAX_LINE_AMOUNT = 100_000;

/**
 * The years a task date may fall in. The bound is not about data - it keeps a
 * year like 9999 from reaching a filter no upstream would understand.
 */
const DATE_MIN = "1900-01-01";
const DATE_MAX = "2100-12-31";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/u;

const idSchema = z.string().min(1).max(64);

const personItemSchema = z.strictObject({
  firstname: z.string().min(1).max(200).describe("Given name (required)."),
  lastname: z.string().max(200).optional().describe("Family name."),
  emails: z
    .array(z.string().min(3).max(320))
    .max(MAX_CONTACT_CHANNELS)
    .optional()
    .describe("E-mail addresses; the first match decides the duplicate check."),
  phones: z
    .array(z.string().min(3).max(40))
    .max(MAX_CONTACT_CHANNELS)
    .optional()
    .describe("Phone numbers."),
  note: z.string().max(5000).optional().describe("Free-text note stored on the person."),
  companyId: idSchema.optional().describe("Company to link the person to (from search_crm)."),
  allowDuplicate: z
    .boolean()
    .optional()
    .describe("Create even when an e-mail already exists in the CRM."),
});

const companyItemSchema = z.strictObject({
  name: z.string().min(1).max(300).describe("Company name (required)."),
  nip: z.string().max(20).optional().describe("Tax id."),
  allowDuplicate: z
    .boolean()
    .optional()
    .describe("Create even when the name already exists in the CRM."),
});

const budgetLineSchema = z.strictObject({
  productId: idSchema.optional().describe("Catalog product id from crm_metadata (products)."),
  productName: z.string().min(1).max(300).optional().describe("Free-text product line."),
  price: z.number().describe("Unit price, a finite number."),
  amount: z.number().positive().max(MAX_LINE_AMOUNT).describe("Quantity, greater than zero."),
});

const dealItemSchema = z.strictObject({
  name: z.string().min(1).max(300).describe("Deal name (required)."),
  companyId: idSchema.optional().describe("Owning company; exclusive with contactId."),
  contactId: idSchema.optional().describe("Owning person; exclusive with companyId."),
  processId: idSchema
    .optional()
    .describe("Sales process from crm_metadata; the first process is used when absent."),
  budget: z
    .array(budgetLineSchema)
    .max(MAX_BUDGET_LINES)
    .optional()
    .describe("Budget lines; the deal value is computed from them upstream."),
});

const taskItemSchema = z.strictObject({
  title: z.string().min(1).max(300).describe("Task title (required)."),
  date: z
    .string()
    .regex(DATE_PATTERN)
    .optional()
    .describe('When it is due: "YYYY-MM-DD" or "YYYY-MM-DD HH:MM:SS".'),
  description: z.string().max(5000).optional().describe("Task description."),
});

const inputSchema = z.strictObject({
  persons: z
    .array(personItemSchema)
    .max(WRITE_BATCH_CAP)
    .optional()
    .describe("Persons to create."),
  companies: z
    .array(companyItemSchema)
    .max(WRITE_BATCH_CAP)
    .optional()
    .describe("Companies to create."),
  deals: z.array(dealItemSchema).max(WRITE_BATCH_CAP).optional().describe("Deals to create."),
  tasks: z.array(taskItemSchema).max(WRITE_BATCH_CAP).optional().describe("Tasks to create."),
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
  firstname: z.string().optional(),
  lastname: z.string().optional(),
  emails: z.array(z.string()).optional(),
  phones: z.array(z.string()).optional(),
  note: z.string().optional(),
  companyId: z.string().optional(),
  contactId: z.string().optional(),
  name: z.string().optional(),
  nip: z.string().optional(),
  processId: z.string().optional(),
  budget: z
    .array(
      z.strictObject({
        productId: z.string().optional(),
        productName: z.string().optional(),
        price: z.number(),
        amount: z.number(),
      }),
    )
    .optional(),
  title: z.string().optional(),
  date: z.string().optional(),
  description: z.string().optional(),
});

const planItemSchema = z.strictObject({
  index: z.number(),
  action: z.string(),
  kind: z.string(),
  status: z.enum(["create", "skipped_duplicate", "blocked"]),
  summary: summarySchema,
  dedupe: z.strictObject({ existingId: z.string() }).optional(),
  error: toolErrorSchema.optional(),
});

const resultItemSchema = z.strictObject({
  index: z.number(),
  action: z.string(),
  kind: z.string(),
  status: z.enum(["ok", "skipped_duplicate", "error", "unknown_outcome", "not_attempted"]),
  id: z.string().optional(),
  existingId: z.string().optional(),
  resolvedByReread: z.boolean().optional(),
  verification: z.enum(["verified", "unavailable"]).optional(),
  unappliedFields: z.array(z.string()).optional(),
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

export type CreateRecordsArgs = z.output<typeof inputSchema>;

type PersonItem = z.output<typeof personItemSchema>;
type CompanyItem = z.output<typeof companyItemSchema>;
type DealItem = z.output<typeof dealItemSchema>;
type TaskItem = z.output<typeof taskItemSchema>;
type BudgetLineItem = z.output<typeof budgetLineSchema>;

/** A write tool returns a normal result, or asks the client for a human's yes. */
export type CreateRecordsResult = ToolRunResult | InputRequiredResult;

export interface CreateRecordsDeps {
  writes: WriteFetchers;
  records: Pick<RecordFetchers, "getRecord">;
  /** Only the `processes` dictionary is read, and only to validate a deal. */
  metadata: MetadataService;
  codec: RequestStateCodec<WriteState>;
}

export interface WriteToolOptions {
  signal?: AbortSignal;
  /** The SDK request context: client capabilities, responses, request state. */
  ctx?: unknown;
  /** Process-level operator opt-in for clients without signed elicitation. */
  allowUnboundWriteConfirmation?: boolean;
}

export const createRecordsToolConfig = {
  title: "Create CRM Records",
  description: `Create persons, companies, deals or tasks - at most 10 items per call across
all four arrays. Nothing is written until a human approves: a plain call
answers with a plan (so does dryRun), clients that can prompt get a
confirmation prompt, and clients that cannot execute the previewed plan by
re-calling with confirm: true. Notes: a person carrying e-mails is checked
against the CRM by exact address (case-insensitive) and against the earlier
items of the same call, a company by exact name - a match is reported as
skipped_duplicate with the existing id, and allowDuplicate: true creates
anyway; a deal takes exactly one of companyId or contactId, an optional
processId from crm_metadata, and its value is computed upstream from the
budget lines, each naming either a catalog productId or a free-text
productName; a task takes one date and cannot be linked to records; tags are
not supported. Every created record is re-read and compared with what was
sent, so an item reports which fields did not stick (unappliedFields) or that
the check itself was unavailable.`,
  inputSchema,
  outputSchema,
  annotations: {
    readOnlyHint: false,
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
      title: "Create these records",
      description: "Approve the write. Anything else leaves the CRM untouched.",
    },
  },
  required: ["confirm"],
};

function badParams(hint: string): ToolError {
  return {
    code: "BAD_PARAMS",
    message: "These create_records arguments cannot be combined.",
    hint,
  };
}

function processNotFound(): ToolError {
  return {
    code: "NOT_FOUND",
    message: "Process not found.",
    hint: 'Call crm_metadata (sections: ["processes"]) for valid process ids.',
  };
}

/**
 * A refused call carries no plan and no results - there is nothing to qualify.
 * The text names the code; the hint travels in the structured channel.
 */
function failed(error: ToolError): ToolRunResult {
  return {
    text: `${CREATE_RECORDS_TOOL} failed: ${error.code}.`,
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

function itemTotal(args: CreateRecordsArgs): number {
  return (
    (args.persons?.length ?? 0) +
    (args.companies?.length ?? 0) +
    (args.deals?.length ?? 0) +
    (args.tasks?.length ?? 0)
  );
}

/**
 * Cross-field rules live here rather than in the schema: a zod refinement would
 * turn every combination mistake into a protocol-level validation error, while a
 * returned `{code, message, hint}` tells the model how to fix the call.
 */
function argumentHint(args: CreateRecordsArgs): string | null {
  const total = itemTotal(args);
  if (total === 0) {
    return "Send at least one item in persons, companies, deals or tasks.";
  }
  if (total > WRITE_BATCH_CAP) {
    return `One call writes at most ${WRITE_BATCH_CAP} records in total (this one has ${total}). Split the batch.`;
  }
  for (const [index, deal] of (args.deals ?? []).entries()) {
    if ((deal.companyId === undefined) === (deal.contactId === undefined)) {
      return `deals[${index}] needs exactly one of companyId and contactId - a deal belongs either to a company or to a person.`;
    }
    for (const [line, entry] of (deal.budget ?? []).entries()) {
      if ((entry.productId === undefined) === (entry.productName === undefined)) {
        return `deals[${index}].budget[${line}] needs exactly one of productId (a catalog product from crm_metadata) and productName (a free-text line).`;
      }
    }
  }
  for (const [index, task] of (args.tasks ?? []).entries()) {
    if (task.date === undefined) continue;
    const hint = dateHint(task.date);
    if (hint !== null) return `tasks[${index}]: ${hint}`;
  }
  return null;
}

/**
 * A deal's process id is validated against the cached dictionary BEFORE any
 * lookup or write runs, so a typo costs one cached read and nothing else.
 */
async function validateProcesses(
  metadata: MetadataService,
  deals: readonly DealItem[],
  signal: AbortSignal | undefined,
): Promise<ToolError | null> {
  const wanted = new Set(
    deals.flatMap((deal) => (deal.processId === undefined ? [] : [deal.processId])),
  );
  if (wanted.size === 0) return null;
  try {
    const dictionary = await metadata.get(
      "processes",
      signal === undefined ? undefined : { signal },
    );
    const known = new Set(dictionary.data.map((process) => process.id));
    for (const id of wanted) {
      if (!known.has(id)) return processNotFound();
    }
    return null;
  } catch (error) {
    return toEntry(error, signal);
  }
}

/** The identity an item claims: an existing record, or one this batch creates. */
type Claim = { existingId: string } | { pendingIndex: number };

interface PlannedBatch {
  items: WriteItemPlan[];
  executable: ExecutableItem[];
  /** Item index -> the earlier item whose create will own the record. */
  pending: Map<number, number>;
}

interface PlanState {
  writes: WriteFetchers;
  opts: WriteCallOptions;
  signal: AbortSignal | undefined;
  /**
   * Why the plan stopped: a rate-limited upstream, or a spent budget. Once
   * set, every remaining item is blocked with it and no further lookup is
   * issued - the plan phase costs reads too, and an upstream that said stop is
   * not hammered by the ten lookups that would otherwise follow.
   */
  halt: ToolError | undefined;
  /**
   * Ids that already existed when the plan was built. The array is filled while
   * planning and read at execute time, where it guards the unknown-outcome
   * resolution: landing on a record that was already there proves nothing.
   */
  knownIds: string[];
  claims: Map<string, Claim>;
  batch: PlannedBatch;
}

interface ItemBase {
  index: number;
  action: string;
  kind: "person" | "company" | "deal" | "task";
}

function normalizeIdentity(value: string): string {
  return value.trim().toLowerCase();
}

/** Trimmed, non-empty, de-duplicated - what actually travels upstream. */
function channels(values: string[] | undefined): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const value of values ?? []) {
    const trimmed = value.trim();
    if (trimmed === "" || seen.has(trimmed)) continue;
    seen.add(trimmed);
    kept.push(trimmed);
  }
  return kept;
}

/** How many items of the batch claim each identity, so uniqueness is knowable. */
function identityCounts(identities: readonly string[][]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const values of identities) {
    for (const value of new Set(values)) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  return counts;
}

function claimAll(state: PlanState, identities: readonly string[], claim: Claim): void {
  for (const identity of identities) {
    if (!state.claims.has(identity)) state.claims.set(identity, claim);
  }
}

function pushSkipped(
  state: PlanState,
  base: ItemBase,
  summary: Record<string, unknown>,
  claim: Claim,
): void {
  const existing = "existingId" in claim ? claim.existingId : undefined;
  state.batch.items.push({
    ...base,
    status: "skipped_duplicate",
    summary,
    ...(existing === undefined ? {} : { dedupe: { existingId: existing } }),
  });
  state.batch.executable.push({
    ...base,
    status: "skipped_duplicate",
    // An in-batch duplicate learns its id only after the earlier item ran.
    existingId: existing ?? "",
  });
  if (existing === undefined && "pendingIndex" in claim) {
    state.batch.pending.set(base.index, claim.pendingIndex);
  }
}

function pushBlocked(
  state: PlanState,
  base: ItemBase,
  summary: Record<string, unknown>,
  error: ToolError,
): void {
  state.batch.items.push({ ...base, status: "blocked", summary, error });
  state.batch.executable.push({ ...base, status: "blocked", error });
}

/**
 * The dedupe verdict for one item: the first identity that is already claimed -
 * in this batch or in the CRM - decides. A lookup that fails does NOT fall
 * through to a create: without an answer a create risks a duplicate nobody
 * asked for, so the item is blocked instead (par. 5, ambiguity does nothing).
 */
async function findClaim(
  state: PlanState,
  identities: readonly string[],
  find: (identity: string, opts: WriteCallOptions) => Promise<RecordPointer | null>,
): Promise<{ claim?: Claim; lookup: CreateResolution["lookup"]; error?: ToolError }> {
  let lookup: CreateResolution["lookup"] = "not-run";
  for (const identity of identities) {
    const claimed = state.claims.get(identity);
    if (claimed !== undefined) return { claim: claimed, lookup };
    let hit: RecordPointer | null;
    try {
      hit = await find(identity, state.opts);
    } catch (error) {
      const entry = toEntry(error, state.signal);
      // The upstream said stop: this item is blocked and so is every one after
      // it - none of them is looked up at all.
      if (entry.code === "RATE_LIMITED") state.halt = entry;
      return { lookup, error: entry };
    }
    if (hit === null) {
      lookup = "missed";
      continue;
    }
    state.knownIds.push(hit.id);
    return { claim: { existingId: hit.id }, lookup: "hit" };
  }
  return { lookup };
}

function resolution(
  state: PlanState,
  lookup: CreateResolution["lookup"],
  unique: boolean,
  identity: string | undefined,
  find: (identity: string, opts: WriteCallOptions) => Promise<RecordPointer | null>,
): CreateResolution {
  return {
    lookup,
    uniqueInBatch: unique && identity !== undefined,
    knownIds: state.knownIds,
    find: async (opts) => (identity === undefined ? null : find(identity, opts)),
  };
}

function personInput(item: PersonItem, emails: string[], phones: string[]): PersonWrite {
  return {
    firstname: item.firstname,
    ...(item.lastname === undefined ? {} : { lastname: item.lastname }),
    ...(emails.length === 0 ? {} : { emails }),
    ...(phones.length === 0 ? {} : { phones }),
    ...(item.note === undefined ? {} : { note: item.note }),
    ...(item.companyId === undefined ? {} : { companyId: item.companyId }),
  };
}

async function planPerson(
  state: PlanState,
  item: PersonItem,
  index: number,
  unique: boolean,
): Promise<void> {
  const base: ItemBase = { index, action: "create_person", kind: "person" };
  const emails = channels(item.emails);
  const input = personInput(item, emails, channels(item.phones));
  const summary = { ...input } as Record<string, unknown>;
  if (state.halt !== undefined) {
    pushBlocked(state, base, summary, state.halt);
    return;
  }
  // Two spellings of one address are one identity: they are looked up once.
  const identities = [...new Set(emails.map(normalizeIdentity))];
  const find = (email: string, opts: WriteCallOptions): Promise<RecordPointer | null> =>
    state.writes.findPersonByEmail(email, opts);

  // An explicit allowDuplicate needs no lookup: its answer could not change the
  // outcome, and an upstream call that cannot change anything is not made.
  const verdict =
    item.allowDuplicate === true
      ? { lookup: "not-run" as const }
      : await findClaim(state, identities, find);
  if (verdict.error !== undefined) {
    pushBlocked(state, base, summary, verdict.error);
    return;
  }
  if (verdict.claim !== undefined) {
    claimAll(state, identities, verdict.claim);
    pushSkipped(state, base, summary, verdict.claim);
    return;
  }

  claimAll(state, identities, { pendingIndex: index });
  state.batch.items.push({ ...base, status: "create", summary });
  state.batch.executable.push({
    ...base,
    status: "create",
    sent: summary,
    perform: async (opts) => (await state.writes.createPerson(input, opts)).id,
    resolve: resolution(state, verdict.lookup, unique, identities[0], find),
  });
}

async function planCompany(
  state: PlanState,
  item: CompanyItem,
  index: number,
  unique: boolean,
): Promise<void> {
  const base: ItemBase = { index, action: "create_company", kind: "company" };
  const input: CompanyWrite = {
    name: item.name,
    ...(item.nip === undefined ? {} : { nip: item.nip }),
  };
  const summary = { ...input } as Record<string, unknown>;
  if (state.halt !== undefined) {
    pushBlocked(state, base, summary, state.halt);
    return;
  }
  // The lookup gets the trimmed name; the local compare is case-insensitive, so
  // the case the caller sent is what gets written.
  const wanted = item.name.trim();
  const identities = wanted === "" ? [] : [normalizeIdentity(wanted)];
  const find = (_identity: string, opts: WriteCallOptions): Promise<RecordPointer | null> =>
    state.writes.findCompanyByName(wanted, opts);

  const verdict =
    item.allowDuplicate === true
      ? { lookup: "not-run" as const }
      : await findClaim(state, identities, find);
  if (verdict.error !== undefined) {
    pushBlocked(state, base, summary, verdict.error);
    return;
  }
  if (verdict.claim !== undefined) {
    claimAll(state, identities, verdict.claim);
    pushSkipped(state, base, summary, verdict.claim);
    return;
  }

  claimAll(state, identities, { pendingIndex: index });
  state.batch.items.push({ ...base, status: "create", summary });
  state.batch.executable.push({
    ...base,
    status: "create",
    sent: summary,
    perform: async (opts) => (await state.writes.createCompany(input, opts)).id,
    resolve: resolution(state, verdict.lookup, unique, identities[0], find),
  });
}

function budgetLine(line: BudgetLineItem): BudgetLineWrite {
  return {
    ...(line.productId === undefined ? {} : { productId: line.productId }),
    ...(line.productName === undefined ? {} : { productName: line.productName }),
    price: line.price,
    amount: line.amount,
  };
}

function planDeal(state: PlanState, item: DealItem, index: number): void {
  const base: ItemBase = { index, action: "create_deal", kind: "deal" };
  const input: DealWrite = {
    name: item.name,
    ...(item.companyId === undefined ? {} : { companyId: item.companyId }),
    ...(item.contactId === undefined ? {} : { contactId: item.contactId }),
    ...(item.processId === undefined ? {} : { processId: item.processId }),
    ...(item.budget === undefined ? {} : { budget: item.budget.map(budgetLine) }),
  };
  const summary = { ...input } as Record<string, unknown>;
  if (state.halt !== undefined) {
    pushBlocked(state, base, summary, state.halt);
    return;
  }
  state.batch.items.push({ ...base, status: "create", summary });
  state.batch.executable.push({
    ...base,
    status: "create",
    sent: summary,
    perform: async (opts) => (await state.writes.createDeal(input, opts)).id,
  });
}

function planTask(state: PlanState, item: TaskItem, index: number): void {
  const base: ItemBase = { index, action: "create_task", kind: "task" };
  // The scalar `date` is the only date key that persists upstream, and it is
  // normalized here so the re-read comparison has an exact value to compare.
  const date = item.date === undefined ? undefined : normalizeWriteTimestamp(item.date);
  const input: TaskWrite = {
    title: item.title,
    ...(date === null || date === undefined ? {} : { date }),
    ...(item.description === undefined ? {} : { description: item.description }),
  };
  const summary = { ...input } as Record<string, unknown>;
  if (state.halt !== undefined) {
    pushBlocked(state, base, summary, state.halt);
    return;
  }
  state.batch.items.push({ ...base, status: "create", summary });
  state.batch.executable.push({
    ...base,
    status: "create",
    sent: summary,
    perform: async (opts) => (await state.writes.createTask(input, opts)).id,
  });
}

/**
 * Between items, in this order - never mid-lookup, the same rule the executor
 * follows. An abort ends the call; a spent budget stops the plan, and every
 * item it never reached is blocked rather than silently dropped.
 */
function checkPlanBudget(state: PlanState, deadlineAt: number): void {
  if (state.halt !== undefined) return;
  if (state.signal?.aborted) throw cancelledError();
  if (Date.now() >= deadlineAt) state.halt = PLAN_BUDGET_EXPIRED;
}

/**
 * Builds the plan in declaration order - persons, companies, deals, tasks - and
 * numbers the items globally, so a result lines up with the batch that was sent.
 * The lookups run here and nowhere else: a preview and the execute round that
 * follows it build the same plan the same way, which is what makes comparing
 * their digests meaningful.
 *
 * They are upstream calls like any other, so they answer to the call's budget
 * and to a rate-limited upstream - a preview never reaches the executor, where
 * those rules used to live alone.
 */
async function buildPlan(
  deps: CreateRecordsDeps,
  args: CreateRecordsArgs,
  signal: AbortSignal | undefined,
  deadlineAt: number,
): Promise<PlannedBatch> {
  const state: PlanState = {
    writes: deps.writes,
    opts: signal === undefined ? {} : { signal },
    signal,
    halt: undefined,
    knownIds: [],
    claims: new Map(),
    batch: { items: [], executable: [], pending: new Map() },
  };

  const persons = args.persons ?? [];
  const companies = args.companies ?? [];
  const personCounts = identityCounts(
    persons.map((item) => channels(item.emails).map(normalizeIdentity)),
  );
  const companyCounts = identityCounts(
    companies.map((item) => [normalizeIdentity(item.name)]),
  );
  const unique = (counts: Map<string, number>, identities: string[]): boolean =>
    identities.length > 0 && identities.every((value) => counts.get(value) === 1);

  let index = 0;
  for (const item of persons) {
    checkPlanBudget(state, deadlineAt);
    await planPerson(
      state,
      item,
      index,
      unique(personCounts, channels(item.emails).map(normalizeIdentity)),
    );
    index += 1;
  }
  for (const item of companies) {
    checkPlanBudget(state, deadlineAt);
    await planCompany(state, item, index, unique(companyCounts, [normalizeIdentity(item.name)]));
    index += 1;
  }
  for (const item of args.deals ?? []) {
    checkPlanBudget(state, deadlineAt);
    planDeal(state, item, index);
    index += 1;
  }
  for (const item of args.tasks ?? []) {
    checkPlanBudget(state, deadlineAt);
    planTask(state, item, index);
    index += 1;
  }
  return state.batch;
}

interface PlanCounts {
  persons: number;
  companies: number;
  deals: number;
  tasks: number;
  total: number;
  duplicates: number;
}

function planCounts(items: readonly WriteItemPlan[]): PlanCounts {
  const of = (kind: string): number => items.filter((item) => item.kind === kind).length;
  return {
    persons: of("person"),
    companies: of("company"),
    deals: of("deal"),
    tasks: of("task"),
    total: items.length,
    duplicates: items.filter((item) => item.status === "skipped_duplicate").length,
  };
}

/** Counts and fixed wording only - no name, id or field value (par. 4). */
function previewLine(counts: PlanCounts): string {
  return (
    `${CREATE_RECORDS_TOOL} preview: ${counts.total} item(s) ` +
    `(${counts.persons} persons, ${counts.companies} companies, ${counts.deals} deals, ${counts.tasks} tasks), ` +
    `${counts.duplicates} duplicate(s) skipped. Re-call with confirm: true to execute.`
  );
}

/** The string a HUMAN approves. Same rule, and it is ours end to end. */
function approvalMessage(counts: PlanCounts): string {
  return (
    `Create ${counts.total} CRM record(s) ` +
    `(${counts.persons} persons, ${counts.companies} companies, ${counts.deals} deals, ${counts.tasks} tasks). ` +
    `${counts.duplicates} duplicate(s) will be skipped. Approve?`
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

/**
 * An in-batch duplicate is planned before the item it duplicates has an id, so
 * the id is filled in here. An earlier item that never landed leaves the key
 * absent rather than pointing at a record that does not exist.
 */
function fillDuplicateIds(
  results: readonly ItemResult[],
  pending: ReadonlyMap<number, number>,
): ItemResult[] {
  if (pending.size === 0) return [...results];
  const byIndex = new Map(results.map((result) => [result.index, result]));
  return results.map((result) => {
    const source = pending.get(result.index);
    // A duplicate the budget or an abort never reached is `not_attempted`, and
    // it carries no id to speak of.
    if (source === undefined || result.status !== "skipped_duplicate") return result;
    const id = byIndex.get(source)?.id;
    const filled: ItemResult = { ...result };
    if (id === undefined) delete filled.existingId;
    else filled.existingId = id;
    return filled;
  });
}

/**
 * The verified confirmation payload of this round, if any. The SDK seam has
 * already run the codec's `verify` by the time the handler is entered, but the
 * accessor is typed by cast alone and returns the RAW wire string when no
 * verify hook is configured - so the shape is checked here before it is
 * believed. Exported because every write tool needs the same read.
 */
export function readWriteState(ctx: unknown): WriteState | undefined {
  const mcpReq = (ctx as { mcpReq?: Record<string, unknown> } | null | undefined)?.mcpReq;
  const accessor = mcpReq?.["requestState"];
  if (typeof accessor !== "function") return undefined;
  const value: unknown = (accessor as (this: unknown) => unknown).call(mcpReq);
  if (value === null || typeof value !== "object") return undefined;
  const data = value as Record<string, unknown>;
  const { tool, argsHash, previewDigest, jti } = data;
  if (
    typeof tool !== "string" ||
    typeof argsHash !== "string" ||
    typeof previewDigest !== "string" ||
    typeof jti !== "string"
  ) {
    return undefined;
  }
  return { tool, argsHash, previewDigest, jti };
}

/** The item arrays alone: flipping `confirm` or `dryRun` is not a new batch. */
function itemArgs(args: CreateRecordsArgs): Record<string, unknown> {
  return {
    persons: args.persons,
    companies: args.companies,
    deals: args.deals,
    tasks: args.tasks,
  };
}

export async function runCreateRecords(
  deps: CreateRecordsDeps,
  args: CreateRecordsArgs,
  opts: WriteToolOptions = {},
): Promise<CreateRecordsResult> {
  // One wall clock for the whole call, plan lookups included - the client's
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
    tool: CREATE_RECORDS_TOOL,
    argsHash,
    confirm: args.confirm,
    dryRun: args.dryRun,
    state,
    elicitedConfirm: readElicitedConfirm(opts.ctx),
    clientSupportsElicitation: clientSupportsElicitation(opts.ctx),
    allowUnboundWriteConfirmation: opts.allowUnboundWriteConfirmation,
  });
  // A refused confirmation costs nothing upstream: it is decided before the
  // first lookup.
  if (!("mode" in decision)) return failed(decision);

  const processError = await validateProcesses(deps.metadata, args.deals ?? [], signal);
  if (processError !== null) return failed(processError);

  const batch = await buildPlan(deps, args, signal, deadlineAt);
  const digest = await hashArgs(batch.items);

  if (decision.mode === "input-required") {
    const wire = await deps.codec.mint(
      { tool: CREATE_RECORDS_TOOL, argsHash, previewDigest: digest, jti: newJti() },
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

  const results = fillDuplicateIds(
    await executePlan({ records: deps.records }, batch.executable, {
      ...(signal === undefined ? {} : { signal }),
      deadlineAt,
    }),
    batch.pending,
  );
  const counts = countResults(results);
  const attempted = counts.ok + counts.error + counts.unknownOutcome;
  return {
    text:
      `${CREATE_RECORDS_TOOL}: attempted ${attempted} of ${batch.items.length} - ` +
      `ok ${counts.ok}, skipped ${counts.skippedDuplicate}, errors ${counts.error}, ` +
      `unknown ${counts.unknownOutcome}, not attempted ${counts.notAttempted}.`,
    structured: { results, counts, errors: [] },
    isError: isBatchError(results),
  };
}
