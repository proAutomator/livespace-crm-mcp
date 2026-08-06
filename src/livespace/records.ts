import type { LivespaceClient } from "./client.js";
import { LivespaceError } from "./errors.js";
import {
  asBool,
  asCount,
  asName,
  asRecord,
  unexpectedShape,
  unwrapList,
} from "./shape.js";

/**
 * Record shapes behind the read tools, plus the mappers that turn raw Livespace
 * payloads into them.
 *
 * Three rules shape this module:
 *
 * 1. Mappers ALWAYS produce the FULL record. Sorting happens on real values, so
 *    the `detail` cut is a separate projection applied after sorting/slicing
 *    (`projectRecord`).
 * 2. Empty conventions are uniform: string -> `""`, array -> `[]`, nullable ->
 *    `null`, boolean -> `false`, number -> `0`. Projected-away fields take those
 *    same values, so the record shape never changes with `detail`.
 * 3. Ids are opaque strings read from `raw.id`. Contact/Deal payloads also carry
 *    `contact_id`/`company_id`/`deal_id`, which are NOT the record id.
 *
 * Field names come from live probes on a sandbox account (2026-08-06), recorded
 * in the M4 plan doc. No caching happens here - record data is never cached
 * (docs/security.md par. 8).
 */

export const RECORD_KINDS = ["person", "company", "deal", "task"] as const;

export type RecordKind = (typeof RECORD_KINDS)[number];

export type DetailLevel = "minimal" | "standard" | "full";

/** Tool arguments name kinds in the plural; the record layer uses the singular. */
export const ARG_KIND_TO_RECORD_KIND = {
  persons: "person",
  companies: "company",
  deals: "deal",
  tasks: "task",
} as const;

/** Tasks have no Contact-style `type` param, so they are absent here. */
export const RECORD_KIND_TO_UPSTREAM_TYPE = {
  person: "contact",
  company: "company",
  deal: "deal",
} as const;

export interface DealCount {
  all: number;
  open: number;
  won: number;
  lost: number;
}

export interface PersonRecord {
  id: string;
  name: string;
  email: string;
  phone: string;
  companyName: string;
  companyId: string | null;
  ownerName: string;
  ownerId: string | null;
  tags: string[];
  source: string;
  note: string;
  created: string;
  modified: string;
  lastActiveDate: string;
  dealCount: DealCount | null;
  cell: string;
  www: string;
  address: string;
  groups: string[];
}

export interface CompanyRecord {
  id: string;
  name: string;
  nip: string;
  email: string;
  phone: string;
  ownerName: string;
  ownerId: string | null;
  tags: string[];
  source: string;
  note: string;
  created: string;
  modified: string;
  dealCount: DealCount | null;
  www: string;
  address: string;
  groups: string[];
}

export interface DealRecord {
  id: string;
  name: string;
  status: string;
  value: number | null;
  currency: string;
  probability: number | null;
  processId: string;
  processName: string;
  stageId: string;
  stageName: string;
  substageId: string;
  substageName: string;
  companyId: string | null;
  companyName: string;
  contactId: string | null;
  contactName: string;
  ownerId: string | null;
  ownerName: string;
  dateEnd: string;
  created: string;
  modified: string;
  lastActiveDate: string;
  tags: string[];
  source: string;
  note: string;
  groups: string[];
  creatorName: string;
  statusChangeDate: string;
}

export interface LinkedRecord {
  kind: string;
  id: string;
  name: string;
}

export interface TaskRecord {
  id: string;
  title: string;
  description: string;
  typeId: string;
  typeName: string;
  statusId: string | null;
  statusName: string;
  isCompleted: boolean;
  isPrivate: boolean;
  priority: number;
  dateFrom: string;
  dateTo: string;
  isAllDay: boolean;
  linkedRecords: LinkedRecord[];
  created: string;
  modified: string;
}

export interface RecordDataMap {
  person: PersonRecord;
  company: CompanyRecord;
  deal: DealRecord;
  task: TaskRecord;
}

/** Every shape failure in this module speaks about a record. */
function badShape(): LivespaceError {
  return unexpectedShape("record");
}

/**
 * Ids are opaque strings - their shape is never validated. `null`, `undefined`,
 * an empty string and any object all mean "no id".
 */
function optionalId(value: unknown): string | null {
  if (value === null || value === undefined || typeof value === "object") return null;
  const id = String(value);
  return id === "" ? null : id;
}

function idText(value: unknown): string {
  return optionalId(value) ?? "";
}

function requiredId(data: Record<string, unknown>): string {
  const id = optionalId(data["id"]);
  if (id === null) throw badShape();
  return id;
}

/**
 * Livespace sends decimals as strings with a Polish comma and space-grouped
 * thousands (`"1 234,50"`). Numbers pass through; anything unparseable is
 * `null` so callers can tell "not filled in" from a real zero.
 */
export function parseCommaDecimal(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\s/gu, "").replaceAll(",", ".");
  if (cleaned === "") return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Tags and groups come as plain strings or as objects carrying `name`. */
function mapNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      if (entry) names.push(entry);
      continue;
    }
    const record = asRecord(entry);
    if (record === null) continue;
    const name = asName(record["name"]);
    if (name) names.push(name);
  }
  return names;
}

function mapDealCount(value: unknown): DealCount | null {
  const counts = asRecord(value);
  if (counts === null) return null;
  return {
    all: asCount(counts["all"]),
    open: asCount(counts["open"]),
    won: asCount(counts["won"]),
    lost: asCount(counts["lost"]),
  };
}

const ADDRESS_PARTS = ["street", "street2", "city", "postcode"] as const;

/**
 * Addresses arrive either as flat `address_*` keys (the simple list shape) or
 * inside an `addresses` array on the richer getAll/get shape. Both flatten to
 * one line; empty parts are skipped.
 */
function mapAddress(data: Record<string, unknown>): string {
  const addresses = data["addresses"];
  const first = Array.isArray(addresses) ? asRecord(addresses[0]) : null;
  const parts: string[] = [];
  for (const part of ADDRESS_PARTS) {
    const value = asName(data[`address_${part}`]) || asName(first?.[part]);
    if (value) parts.push(value);
  }
  return parts.join(", ");
}

/** `role_*` keys are dynamic and carry no record link - only `objects` does. */
function mapLinkedRecords(value: unknown): LinkedRecord[] {
  if (!Array.isArray(value)) return [];
  const linked: LinkedRecord[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (record === null) continue;
    const id = optionalId(record["object_id"]);
    if (id === null) continue;
    linked.push({
      kind: asName(record["object_type"]),
      id,
      name: asName(record["object_name"]),
    });
  }
  return linked;
}

function asMappable(raw: unknown): Record<string, unknown> {
  const data = asRecord(raw);
  if (data === null) throw badShape();
  return data;
}

export function mapPerson(raw: unknown): PersonRecord {
  const data = asMappable(raw);
  return {
    id: requiredId(data),
    name: asName(data["name"]),
    email: asName(data["email"]),
    phone: asName(data["phone"]),
    // `company_name` on the simple shape, `company` on the full one.
    companyName: asName(data["company_name"]) || asName(data["company"]),
    companyId: optionalId(data["company_id"]),
    ownerName: asName(data["owner_name"]),
    ownerId: optionalId(data["owner_id"]),
    tags: mapNames(data["tags"]),
    source: asName(data["source_name"]),
    note: asName(data["note"]),
    created: asName(data["created"]),
    modified: asName(data["modified"]),
    lastActiveDate: asName(data["last_active_date"]),
    dealCount: mapDealCount(data["deal_count"]),
    cell: asName(data["cell"]),
    www: asName(data["www"]),
    address: mapAddress(data),
    groups: mapNames(data["groups"]),
  };
}

export function mapCompany(raw: unknown): CompanyRecord {
  const data = asMappable(raw);
  return {
    id: requiredId(data),
    name: asName(data["name"]),
    nip: asName(data["nip"]),
    email: asName(data["email"]),
    phone: asName(data["phone"]),
    ownerName: asName(data["owner_name"]),
    ownerId: optionalId(data["owner_id"]),
    tags: mapNames(data["tags"]),
    source: asName(data["source_name"]),
    note: asName(data["note"]),
    created: asName(data["created"]),
    modified: asName(data["modified"]),
    dealCount: mapDealCount(data["deal_count"]),
    www: asName(data["www"]),
    address: mapAddress(data),
    groups: mapNames(data["groups"]),
  };
}

export function mapDeal(raw: unknown): DealRecord {
  const data = asMappable(raw);
  return {
    id: requiredId(data),
    name: asName(data["name"]),
    // The item-level `status` carries the same labels the filter accepts:
    // "open" | "won" | "lost".
    status: asName(data["status"]),
    value: parseCommaDecimal(data["value"]),
    currency: asName(data["currency"]),
    probability: parseCommaDecimal(data["probability"]),
    processId: idText(data["process_id"]),
    processName: asName(data["process_name"]),
    stageId: idText(data["stage_id"]),
    stageName: asName(data["stage_name"]),
    substageId: idText(data["substage_id"]),
    substageName: asName(data["substage_name"]),
    companyId: optionalId(data["company_id"]),
    companyName: asName(data["company_name"]),
    contactId: optionalId(data["contact_id"]),
    contactName: asName(data["contact_name"]),
    ownerId: optionalId(data["owner_id"]),
    ownerName: asName(data["owner_name"]),
    dateEnd: asName(data["date_end"]),
    created: asName(data["created"]),
    modified: asName(data["modified"]),
    lastActiveDate: asName(data["last_active_date"]),
    tags: mapNames(data["tags"]),
    source: asName(data["source_name"]),
    note: asName(data["note"]),
    groups: mapNames(data["groups"]),
    creatorName: asName(data["creator_name"]),
    statusChangeDate: asName(data["status_change_date"]),
  };
}

export function mapTask(raw: unknown): TaskRecord {
  const data = asMappable(raw);
  return {
    id: requiredId(data),
    title: asName(data["title"]),
    description: asName(data["description"]),
    typeId: idText(data["type_id"]),
    typeName: asName(data["type_name"]),
    statusId: optionalId(data["status_id"]),
    statusName: asName(data["status_name"]),
    isCompleted: asBool(data["is_completed"]),
    isPrivate: asBool(data["is_private"]),
    priority: asCount(data["priority"]),
    dateFrom: asName(data["date_from"]),
    dateTo: asName(data["date_to"]),
    isAllDay: asBool(data["is_all_day"]),
    linkedRecords: mapLinkedRecords(data["objects"]),
    created: asName(data["created"]),
    modified: asName(data["modified"]),
  };
}

const EMPTY_PERSON: PersonRecord = {
  id: "",
  name: "",
  email: "",
  phone: "",
  companyName: "",
  companyId: null,
  ownerName: "",
  ownerId: null,
  tags: [],
  source: "",
  note: "",
  created: "",
  modified: "",
  lastActiveDate: "",
  dealCount: null,
  cell: "",
  www: "",
  address: "",
  groups: [],
};

const EMPTY_COMPANY: CompanyRecord = {
  id: "",
  name: "",
  nip: "",
  email: "",
  phone: "",
  ownerName: "",
  ownerId: null,
  tags: [],
  source: "",
  note: "",
  created: "",
  modified: "",
  dealCount: null,
  www: "",
  address: "",
  groups: [],
};

const EMPTY_DEAL: DealRecord = {
  id: "",
  name: "",
  status: "",
  value: null,
  currency: "",
  probability: null,
  processId: "",
  processName: "",
  stageId: "",
  stageName: "",
  substageId: "",
  substageName: "",
  companyId: null,
  companyName: "",
  contactId: null,
  contactName: "",
  ownerId: null,
  ownerName: "",
  dateEnd: "",
  created: "",
  modified: "",
  lastActiveDate: "",
  tags: [],
  source: "",
  note: "",
  groups: [],
  creatorName: "",
  statusChangeDate: "",
};

const EMPTY_TASK: TaskRecord = {
  id: "",
  title: "",
  description: "",
  typeId: "",
  typeName: "",
  statusId: null,
  statusName: "",
  isCompleted: false,
  isPrivate: false,
  priority: 0,
  dateFrom: "",
  dateTo: "",
  isAllDay: false,
  linkedRecords: [],
  created: "",
  modified: "",
};

/** A fresh empty record per kind; arrays must never be shared between results. */
function emptyRecord(kind: RecordKind): Record<string, unknown> {
  switch (kind) {
    case "person":
      return { ...EMPTY_PERSON, tags: [], groups: [] };
    case "company":
      return { ...EMPTY_COMPANY, tags: [], groups: [] };
    case "deal":
      return { ...EMPTY_DEAL, tags: [], groups: [] };
    case "task":
      return { ...EMPTY_TASK, linkedRecords: [] };
  }
}

const MINIMAL_FIELDS: Record<RecordKind, readonly string[]> = {
  person: ["id", "name", "email", "companyName"],
  company: ["id", "name", "nip", "email"],
  deal: ["id", "name", "status", "value", "currency", "stageName", "ownerName"],
  task: ["id", "title", "typeName", "isCompleted", "dateFrom"],
};

/** `standard` is the full record minus these. Tasks are slim enough already. */
const STANDARD_OMITTED: Record<RecordKind, readonly string[]> = {
  person: ["cell", "www", "address", "groups"],
  company: ["www", "address", "groups"],
  deal: ["groups", "creatorName", "statusChangeDate"],
  task: [],
};

/**
 * Cuts a full record down to a detail level. Applied AFTER sorting and slicing:
 * sorting on projected records would sort empty strings.
 */
export function projectRecord<K extends RecordKind>(
  kind: K,
  record: RecordDataMap[K],
  detail: DetailLevel,
): RecordDataMap[K] {
  if (detail === "full") return { ...record };
  const source = record as unknown as Record<string, unknown>;
  const projected = emptyRecord(kind);
  if (detail === "minimal") {
    for (const field of MINIMAL_FIELDS[kind]) projected[field] = source[field];
    return projected as unknown as RecordDataMap[K];
  }
  const omitted = new Set(STANDARD_OMITTED[kind]);
  for (const [field, value] of Object.entries(source)) {
    if (!omitted.has(field)) projected[field] = value;
  }
  return projected as unknown as RecordDataMap[K];
}

/**
 * One upstream page. Livespace reports no totals anywhere, so `hasMore` is a
 * heuristic over `rawCount` - the number of rows upstream actually returned,
 * counted BEFORE idless rows are dropped and before the defensive slice. Using
 * the mapped item count instead would silently end pagination early.
 */
export interface ListPage<T> {
  items: T[];
  hasMore: boolean;
  rawCount: number;
}

/** `Search/getResult` returns pointers, not records: id, name and two labels. */
export interface SearchHit {
  id: string;
  name: string;
  description: string;
  modified: string;
}

export interface ListOptions {
  limit: number;
  offset: number;
  namesLike?: string;
  signal?: AbortSignal;
}

export interface DealListOptions extends ListOptions {
  status?: "open" | "won" | "lost" | "all";
  processId?: string;
  stageId?: string;
  ownerLogin?: string;
  modifiedFrom?: string;
}

export interface TaskListOptions {
  page: number;
  completed?: boolean;
  dateFrom?: string;
  dateTo?: string;
  signal?: AbortSignal;
}

export interface SearchOptions {
  q: string;
  kind: "person" | "company" | "deal";
  limit: number;
  signal?: AbortSignal;
}

export interface RecordFetchers {
  listPersons(opts: ListOptions): Promise<ListPage<PersonRecord>>;
  listCompanies(opts: ListOptions): Promise<ListPage<CompanyRecord>>;
  listDeals(opts: DealListOptions): Promise<ListPage<DealRecord>>;
  listTasks(opts: TaskListOptions): Promise<ListPage<TaskRecord>>;
  searchPhrase(opts: SearchOptions): Promise<{ hits: SearchHit[]; rawCount: number }>;
  getRecord<K extends RecordKind>(
    kind: K,
    id: string,
    opts?: { signal?: AbortSignal },
  ): Promise<RecordDataMap[K] | null>;
}

/**
 * `Todo/getTodoObjects` has NO limit parameter - it always returns exactly 50
 * rows per page, so the page number is the only load control there (probe
 * 2026-08-06; docs/security.md par. 3). Every other list/search call sends an
 * explicit `limit`.
 */
const TASK_PAGE_SIZE = 50;

const TASK_WRAPPER_KEY = "todo";

const RECORD_MAPPERS: { [K in RecordKind]: (raw: unknown) => RecordDataMap[K] } = {
  person: mapPerson,
  company: mapCompany,
  deal: mapDeal,
  task: mapTask,
};

function hasId(raw: unknown): boolean {
  const data = asRecord(raw);
  return data !== null && optionalId(data["id"]) !== null;
}

/**
 * Idless rows are dropped instead of failing the whole page, but they still
 * count towards `rawCount`. The `slice` is defensive: an endpoint that ignores
 * the limit we sent must never blow up a page (M3 lesson).
 *
 * Slice BEFORE filtering, never after. The tools advance their cursor by the
 * window they asked for, so a row promoted into the window by a dropped
 * neighbour would be delivered twice - here and at the top of the next page.
 */
function toListPage<T>(
  payload: unknown,
  keys: readonly string[],
  limit: number,
  map: (raw: unknown) => T,
): ListPage<T> {
  const raw = unwrapList(payload, keys, badShape);
  const rawCount = raw.length;
  const page = raw.slice(0, limit).filter(hasId);
  return { items: page.map(map), hasMore: rawCount >= limit, rawCount };
}

function mapSearchHit(raw: unknown): SearchHit | null {
  const data = asRecord(raw);
  if (data === null) return null;
  const id = optionalId(data["id"]);
  if (id === null) return null;
  return {
    id,
    name: asName(data["name"]),
    description: asName(data["description"]),
    modified: asName(data["modified"]),
  };
}

/**
 * Payloads are keyed by the type that was asked for - `{contact: ...}` for
 * `type: "contact"`, `{deal: ...}` for deals - and lists and single records
 * follow the same naming. Only the contact form was probed live, so companies
 * accept the contact key as a fallback: the request already named the type, so
 * whatever comes back under either key IS the company data. Persons list no
 * fallback, which keeps a company payload from reading as a person one.
 */
const WRAPPER_KEYS: Record<RecordKind, readonly string[]> = {
  person: ["contact"],
  company: ["company", "contact"],
  deal: ["deal"],
  task: [TASK_WRAPPER_KEY],
};

function unwrapRecord(payload: unknown, kind: RecordKind): unknown {
  const data = asRecord(payload);
  if (data === null) return payload;
  for (const key of WRAPPER_KEYS[kind]) {
    // Only a plain object counts as a wrapper, so a key holding something else
    // does not cut the fallback chain short.
    const inner = asRecord(data[key]);
    if (inner !== null) return inner;
  }
  return payload;
}

function getEndpoint(
  kind: RecordKind,
  id: string,
): { module: string; method: string; params: Record<string, unknown> } {
  if (kind === "deal") return { module: "Deal", method: "get", params: { id } };
  if (kind === "task") return { module: "Todo", method: "get", params: { id } };
  return {
    module: "Contact",
    method: "get",
    params: { type: RECORD_KIND_TO_UPSTREAM_TYPE[kind], id },
  };
}

/**
 * Upstream has no empty-payload not-found: a bogus id fails with 540 on
 * contacts and 550 on deals and tasks (probe evidence 11). Livespace itself
 * conflates "does not exist" with "the key's user cannot see it", so a get by
 * id maps both codes to `null` and the tool layer reports that ambiguity.
 */
function isNotFoundOnGet(error: unknown): boolean {
  return (
    error instanceof LivespaceError &&
    (error.resultCode === 540 || error.resultCode === 550)
  );
}

export function createRecordFetchers(
  client: Pick<LivespaceClient, "call">,
): RecordFetchers {
  const call = (
    module: string,
    method: string,
    params: Record<string, unknown>,
    opts?: { signal?: AbortSignal },
  ): Promise<unknown> => client.call(module, method, params, { signal: opts?.signal });

  const listContacts = async <K extends "person" | "company">(
    kind: K,
    opts: ListOptions,
  ): Promise<ListPage<RecordDataMap[K]>> => {
    const type = RECORD_KIND_TO_UPSTREAM_TYPE[kind];
    const params: Record<string, unknown> = {
      type,
      limit: opts.limit,
      offset: opts.offset,
    };
    if (opts.namesLike !== undefined) {
      params["names"] = opts.namesLike;
      params["condition"] = "like";
    }
    const payload = await call("Contact", "getAll", params, opts);
    return toListPage(payload, WRAPPER_KEYS[kind], opts.limit, RECORD_MAPPERS[kind]);
  };

  return {
    listPersons: (opts) => listContacts("person", opts),
    listCompanies: (opts) => listContacts("company", opts),

    listDeals: async (opts) => {
      const params: Record<string, unknown> = {
        // `Deal/getAll` needs at least one condition; the status label is it.
        status: opts.status ?? "open",
        limit: opts.limit,
        offset: opts.offset,
      };
      if (opts.processId !== undefined) params["processes"] = opts.processId;
      if (opts.stageId !== undefined) params["stages"] = opts.stageId;
      if (opts.ownerLogin !== undefined) params["owner_login"] = opts.ownerLogin;
      if (opts.modifiedFrom !== undefined) params["modified"] = opts.modifiedFrom;
      if (opts.namesLike !== undefined) params["names"] = opts.namesLike;
      const payload = await call("Deal", "getAll", params, opts);
      return toListPage(payload, WRAPPER_KEYS["deal"], opts.limit, mapDeal);
    },

    listTasks: async (opts) => {
      // Stringly-typed params, and no limit to send - see TASK_PAGE_SIZE.
      const todo: Record<string, unknown> = {
        getWholeList: "0",
        page: String(opts.page),
      };
      if (opts.completed !== undefined) todo["isCompleted"] = opts.completed ? "1" : "0";
      const datesPeriod: Record<string, string> = {};
      if (opts.dateFrom !== undefined) datesPeriod["from"] = opts.dateFrom;
      if (opts.dateTo !== undefined) datesPeriod["to"] = opts.dateTo;
      if (Object.keys(datesPeriod).length > 0) todo["datesPeriod"] = datesPeriod;
      const payload = await call("Todo", "getTodoObjects", { todo }, opts);
      return toListPage(payload, WRAPPER_KEYS["task"], TASK_PAGE_SIZE, mapTask);
    },

    searchPhrase: async (opts) => {
      const objectType = RECORD_KIND_TO_UPSTREAM_TYPE[opts.kind];
      const payload = await call(
        "Search",
        "getResult",
        { q: opts.q, object_type: objectType, limit: opts.limit },
        opts,
      );
      // Search hits carry no fallback key: the wrapper here is the object type
      // that was searched for, and that form was probed for all three.
      const raw = unwrapList(payload, [objectType], badShape);
      const hits = raw
        .map(mapSearchHit)
        .filter((hit): hit is SearchHit => hit !== null)
        .slice(0, opts.limit);
      return { hits, rawCount: raw.length };
    },

    getRecord: async (kind, id, opts) => {
      const endpoint = getEndpoint(kind, id);
      try {
        const payload = await call(
          endpoint.module,
          endpoint.method,
          endpoint.params,
          opts,
        );
        return RECORD_MAPPERS[kind](unwrapRecord(payload, kind));
      } catch (error) {
        if (isNotFoundOnGet(error)) return null;
        throw error;
      }
    },
  };
}
