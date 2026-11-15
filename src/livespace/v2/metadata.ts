import { LivespaceError } from "../errors.js";
import type { CallBudget } from "./budget.js";
import type { LivespaceV2Client } from "./client.js";

/**
 * CRM dictionaries of API v2 behind `health` and `crm_metadata`.
 *
 * The shapes below were read live on a demo account (2026-11-15) and compared
 * with the vendor's draft contract. The API changed once without a
 * `meta.version` bump, so every mapper reads only the fields it needs, takes
 * a row without a string id as an unknown shape, and fails with fixed wording
 * instead of guessing (docs/security.md par. 6).
 */

type V2Requester = Pick<LivespaceV2Client, "request">;

export interface V2FetchOptions {
  signal?: AbortSignal;
  /** The tool call's request budget; every page spends from it. */
  budget?: CallBudget;
}

/** The integration user the API v2 key belongs to: never a person. */
export interface IntegrationUser {
  login: string;
  timeZone: string;
}

/** The human this server works for, from `LIVESPACE_ACTING_USER_EMAIL`. */
export interface ActingUser {
  id: string;
  name: string;
  email: string;
}

/**
 * `not_configured`: no e-mail is set. `not_found`: it matches no user the API
 * lists. `list_truncated`: no match among the users read, and the account has
 * more than the page cap lets through. `unknown`: the user list itself did
 * not load. Only `not_configured` and `not_found` mean "nobody".
 */
export type ActingUserState =
  | "resolved"
  | "not_configured"
  | "not_found"
  | "list_truncated"
  | "unknown";

export interface ActingUserLookup {
  state: ActingUserState;
  user: ActingUser | null;
}

// Fixed wording only: upstream content must never reach an error message
// (docs/security.md par. 6).
function unexpectedShape(): LivespaceError {
  return new LivespaceError(
    "UPSTREAM_ERROR",
    "Livespace API v2 returned an unexpected shape for this dictionary.",
    "Report it on the issue tracker; the API may have changed.",
  );
}

function asObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw unexpectedShape();
  }
  return value as Record<string, unknown>;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * `GET /users/me`. The live API answers camelCase (`timeZone`); the draft
 * contract says snake_case (`time_zone`). Both are read, so neither spelling
 * breaks the caller. `essential` is for `health` alone: it lets this one
 * request through when the daily reserve refuses everything else.
 */
export async function readIntegrationUser(
  client: V2Requester,
  opts: V2FetchOptions & { essential?: boolean } = {},
): Promise<IntegrationUser> {
  const response = await client.request<unknown>(
    { method: "GET", path: "/users/me" },
    {
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      ...(opts.budget === undefined ? {} : { budget: opts.budget }),
      ...(opts.essential === true ? { essential: true } : {}),
    },
  );
  const me = asObject(response.data);
  return {
    login: asText(me["login"]),
    timeZone: asText(me["timeZone"]) || asText(me["time_zone"]),
  };
}

/**
 * What to tell the model when no acting user is known. Fixed wording: it
 * names a variable and a tool, never a value (docs/security.md par. 1).
 */
export function actingUserHint(state: ActingUserState): string | undefined {
  switch (state) {
    case "resolved":
      return undefined;
    case "not_configured":
      return (
        "No acting user is configured. The API v2 key belongs to an integration " +
        "user, not a person: set LIVESPACE_ACTING_USER_EMAIL to the e-mail of the " +
        "Livespace user this server works for."
      );
    case "not_found":
      return (
        "LIVESPACE_ACTING_USER_EMAIL matches no user Livespace lists as a possible " +
        "record owner. Compare it with the users section of crm_metadata."
      );
    case "list_truncated":
      return (
        "The acting user could not be checked: the account has more users than " +
        "this server reads, and LIVESPACE_ACTING_USER_EMAIL matches none of those " +
        "it read."
      );
    case "unknown":
      return (
        "The acting user could not be checked because the user list did not load. " +
        "Retry later."
      );
  }
}

export const V2_METADATA_SECTIONS = [
  "processes",
  "users",
  "teams",
  "contactGroups",
  "dealGroups",
  "sources",
  "positions",
  "dealReasons",
  "tags",
  "currencies",
  "taskTypes",
  "taskStatuses",
  "customFields",
  "products",
  "currentUser",
] as const;

export type V2MetadataSection = (typeof V2_METADATA_SECTIONS)[number];

export interface IdName {
  id: string;
  name: string;
}

/**
 * A dictionary row. `selectable: false` marks a retired row: records still
 * reference it, a write no longer accepts it. An assignable row omits the key.
 */
export interface DictItem extends IdName {
  selectable?: false;
}

export interface StepConfig {
  id: string;
  name: string;
  description: string | null;
  /** The step's weight in the stage's progress bar. */
  weight: number;
  /** A required step blocks closing the deal as won while it is open. */
  required: boolean;
  /** What completing the step asks for. */
  requiredItem: "none" | "note" | "file";
  /** How many record fields the step binds. */
  boundFields: number;
}

export interface StageConfig {
  id: string;
  name: string;
  description: string | null;
  /** Planned days in the stage, null when the stage has no duration set. */
  durationDays: number | null;
  steps: StepConfig[];
}

export interface ProcessConfig {
  id: string;
  name: string;
  /** False for a process an administrator switched off. */
  selectable: boolean;
  isDefault: boolean;
  defaultLengthDays: number | null;
  productRequired: boolean;
  /** True when the process closes idle deals on its own. */
  autoclose: boolean;
  stages: StageConfig[];
}

export interface UserInfo extends IdName {
  email: string;
  /** The user's main team. */
  team: IdName | null;
}

export interface TreeItem extends DictItem {
  parentId: string | null;
}

export type ReasonKind = "won" | "lost" | "outdated";

export interface ReasonInfo extends DictItem {
  kind: ReasonKind;
}

export interface CurrencyInfo extends DictItem {
  isDefault: boolean;
}

export type CustomFieldKind = "person" | "company" | "deal" | "task";

export interface CustomFieldInfo {
  id: string;
  name: string;
  type: string;
  /** The name of the form group the field sits in. */
  group: string | null;
  required: boolean;
  readOnly: boolean;
  /** True for the field types a search filter accepts. */
  filterable: boolean;
  selectable?: false;
  /** Answers of a choice field: a write takes the option id, not its name. */
  options: IdName[];
  /** Present when the field has more options than `CUSTOM_FIELD_OPTION_CAP`. */
  optionsTruncated?: true;
}

export interface ProductInfo extends IdName {
  sku: string | null;
}

export interface CurrentUserV2 {
  integrationLogin: string;
  timeZone: string;
  /**
   * Filled in by the metadata service from the cached user dictionary: null
   * when nobody is configured or matched, absent when that could not be
   * checked.
   */
  actingUser?: ActingUser | null;
}

export interface V2SectionDataMap {
  processes: ProcessConfig[];
  users: UserInfo[];
  teams: TreeItem[];
  contactGroups: DictItem[];
  dealGroups: DictItem[];
  sources: TreeItem[];
  positions: DictItem[];
  dealReasons: ReasonInfo[];
  tags: string[];
  currencies: CurrencyInfo[];
  taskTypes: DictItem[];
  taskStatuses: DictItem[];
  customFields: Record<CustomFieldKind, CustomFieldInfo[]>;
  products: ProductInfo[];
  currentUser: CurrentUserV2;
}

/** A section's rows plus whether the page cap cut the list short. */
export interface Fetched<T> {
  data: T;
  truncated: boolean;
}

export type V2MetadataFetchers = {
  [S in V2MetadataSection]: (opts?: V2FetchOptions) => Promise<Fetched<V2SectionDataMap[S]>>;
};

/** The contract's largest page; every list request names it explicitly. */
export const DICTIONARY_PER_PAGE = 500;
/** 2000 rows: past that a dictionary is reported as truncated. */
export const DICTIONARY_MAX_PAGES = 4;
const PRODUCT_MAX_PAGES = 2;
/** Options kept per choice field; a longer list is cut and marked. */
export const CUSTOM_FIELD_OPTION_CAP = 200;

const PROCESS_PATH = "/sales-processes";
/** The deprecated route, with the same body, for accounts without the new one. */
const PROCESS_PATH_FALLBACK = "/dictionaries/processes";

const FILTERABLE_FIELD_TYPES: ReadonlySet<string> = new Set([
  "text",
  "textarea",
  "checkbox",
  "select",
  "radio",
  "multiselect",
  "multicheckbox",
]);

const REASON_KINDS: ReadonlySet<string> = new Set(["won", "lost", "outdated"]);
const REQUIRED_ITEMS: ReadonlySet<string> = new Set(["none", "note", "file"]);

const CUSTOM_FIELD_PATHS: Record<CustomFieldKind, string> = {
  person: "/dictionaries/people/fields",
  company: "/dictionaries/companies/fields",
  deal: "/dictionaries/deals/fields",
  task: "/dictionaries/tasks/fields",
};

function asList(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw unexpectedShape();
  return value;
}

/** An id is an opaque non-empty string; anything else is an unknown shape. */
function readId(row: Record<string, unknown>): string {
  const id = row["id"];
  if (typeof id !== "string" || id === "") throw unexpectedShape();
  return id;
}

function asTextOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function asInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/** `{id, name}` of an optional nested reference, null when absent. */
function asRef(value: unknown): IdName | null {
  if (value === null || value === undefined) return null;
  const ref = asObject(value);
  return { id: readId(ref), name: asText(ref["name"]) };
}

function retired(row: Record<string, unknown>): { selectable?: false } {
  return row["selectable"] === false ? { selectable: false } : {};
}

function mapDictItem(raw: unknown): DictItem {
  const row = asObject(raw);
  return { id: readId(row), name: asText(row["name"]), ...retired(row) };
}

function mapTreeItem(raw: unknown): TreeItem {
  const row = asObject(raw);
  return {
    id: readId(row),
    name: asText(row["name"]),
    parentId: asRef(row["parent"])?.id ?? null,
    ...retired(row),
  };
}

function mapUser(raw: unknown): UserInfo {
  const row = asObject(raw);
  return {
    id: readId(row),
    name: [asText(row["firstName"]), asText(row["lastName"])].filter(Boolean).join(" "),
    email: asText(row["email"]),
    team: asRef(row["team"]),
  };
}

function mapReason(raw: unknown): ReasonInfo {
  const row = asObject(raw);
  const kind = row["kind"];
  if (typeof kind !== "string" || !REASON_KINDS.has(kind)) throw unexpectedShape();
  return {
    id: readId(row),
    name: asText(row["name"]),
    kind: kind as ReasonKind,
    ...retired(row),
  };
}

function mapCustomField(raw: unknown): CustomFieldInfo {
  const row = asObject(raw);
  const type = asText(row["type"]);
  const options =
    row["options"] === null || row["options"] === undefined ? [] : asList(row["options"]);
  return {
    id: readId(row),
    name: asText(row["name"]),
    type,
    group: asRef(row["group"])?.name ?? null,
    required: row["required"] === true,
    readOnly: row["readOnly"] === true,
    filterable: FILTERABLE_FIELD_TYPES.has(type),
    ...retired(row),
    options: options.slice(0, CUSTOM_FIELD_OPTION_CAP).map((option) => {
      const item = asObject(option);
      return { id: readId(item), name: asText(item["name"]) };
    }),
    ...(options.length > CUSTOM_FIELD_OPTION_CAP ? { optionsTruncated: true as const } : {}),
  };
}

function mapProduct(raw: unknown): ProductInfo {
  const row = asObject(raw);
  return { id: readId(row), name: asText(row["name"]), sku: asTextOrNull(row["sku"]) };
}

/** Rows in their `sort` order; rows without one keep their place at the end. */
function bySort(rows: unknown[]): Record<string, unknown>[] {
  return rows
    .map((raw, index) => {
      const row = asObject(raw);
      return { row, index, sort: asInteger(row["sort"]) ?? Number.MAX_SAFE_INTEGER };
    })
    .sort((a, b) => a.sort - b.sort || a.index - b.index)
    .map((entry) => entry.row);
}

function mapStep(row: Record<string, unknown>): StepConfig {
  const mandatory =
    row["mandatory"] === null || row["mandatory"] === undefined
      ? {}
      : asObject(row["mandatory"]);
  const item = mandatory["item"];
  const bindings = row["fieldBindings"];
  return {
    id: readId(row),
    name: asText(row["name"]),
    description: asTextOrNull(row["description"]),
    weight: asInteger(row["scales"]) ?? 0,
    required: mandatory["required"] === true,
    requiredItem:
      typeof item === "string" && REQUIRED_ITEMS.has(item)
        ? (item as StepConfig["requiredItem"])
        : "none",
    boundFields: Array.isArray(bindings) ? bindings.length : 0,
  };
}

function mapStage(row: Record<string, unknown>): StageConfig {
  const duration =
    row["duration"] === null || row["duration"] === undefined ? {} : asObject(row["duration"]);
  return {
    id: readId(row),
    name: asText(row["name"]),
    description: asTextOrNull(row["description"]),
    durationDays: duration["enabled"] === true ? asInteger(duration["days"]) : null,
    steps: bySort(asList(row["steps"])).map(mapStep),
  };
}

function mapProcess(raw: unknown): ProcessConfig {
  const row = asObject(raw);
  const settings =
    row["settings"] === null || row["settings"] === undefined ? {} : asObject(row["settings"]);
  const autoclose = settings["autoclose"];
  return {
    id: readId(row),
    name: asText(row["name"]),
    selectable: row["selectable"] !== false,
    isDefault: row["isDefault"] === true,
    defaultLengthDays: asInteger(settings["defaultLengthDays"]),
    productRequired: settings["productRequired"] === true,
    autoclose: autoclose !== null && autoclose !== undefined,
    stages: bySort(asList(row["stages"])).map(mapStage),
  };
}

/** Exact, case-insensitive e-mail match; a user without an e-mail never matches. */
export function findActingUser(
  users: readonly UserInfo[],
  email: string,
): ActingUser | null {
  const wanted = email.trim().toLowerCase();
  if (wanted === "") return null;
  const match = users.find((user) => user.email.toLowerCase() === wanted);
  return match === undefined ? null : { id: match.id, name: match.name, email: match.email };
}

export function createV2MetadataFetchers(client: V2Requester): V2MetadataFetchers {
  const callOptions = (opts: V2FetchOptions | undefined) => ({
    ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
    ...(opts?.budget === undefined ? {} : { budget: opts.budget }),
  });

  /**
   * Reads a list page by page with an explicit `perPage` and a hard page cap
   * (docs/security.md par. 3). `truncated` is true when rows remain past the
   * cap, or when a page came back empty before the announced total.
   */
  async function readPages(
    fetchPage: (page: number) => Promise<{ data: unknown; extra: Record<string, unknown> }>,
    maxPages: number,
  ): Promise<Fetched<unknown[]>> {
    const rows: unknown[] = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const response = await fetchPage(page);
      const pageRows = asList(response.data);
      rows.push(...pageRows);
      const total = response.extra["totalCount"];
      // Rows read against the announced total; without a total, a full page
      // is the only sign that another one follows.
      const more =
        typeof total === "number"
          ? rows.length < total
          : pageRows.length >= DICTIONARY_PER_PAGE;
      if (!more) return { data: rows, truncated: false };
      if (pageRows.length === 0) break;
    }
    return { data: rows, truncated: true };
  }

  function list(
    path: string,
    opts: V2FetchOptions | undefined,
    maxPages = DICTIONARY_MAX_PAGES,
  ): Promise<Fetched<unknown[]>> {
    return readPages(
      (page) =>
        client.request<unknown>(
          { method: "GET", path, query: { page, perPage: DICTIONARY_PER_PAGE } },
          callOptions(opts),
        ),
      maxPages,
    );
  }

  async function mapped<T>(
    path: string,
    map: (raw: unknown) => T,
    opts: V2FetchOptions | undefined,
    maxPages = DICTIONARY_MAX_PAGES,
  ): Promise<Fetched<T[]>> {
    const { data, truncated } = await list(path, opts, maxPages);
    return { data: data.map(map), truncated };
  }

  // `/sales-processes` is the current route. An account that does not have it
  // yet answers 404, and the deprecated dictionary route carries the same
  // body. Whichever route answered last is tried first; a 404 on it tries the
  // other one, and only a route that answered is remembered.
  let processPath = PROCESS_PATH;

  return {
    processes: async (opts) => {
      const first = processPath;
      try {
        return await mapped(first, mapProcess, opts);
      } catch (error) {
        if (!(error instanceof LivespaceError) || error.code !== "NOT_FOUND") throw error;
        const other = first === PROCESS_PATH ? PROCESS_PATH_FALLBACK : PROCESS_PATH;
        const result = await mapped(other, mapProcess, opts);
        processPath = other;
        return result;
      }
    },
    users: (opts) => mapped("/users", mapUser, opts),
    teams: (opts) => mapped("/dictionaries/teams", mapTreeItem, opts),
    contactGroups: (opts) => mapped("/dictionaries/person-groups", mapDictItem, opts),
    dealGroups: (opts) => mapped("/dictionaries/deal-groups", mapDictItem, opts),
    sources: (opts) => mapped("/dictionaries/sources", mapTreeItem, opts),
    positions: (opts) => mapped("/dictionaries/positions", mapDictItem, opts),
    dealReasons: (opts) => mapped("/dictionaries/deal-reasons", mapReason, opts),
    // One page: a tag is a bare name with no id, so 500 of them is already
    // more than a model can use, and a longer catalog says so.
    tags: (opts) =>
      mapped(
        "/dictionaries/tags",
        (raw) => {
          if (typeof raw !== "string") throw unexpectedShape();
          return raw;
        },
        opts,
        1,
      ),
    // The catalog lists every ISO currency; only the ones an administrator
    // switched on are accepted on a deal, so the rest are left out.
    currencies: async (opts) => {
      const { data, truncated } = await list("/dictionaries/currencies", opts);
      const currencies: CurrencyInfo[] = [];
      for (const raw of data) {
        const row = asObject(raw);
        const isDefault = row["default"] === true;
        const id = readId(row);
        if (row["selectable"] === false && !isDefault) continue;
        currencies.push({ id, name: asText(row["name"]), isDefault, ...retired(row) });
      }
      return { data: currencies, truncated };
    },
    taskTypes: (opts) => mapped("/dictionaries/task-types", mapDictItem, opts),
    taskStatuses: (opts) => mapped("/dictionaries/task-statuses", mapDictItem, opts),
    customFields: async (opts) => {
      const kinds = Object.keys(CUSTOM_FIELD_PATHS) as CustomFieldKind[];
      const lists = await Promise.all(
        kinds.map((kind) => mapped(CUSTOM_FIELD_PATHS[kind], mapCustomField, opts)),
      );
      const data = { person: [], company: [], deal: [], task: [] } as Record<
        CustomFieldKind,
        CustomFieldInfo[]
      >;
      kinds.forEach((kind, index) => {
        data[kind] = lists[index]?.data ?? [];
      });
      return { data, truncated: lists.some((entry) => entry.truncated) };
    },
    products: async (opts) => {
      const { data, truncated } = await readPages(
        (page) =>
          client.request<unknown>(
            {
              method: "POST",
              path: "/products/searches",
              body: { page, perPage: DICTIONARY_PER_PAGE },
            },
            // A search is a read sent as POST: it may retry like one.
            { ...callOptions(opts), write: false },
          ),
        PRODUCT_MAX_PAGES,
      );
      return { data: data.map(mapProduct), truncated };
    },
    currentUser: async (opts) => {
      const me = await readIntegrationUser(client, opts);
      return {
        data: { integrationLogin: me.login, timeZone: me.timeZone },
        truncated: false,
      };
    },
  };
}
