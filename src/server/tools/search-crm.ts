import * as z from "zod/v4";
import { cancelledError } from "../../livespace/errors.js";
import { CALL_BUDGETS, CallBudget } from "../../livespace/v2/budget.js";
import {
  and,
  dayBounds,
  or,
  where,
  type FilterNode,
} from "../../livespace/v2/filters.js";
import { MEDIA_JSON, MEDIA_MINIMAL } from "../../livespace/v2/media-types.js";
import {
  actingUserHint,
  type CustomFieldInfo,
} from "../../livespace/v2/metadata.js";
import {
  isV2Id,
  PHRASE_MAX_PAGE,
  PHRASE_MAX_PER_PAGE,
  projectRecord,
  type DetailLevel,
  type PhraseHit,
  type PhraseKind,
  type ReadOptions,
  type RecordReader,
  type RecordV2Map,
  type V2Kind,
} from "../../livespace/v2/records.js";
import type { MetadataService } from "./crm-metadata.js";
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
 * `search_crm` - the entry point into the CRM: find records by phrase or by
 * filters, then read them with `get_records`.
 *
 * Three rules live here:
 *
 * 1. Livespace filters, sorts, pages and counts. This tool turns its
 *    arguments into one filter tree per kind and sends one request per kind;
 *    nothing is sorted or counted locally.
 * 2. Every refusal that can be known before a request is made before it: a
 *    refused request still costs the account's shared daily budget
 *    (docs/security.md par. 3). "Mine" without a resolved acting user is such
 *    a refusal - the API key is an integration user, and falling back to it
 *    would answer an empty "my deals" list.
 * 3. The text channel carries counts and fixed wording only. Every
 *    CRM-authored string stays in `structuredContent`, where the schema types
 *    it as data (par. 4).
 */

const ARG_KINDS = ["persons", "companies", "deals", "tasks", "notes"] as const;

type ArgKind = (typeof ARG_KINDS)[number];

/** The kinds a filter search lists; notes are found by phrase only. */
type RecordArgKind = Exclude<ArgKind, "notes">;

const DEFAULT_KINDS: readonly ArgKind[] = ["persons", "companies", "deals"];

const RECORD_KIND: Record<RecordArgKind, V2Kind> = {
  persons: "person",
  companies: "company",
  deals: "deal",
  tasks: "task",
};

const PHRASE_KIND: Record<Exclude<ArgKind, "tasks">, PhraseKind> = {
  persons: "person",
  companies: "company",
  deals: "deal",
  notes: "note",
};

const ARG_KIND_OF_PHRASE: Record<PhraseKind, ArgKind> = {
  person: "persons",
  company: "companies",
  deal: "deals",
  note: "notes",
};

const CUSTOM_FIELD_OPERATORS = [
  "eq",
  "contains",
  "anyOf",
  "allOf",
  "noneOf",
  "isEmpty",
  "isNotEmpty",
] as const;

type CustomFieldOperator = (typeof CUSTOM_FIELD_OPERATORS)[number];

export interface CustomFieldFilter {
  fieldId: string;
  operator: CustomFieldOperator;
  value?: string | boolean | string[];
}

export interface SearchFilters {
  mine?: boolean;
  ownerIds?: string[];
  status?: "open" | "won" | "lost" | "outdated" | "all";
  processId?: string;
  stageIds?: string[];
  companyId?: string;
  personId?: string;
  nameContains?: string;
  taxId?: string;
  tags?: string[];
  groupIds?: string[];
  sourceIds?: string[];
  createdFrom?: string;
  createdTo?: string;
  updatedFrom?: string;
  updatedTo?: string;
  statusChangedFrom?: string;
  statusChangedTo?: string;
  expectedCloseFrom?: string;
  expectedCloseTo?: string;
  customFields?: CustomFieldFilter[];
  completed?: boolean;
  overdue?: boolean;
  dueFrom?: string;
  dueTo?: string;
  taskTypeIds?: string[];
  linkedTo?: { kind: "person" | "company" | "deal"; id: string };
}

export interface SearchCrmArgs {
  kinds?: ArgKind[];
  phrase?: string;
  filters?: SearchFilters;
  sort?: { field: string; direction: "asc" | "desc" };
  detail?: DetailLevel;
  page?: number;
  perPage?: number;
  countOnly?: boolean;
}

export interface SearchCrmDeps {
  records: Pick<RecordReader, "search" | "phrase">;
  metadata: Pick<MetadataService, "get" | "actingUser">;
  /** Whether the write tools are listed; shapes the next-step hints. */
  writesEnabled: boolean;
}

export type SearchCrmResult = ToolRunResult;

const DEFAULT_PER_PAGE = 20;
const MAX_PER_PAGE = 100;
const MAX_PAGE = 10_000;
/** Ids or tags in one list filter. */
const MAX_LIST = 50;
const MAX_CUSTOM_FIELD_FILTERS = 10;

const PEOPLE_COMPANIES_DEALS: readonly RecordArgKind[] = ["persons", "companies", "deals"];
const EVERY_KIND: readonly RecordArgKind[] = ["persons", "companies", "deals", "tasks"];
const DEALS: readonly RecordArgKind[] = ["deals"];
const TASKS: readonly RecordArgKind[] = ["tasks"];

/** Which kinds each filter exists for in the API's filter fields. */
const FILTER_KINDS: Record<keyof SearchFilters, readonly RecordArgKind[]> = {
  mine: EVERY_KIND,
  ownerIds: EVERY_KIND,
  status: DEALS,
  processId: DEALS,
  stageIds: DEALS,
  companyId: ["persons", "deals"],
  personId: DEALS,
  nameContains: EVERY_KIND,
  taxId: ["persons", "companies"],
  tags: PEOPLE_COMPANIES_DEALS,
  groupIds: PEOPLE_COMPANIES_DEALS,
  sourceIds: PEOPLE_COMPANIES_DEALS,
  createdFrom: PEOPLE_COMPANIES_DEALS,
  createdTo: PEOPLE_COMPANIES_DEALS,
  updatedFrom: EVERY_KIND,
  updatedTo: EVERY_KIND,
  statusChangedFrom: DEALS,
  statusChangedTo: DEALS,
  expectedCloseFrom: DEALS,
  expectedCloseTo: DEALS,
  customFields: EVERY_KIND,
  completed: TASKS,
  overdue: TASKS,
  dueFrom: TASKS,
  dueTo: TASKS,
  taskTypeIds: TASKS,
  linkedTo: TASKS,
};

/** The fields each search sorts by (the contract's `sortable` list). */
const SORTABLE: Record<V2Kind, readonly string[]> = {
  person: ["firstName", "lastName", "createdAt", "updatedAt"],
  company: ["name", "createdAt", "updatedAt"],
  deal: ["name", "createdAt", "updatedAt", "expectedCloseDate", "statusChangedAt"],
  task: ["title", "priority", "startsAt", "endsAt", "completedAt", "createdAt", "updatedAt"],
};

/** `name` is accepted for every kind, so one sort can serve a mixed search. */
const SORT_ALIAS: Partial<Record<V2Kind, Record<string, string>>> = {
  person: { name: "lastName" },
  task: { name: "title" },
};

const DATE_RANGES = [
  ["createdFrom", "createdTo"],
  ["updatedFrom", "updatedTo"],
  ["statusChangedFrom", "statusChangedTo"],
  ["expectedCloseFrom", "expectedCloseTo"],
  ["dueFrom", "dueTo"],
] as const;

/**
 * The dates a filter accepts. The bound is not about data - it keeps a year
 * like 9999 out of an upstream condition nobody has probed.
 */
const DATE_MIN = "1900-01-01";
const DATE_MAX = "2100-12-31";

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/u;

const idSchema = z.string().min(1).max(64);
const idListSchema = z.array(idSchema).min(1).max(MAX_LIST);
const dateSchema = z.string().regex(DATE_SHAPE);

const hitSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  url: z.string().nullable(),
  status: z.string().nullable().optional(),
  company: refSchema.nullable().optional(),
  person: refSchema.nullable().optional(),
  taxId: z.string().nullable().optional(),
  createdAt: z.string().nullable().optional(),
  parent: z
    .strictObject({ kind: z.string(), id: z.string(), name: z.string() })
    .nullable()
    .optional(),
  textTruncated: z.boolean().optional(),
});

// One envelope per kind, each carrying its own record schema. A union of
// look-alike shapes would let one kind validate as another and silently strip
// the fields it does not know (M3 lesson), so nothing here is a union.
const envelopeOf = <T extends z.ZodType>(item: T) =>
  z.strictObject({
    items: z.array(item).optional(),
    hits: z.array(hitSchema).optional(),
    returned: z.number().describe("Records or hits in this answer."),
    totalCount: z.number().optional().describe("Every record matching the filters."),
    totalCountExact: z
      .boolean()
      .optional()
      .describe("False above 10 000 matches: totalCount is then a floor."),
    page: z.number().optional(),
    perPage: z.number().optional(),
    hasMore: z.boolean().optional(),
    hint: z.string().optional().describe("What an empty answer does and does not mean."),
  });

export const searchCrmToolConfig = {
  title: "Search CRM",
  description: `Find persons, companies, deals, tasks and notes. Two modes, exactly one
per call. "phrase" runs the CRM's full-text search (word prefixes, accents
ignored; it also matches e-mail addresses and phone numbers) over persons,
companies, deals and, when asked, notes, and returns light hits in relevance
order, grouped by kind; the phrase block carries Livespace's estimate of the
total across kinds, which is not exact, so trust hasMore for "is there more".
"filters" lists whole records of persons, companies, deals or tasks, filtered,
sorted, paged and counted by Livespace; an empty filters object lists
everything of that kind. Feed the returned ids into get_records; never guess
ids. Filters: mine (records owned by, or tasks assigned to, the acting user;
refused when no acting user is resolved), ownerIds (with mine: the acting
user or any of these), nameContains (matches
inside words; for persons the first or the last name), tags, groupIds,
sourceIds, createdFrom/To, updatedFrom/To, customFields (one kind per call,
ids from crm_metadata customFields); deals also status (default open; "all"
includes won, lost and outdated), processId, stageIds, companyId, personId,
statusChangedFrom/To, expectedCloseFrom/To; persons also companyId and taxId;
companies also taxId; tasks also completed, overdue, dueFrom/To, taskTypeIds
and linkedTo. A filter that does not exist for a requested kind is refused
with BAD_PARAMS naming the kind. Dates are inclusive YYYY-MM-DD days in the
account's time zone. totalCount is every match, exact up to 10 000.
countOnly returns only the totals: use it for "how many" questions, for
example once per stage. page above 1 needs exactly one kind in filter mode.
Fields outside the detail level are omitted. A null or empty value means this
answer supplies no value; it does not prove the CRM field is empty. Deal value
keeps zero apart from null. The API key sees every active record, whatever
the acting user's own permissions are.`,
  inputSchema: z.strictObject({
    kinds: z
      .array(z.enum(ARG_KINDS))
      .min(1)
      .max(ARG_KINDS.length)
      .optional()
      .describe(
        "Kinds to search (default: persons, companies, deals). tasks need filters, notes need phrase.",
      ),
    phrase: z
      .string()
      .min(2)
      .max(100)
      .optional()
      .describe("Text to search for: word prefixes, accents ignored."),
    filters: z
      .strictObject({
        mine: z
          .boolean()
          .optional()
          .describe("Only records owned by the acting user; for tasks, assigned to them."),
        ownerIds: idListSchema
          .optional()
          .describe("User ids from crm_metadata users: any of these owns the record."),
        status: z
          .enum(["open", "won", "lost", "outdated", "all"])
          .optional()
          .describe(
            'Deal status (default: open). "outdated" is a closing status, not "past its close date". Deals only.',
          ),
        processId: idSchema.optional().describe("Deal process id. Deals only."),
        stageIds: idListSchema.optional().describe("Current stage is any of these. Deals only."),
        companyId: idSchema.optional().describe("Linked company. Persons and deals."),
        personId: idSchema.optional().describe("Linked person. Deals only."),
        nameContains: z
          .string()
          .min(2)
          .max(100)
          .optional()
          .describe("Name fragment, matched inside words; task title for tasks."),
        taxId: z
          .string()
          .min(1)
          .max(32)
          .optional()
          .describe("Tax id of the company, or of a person's company; spaces and dashes ignored."),
        tags: z
          .array(z.string().min(1).max(255))
          .min(1)
          .max(MAX_LIST)
          .optional()
          .describe("Tag names: any of these. Not for tasks."),
        groupIds: idListSchema.optional().describe("Group ids: any of these. Not for tasks."),
        sourceIds: idListSchema.optional().describe("Source ids: any of these. Not for tasks."),
        createdFrom: dateSchema.optional().describe("Created on or after this day. Not for tasks."),
        createdTo: dateSchema.optional().describe("Created on or before this day. Not for tasks."),
        updatedFrom: dateSchema.optional().describe("Changed on or after this day."),
        updatedTo: dateSchema.optional().describe("Changed on or before this day."),
        statusChangedFrom: dateSchema
          .optional()
          .describe("Status changed (for a closed deal: closed) on or after this day. Deals only."),
        statusChangedTo: dateSchema
          .optional()
          .describe("Status changed on or before this day. Deals only."),
        expectedCloseFrom: dateSchema
          .optional()
          .describe("Expected close date on or after this day. Deals only."),
        expectedCloseTo: dateSchema
          .optional()
          .describe("Expected close date on or before this day. Deals only."),
        customFields: z
          .array(
            z.strictObject({
              fieldId: idSchema.describe("Field id from crm_metadata customFields."),
              operator: z
                .enum(CUSTOM_FIELD_OPERATORS)
                .describe(
                  "Text fields: eq, contains, isEmpty, isNotEmpty. Checkbox: eq only. Choice fields: anyOf, allOf, noneOf, isEmpty, isNotEmpty.",
                ),
              value: z
                .union([
                  z.string().min(1).max(255),
                  z.boolean(),
                  z.array(idSchema).max(MAX_LIST),
                ])
                .optional()
                .describe(
                  "Text for eq and contains, true or false for a checkbox, option ids for a choice field; none for isEmpty and isNotEmpty.",
                ),
            }),
          )
          .min(1)
          .max(MAX_CUSTOM_FIELD_FILTERS)
          .optional()
          .describe("Custom-field conditions, all of which must hold. Exactly one kind per call."),
        completed: z.boolean().optional().describe("Task done or not. Tasks only."),
        overdue: z.boolean().optional().describe("Scheduled, not done and past due. Tasks only."),
        dueFrom: dateSchema.optional().describe("Task starts on or after this day. Tasks only."),
        dueTo: dateSchema.optional().describe("Task starts on or before this day. Tasks only."),
        taskTypeIds: idListSchema.optional().describe("Task type ids: any of these. Tasks only."),
        linkedTo: z
          .strictObject({ kind: z.enum(["person", "company", "deal"]), id: idSchema })
          .optional()
          .describe("Tasks linked to this record. Tasks only."),
      })
      .optional()
      .describe("Filter mode. Pass an empty object to list without narrowing."),
    sort: z
      .strictObject({
        field: z
          .string()
          .min(1)
          .max(64)
          .describe(
            "name, createdAt or updatedAt for any kind; deals also expectedCloseDate, statusChangedAt; persons firstName, lastName; tasks title, priority, startsAt, endsAt, completedAt.",
          ),
        direction: z.enum(["asc", "desc"]),
      })
      .optional()
      .describe("Filter mode only (default: last change, newest first)."),
    detail: z
      .enum(["minimal", "standard", "full"])
      .optional()
      .describe("How much of each record to return (default: standard). Filter mode only."),
    page: z.number().int().min(1).max(MAX_PAGE).optional().describe("Page, from 1 (default 1)."),
    perPage: z
      .number()
      .int()
      .min(1)
      .max(MAX_PER_PAGE)
      .optional()
      .describe("Records per kind and page (1-100, default 20); a phrase search returns at most 50 hits."),
    countOnly: z
      .boolean()
      .optional()
      .describe("Return only totalCount per kind, no records. Filter mode only."),
  }),
  outputSchema: z.strictObject({
    results: z.strictObject({
      persons: envelopeOf(personV2Schema).optional(),
      companies: envelopeOf(companyV2Schema).optional(),
      deals: envelopeOf(dealV2Schema).optional(),
      tasks: envelopeOf(taskV2Schema).optional(),
      // Notes come back as phrase hits only.
      notes: z.strictObject({ hits: z.array(hitSchema), returned: z.number() }).optional(),
    }),
    phrase: z
      .strictObject({
        totalCount: z
          .number()
          .describe("Livespace's estimate of the hits across every requested kind; not exact."),
        page: z.number(),
        perPage: z.number(),
        hasMore: z.boolean().describe("True when this page came back full."),
        hint: z.string().optional(),
      })
      .optional()
      .describe("Phrase mode only: the one ranked hit list the kinds were grouped from."),
    nextSteps: z
      .array(z.string())
      .max(3)
      .optional()
      .describe("Server-authored suggestions for the next call."),
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

type ProjectedRecord = Partial<RecordV2Map[V2Kind]>;

type OutputHit = Omit<PhraseHit, "kind">;

interface KindEnvelope {
  items?: ProjectedRecord[];
  hits?: OutputHit[];
  returned: number;
  totalCount?: number;
  totalCountExact?: boolean;
  page?: number;
  perPage?: number;
  hasMore?: boolean;
  hint?: string;
}

interface PhraseBlock {
  totalCount: number;
  page: number;
  perPage: number;
  hasMore: boolean;
  hint?: string;
}

interface KindError extends ToolError {
  kind?: ArgKind;
}

type KindOutcome =
  | { kind: RecordArgKind; envelope: KindEnvelope }
  | { kind: RecordArgKind; error: KindError };

function canonicalKinds(kinds?: ArgKind[]): ArgKind[] {
  const wanted = new Set(kinds ?? DEFAULT_KINDS);
  return ARG_KINDS.filter((kind) => wanted.has(kind));
}

function badParams(hint: string, kind?: ArgKind): KindError {
  return {
    ...(kind === undefined ? {} : { kind }),
    code: "BAD_PARAMS",
    message: "These search_crm arguments cannot be combined.",
    hint,
  };
}

function rejected(requested: number, error: KindError): SearchCrmResult {
  return {
    text: [
      `search_crm (0/${requested} kinds ok)`,
      `arguments: ERROR ${error.code} - ${error.hint}`,
    ].join("\n"),
    structured: { results: {}, errors: [error] },
    isError: true,
  };
}

/**
 * Whether a shape-valid "YYYY-MM-DD" is a date that actually exists. The NaN
 * guard comes first: `new Date("2026-13-01T00:00:00Z")` is an invalid date and
 * `toISOString()` on it throws. Rolling months ("2026-02-31" -> March 3) fail
 * the round-trip instead.
 */
function isCalendarDate(value: string): boolean {
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms)) return false;
  return new Date(ms).toISOString().slice(0, 10) === value;
}

function dateHint(filters: SearchFilters): string | null {
  for (const [fromKey, toKey] of DATE_RANGES) {
    for (const key of [fromKey, toKey]) {
      const value = filters[key];
      if (value === undefined) continue;
      if (!isCalendarDate(value)) {
        return `${key} is not a real calendar date. Send an existing day as YYYY-MM-DD, for example 2026-01-31.`;
      }
      if (value < DATE_MIN || value > DATE_MAX) {
        return `${key} is outside the supported range. Send a date between ${DATE_MIN} and ${DATE_MAX}.`;
      }
    }
    const from = filters[fromKey];
    const to = filters[toKey];
    if (from !== undefined && to !== undefined && from > to) {
      return `${fromKey} must not be later than ${toKey}. Swap them, or widen the period.`;
    }
  }
  return null;
}

/** The ids each id-typed filter carries. */
const ID_FILTERS: { [K in keyof SearchFilters]?: (filters: SearchFilters) => string[] } = {
  ownerIds: (filters) => filters.ownerIds ?? [],
  processId: (filters) => (filters.processId === undefined ? [] : [filters.processId]),
  stageIds: (filters) => filters.stageIds ?? [],
  companyId: (filters) => (filters.companyId === undefined ? [] : [filters.companyId]),
  personId: (filters) => (filters.personId === undefined ? [] : [filters.personId]),
  groupIds: (filters) => filters.groupIds ?? [],
  sourceIds: (filters) => filters.sourceIds ?? [],
  taskTypeIds: (filters) => filters.taskTypeIds ?? [],
  linkedTo: (filters) => (filters.linkedTo === undefined ? [] : [filters.linkedTo.id]),
  customFields: (filters) =>
    (filters.customFields ?? []).flatMap((filter) => [
      filter.fieldId,
      ...(Array.isArray(filter.value) ? filter.value : []),
    ]),
};

/**
 * Livespace answers 400 for an id that is not id-shaped, and a 400 still
 * costs the daily budget, so such an id stops here. The hint names the
 * filter, never the value.
 */
function idShapeHint(filters: SearchFilters): string | null {
  for (const [name, read] of Object.entries(ID_FILTERS)) {
    if (read(filters).some((id) => !isV2Id(id))) {
      return (
        `${name} carries a value that is not a Livespace API v2 id (8-4-4-4-12 hex digits). ` +
        "Take ids from search_crm, get_records or crm_metadata; ids of the old API do not work here."
      );
    }
  }
  return null;
}

function usedFilters(filters: SearchFilters): (keyof SearchFilters)[] {
  return (Object.keys(FILTER_KINDS) as (keyof SearchFilters)[]).filter((key) => {
    const value = filters[key];
    // `mine: false` asks for nothing.
    return value !== undefined && !(key === "mine" && value === false);
  });
}

/**
 * Cross-field rules live here rather than in the schema: a zod refinement
 * would turn every combination mistake into a protocol-level validation
 * error, while a returned `{code, message, hint}` tells the model how to fix
 * the call.
 */
function argumentError(args: SearchCrmArgs, kinds: ArgKind[]): KindError | null {
  const hasPhrase = args.phrase !== undefined;
  const hasFilters = args.filters !== undefined;
  if (hasPhrase === hasFilters) {
    return badParams(
      hasPhrase
        ? "Use phrase or filters, not both: phrase searches text, filters list records."
        : "Give either a phrase to search for, or a filters object (an empty one lists everything).",
    );
  }
  if (hasPhrase) {
    // Livespace counts the characters after trimming and answers 400 below 2.
    if ((args.phrase ?? "").trim().length < 2) {
      return badParams("phrase needs at least 2 characters besides outer spaces.");
    }
    if (kinds.includes("tasks")) {
      return badParams(
        'The phrase search does not cover tasks. For tasks use filters, for example nameContains, with kinds: ["tasks"].',
        "tasks",
      );
    }
    if (args.sort !== undefined) {
      return badParams("Phrase mode returns relevance order. Drop sort, or switch to filters.");
    }
    if (args.countOnly === true) {
      return badParams("countOnly counts filtered records. Drop it, or switch to filters.");
    }
    if ((args.page ?? 1) > PHRASE_MAX_PAGE) {
      return badParams(`A phrase search has at most ${PHRASE_MAX_PAGE} pages. Narrow the phrase.`);
    }
    return null;
  }

  if (kinds.includes("notes")) {
    return badParams(
      'Notes are found by phrase only. Use phrase with kinds: ["notes"], or get_activity for the notes of one record.',
      "notes",
    );
  }
  const recordKinds = kinds as RecordArgKind[];
  if ((args.page ?? 1) > 1 && recordKinds.length !== 1) {
    return badParams("A page above 1 belongs to one kind. Ask for exactly one kind per call.");
  }
  const filters = args.filters ?? {};
  const used = usedFilters(filters);
  for (const key of used) {
    const allowed = FILTER_KINDS[key];
    const refused = recordKinds.find((kind) => !allowed.includes(kind));
    if (refused !== undefined) {
      return badParams(
        `The filter ${key} does not exist for ${refused}. It works for: ${allowed.join(", ")}. Set kinds to those, or drop the filter.`,
        refused,
      );
    }
  }
  if (used.includes("customFields") && recordKinds.length !== 1) {
    return badParams(
      "A custom field belongs to one kind. Use customFields with exactly one kind per call.",
    );
  }
  if (args.sort !== undefined) {
    for (const argKind of recordKinds) {
      const kind = RECORD_KIND[argKind];
      if (sortField(kind, args.sort.field) === undefined) {
        return badParams(
          `${argKind} cannot be sorted by this field. Sortable for ${argKind}: name, ${SORTABLE[kind]
            .filter((field) => field !== "name")
            .join(", ")}.`,
          argKind,
        );
      }
    }
  }
  const hint = dateHint(filters) ?? idShapeHint(filters);
  return hint === null ? null : badParams(hint);
}

function sortField(kind: V2Kind, field: string): string | undefined {
  const resolved = SORT_ALIAS[kind]?.[field] ?? field;
  return SORTABLE[kind].includes(resolved) ? resolved : undefined;
}

const TEXT_FIELD_TYPES: ReadonlySet<string> = new Set(["text", "textarea"]);
const CHOICE_FIELD_TYPES: ReadonlySet<string> = new Set([
  "select",
  "radio",
  "multiselect",
  "multicheckbox",
]);

/**
 * One custom-field condition checked against the field dictionary, so a
 * condition Livespace would answer 400 for is refused here. The hints name
 * our own operator lists and never the field's name or the value sent.
 */
function customFieldNode(
  filter: CustomFieldFilter,
  fields: readonly CustomFieldInfo[],
  truncated: boolean,
): FilterNode | string {
  const field = fields.find((candidate) => candidate.id === filter.fieldId);
  if (field === undefined) {
    return (
      "A customFields fieldId is not a field of this kind. Take field ids from the " +
      "customFields section of crm_metadata." +
      (truncated ? " That section is truncated, so the field may exist beyond what was read." : "")
    );
  }
  if (!field.filterable) {
    return "A customFields field has a type Livespace cannot filter by (numbers, dates and files). Drop that condition.";
  }
  const name = `additionalFields.${field.id}`;
  const { operator, value } = filter;
  if (field.type === "checkbox") {
    // The contract gives a checkbox `eq` alone; `false` also matches a
    // record with no stored answer.
    if (operator !== "eq" || typeof value !== "boolean") {
      return "A checkbox custom field takes eq with true or false only; eq false also matches records with no answer.";
    }
    return where(name, "eq", value);
  }
  if (operator === "isEmpty" || operator === "isNotEmpty") {
    if (value !== undefined) return "isEmpty and isNotEmpty take no value. Drop the value.";
    return where(name, operator);
  }
  if (TEXT_FIELD_TYPES.has(field.type)) {
    if ((operator !== "eq" && operator !== "contains") || typeof value !== "string") {
      return "A text custom field takes eq or contains with a text value, or isEmpty and isNotEmpty.";
    }
    return where(name, operator, value);
  }
  if (CHOICE_FIELD_TYPES.has(field.type)) {
    if (
      (operator !== "anyOf" && operator !== "allOf" && operator !== "noneOf") ||
      !Array.isArray(value) ||
      value.length === 0
    ) {
      return "A choice custom field takes anyOf, allOf or noneOf with a list of option ids, or isEmpty and isNotEmpty.";
    }
    if (field.optionsTruncated !== true) {
      const known = new Set(field.options.map((option) => option.id));
      if (value.some((id) => !known.has(id))) {
        return "A customFields value is not an option of that field. Take option ids from the customFields section of crm_metadata.";
      }
    }
    return where(name, operator, value);
  }
  return "A customFields field has a type this server cannot filter by. Drop that condition.";
}

/** What a filter search needs beyond its arguments, read once per call. */
interface FilterContext {
  actingUserId?: string;
  timeZone?: string;
  customFieldNodes?: FilterNode[];
}

const DATETIME_FILTERS = [
  "createdFrom",
  "createdTo",
  "updatedFrom",
  "updatedTo",
  "statusChangedFrom",
  "statusChangedTo",
] as const;

const TASK_LINK_FIELD = {
  person: "people.id",
  company: "companies.id",
  deal: "deals.id",
} as const;

/** The whole filter tree of one kind. Unused filters add nothing. */
function buildFilter(
  argKind: RecordArgKind,
  filters: SearchFilters,
  context: FilterContext,
): FilterNode | undefined {
  const nodes: (FilterNode | undefined)[] = [];
  const task = argKind === "tasks";

  if (argKind === "deals" && filters.status !== "all") {
    nodes.push(where("status", "eq", filters.status ?? "open"));
  }

  // Tasks have assignees where records have owners; `members` never matched
  // in the live check.
  const owners = [...(filters.ownerIds ?? [])];
  if (context.actingUserId !== undefined && !owners.includes(context.actingUserId)) {
    owners.push(context.actingUserId);
  }
  if (owners.length > 0) nodes.push(where(task ? "assignees" : "owners", "anyOf", owners));

  if (filters.processId !== undefined) nodes.push(where("process.id", "eq", filters.processId));
  if (filters.stageIds !== undefined) nodes.push(where("currentStage.id", "in", filters.stageIds));
  if (filters.companyId !== undefined) nodes.push(where("company.id", "eq", filters.companyId));
  if (filters.personId !== undefined) nodes.push(where("person.id", "eq", filters.personId));

  if (filters.nameContains !== undefined) {
    const fragment = filters.nameContains;
    nodes.push(
      argKind === "persons"
        ? // A person has no single name field to filter by.
          or(where("firstName", "contains", fragment), where("lastName", "contains", fragment))
        : where(task ? "title" : "name", "contains", fragment),
    );
  }
  if (filters.taxId !== undefined) {
    nodes.push(where(argKind === "persons" ? "company.taxId" : "taxId", "eq", filters.taxId));
  }
  if (filters.tags !== undefined) nodes.push(where("tags", "anyOf", filters.tags));
  if (filters.groupIds !== undefined) nodes.push(where("groups", "anyOf", filters.groupIds));
  if (filters.sourceIds !== undefined) nodes.push(where("source.id", "in", filters.sourceIds));

  // Datetime fields refuse a bare day: the bounds are instants in the
  // integration user's time zone. `timeZone` is set whenever one is used.
  const zone = context.timeZone ?? "";
  nodes.push(dayBounds("createdAt", filters.createdFrom, filters.createdTo, zone));
  nodes.push(dayBounds("updatedAt", filters.updatedFrom, filters.updatedTo, zone));
  nodes.push(
    dayBounds("statusChangedAt", filters.statusChangedFrom, filters.statusChangedTo, zone),
  );
  // A date field takes the bare days.
  nodes.push(dayBounds("expectedCloseDate", filters.expectedCloseFrom, filters.expectedCloseTo));

  nodes.push(...(context.customFieldNodes ?? []));

  if (filters.completed !== undefined) nodes.push(where("completed", "eq", filters.completed));
  if (filters.overdue !== undefined) nodes.push(where("overdue", "eq", filters.overdue));
  // `startsAt` takes a bare day in the caller's zone: `gte` starts with the
  // day, `lte` ends with it. Two conditions, because the contract documents
  // those two operators for days and says nothing of `between`.
  if (filters.dueFrom !== undefined) nodes.push(where("startsAt", "gte", filters.dueFrom));
  if (filters.dueTo !== undefined) nodes.push(where("startsAt", "lte", filters.dueTo));
  if (filters.taskTypeIds !== undefined) nodes.push(where("type.id", "in", filters.taskTypeIds));
  if (filters.linkedTo !== undefined) {
    nodes.push(where(TASK_LINK_FIELD[filters.linkedTo.kind], "eq", filters.linkedTo.id));
  }
  return and(...nodes);
}

function noMatchHint(argKind: RecordArgKind, filters: SearchFilters): string {
  const status =
    argKind === "deals" && filters.status === undefined
      ? ' Deal searches default to status open; pass status "all" to include won, lost and outdated deals.'
      : "";
  return (
    "No record matches these filters. Check ids against crm_metadata and loosen " +
    `filters only within the user's request.${status}`
  );
}

const PAST_END_HINT =
  "This page is past the last page: totalCount records match. Ask for an earlier page.";

const NO_HITS_HINT =
  "No hits. The phrase search matches word prefixes and ignores accents: try a shorter " +
  "prefix, or filters.nameContains, which matches inside words.";

function project(kind: V2Kind, record: unknown, detail: DetailLevel): ProjectedRecord {
  return projectRecord(kind, record as RecordV2Map[typeof kind], detail);
}

// Counts and fixed wording only - CRM-authored strings stay in the structured
// channel (docs/security.md par. 4).
function kindLine(outcome: KindOutcome, countOnly: boolean): string {
  if ("error" in outcome) {
    return `${outcome.kind}: ERROR ${outcome.error.code} - ${outcome.error.hint}`;
  }
  const { envelope } = outcome;
  const floor = envelope.totalCountExact === false ? "+" : "";
  const hint = envelope.hint === undefined ? "" : `\n${envelope.hint}`;
  if (countOnly) return `${outcome.kind}: ${envelope.totalCount}${floor} total${hint}`;
  const more = envelope.hasMore ? ", more" : "";
  return (
    `${outcome.kind}: ${envelope.returned} of ${envelope.totalCount}${floor} ` +
    `(page ${envelope.page}${more})${hint}`
  );
}

async function runPhrase(
  deps: SearchCrmDeps,
  args: SearchCrmArgs,
  kinds: ArgKind[],
  read: ReadOptions,
  signal: AbortSignal | undefined,
): Promise<SearchCrmResult> {
  const page = args.page ?? 1;
  const perPage = Math.min(args.perPage ?? DEFAULT_PER_PAGE, PHRASE_MAX_PER_PAGE);
  const phraseKinds = kinds.map((kind) => PHRASE_KIND[kind as Exclude<ArgKind, "tasks">]);
  let found;
  try {
    // One request for every kind: the hits are one ranked list.
    found = await deps.records.phrase(
      { q: (args.phrase ?? "").trim(), kinds: phraseKinds, page, perPage },
      read,
    );
  } catch (error) {
    // Only the signal STATE is reliable: an abort surfaces as a DOMException,
    // a plain Error or a bare string reason (M3 lesson).
    if (signal?.aborted) throw cancelledError();
    return rejected(kinds.length, toToolError(error));
  }

  const results: Partial<Record<ArgKind, KindEnvelope>> = {};
  for (const kind of kinds) results[kind] = { hits: [], returned: 0 };
  for (const hit of found.hits) {
    const envelope = results[ARG_KIND_OF_PHRASE[hit.kind]];
    if (envelope === undefined) continue;
    const { kind: _kind, ...rest } = hit;
    envelope.hits?.push(rest);
    envelope.returned += 1;
  }
  const returned = found.hits.length;
  const block: PhraseBlock = {
    totalCount: found.totalCount,
    page,
    perPage,
    // The API calls its total approximate, so it cannot say whether another
    // page exists; a full page of rows can. Rows of kinds this server drops
    // count too: they filled the page.
    hasMore: found.rowCount >= perPage && page < PHRASE_MAX_PAGE,
    ...(returned === 0 ? { hint: NO_HITS_HINT } : {}),
  };
  // A note hit has no record to read: the ids worth reading are its parent's.
  const readable = kinds.filter((kind) => kind !== "notes" && (results[kind]?.returned ?? 0) > 0);
  const single = readable.length === 1 ? RECORD_KIND[readable[0] as RecordArgKind] : undefined;
  const steps = nextSteps("search_crm", {
    ...(single === undefined ? {} : { kind: single }),
    empty: readable.length === 0,
    hasMore: block.hasMore,
    writesEnabled: deps.writesEnabled,
  });
  const text = [
    `search_crm (${kinds.length}/${kinds.length} kinds ok)`,
    `phrase: ${returned} ${returned === 1 ? "hit" : "hits"} of about ${found.totalCount} ` +
      `(page ${page}${block.hasMore ? ", more" : ""})` +
      (block.hint === undefined ? "" : `\n${block.hint}`),
    ...kinds.map((kind) => {
      const count = results[kind]?.returned ?? 0;
      return `${kind}: ${count} ${count === 1 ? "hit" : "hits"}`;
    }),
  ].join("\n");
  return {
    text,
    structured: {
      results,
      phrase: block,
      ...(steps.length === 0 ? {} : { nextSteps: steps }),
      errors: [],
    },
    isError: false,
  };
}

/**
 * Reads what the filters need once per call: the acting user for `mine`, the
 * time zone for day bounds on datetime fields, the field dictionary for
 * custom-field conditions. Each is read only when a filter asks for it.
 */
async function resolveContext(
  deps: SearchCrmDeps,
  filters: SearchFilters,
  argKind: RecordArgKind | undefined,
  read: ReadOptions,
): Promise<FilterContext | KindError> {
  const context: FilterContext = {};
  if (filters.mine === true) {
    const acting = await deps.metadata.actingUser(read);
    if (acting.state !== "resolved" || acting.user === null) {
      // Never the integration user instead: that would answer an empty list
      // where the truth is "nobody to ask for".
      return {
        code: "NO_ACTING_USER",
        message: "mine needs an acting user, and none is resolved.",
        hint:
          `${actingUserHint(acting.state) ?? "The acting user could not be resolved."} ` +
          "Or drop mine and pass ownerIds from the users section of crm_metadata.",
      };
    }
    context.actingUserId = acting.user.id;
  }
  if (DATETIME_FILTERS.some((key) => filters[key] !== undefined)) {
    const current = await deps.metadata.get("currentUser", read);
    context.timeZone = current.data.timeZone;
  }
  if (filters.customFields !== undefined && argKind !== undefined) {
    const section = await deps.metadata.get("customFields", read);
    const fields = section.data[RECORD_KIND[argKind]];
    const nodes: FilterNode[] = [];
    for (const filter of filters.customFields) {
      const node = customFieldNode(filter, fields, section.truncated);
      if (typeof node === "string") return badParams(node, argKind);
      nodes.push(node);
    }
    context.customFieldNodes = nodes;
  }
  return context;
}

export async function runSearchCrm(
  deps: SearchCrmDeps,
  args: SearchCrmArgs,
  opts: { signal?: AbortSignal } = {},
): Promise<SearchCrmResult> {
  const kinds = canonicalKinds(args.kinds);
  const refusal = argumentError(args, kinds);
  if (refusal !== null) return rejected(kinds.length, refusal);

  // One request budget for the whole tool call (docs/security.md par. 3):
  // dictionary reads and searches spend from the same one.
  const read: ReadOptions = {
    budget: new CallBudget(CALL_BUDGETS.read),
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  };

  if (args.phrase !== undefined) return runPhrase(deps, args, kinds, read, opts.signal);

  const recordKinds = kinds as RecordArgKind[];
  const filters = args.filters ?? {};
  let context: FilterContext;
  try {
    const resolved = await resolveContext(
      deps,
      filters,
      recordKinds.length === 1 ? recordKinds[0] : undefined,
      read,
    );
    if ("code" in resolved) return rejected(kinds.length, resolved);
    context = resolved;
  } catch (error) {
    if (opts.signal?.aborted) throw cancelledError();
    return rejected(kinds.length, toToolError(error));
  }

  const countOnly = args.countOnly === true;
  const detail = args.detail ?? "standard";
  const page = countOnly ? 1 : (args.page ?? 1);
  const perPage = countOnly ? 1 : (args.perPage ?? DEFAULT_PER_PAGE);
  // A count needs no fields, and minimal detail is exactly the minimal rows.
  const media = countOnly || detail === "minimal" ? MEDIA_MINIMAL : MEDIA_JSON;

  // Every kind settles in its own try/catch: one failing kind must not take
  // the whole result down.
  const outcomes = await Promise.all(
    recordKinds.map(async (argKind): Promise<KindOutcome> => {
      const kind = RECORD_KIND[argKind];
      try {
        const filter = buildFilter(argKind, filters, context);
        const field = args.sort === undefined ? undefined : sortField(kind, args.sort.field);
        const found = await deps.records.search(
          kind,
          {
            ...(filter === undefined ? {} : { filter }),
            ...(args.sort === undefined || field === undefined
              ? {}
              : { sort: { field, direction: args.sort.direction } }),
            page,
            perPage,
            media,
          },
          read,
        );
        if (countOnly) {
          return {
            kind: argKind,
            envelope: {
              returned: 0,
              totalCount: found.totalCount,
              totalCountExact: found.totalCountExact,
              ...(found.totalCount === 0 ? { hint: noMatchHint(argKind, filters) } : {}),
            },
          };
        }
        const items = found.items.map((record) => project(kind, record, detail));
        const envelope: KindEnvelope = {
          items,
          returned: items.length,
          totalCount: found.totalCount,
          totalCountExact: found.totalCountExact,
          page,
          perPage,
          // Above 10 000 matches the total is a floor, so a full page is the
          // only sign that another one follows.
          hasMore:
            page * perPage < found.totalCount ||
            (!found.totalCountExact && items.length >= perPage),
        };
        if (items.length === 0) {
          envelope.hint = found.totalCount > 0 ? PAST_END_HINT : noMatchHint(argKind, filters);
        }
        return { kind: argKind, envelope };
      } catch (error) {
        if (opts.signal?.aborted) throw cancelledError();
        return { kind: argKind, error: { kind: argKind, ...toToolError(error) } };
      }
    }),
  );

  const errors = outcomes.flatMap((outcome) => ("error" in outcome ? [outcome.error] : []));
  if (
    errors.length > 0 &&
    errors.length === outcomes.length &&
    errors.every((error) => error.code === "CANCELLED")
  ) {
    throw cancelledError();
  }

  const results: Partial<Record<RecordArgKind, KindEnvelope>> = {};
  const answered: { kind: RecordArgKind; envelope: KindEnvelope }[] = [];
  for (const outcome of outcomes) {
    if ("envelope" in outcome) {
      results[outcome.kind] = outcome.envelope;
      answered.push(outcome);
    }
  }
  const withRecords = answered.filter((entry) => entry.envelope.returned > 0);
  const steps = nextSteps("search_crm", {
    ...(withRecords.length === 1 ? { kind: RECORD_KIND[withRecords[0]!.kind] } : {}),
    empty: withRecords.length === 0,
    hasMore: withRecords.some((entry) => entry.envelope.hasMore === true),
    writesEnabled: deps.writesEnabled,
  });

  const ok = outcomes.length - errors.length;
  const text = [
    `search_crm (${ok}/${kinds.length} kinds ok)`,
    ...outcomes.map((outcome) => kindLine(outcome, countOnly)),
  ].join("\n");

  return {
    text,
    structured: {
      results,
      ...(steps.length === 0 ? {} : { nextSteps: steps }),
      errors,
    },
    isError: ok === 0,
  };
}
