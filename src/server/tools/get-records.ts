import * as z from "zod/v4";
import type {
  ActivityFetchers,
  RecordWallOptions,
  WallEntry,
} from "../../livespace/activity.js";
import { cancelledError } from "../../livespace/errors.js";
import {
  projectRecord,
  RECORD_KINDS,
  type CompanyRecord,
  type DealRecord,
  type DetailLevel,
  type PersonRecord,
  type RecordFetchers,
  type RecordKind,
  type TaskRecord,
} from "../../livespace/records.js";
import {
  companySchema,
  dealSchema,
  personSchema,
  taskSchema,
  wallEntrySchema,
} from "./record-schemas.js";
import { toToolError, type ToolError } from "./tool-error.js";

/**
 * `get_records` - read known records by id, one kind per call.
 *
 * Three shapes of discipline live here:
 *
 * 1. Every id settles on its own. A batch answers with a per-item status, so a
 *    missing or forbidden record never hides the ones that came back.
 * 2. "Not found" is an answer, not a failure. Upstream conflates "does not
 *    exist" with "the key's user cannot see it" (probe evidence 11), and the
 *    item hint says exactly that instead of guessing.
 * 3. The markdown channel carries counts and fixed wording only. Every
 *    CRM-authored string - record fields and wall text alike - stays in
 *    `structuredContent`, where the schema types it as data
 *    (docs/security.md par. 4).
 */

/** Ids per call. Each one costs its own upstream get (docs/security.md par. 3). */
const MAX_IDS = 25;

/** Walls multiply the calls, so they are limited to a handful of ids. */
const MAX_WALL_IDS = 5;

const DEFAULT_DETAIL: DetailLevel = "standard";

const NOT_FOUND_HINT =
  "The id does not exist or the API key's user cannot see it - take ids from search_crm or crm_metadata.";

export interface GetRecordsArgs {
  kind: RecordKind;
  ids: string[];
  detail?: DetailLevel;
  includeWall?: boolean;
}

export interface GetRecordsResult {
  text: string;
  structured: Record<string, unknown>;
  isError: boolean;
}

const toolErrorSchema = z.strictObject({
  code: z.string(),
  message: z.string(),
  hint: z.string(),
});

// One static item shape with optional keys per kind - never a union. A union of
// look-alike record shapes would let one kind validate as another and silently
// strip the fields it does not know (M3 lesson). Exactly one kind key is present
// when `status` is "ok".
const itemSchema = z.strictObject({
  id: z.string(),
  status: z.enum(["ok", "not_found", "error"]),
  person: personSchema.optional(),
  company: companySchema.optional(),
  deal: dealSchema.optional(),
  task: taskSchema.optional(),
  code: z.string().optional(),
  message: z.string().optional(),
  hint: z.string().optional(),
  wall: z.array(wallEntrySchema).optional(),
  wallTruncated: z.boolean().optional(),
  wallTotal: z.number().optional(),
  wallError: toolErrorSchema.optional(),
});

export const getRecordsToolConfig = {
  title: "Get CRM Records",
  description: `Read persons, companies, deals or tasks by id - one kind per call, up to
25 ids at a time. Take the ids from search_crm or crm_metadata; never guess
them. Every id answers for itself: status "ok" carries the record under the
key of its kind, "not_found" means the record does not exist OR the API
key's user cannot see it (Livespace does not distinguish the two), and
"error" carries a {code, message, hint}. Duplicate ids are collapsed before
fetching. Notes: detail controls how much of each record you get back
(minimal keeps a handful of fields); includeWall adds the recent wall
entries of each record and needs at most 5 ids and a kind other than task -
use get_activity for longer histories or for the CRM-wide feed.`,
  inputSchema: z.strictObject({
    kind: z
      .enum(RECORD_KINDS)
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
    includeWall: z
      .boolean()
      .optional()
      .describe("Attach each record's wall entries (max 5 ids, not for tasks)."),
  }),
  outputSchema: z.strictObject({
    kind: z.enum(RECORD_KINDS),
    items: z.array(itemSchema),
    summary: z.strictObject({
      requested: z.number(),
      ok: z.number(),
      notFound: z.number(),
      failed: z.number(),
    }),
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

/** Tasks have no wall upstream, so they are absent here. */
type WallKind = "person" | "company" | "deal";

interface RecordItem {
  id: string;
  status: ItemStatus;
  person?: PersonRecord;
  company?: CompanyRecord;
  deal?: DealRecord;
  task?: TaskRecord;
  code?: string;
  message?: string;
  hint?: string;
  wall?: WallEntry[];
  wallTruncated?: boolean;
  wallTotal?: number;
  wallError?: ToolError;
}

/** First-seen order wins, so the answer lines up with the ids as they were asked. */
function dedupe(ids: string[]): string[] {
  return [...new Set(ids)];
}

/**
 * Cross-field rules live here rather than in the schema: a zod refinement would
 * turn every combination mistake into a protocol-level validation error, while a
 * returned `{code, message, hint}` tells the model how to fix the call.
 */
function argumentHint(
  args: GetRecordsArgs,
  ids: string[],
  activity: ActivityFetchers | undefined,
): string | null {
  if (args.includeWall !== true) return null;
  if (args.kind === "task") {
    return "Tasks have no wall. Drop includeWall, or ask for a person, company or deal.";
  }
  if (ids.length > MAX_WALL_IDS) {
    return `includeWall reads one wall per record, so it takes up to ${MAX_WALL_IDS} ids at a time. Split the batch, or drop includeWall.`;
  }
  if (activity === undefined) {
    return "The activity fetchers are not configured on this server. Drop includeWall to read the records only.";
  }
  return null;
}

function badParams(hint: string): ToolError {
  return {
    code: "BAD_PARAMS",
    message: "These get_records arguments cannot be combined.",
    hint,
  };
}

function summaryLine(kind: RecordKind, ok: number, notFound: number, failed: number): string {
  return `get_records ${kind} (${ok} ok, ${notFound} not_found, ${failed} failed)`;
}

function rejected(kind: RecordKind, error: ToolError): GetRecordsResult {
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

/** The record goes under the key of its kind - one static shape, no union. */
function attachRecord(
  item: RecordItem,
  kind: RecordKind,
  record: unknown,
  detail: DetailLevel,
): void {
  switch (kind) {
    case "person":
      item.person = projectRecord("person", record as PersonRecord, detail);
      return;
    case "company":
      item.company = projectRecord("company", record as CompanyRecord, detail);
      return;
    case "deal":
      item.deal = projectRecord("deal", record as DealRecord, detail);
      return;
    case "task":
      item.task = projectRecord("task", record as TaskRecord, detail);
      return;
  }
}

export async function runGetRecords(
  records: RecordFetchers,
  activity: ActivityFetchers | undefined,
  args: GetRecordsArgs,
  opts: { signal?: AbortSignal } = {},
): Promise<GetRecordsResult> {
  const kind = args.kind;
  // Duplicates collapse BEFORE anything else: the caps, the fan-out and the
  // reported `requested` count all speak about distinct records.
  const ids = dedupe(args.ids);
  if (ids.length === 0) {
    return {
      text: summaryLine(kind, 0, 0, 0),
      structured: {
        kind,
        items: [],
        summary: { requested: 0, ok: 0, notFound: 0, failed: 0 },
        errors: [],
      },
      isError: false,
    };
  }

  const hint = argumentHint(args, ids, activity);
  if (hint !== null) return rejected(kind, badParams(hint));

  const detail = args.detail ?? DEFAULT_DETAIL;
  // `argumentHint` already refused a wall without fetchers, so this is only the
  // narrowing the type checker needs.
  const walls = args.includeWall === true ? activity : undefined;
  const callerOpts = opts.signal ? { signal: opts.signal } : undefined;

  // Every id settles in its own try/catch: one unreadable record must not take
  // the whole batch down.
  const items = await Promise.all(
    ids.map(async (id): Promise<RecordItem> => {
      try {
        const record = await records.getRecord(kind, id, callerOpts);
        if (record === null) {
          return { id, status: "not_found", hint: NOT_FOUND_HINT };
        }
        const item: RecordItem = { id, status: "ok" };
        attachRecord(item, kind, record, detail);
        if (walls === undefined) return item;
        try {
          // `argumentHint` refused tasks, so the wall kind is safe to narrow.
          const wallOpts: RecordWallOptions = { kind: kind as WallKind, id };
          if (opts.signal !== undefined) wallOpts.signal = opts.signal;
          const wall = await walls.recordWall(wallOpts);
          item.wall = wall.entries;
          item.wallTruncated = wall.truncated;
          item.wallTotal = wall.totalEntries;
        } catch (error) {
          // Only the signal STATE is reliable: an abort surfaces as a
          // DOMException, a plain Error or a bare string reason (M3 lesson).
          if (opts.signal?.aborted) throw cancelledError();
          // The record itself was read, so a failing wall degrades the item
          // instead of failing it.
          item.wallError = toToolError(error);
        }
        return item;
      } catch (error) {
        if (opts.signal?.aborted) throw cancelledError();
        return { id, status: "error", ...toToolError(error) };
      }
    }),
  );

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

  return {
    text: summaryLine(kind, ok, notFound, failed),
    structured: {
      kind,
      items,
      summary: { requested: ids.length, ok, notFound, failed },
      errors: [],
    },
    isError: failed === items.length,
  };
}
