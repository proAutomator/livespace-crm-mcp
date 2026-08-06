import * as z from "zod/v4";
import { cancelledError } from "../../livespace/errors.js";
import {
  ARG_KIND_TO_RECORD_KIND,
  projectRecord,
  type CompanyRecord,
  type DealListOptions,
  type DealRecord,
  type DetailLevel,
  type ListOptions,
  type ListPage,
  type PersonRecord,
  type RecordFetchers,
  type SearchHit,
  type SearchOptions,
} from "../../livespace/records.js";
import { decodeCursor, encodeCursor, MAX_CURSOR_OFFSET } from "../cursor.js";
import { companySchema, dealSchema, personSchema } from "./record-schemas.js";
import {
  toolErrorSchema,
  toToolError,
  type ToolError,
  type ToolRunResult,
} from "./tool-error.js";

/**
 * `search_crm` - the entry point into the CRM: find records by phrase or by
 * filters, then read them with `get_records`.
 *
 * Three shapes of discipline live here:
 *
 * 1. Sorting is ours. `Deal/getAll` accepts an `order` param and ignores it
 *    (probe 2026-08-06), so a sorted request fetches ONE bounded window and
 *    sorts it locally. That window is the honest limit of the feature, and
 *    `sortWindowTruncated` says so out loud.
 * 2. Pagination is stateless. A cursor is base64url JSON, nothing is stored
 *    (docs/security.md par. 8), and it advances by the window that was actually
 *    delivered, so a page that dropped rows neither re-delivers nor skips them.
 * 3. The markdown channel carries counts and fixed wording only. Every
 *    CRM-authored string stays in `structuredContent`, where the schema types it
 *    as data (docs/security.md par. 4).
 */

const ARG_KINDS = ["persons", "companies", "deals"] as const;

type ArgKind = (typeof ARG_KINDS)[number];

/** Tasks are not searchable this way: `Search/getResult` knows three types. */
type ListKind = "person" | "company" | "deal";

type ListRecord = PersonRecord | CompanyRecord | DealRecord;

export type SortKey = "name" | "modified" | "value" | "dateEnd";

export type SortDir = "asc" | "desc";

export interface SearchFilters {
  status?: "open" | "won" | "lost" | "all";
  processId?: string;
  stageId?: string;
  ownerLogin?: string;
  modifiedFrom?: string;
  namesLike?: string;
}

export interface SearchCrmArgs {
  kinds?: ArgKind[];
  phrase?: string;
  filters?: SearchFilters;
  detail?: DetailLevel;
  sortBy?: SortKey;
  sortDir?: SortDir;
  limit?: number;
  cursor?: string;
}

export type SearchCrmResult = ToolRunResult;

const DEFAULT_LIMIT = 20;

const MAX_LIMIT = 100;

/**
 * How many rows one sorted request may pull. Server-side sorting does not exist
 * upstream, so this is the whole population a sort can see - deliberately small
 * enough to stay within the load discipline of docs/security.md par. 3.
 */
const SORT_WINDOW = 200;

/** Pinned so the order never drifts with the host locale. */
const COLLATOR = new Intl.Collator("en", { sensitivity: "base" });

const SORT_DEFAULT_DIR: Record<SortKey, SortDir> = {
  name: "asc",
  modified: "desc",
  value: "desc",
  dateEnd: "desc",
};

const DEAL_ONLY_FILTERS = [
  "status",
  "processId",
  "stageId",
  "ownerLogin",
  "modifiedFrom",
] as const;

// The record shapes are shared with get_records via ./record-schemas.js; only
// the search-specific hit shape lives here.
const hitSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  modified: z.string(),
});

// One envelope per kind, each carrying its own record schema. A union of
// look-alike shapes would let one kind validate as another and silently strip
// the fields it does not know (M3 lesson), so nothing here is a union.
const envelopeOf = <T extends z.ZodType>(item: T) =>
  z.strictObject({
    items: z.array(item).optional(),
    hits: z.array(hitSchema).optional(),
    count: z.number(),
    returned: z.number(),
    hasMore: z.boolean(),
    nextCursor: z.string().optional(),
    sortWindowTruncated: z.boolean().optional(),
  });

export const searchCrmToolConfig = {
  title: "Search CRM",
  description: `Find persons, companies and deals. Two modes, exactly one per call:
"phrase" runs the CRM's own word-prefix search and returns light hits
(id, name, description) - use it when you have a name or a fragment of one;
"filters" lists records and returns full ones - use it for "all open deals in
process X". An empty filters object lists everything of that kind. Feed the
returned ids into get_records or get_activity; never guess ids. Notes:
sorting is done by this server over one window of at most 200 rows, so
sortBy cannot be combined with cursor and sortWindowTruncated tells you the
window was full; sortBy value/dateEnd and the deal filters need
kinds: ["deals"]; empty sort keys always sort last because a blank field
means "not filled in", not zero; detail controls how much of each record you
get back (minimal keeps a handful of fields); pass nextCursor back as cursor
to get the next page of the same single kind.`,
  inputSchema: z.strictObject({
    kinds: z
      .array(z.enum(ARG_KINDS))
      .min(1)
      .optional()
      .describe("Record kinds to search (default: all three)."),
    phrase: z
      .string()
      .min(2)
      .max(100)
      .optional()
      .describe("Text to search for. Matching is word-prefix based upstream."),
    filters: z
      .strictObject({
        status: z
          .enum(["open", "won", "lost", "all"])
          .optional()
          .describe("Deal status (default: open). Deals only."),
        processId: z.string().max(64).optional().describe("Deal process id. Deals only."),
        stageId: z.string().max(64).optional().describe("Deal stage id. Deals only."),
        ownerLogin: z
          .string()
          .max(64)
          .optional()
          .describe("Deal owner login. Deals only."),
        modifiedFrom: z
          .string()
          .max(64)
          .optional()
          .describe("Only deals modified since this date (YYYY-MM-DD). Deals only."),
        namesLike: z
          .string()
          .min(2)
          .max(100)
          .optional()
          .describe("Name fragment, matched upstream with a like condition."),
      })
      .optional()
      .describe("Filter mode. Pass an empty object to list without narrowing."),
    detail: z
      .enum(["minimal", "standard", "full"])
      .optional()
      .describe("How much of each record to return (default: standard)."),
    sortBy: z
      .enum(["name", "modified", "value", "dateEnd"])
      .optional()
      .describe("Sort key. Filter mode only, and never together with cursor."),
    sortDir: z
      .enum(["asc", "desc"])
      .optional()
      .describe("Sort direction (default: asc for name, desc for the rest)."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .optional()
      .describe("Records per kind (1-100, default 20)."),
    cursor: z
      .string()
      .max(512)
      .optional()
      .describe("nextCursor from a previous call. Needs exactly one kind."),
  }),
  outputSchema: z.strictObject({
    results: z.strictObject({
      persons: envelopeOf(personSchema).optional(),
      companies: envelopeOf(companySchema).optional(),
      deals: envelopeOf(dealSchema).optional(),
    }),
    // One extra key on the shared shape: which kind the failure belongs to.
    errors: z.array(toolErrorSchema.extend({ kind: z.string().optional() })),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
} as const;

interface KindEnvelope {
  items?: ListRecord[];
  hits?: SearchHit[];
  count: number;
  returned: number;
  hasMore: boolean;
  nextCursor?: string;
  sortWindowTruncated?: boolean;
}

interface KindError extends ToolError {
  kind: ArgKind;
}

type KindOutcome =
  | { kind: ArgKind; envelope: KindEnvelope }
  | { kind: ArgKind; error: KindError };

function canonicalKinds(kinds?: ArgKind[]): ArgKind[] {
  if (!kinds) return [...ARG_KINDS];
  const wanted = new Set(kinds);
  return ARG_KINDS.filter((kind) => wanted.has(kind));
}

/**
 * Cross-field rules live here rather than in the schema: a zod refinement would
 * turn every combination mistake into a protocol-level validation error, while
 * a returned `{code, message, hint}` tells the model how to fix the call.
 */
function argumentHint(args: SearchCrmArgs, kinds: ArgKind[]): string | null {
  const hasPhrase = args.phrase !== undefined;
  const hasFilters = args.filters !== undefined;
  if (hasPhrase === hasFilters) {
    return hasPhrase
      ? "Use phrase or filters, not both: phrase searches text, filters list records."
      : "Give either a phrase to search for, or a filters object (an empty one lists everything).";
  }
  if (hasPhrase) {
    if (args.sortBy !== undefined) {
      return "Phrase mode returns the upstream relevance order. Drop sortBy, or switch to filters.";
    }
    if (args.cursor !== undefined) {
      return "Phrase mode does not paginate. Drop cursor, or switch to filters and raise limit.";
    }
    return null;
  }
  if (args.cursor !== undefined) {
    if (kinds.length !== 1) {
      return "A cursor belongs to one kind. Ask for exactly the kind the cursor came from.";
    }
    if (args.sortBy !== undefined) {
      return "Sorted results do not paginate. Drop cursor, or drop sortBy.";
    }
  }
  const dealsOnly = kinds.length === 1 && kinds[0] === "deals";
  if (!dealsOnly) {
    if (args.sortBy === "value" || args.sortBy === "dateEnd") {
      return 'Sorting by value or dateEnd needs kinds: ["deals"].';
    }
    const filters = args.filters;
    if (filters && DEAL_ONLY_FILTERS.some((key) => filters[key] !== undefined)) {
      return 'Deal filters (status, processId, stageId, ownerLogin, modifiedFrom) need kinds: ["deals"]. namesLike works for every kind.';
    }
  }
  return null;
}

function badParams(hint: string): ToolError {
  return {
    code: "BAD_PARAMS",
    message: "These search_crm arguments cannot be combined.",
    hint,
  };
}

function rejected(requested: number, error: ToolError): SearchCrmResult {
  return {
    text: [
      `search_crm (0/${requested} kinds ok)`,
      `arguments: ERROR ${error.code} - ${error.hint}`,
    ].join("\n"),
    structured: { results: {}, errors: [error] },
    isError: true,
  };
}

function listFor(
  fetchers: RecordFetchers,
  kind: ListKind,
  limit: number,
  offset: number,
  filters: SearchFilters,
  signal?: AbortSignal,
): Promise<ListPage<ListRecord>> {
  // Optional properties are assigned, never spread in as `undefined`: the
  // fetchers only send a param when the key exists.
  const base: ListOptions = { limit, offset };
  if (filters.namesLike !== undefined) base.namesLike = filters.namesLike;
  if (signal !== undefined) base.signal = signal;
  if (kind === "person") return fetchers.listPersons(base);
  if (kind === "company") return fetchers.listCompanies(base);
  const dealOpts: DealListOptions = { ...base };
  if (filters.status !== undefined) dealOpts.status = filters.status;
  if (filters.processId !== undefined) dealOpts.processId = filters.processId;
  if (filters.stageId !== undefined) dealOpts.stageId = filters.stageId;
  if (filters.ownerLogin !== undefined) dealOpts.ownerLogin = filters.ownerLogin;
  if (filters.modifiedFrom !== undefined) dealOpts.modifiedFrom = filters.modifiedFrom;
  return fetchers.listDeals(dealOpts);
}

function project(kind: ListKind, record: ListRecord, detail: DetailLevel): ListRecord {
  switch (kind) {
    case "person":
      return projectRecord("person", record as PersonRecord, detail);
    case "company":
      return projectRecord("company", record as CompanyRecord, detail);
    case "deal":
      return projectRecord("deal", record as DealRecord, detail);
  }
}

type SortValue = string | number | null;

function sortValue(record: ListRecord, key: SortKey): SortValue {
  switch (key) {
    case "name":
      return record.name;
    case "modified":
      return record.modified;
    case "value":
      return (record as DealRecord).value ?? null;
    case "dateEnd":
      return (record as DealRecord).dateEnd ?? "";
  }
}

/** A blank field means "not filled in", so it sorts last in both directions. */
function isEmptyKey(value: SortValue): boolean {
  return value === null || value === "";
}

function comparatorFor(key: SortKey, dir?: SortDir): (a: ListRecord, b: ListRecord) => number {
  const sign = (dir ?? SORT_DEFAULT_DIR[key]) === "asc" ? 1 : -1;
  return (left, right) => {
    const a = sortValue(left, key);
    const b = sortValue(right, key);
    if (isEmptyKey(a) || isEmptyKey(b)) {
      if (isEmptyKey(a) && isEmptyKey(b)) return 0;
      return isEmptyKey(a) ? 1 : -1;
    }
    if (typeof a === "number" && typeof b === "number") return sign * (a - b);
    const first = String(a);
    const second = String(b);
    // Names go through the pinned collator; dates are compared as the upstream
    // strings they are ("2025-10-08 15:19:13+02" sorts correctly as text within
    // one UTC offset, and Livespace reports one offset per account).
    const base =
      key === "name"
        ? COLLATOR.compare(first, second)
        : first < second
          ? -1
          : first > second
            ? 1
            : 0;
    return sign * base;
  };
}

async function phraseEnvelope(
  fetchers: RecordFetchers,
  kind: ListKind,
  phrase: string,
  limit: number,
  signal?: AbortSignal,
): Promise<KindEnvelope> {
  const opts: SearchOptions = { q: phrase, kind, limit };
  if (signal !== undefined) opts.signal = signal;
  const found = await fetchers.searchPhrase(opts);
  const hits = found.hits.slice(0, limit);
  // Phrase mode has no cursor, so `hasMore` answers one question: did the page
  // come back FULL, meaning the cap may have trimmed matches away? Comparing
  // against the returned hits instead would call a page complete whenever a row
  // was dropped for having no id.
  return {
    hits,
    count: found.rawCount,
    returned: hits.length,
    hasMore: found.rawCount >= limit,
  };
}

async function filterEnvelope(
  fetchers: RecordFetchers,
  kind: ListKind,
  args: SearchCrmArgs,
  limit: number,
  detail: DetailLevel,
  offset: number,
  signal?: AbortSignal,
): Promise<KindEnvelope> {
  const filters = args.filters ?? {};
  if (args.sortBy === undefined) {
    const result = await listFor(fetchers, kind, limit, offset, filters, signal);
    const items = result.items.map((record) => project(kind, record, detail));
    const envelope: KindEnvelope = {
      items,
      count: result.rawCount,
      returned: items.length,
      hasMore: result.hasMore,
    };
    // The cursor advances by the DELIVERED window - the rows we asked for, not
    // the rows upstream chose to send. Rows we dropped inside the window must
    // not come back; rows past it were never delivered and must not be skipped.
    const nextOffset = offset + Math.min(result.rawCount, limit);
    if (result.hasMore && nextOffset <= MAX_CURSOR_OFFSET) {
      envelope.nextCursor = encodeCursor({ v: 1, k: kind, o: nextOffset });
    }
    return envelope;
  }
  const window = await listFor(fetchers, kind, SORT_WINDOW, 0, filters, signal);
  // Sorting runs on FULL records; the detail projection comes after the slice,
  // because projected-away fields are empty strings and would sort as such.
  const sorted = [...window.items].sort(comparatorFor(args.sortBy, args.sortDir));
  const paged = sorted.slice(0, limit);
  return {
    items: paged.map((record) => project(kind, record, detail)),
    count: window.rawCount,
    returned: paged.length,
    hasMore: sorted.length > limit,
    sortWindowTruncated: window.rawCount >= SORT_WINDOW,
  };
}

// Counts and fixed wording only - CRM-authored strings stay in the structured
// channel (docs/security.md par. 4).
function kindLine(outcome: KindOutcome): string {
  if ("error" in outcome) {
    return `${outcome.kind}: ERROR ${outcome.error.code} - ${outcome.error.hint}`;
  }
  const envelope = outcome.envelope;
  const more = envelope.hasMore ? " (more)" : "";
  const window = envelope.sortWindowTruncated ? " (sort window truncated)" : "";
  return `${outcome.kind}: ${envelope.returned} of ${envelope.count}${more}${window}`;
}

export async function runSearchCrm(
  fetchers: RecordFetchers,
  args: SearchCrmArgs,
  opts: { signal?: AbortSignal } = {},
): Promise<SearchCrmResult> {
  const kinds = canonicalKinds(args.kinds);
  if (kinds.length === 0) {
    return {
      text: "search_crm (0/0 kinds ok)",
      structured: { results: {}, errors: [] },
      isError: false,
    };
  }

  const hint = argumentHint(args, kinds);
  if (hint !== null) return rejected(kinds.length, badParams(hint));

  let offset = 0;
  const single = kinds.length === 1 ? kinds[0] : undefined;
  if (args.cursor !== undefined && single !== undefined) {
    try {
      // The expected kind is the requested one, so a cursor from another kind
      // is rejected here instead of silently paging the wrong list.
      offset = decodeCursor(args.cursor, ARG_KIND_TO_RECORD_KIND[single]).o;
    } catch (error) {
      return rejected(kinds.length, toToolError(error));
    }
  }

  const limit = args.limit ?? DEFAULT_LIMIT;
  const detail = args.detail ?? "standard";
  // Every kind settles in its own try/catch: one failing kind must not take the
  // whole result down.
  const outcomes = await Promise.all(
    kinds.map(async (argKind): Promise<KindOutcome> => {
      const kind = ARG_KIND_TO_RECORD_KIND[argKind] as ListKind;
      try {
        const envelope =
          args.phrase !== undefined
            ? await phraseEnvelope(fetchers, kind, args.phrase, limit, opts.signal)
            : await filterEnvelope(
                fetchers,
                kind,
                args,
                limit,
                detail,
                offset,
                opts.signal,
              );
        return { kind: argKind, envelope };
      } catch (error) {
        // Only the signal STATE is reliable: an abort surfaces as a
        // DOMException, a plain Error or a bare string reason (M3 lesson).
        if (opts.signal?.aborted) throw cancelledError();
        return { kind: argKind, error: { kind: argKind, ...toToolError(error) } };
      }
    }),
  );

  const errors = outcomes.flatMap((outcome) =>
    "error" in outcome ? [outcome.error] : [],
  );
  if (
    errors.length > 0 &&
    errors.length === kinds.length &&
    errors.every((error) => error.code === "CANCELLED")
  ) {
    throw cancelledError();
  }

  const results: Record<string, KindEnvelope> = {};
  for (const outcome of outcomes) {
    if ("envelope" in outcome) results[outcome.kind] = outcome.envelope;
  }

  const ok = outcomes.length - errors.length;
  const text = [
    `search_crm (${ok}/${kinds.length} kinds ok)`,
    ...outcomes.map(kindLine),
  ].join("\n");

  return { text, structured: { results, errors }, isError: ok === 0 };
}
