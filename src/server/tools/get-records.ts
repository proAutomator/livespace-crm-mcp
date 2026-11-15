import * as z from "zod/v4";
import { cancelledError } from "../../livespace/errors.js";
import { CALL_BUDGETS, CallBudget } from "../../livespace/v2/budget.js";
import { where } from "../../livespace/v2/filters.js";
import { MEDIA_JSON, MEDIA_MINIMAL } from "../../livespace/v2/media-types.js";
import {
  projectRecord,
  V2_KINDS,
  type BudgetLineV2,
  type BudgetSummaryV2,
  type DealProcessV2,
  type DetailLevel,
  type ReadOptions,
  type RecordReader,
  type RecordV2Map,
  type TaskV2,
  type V2Kind,
} from "../../livespace/v2/records.js";
import type {
  RecordEntryType,
  TimelineEntry,
  TimelineParentKind,
  TimelineReader,
} from "../../livespace/v2/timeline.js";
import { nextSteps } from "./next-steps.js";
import {
  companyV2Schema,
  dealV2Schema,
  personV2Schema,
  refSchema,
  taskV2Schema,
} from "./record-schemas.js";
import {
  toolErrorSchema,
  toToolError,
  type ToolError,
  type ToolRunResult,
} from "./tool-error.js";

/**
 * `get_records` - read known records by id, one kind per call, with the
 * related data a question usually needs in the same call.
 *
 * Four rules live here:
 *
 * 1. Every id settles on its own. A batch answers with a per-item status, so
 *    a missing record never hides the ones that came back, and a failing
 *    include degrades its item instead of failing it.
 * 2. "Not found" is an answer, not a failure. The API gives the same 404 to
 *    an unknown id and to a record the key cannot see, and the item hint says
 *    exactly that instead of guessing.
 * 3. The request count is known before the first request: one per record
 *    plus one per record and include. A call over the read budget is refused
 *    up front, because every request is taken from a daily budget the whole
 *    account shares (docs/security.md par. 3).
 * 4. The text channel carries counts and fixed wording only. Every
 *    CRM-authored string - record fields, note and e-mail text alike - stays
 *    in `structuredContent`, where the schema types it as data (par. 4).
 */

/** Ids per call. Each one costs its own request. */
const MAX_IDS = 25;

/** Entries each activity include returns per record: the latest ones. */
const INCLUDE_ENTRY_LIMIT = 5;

/**
 * Records read at a time. The API client lets two requests be in flight, so
 * two workers lose no time, and reading in step lets a missing scope seen on
 * one record spare the others the same refused request.
 */
const RECORD_WORKERS = 2;

const DEFAULT_DETAIL: DetailLevel = "standard";

const NOT_FOUND_HINT =
  "The id is unknown or not visible to the integration user of the API key - " +
  "take ids from search_crm or crm_metadata.";

/** In the order they are read for one record. */
const INCLUDES = [
  "process",
  "products",
  "budget",
  "notes",
  "calls",
  "emails",
  "tasks",
  "wall",
] as const;

export type IncludeName = (typeof INCLUDES)[number];

const DEAL_INCLUDES: ReadonlySet<IncludeName> = new Set(["process", "products", "budget"]);

const ENTRY_TYPE: Partial<Record<IncludeName, RecordEntryType>> = {
  notes: "note",
  calls: "call",
  emails: "email",
};

const TASK_LINK_FIELD: Record<TimelineParentKind, string> = {
  person: "people.id",
  company: "companies.id",
  deal: "deals.id",
};

/**
 * The wall and its system entries exist only in the old API. Until the
 * fallback to it is wired, the include answers this instead of an empty list.
 */
const WALL_UNAVAILABLE_HINT =
  "The record wall is not available from API v2 in this version. Use include " +
  "notes, calls, emails and tasks for what people logged.";

export interface GetRecordsArgs {
  kind: V2Kind;
  ids: string[];
  detail?: DetailLevel;
  include?: IncludeName[];
}

export interface GetRecordsDeps {
  records: Pick<RecordReader, "get" | "dealProcess" | "dealLines" | "dealBudget" | "search">;
  timeline: TimelineReader;
  /** Whether the write tools are listed; shapes the next-step hints. */
  writesEnabled: boolean;
}

export type GetRecordsResult = ToolRunResult;

const entrySchema = z.strictObject({
  type: z.enum(["note", "call", "email", "task", "system"]),
  id: z.string().nullable(),
  date: z.string().nullable(),
  author: refSchema.nullable(),
  text: z.string(),
  textTruncated: z.boolean(),
  direction: z.enum(["incoming", "outgoing"]).optional(),
  visibility: z.string().optional(),
  tags: z.array(z.string()).optional(),
  completed: z.boolean().optional(),
  subject: z.string().optional(),
  from: z.string().optional(),
  durationSeconds: z.number().optional(),
  url: z.string().nullable(),
});

const entryListSchema = z.strictObject({
  entries: z.array(entrySchema).describe("The latest entries, newest first."),
  totalCount: z.number().describe("Every entry of this type on the record."),
});

const moneyPairSchema = z.strictObject({ forecast: z.number(), executed: z.number() });

const processSchema = z.strictObject({
  process: refSchema.nullable(),
  currentStage: refSchema.nullable(),
  stages: z.array(
    z.strictObject({
      id: z.string(),
      name: z.string(),
      position: z.number(),
      state: z.enum(["completed", "current", "pending"]),
      completedAt: z.string().nullable(),
      steps: z.array(
        z.strictObject({
          id: z.string(),
          name: z.string(),
          required: z.boolean(),
          completed: z.boolean(),
        }),
      ),
    }),
  ),
});

const productsSchema = z.strictObject({
  lines: z.array(
    z.strictObject({
      id: z.string(),
      product: refSchema.nullable(),
      quantity: z.number().nullable(),
      unitPrice: z.number().nullable(),
      value: z.number().describe("The line value after discount."),
      currency: z.string(),
      forecast: z.boolean().describe("True for a forecast line, false for an executed one."),
      description: z.string().nullable(),
    }),
  ),
  totalCount: z.number(),
  truncated: z.boolean().describe("True when the deal has more lines than were read."),
});

const budgetSchema = z.strictObject({
  currency: z.string().nullable(),
  revenue: moneyPairSchema,
  cost: moneyPairSchema,
  margin: moneyPairSchema,
  quantity: moneyPairSchema,
});

// One static item shape with optional keys per kind - never a union. A union of
// look-alike record shapes would let one kind validate as another and silently
// strip the fields it does not know (M3 lesson). Exactly one kind key is present
// when `status` is "ok".
const itemSchema = z.strictObject({
  id: z.string(),
  status: z.enum(["ok", "not_found", "error"]),
  person: personV2Schema.optional(),
  company: companyV2Schema.optional(),
  deal: dealV2Schema.optional(),
  task: taskV2Schema.optional(),
  // A failed item carries the shared error shape, v2 details included.
  code: z.string().optional(),
  message: z.string().optional(),
  hint: z.string().optional(),
  fields: toolErrorSchema.shape.fields,
  requestId: toolErrorSchema.shape.requestId,
  process: processSchema.nullable().optional(),
  products: productsSchema.optional(),
  budget: budgetSchema
    .nullable()
    .optional()
    .describe("The stored budget summary; null when the deal does not show one."),
  notes: entryListSchema.optional(),
  calls: entryListSchema.optional(),
  emails: entryListSchema.optional(),
  tasks: z
    .strictObject({ items: z.array(taskV2Schema), totalCount: z.number() })
    .optional()
    .describe("The latest tasks linked to the record, as minimal rows."),
  includeErrors: z
    .array(toolErrorSchema.extend({ include: z.enum(INCLUDES) }))
    .optional()
    .describe("Includes that could not be read for this record; the record itself was."),
});

export const getRecordsToolConfig = {
  title: "Get CRM Records",
  description: `Read persons, companies, deals or tasks by id - one kind per call, up to
25 ids at a time. Take the ids from search_crm or crm_metadata; never guess
them. Every id answers for itself: status "ok" carries the record under the
key of its kind, "not_found" means the id is unknown OR not visible to the
integration user of the API key (Livespace does not tell the two apart), and
"error" carries a {code, message, hint}. Duplicate ids are collapsed.
include adds related data to every record in the same call: process (deal
stages with their state and steps, required and completed), products (budget
lines) and budget (the stored revenue, cost and margin summary) for deals;
notes, calls, emails and tasks for persons, companies and deals, each as the
latest 5 entries plus the total. Tasks take no include. Each record costs one
request and each include one more per record; the call is refused up front
when that is over 60, so split large batches. An include that fails for one
record is listed in that item's includeErrors and the record is still
returned. wall is not available from API v2 and is reported as unavailable.
detail omits fields outside the selected level; full adds description,
groups, source, every owner, addresses and custom fields that carry a value.
A null or empty field means this answer supplies no value; it does not prove
the CRM field is empty. Deal value keeps zero apart from null. A deal's
reason is the reason of its current status only. Note, call and e-mail text
is plain text, cut at 500 characters with textTruncated set.`,
  inputSchema: z.strictObject({
    kind: z
      .enum(V2_KINDS)
      .describe("Which kind of record the ids belong to. One kind per call."),
    ids: z
      .array(z.string().min(1).max(64))
      .min(1)
      .max(MAX_IDS)
      .describe("Record ids from search_crm or crm_metadata (1-25, duplicates collapsed)."),
    detail: z
      .enum(["minimal", "standard", "full"])
      .optional()
      .describe("How much of each record to return (default: standard)."),
    include: z
      .array(z.enum(INCLUDES))
      .min(1)
      .max(INCLUDES.length)
      .optional()
      .describe(
        "Related data per record. Deals: process, products, budget. Persons, companies, deals: notes, calls, emails, tasks.",
      ),
  }),
  outputSchema: z.strictObject({
    kind: z.enum(V2_KINDS),
    items: z.array(itemSchema),
    summary: z.strictObject({
      requested: z.number(),
      ok: z.number(),
      notFound: z.number(),
      failed: z.number(),
    }),
    unavailable: z
      .array(z.strictObject({ include: z.enum(INCLUDES), hint: z.string() }))
      .optional()
      .describe("Includes this server cannot answer at all, with what to use instead."),
    nextSteps: z
      .array(z.string())
      .max(3)
      .optional()
      .describe("Server-authored suggestions for the next call."),
    errors: z.array(toolErrorSchema),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
} as const;

type ItemStatus = "ok" | "not_found" | "error";

interface IncludeError extends ToolError {
  include: IncludeName;
}

interface RecordItem {
  id: string;
  status: ItemStatus;
  // Partial, because `detail` OMITS the keys outside its level: a delivered
  // record is a subset of its shape, never the full shape with blanks.
  person?: Partial<RecordV2Map["person"]>;
  company?: Partial<RecordV2Map["company"]>;
  deal?: Partial<RecordV2Map["deal"]>;
  task?: Partial<TaskV2>;
  code?: string;
  message?: string;
  hint?: string;
  fields?: string[];
  requestId?: string;
  process?: DealProcessV2 | null;
  products?: { lines: BudgetLineV2[]; totalCount: number; truncated: boolean };
  budget?: BudgetSummaryV2 | null;
  notes?: { entries: TimelineEntry[]; totalCount: number };
  calls?: { entries: TimelineEntry[]; totalCount: number };
  emails?: { entries: TimelineEntry[]; totalCount: number };
  tasks?: { items: Partial<TaskV2>[]; totalCount: number };
  includeErrors?: IncludeError[];
}

/** First-seen order wins, so the answer lines up with the ids as they were asked. */
function dedupe<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function canonicalIncludes(include: readonly IncludeName[] | undefined): IncludeName[] {
  const wanted = new Set(include ?? []);
  return INCLUDES.filter((name) => wanted.has(name));
}

function badParams(hint: string): ToolError {
  return {
    code: "BAD_PARAMS",
    message: "These get_records arguments cannot be combined.",
    hint,
  };
}

/**
 * Cross-field rules live here rather than in the schema: a zod refinement would
 * turn every combination mistake into a protocol-level validation error, while a
 * returned `{code, message, hint}` tells the model how to fix the call.
 */
function argumentHint(kind: V2Kind, ids: string[], includes: IncludeName[]): string | null {
  if (includes.length === 0) return null;
  if (kind === "task") {
    return "A task takes no include. Drop include, or ask for a person, company or deal.";
  }
  const dealOnly = includes.find((name) => DEAL_INCLUDES.has(name));
  if (kind !== "deal" && dealOnly !== undefined) {
    return `The include ${dealOnly} does not exist for a ${kind}: process, products and budget belong to deals. Drop it, or ask with kind "deal".`;
  }
  // The wall answers "unavailable" without a request.
  const perRecord = 1 + includes.filter((name) => name !== "wall").length;
  const planned = ids.length * perRecord;
  if (planned > CALL_BUDGETS.read) {
    const fits = Math.floor(CALL_BUDGETS.read / perRecord);
    return (
      `This call would send ${planned} Livespace requests (${ids.length} records, ` +
      `${perRecord} requests each); one call may send ${CALL_BUDGETS.read}. ` +
      `Ask for at most ${fits} ids with these includes, or use fewer includes.`
    );
  }
  return null;
}

function summaryLine(kind: V2Kind, ok: number, notFound: number, failed: number): string {
  return `get_records ${kind} (${ok} ok, ${notFound} not_found, ${failed} failed)`;
}

function rejected(kind: V2Kind, error: ToolError): GetRecordsResult {
  return {
    text: [
      summaryLine(kind, 0, 0, 0),
      `arguments: ERROR ${error.code} - ${error.hint}`,
    ].join("\n"),
    structured: {
      kind,
      items: [],
      summary: { requested: 0, ok: 0, notFound: 0, failed: 0 },
      errors: [error],
    },
    isError: true,
  };
}

/** Runs `work` over `values` with a fixed number of workers, order kept. */
async function mapPool<T, R>(
  values: readonly T[],
  workers: number,
  work: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      results[index] = await work(values[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(workers, values.length) }, worker));
  return results;
}

export async function runGetRecords(
  deps: GetRecordsDeps,
  args: GetRecordsArgs,
  opts: { signal?: AbortSignal } = {},
): Promise<GetRecordsResult> {
  const kind = args.kind;
  // Duplicates collapse BEFORE anything else: the caps, the request plan and
  // the reported `requested` count all speak about distinct records.
  const ids = dedupe(args.ids);
  const includes = canonicalIncludes(args.include);

  const hint = argumentHint(kind, ids, includes);
  if (hint !== null) return rejected(kind, badParams(hint));

  const detail = args.detail ?? DEFAULT_DETAIL;
  // One request budget for the whole tool call (docs/security.md par. 3).
  const read: ReadOptions = {
    budget: new CallBudget(CALL_BUDGETS.read),
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  };
  const media = detail === "minimal" ? MEDIA_MINIMAL : MEDIA_JSON;
  const reading = includes.filter((name) => name !== "wall");
  // A missing scope is a property of the key, not of a record: once an
  // include was refused for it, the other records get the same answer
  // without spending a request each.
  const scopeDenied = new Map<IncludeName, ToolError>();

  async function readInclude(item: RecordItem, name: IncludeName, id: string): Promise<void> {
    // `argumentHint` refused tasks, so the parent kind is safe to narrow.
    const parent = kind as TimelineParentKind;
    switch (name) {
      case "process":
        item.process = await deps.records.dealProcess(id, read);
        return;
      case "products": {
        const { lines, totalCount } = await deps.records.dealLines(id, read);
        item.products = { lines, totalCount, truncated: totalCount > lines.length };
        return;
      }
      case "budget":
        item.budget = await deps.records.dealBudget(id, read);
        return;
      case "notes":
      case "calls":
      case "emails": {
        const type = ENTRY_TYPE[name] as RecordEntryType;
        item[name] = await deps.timeline.recordEntries(parent, id, type, {
          ...read,
          limit: INCLUDE_ENTRY_LIMIT,
        });
        return;
      }
      case "tasks": {
        // The default order is the last change, newest first.
        const found = await deps.records.search(
          "task",
          {
            filter: where(TASK_LINK_FIELD[parent], "eq", id),
            page: 1,
            perPage: INCLUDE_ENTRY_LIMIT,
            media: MEDIA_MINIMAL,
          },
          read,
        );
        item.tasks = {
          items: found.items.map((task) => projectRecord("task", task, "minimal")),
          totalCount: found.totalCount,
        };
        return;
      }
      case "wall":
        return;
    }
  }

  // Every id settles in its own try/catch: one unreadable record must not take
  // the whole batch down.
  const items = await mapPool(ids, RECORD_WORKERS, async (id): Promise<RecordItem> => {
    try {
      const record = await deps.records.get(kind, id, { ...read, media });
      if (record === null) return { id, status: "not_found", hint: NOT_FOUND_HINT };
      const item: RecordItem = { id, status: "ok" };
      // One cast, one assignment: the kind and the item key cannot drift apart.
      (item as unknown as Record<string, unknown>)[kind] = projectRecord(kind, record, detail);
      for (const name of reading) {
        const denied = scopeDenied.get(name);
        if (denied !== undefined) {
          (item.includeErrors ??= []).push({ include: name, ...denied });
          continue;
        }
        try {
          await readInclude(item, name, id);
        } catch (error) {
          // Only the signal STATE is reliable: an abort surfaces as a
          // DOMException, a plain Error or a bare string reason (M3 lesson).
          if (opts.signal?.aborted) throw cancelledError();
          // The record itself was read, so a failing include degrades the
          // item instead of failing it.
          const toolError = toToolError(error);
          if (toolError.code === "INSUFFICIENT_SCOPE") scopeDenied.set(name, toolError);
          (item.includeErrors ??= []).push({ include: name, ...toolError });
        }
      }
      return item;
    } catch (error) {
      if (opts.signal?.aborted) throw cancelledError();
      return { id, status: "error", ...toToolError(error) };
    }
  });

  const failedItems = items.filter((item) => item.status === "error");
  if (
    failedItems.length === items.length &&
    failedItems.every((item) => item.code === "CANCELLED")
  ) {
    throw cancelledError();
  }

  const ok = items.filter((item) => item.status === "ok").length;
  const notFound = items.filter((item) => item.status === "not_found").length;
  const failed = failedItems.length;
  const includeErrors = items.reduce(
    (count, item) => count + (item.includeErrors?.length ?? 0),
    0,
  );
  const wallAsked = includes.includes("wall");
  const steps = nextSteps("get_records", {
    kind,
    empty: ok === 0,
    // For a record read: there is related data left to ask for.
    hasMore: reading.length === 0,
    writesEnabled: deps.writesEnabled,
  });

  // Counts and fixed wording only (docs/security.md par. 4).
  const text = [
    summaryLine(kind, ok, notFound, failed),
    ...(includeErrors === 0
      ? []
      : [`include errors: ${includeErrors} - see includeErrors on the items`]),
    ...(wallAsked ? [`wall: unavailable - ${WALL_UNAVAILABLE_HINT}`] : []),
  ].join("\n");

  return {
    text,
    structured: {
      kind,
      items,
      summary: { requested: ids.length, ok, notFound, failed },
      ...(wallAsked ? { unavailable: [{ include: "wall", hint: WALL_UNAVAILABLE_HINT }] } : {}),
      ...(steps.length === 0 ? {} : { nextSteps: steps }),
      errors: [],
    },
    isError: failed === items.length,
  };
}
