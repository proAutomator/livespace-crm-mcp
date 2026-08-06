import { LivespaceError } from "./errors.js";

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

// Fixed wording only: upstream content must never reach an error message
// (docs/security.md par. 6).
function unexpectedShape(): LivespaceError {
  return new LivespaceError(
    "UPSTREAM_ERROR",
    "Livespace returned an unexpected shape for this record.",
    "Report it on the issue tracker; the API may have changed.",
  );
}

export function asName(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** PHP serializes empty maps as `[]`, so an array is never a record here. */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
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
  if (id === null) throw unexpectedShape();
  return id;
}

/** Upstream booleans arrive as `true`, `1` or `"1"` depending on the endpoint. */
function asBool(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

function asCount(value: unknown): number {
  const count = Number(value);
  return Number.isFinite(count) ? count : 0;
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
  if (data === null) throw unexpectedShape();
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
