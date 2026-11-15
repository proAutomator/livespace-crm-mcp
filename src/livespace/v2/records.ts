import { stripHtml } from "../activity.js";
import { LivespaceError } from "../errors.js";
import type { CallBudget } from "./budget.js";
import { v2Path, type LivespaceV2Client } from "./client.js";
import { assertFilterLimits, type FilterNode } from "./filters.js";
import { MEDIA_JSON, type V2MediaType } from "./media-types.js";

/**
 * Records of API v2: persons, companies, deals and tasks, the phrase search
 * and the deal sub-resources (process, product lines, budget summary).
 *
 * Rules the mappers keep:
 *
 * 1. A mapper always produces the whole interface. A row read under the
 *    minimal media type carries a few fields only; the rest map to `null`,
 *    `[]` or the type's default, and `projectRecord` cuts the record down to
 *    the detail level that was asked for.
 * 2. An id is an opaque non-empty string. A row without one is an unknown
 *    shape and fails with fixed wording: the API changed once without a
 *    version bump, and guessing would hide the next change (docs/security.md
 *    par. 6). Every other field is read leniently.
 * 3. A nested reference that is absent maps to `null`, never to an empty
 *    name: `null` says "no value in this answer".
 * 4. Nothing here is cached: record data is never cached (par. 8).
 */

type V2Requester = Pick<LivespaceV2Client, "request">;

export interface Ref {
  id: string;
  name: string;
}

export interface CustomFieldValue {
  id: string;
  name: string;
  type: string;
  /** Choice fields carry option names, not option ids. */
  value: string | number | boolean | string[] | null;
}

export interface AddressV2 {
  name: string | null;
  street: string | null;
  city: string | null;
  postcode: string | null;
  region: string | null;
  country: string | null;
  isMain: boolean;
}

export interface PersonV2 {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  company: Ref | null;
  position: Ref | null;
  owner: Ref | null;
  /** Every user holding the owner role; `mine` and `ownerIds` match these. */
  owners: Ref[];
  emails: string[];
  /** Mobile numbers first, then landlines. */
  phones: string[];
  tags: string[];
  groups: Ref[];
  source: Ref | null;
  description: string | null;
  visibility: string;
  lastActivity: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  addresses: AddressV2[];
  customFields: CustomFieldValue[];
  url: string;
}

export interface CompanyV2 {
  id: string;
  name: string;
  taxId: string | null;
  regon: string | null;
  owner: Ref | null;
  owners: Ref[];
  emails: string[];
  phones: string[];
  websites: string[];
  tags: string[];
  groups: Ref[];
  source: Ref | null;
  description: string | null;
  visibility: string;
  lastActivity: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  addresses: AddressV2[];
  customFields: CustomFieldValue[];
  url: string;
}

export type DealReasonKind = "won" | "lost" | "outdated";

export interface DealReasonV2 {
  kind: DealReasonKind;
  name: string;
  note: string | null;
}

export interface DealV2 {
  id: string;
  name: string;
  number: string | null;
  status: string | null;
  /** The deal's budget value; zero is a value, `null` is none. */
  value: number | null;
  currency: string | null;
  process: Ref | null;
  stage: Ref | null;
  owner: Ref | null;
  owners: Ref[];
  company: Ref | null;
  person: Ref | null;
  expectedCloseDate: string | null;
  statusChangedAt: string | null;
  stageChangedAt: string | null;
  lastActivity: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  tags: string[];
  groups: Ref[];
  source: Ref | null;
  description: string | null;
  visibility: string;
  /** The reason of the CURRENT status only; an open deal has none. */
  reason: DealReasonV2 | null;
  /** API v2 does not publish it; null unless the v1 fallback fills it. */
  probability: number | null;
  customFields: CustomFieldValue[];
  url: string;
}

export interface TaskLink {
  kind: "person" | "company" | "deal";
  id: string;
  name: string;
}

export interface TaskV2 {
  id: string;
  title: string;
  description: string | null;
  completed: boolean;
  completedAt: string | null;
  priority: "normal" | "high";
  dueType: string;
  startsAt: string | null;
  endsAt: string | null;
  allDay: boolean | null;
  type: Ref | null;
  status: Ref | null;
  private: boolean;
  recurring: boolean;
  assignees: Ref[];
  links: TaskLink[];
  createdAt: string | null;
  updatedAt: string | null;
  customFields: CustomFieldValue[];
  url: string;
}

export type RecordV2 = PersonV2 | CompanyV2 | DealV2 | TaskV2;

export interface RecordV2Map {
  person: PersonV2;
  company: CompanyV2;
  deal: DealV2;
  task: TaskV2;
}

export const V2_KINDS = ["person", "company", "deal", "task"] as const;

export type V2Kind = keyof RecordV2Map;

export type DetailLevel = "minimal" | "standard" | "full";

export type StageState = "completed" | "current" | "pending";

export interface DealProcessV2 {
  process: Ref | null;
  currentStage: Ref | null;
  stages: {
    id: string;
    name: string;
    position: number;
    state: StageState;
    completedAt: string | null;
    steps: { id: string; name: string; required: boolean; completed: boolean }[];
  }[];
}

export interface BudgetLineV2 {
  id: string;
  product: Ref | null;
  quantity: number | null;
  unitPrice: number | null;
  /** The stored line value after discount. */
  value: number;
  currency: string;
  /** True for a forecast line, false for an executed one. */
  forecast: boolean;
  description: string | null;
}

export interface MoneyPair {
  forecast: number;
  executed: number;
}

/** The stored budget summary of a deal, in the deal's currency. */
export interface BudgetSummaryV2 {
  currency: string | null;
  revenue: MoneyPair;
  cost: MoneyPair;
  margin: MoneyPair;
  quantity: MoneyPair;
}

export type PhraseKind = "person" | "company" | "deal" | "note";

export interface PhraseHit {
  kind: PhraseKind;
  id: string;
  /** A note has no name: this is the start of its text, flattened. */
  name: string;
  url: string | null;
  status?: string | null;
  company?: Ref | null;
  person?: Ref | null;
  taxId?: string | null;
  createdAt?: string | null;
  /** The record a note hit sits on. */
  parent?: { kind: string; id: string; name: string } | null;
  textTruncated?: boolean;
}

export interface ReadOptions {
  signal?: AbortSignal;
  /** The tool call's request budget: every request spends from it. */
  budget: CallBudget;
}

export interface SearchQuery {
  filter?: FilterNode;
  sort?: { field: string; direction: "asc" | "desc" };
  page: number;
  perPage: number;
  media: V2MediaType;
}

export interface SearchPage<T> {
  items: T[];
  totalCount: number;
  /** False above 10 000 matches: `totalCount` is then a floor. */
  totalCountExact: boolean;
}

export interface PhraseQuery {
  q: string;
  kinds: readonly PhraseKind[];
  page: number;
  perPage: number;
}

export interface PhrasePage {
  hits: PhraseHit[];
  /** Matches across every asked kind together. */
  totalCount: number;
  /** Rows upstream sent on this page, before unknown hit types were dropped. */
  rowCount: number;
}

export interface RecordReader {
  search<K extends V2Kind>(
    kind: K,
    query: SearchQuery,
    opts: ReadOptions,
  ): Promise<SearchPage<RecordV2Map[K]>>;
  phrase(query: PhraseQuery, opts: ReadOptions): Promise<PhrasePage>;
  /** `null` for an id that is unknown or not visible to the integration user. */
  get<K extends V2Kind>(
    kind: K,
    id: string,
    opts: ReadOptions & { media?: V2MediaType },
  ): Promise<RecordV2Map[K] | null>;
  dealProcess(id: string, opts: ReadOptions): Promise<DealProcessV2 | null>;
  dealLines(id: string, opts: ReadOptions): Promise<{ lines: BudgetLineV2[]; totalCount: number }>;
  /** `null` when the deal is shown at basic access level. */
  dealBudget(id: string, opts: ReadOptions): Promise<BudgetSummaryV2 | null>;
}

/** The largest page a search accepts (the contract's `perPage` maximum). */
export const SEARCH_MAX_PER_PAGE = 500;
/** `GET /search` takes at most 50 rows a page and 200 pages. */
export const PHRASE_MAX_PER_PAGE = 50;
export const PHRASE_MAX_PAGE = 200;
/** Flattened note text kept in a phrase hit. */
export const PHRASE_TEXT_LIMIT = 200;
/** Product lines read per deal: one page, the total says when there are more. */
export const DEAL_LINE_PAGE = 100;

const COLLECTIONS: Record<V2Kind, string> = {
  person: "people",
  company: "companies",
  deal: "deals",
  task: "tasks",
};

const PHRASE_KINDS: ReadonlySet<string> = new Set(["person", "company", "deal", "note"]);
const STAGE_STATES: ReadonlySet<string> = new Set(["completed", "current", "pending"]);

// Fixed wording only: upstream content must never reach an error message
// (docs/security.md par. 6).
function unexpectedShape(): LivespaceError {
  return new LivespaceError(
    "UPSTREAM_ERROR",
    "Livespace API v2 returned an unexpected shape for this record.",
    "Report it on the issue tracker; the API may have changed.",
  );
}

type Row = Record<string, unknown>;

function asObject(value: unknown): Row {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw unexpectedShape();
  }
  return value as Row;
}

function asList(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw unexpectedShape();
  return value;
}

/** A list field of a row: absent on minimal rows, so that is an empty list. */
function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function objectOf(value: unknown): Row {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};
}

function readId(row: Row): string {
  const id = row["id"];
  if (typeof id !== "string" || id === "") throw unexpectedShape();
  return id;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function strings(value: unknown): string[] {
  return listOf(value).filter((item): item is string => typeof item === "string" && item !== "");
}

/** `{id, name}` of a nested reference; null when absent or without an id. */
function refOf(value: unknown): Ref | null {
  const row = objectOf(value);
  const id = row["id"];
  if (typeof id !== "string" || id === "") return null;
  return { id, name: text(row["name"]) };
}

function refs(value: unknown): Ref[] {
  return listOf(value).flatMap((item) => {
    const ref = refOf(item);
    return ref === null ? [] : [ref];
  });
}

/** The users of an `{users, teams}` block; a team row is not a person. */
function userRefs(value: unknown): Ref[] {
  return refs(objectOf(value)["users"]);
}

function customFieldValue(value: unknown): CustomFieldValue["value"] {
  if (typeof value === "string") return value === "" ? null : value;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    const names = value.flatMap((option) => {
      const name = textOrNull(objectOf(option)["name"]);
      return name === null ? [] : [name];
    });
    return names.length === 0 ? null : names;
  }
  if (value !== null && typeof value === "object") {
    return textOrNull((value as Row)["name"]);
  }
  return null;
}

/** Only the fields that carry an answer: `false` and `0` are answers. */
function customFields(value: unknown): CustomFieldValue[] {
  return listOf(value).flatMap((raw) => {
    const row = objectOf(raw);
    const id = row["id"];
    const answer = customFieldValue(row["value"]);
    if (typeof id !== "string" || id === "" || answer === null) return [];
    return [{ id, name: text(row["name"]), type: text(row["type"]), value: answer }];
  });
}

function addresses(value: unknown): AddressV2[] {
  return listOf(value).map((raw) => {
    const row = objectOf(raw);
    const street = strings(row["streetLines"]).join(", ");
    return {
      name: textOrNull(row["name"]),
      street: street === "" ? null : street,
      city: textOrNull(row["city"]),
      postcode: textOrNull(row["postcode"]),
      region: textOrNull(row["region"]),
      country: textOrNull(row["country"]),
      isMain: row["isMain"] === true,
    };
  });
}

function mapPerson(raw: unknown): PersonV2 {
  const row = asObject(raw);
  const communication = objectOf(row["communication"]);
  const firstName = text(row["firstName"]);
  const lastName = text(row["lastName"]);
  return {
    id: readId(row),
    name: [firstName, lastName].filter(Boolean).join(" "),
    firstName,
    lastName,
    company: refOf(row["company"]),
    position: refOf(row["position"]),
    owner: refOf(row["owner"]),
    owners: userRefs(row["owners"]),
    emails: strings(communication["email"]),
    phones: [...strings(communication["phoneMobile"]), ...strings(communication["phoneLandline"])],
    tags: strings(row["tags"]),
    groups: refs(row["groups"]),
    source: refOf(row["source"]),
    description: textOrNull(row["description"]),
    visibility: text(row["visibility"]),
    lastActivity: textOrNull(row["lastActivity"]),
    createdAt: textOrNull(row["createdAt"]),
    updatedAt: textOrNull(row["updatedAt"]),
    addresses: addresses(row["addresses"]),
    customFields: customFields(row["additionalFields"]),
    url: text(row["url"]),
  };
}

function mapCompany(raw: unknown): CompanyV2 {
  const row = asObject(raw);
  const communication = objectOf(row["communication"]);
  return {
    id: readId(row),
    name: text(row["name"]),
    taxId: textOrNull(row["taxId"]),
    regon: textOrNull(row["regon"]),
    owner: refOf(row["owner"]),
    owners: userRefs(row["owners"]),
    emails: strings(communication["email"]),
    phones: [...strings(communication["phoneMobile"]), ...strings(communication["phoneLandline"])],
    websites: strings(communication["website"]),
    tags: strings(row["tags"]),
    groups: refs(row["groups"]),
    source: refOf(row["source"]),
    description: textOrNull(row["description"]),
    visibility: text(row["visibility"]),
    lastActivity: textOrNull(row["lastActivity"]),
    createdAt: textOrNull(row["createdAt"]),
    updatedAt: textOrNull(row["updatedAt"]),
    addresses: addresses(row["addresses"]),
    customFields: customFields(row["additionalFields"]),
    url: text(row["url"]),
  };
}

const REASON_FIELDS: Record<DealReasonKind, string> = {
  won: "wonReason",
  lost: "lostReason",
  outdated: "outdatedReason",
};

/**
 * The reason of the current status only. The API keeps `wonReason` on a deal
 * that was reopened or later lost; reporting it would describe a status the
 * deal no longer has.
 */
function dealReason(row: Row, status: string | null): DealReasonV2 | null {
  if (status !== "won" && status !== "lost" && status !== "outdated") return null;
  const reason = objectOf(row[REASON_FIELDS[status]]);
  const name = textOrNull(reason["name"]);
  if (name === null) return null;
  return { kind: status, name, note: textOrNull(reason["note"]) };
}

function mapDeal(raw: unknown): DealV2 {
  const row = asObject(raw);
  const budget = objectOf(row["budget"]);
  const status = textOrNull(row["status"]);
  return {
    id: readId(row),
    name: text(row["name"]),
    number: textOrNull(row["number"]),
    status,
    value: numberOrNull(budget["value"]),
    currency: textOrNull(budget["currency"]),
    process: refOf(row["process"]),
    stage: refOf(row["currentStage"]),
    owner: refOf(row["owner"]),
    owners: userRefs(row["owners"]),
    company: refOf(row["company"]),
    person: refOf(row["person"]),
    expectedCloseDate: textOrNull(row["expectedCloseDate"]),
    statusChangedAt: textOrNull(row["statusChangedAt"]),
    stageChangedAt: textOrNull(row["stageChangedAt"]),
    lastActivity: textOrNull(row["lastActivity"]),
    createdAt: textOrNull(row["createdAt"]),
    updatedAt: textOrNull(row["updatedAt"]),
    tags: strings(row["tags"]),
    groups: refs(row["groups"]),
    source: refOf(row["source"]),
    description: textOrNull(row["description"]),
    visibility: text(row["visibility"]),
    reason: dealReason(row, status),
    probability: null,
    customFields: customFields(row["additionalFields"]),
    url: text(row["url"]),
  };
}

function taskLinks(row: Row): TaskLink[] {
  const sources: [TaskLink["kind"], string][] = [
    ["person", "people"],
    ["company", "companies"],
    ["deal", "deals"],
  ];
  return sources.flatMap(([kind, key]) =>
    refs(row[key]).map((ref) => ({ kind, id: ref.id, name: ref.name })),
  );
}

function mapTask(raw: unknown): TaskV2 {
  const row = asObject(raw);
  const allDay = row["allDay"];
  return {
    id: readId(row),
    title: text(row["title"]),
    description: textOrNull(row["description"]),
    completed: row["completed"] === true,
    completedAt: textOrNull(row["completedAt"]),
    priority: row["priority"] === "high" ? "high" : "normal",
    dueType: text(row["dueType"]),
    startsAt: textOrNull(row["startsAt"]),
    endsAt: textOrNull(row["endsAt"]),
    allDay: typeof allDay === "boolean" ? allDay : null,
    type: refOf(row["type"]),
    status: refOf(row["status"]),
    private: row["private"] === true,
    recurring: row["recurring"] === true,
    assignees: userRefs(row["assignees"]),
    links: taskLinks(row),
    createdAt: textOrNull(row["createdAt"]),
    updatedAt: textOrNull(row["updatedAt"]),
    customFields: customFields(row["additionalFields"]),
    url: text(row["url"]),
  };
}

const MAPPERS: { [K in V2Kind]: (raw: unknown) => RecordV2Map[K] } = {
  person: mapPerson,
  company: mapCompany,
  deal: mapDeal,
  task: mapTask,
};

/** What the minimal media type sends, plus the names derived from it. */
const MINIMAL_FIELDS: { [K in V2Kind]: readonly (keyof RecordV2Map[K])[] } = {
  person: ["id", "name", "firstName", "lastName", "company", "visibility", "url"],
  company: ["id", "name", "visibility", "url"],
  deal: [
    "id",
    "name",
    "status",
    "process",
    "stage",
    "owner",
    "createdAt",
    "updatedAt",
    "visibility",
    "url",
  ],
  task: ["id", "title", "completed", "dueType", "startsAt", "allDay", "private", "url"],
};

/** Fields only `full` carries; `standard` is everything else. */
const FULL_ONLY_FIELDS: { [K in V2Kind]: readonly (keyof RecordV2Map[K])[] } = {
  person: ["owners", "groups", "source", "description", "addresses", "customFields"],
  company: ["regon", "owners", "groups", "source", "description", "addresses", "customFields"],
  deal: ["owners", "groups", "source", "description", "probability", "customFields"],
  task: ["description", "recurring", "createdAt", "customFields"],
};

/**
 * Cuts a record to a detail level. Fields outside the level are OMITTED, so a
 * delivered record is a subset of its shape, never the full shape with
 * blanks.
 */
export function projectRecord<K extends V2Kind>(
  kind: K,
  record: RecordV2Map[K],
  detail: DetailLevel,
): Partial<RecordV2Map[K]> {
  if (detail === "full") return { ...record };
  const source = record as unknown as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  if (detail === "minimal") {
    for (const field of MINIMAL_FIELDS[kind]) {
      projected[field as string] = source[field as string];
    }
    return projected as Partial<RecordV2Map[K]>;
  }
  const omitted = new Set<string>(FULL_ONLY_FIELDS[kind] as readonly string[]);
  for (const [field, value] of Object.entries(source)) {
    if (!omitted.has(field)) projected[field] = value;
  }
  return projected as Partial<RecordV2Map[K]>;
}

function mapPhraseHit(raw: unknown): PhraseHit | null {
  const row = asObject(raw);
  const kind = row["type"];
  // `space` and `user` hits come back with any scope; this server has no
  // record kind for them.
  if (typeof kind !== "string" || !PHRASE_KINDS.has(kind)) return null;
  const id = readId(row);
  const url = textOrNull(row["url"]);
  switch (kind as PhraseKind) {
    case "person":
      return {
        kind: "person",
        id,
        name: [text(row["firstName"]), text(row["lastName"])].filter(Boolean).join(" "),
        url,
        company: refOf(row["company"]),
      };
    case "company":
      return { kind: "company", id, name: text(row["name"]), url, taxId: textOrNull(row["tin"]) };
    case "deal":
      return {
        kind: "deal",
        id,
        name: text(row["name"]),
        url,
        status: textOrNull(row["status"]),
        company: refOf(row["company"]),
        person: refOf(row["person"]),
      };
    case "note": {
      // Note text is the most hostile content of the CRM: flattened here, in
      // the data layer, and cut short (docs/security.md par. 4).
      const flattened = stripHtml(row["content"]);
      const referer = objectOf(row["referer"]);
      const parent = refOf(referer);
      return {
        kind: "note",
        id,
        name: flattened.slice(0, PHRASE_TEXT_LIMIT),
        textTruncated: flattened.length > PHRASE_TEXT_LIMIT,
        url,
        createdAt: textOrNull(row["createdAt"]),
        parent: parent === null ? null : { kind: text(referer["type"]), ...parent },
      };
    }
  }
}

function mapProcess(raw: unknown): DealProcessV2 {
  const row = asObject(raw);
  const stages = asList(row["stages"]).map((rawStage) => {
    const stage = asObject(rawStage);
    const state = stage["state"];
    if (typeof state !== "string" || !STAGE_STATES.has(state)) throw unexpectedShape();
    return {
      id: readId(stage),
      name: text(stage["name"]),
      position: numberOrNull(stage["position"]) ?? 0,
      state: state as StageState,
      completedAt: textOrNull(stage["completedAt"]),
      steps: listOf(stage["steps"]).map((rawStep) => {
        const step = asObject(rawStep);
        return {
          id: readId(step),
          name: text(step["name"]),
          required: step["required"] === true,
          completed: step["completed"] === true,
        };
      }),
    };
  });
  stages.sort((a, b) => a.position - b.position);
  return {
    process: refOf(row["process"]),
    currentStage: refOf(row["currentStage"]),
    stages,
  };
}

function mapLine(raw: unknown): BudgetLineV2 {
  const row = asObject(raw);
  return {
    id: readId(row),
    product: refOf(row["product"]),
    quantity: numberOrNull(row["quantity"]),
    unitPrice: numberOrNull(row["unitPrice"]),
    value: numberOrNull(row["totalValue"]) ?? 0,
    currency: text(row["currency"]),
    forecast: row["isForecast"] === true,
    description: textOrNull(row["description"]),
  };
}

function moneyPair(value: unknown): MoneyPair {
  const row = objectOf(value);
  return {
    forecast: numberOrNull(row["forecast"]) ?? 0,
    executed: numberOrNull(row["executed"]) ?? 0,
  };
}

function totalOf(extra: Record<string, unknown>, fallback: number): number {
  const total = extra["totalCount"];
  return typeof total === "number" && Number.isInteger(total) && total >= 0 ? total : fallback;
}

function isNotFound(error: unknown): boolean {
  return error instanceof LivespaceError && error.code === "NOT_FOUND";
}

function assertPage(page: number, perPage: number, maxPerPage: number): void {
  if (!Number.isInteger(page) || page < 1) {
    throw new RangeError("A page number is a positive integer.");
  }
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > maxPerPage) {
    throw new RangeError(`A page size is an integer from 1 to ${maxPerPage}.`);
  }
}

export function createV2RecordReader(client: V2Requester): RecordReader {
  const callOptions = (opts: ReadOptions) => ({
    budget: opts.budget,
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  });

  return {
    async search(kind, query, opts) {
      // Every search names its page and page size (docs/security.md par. 3).
      assertPage(query.page, query.perPage, SEARCH_MAX_PER_PAGE);
      if (query.filter !== undefined) assertFilterLimits(query.filter);
      const response = await client.request<unknown>(
        {
          method: "POST",
          path: `/${COLLECTIONS[kind]}/searches`,
          body: {
            ...(query.filter === undefined ? {} : { filter: query.filter }),
            ...(query.sort === undefined ? {} : { sort: query.sort }),
            page: query.page,
            perPage: query.perPage,
          },
          accept: query.media,
        },
        // A search is a read sent as POST: it may retry like one.
        { ...callOptions(opts), write: false },
      );
      const items = asList(response.data).map(MAPPERS[kind]);
      return {
        items,
        totalCount: totalOf(response.extra, items.length),
        totalCountExact: response.extra["totalCountExact"] !== false,
      };
    },

    async phrase(query, opts) {
      const perPage = Math.min(query.perPage, PHRASE_MAX_PER_PAGE);
      assertPage(query.page, perPage, PHRASE_MAX_PER_PAGE);
      const response = await client.request<unknown>(
        {
          method: "GET",
          path: "/search",
          query: { q: query.q, types: [...query.kinds], page: query.page, perPage },
        },
        callOptions(opts),
      );
      const rows = asList(response.data);
      const hits = rows.flatMap((raw) => {
        const hit = mapPhraseHit(raw);
        return hit === null ? [] : [hit];
      });
      return { hits, totalCount: totalOf(response.extra, rows.length), rowCount: rows.length };
    },

    async get(kind, id, opts) {
      try {
        const response = await client.request<unknown>(
          {
            method: "GET",
            path: v2Path(`/${COLLECTIONS[kind]}/{}`, id),
            accept: opts.media ?? MEDIA_JSON,
          },
          callOptions(opts),
        );
        return MAPPERS[kind](response.data);
      } catch (error) {
        // The API answers the same 404 for "unknown" and "not visible".
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    async dealProcess(id, opts) {
      try {
        const response = await client.request<unknown>(
          { method: "GET", path: v2Path("/deals/{}/process", id) },
          callOptions(opts),
        );
        return mapProcess(response.data);
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    async dealLines(id, opts) {
      const response = await client.request<unknown>(
        {
          method: "GET",
          path: v2Path("/deals/{}/products", id),
          query: { page: 1, perPage: DEAL_LINE_PAGE },
        },
        callOptions(opts),
      );
      const lines = asList(response.data).map(mapLine);
      return { lines, totalCount: totalOf(response.extra, lines.length) };
    },

    async dealBudget(id, opts) {
      const response = await client.request<unknown>(
        { method: "GET", path: v2Path("/deals/{}/budget", id) },
        callOptions(opts),
      );
      if (response.data === null) return null;
      const row = asObject(response.data);
      return {
        currency: textOrNull(row["currency"]),
        revenue: moneyPair(row["revenue"]),
        cost: moneyPair(row["cost"]),
        margin: moneyPair(row["margin"]),
        quantity: moneyPair(row["quantity"]),
      };
    },
  };
}
