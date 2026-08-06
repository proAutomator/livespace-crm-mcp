import type { LivespaceClient } from "./client.js";
import { LivespaceError } from "./errors.js";

/**
 * Slim CRM dictionaries behind the `crm_metadata` tool.
 *
 * Two upstream traps shape every mapper here:
 *
 * 1. PHP serializes empty maps as `[]`, at every nesting level, so a record
 *    read must normalize `[]`, `null` and absent to an empty record first.
 * 2. Upstream emission order IS the workflow order shown in the Livespace UI
 *    (pipeline stages, checkbox steps, task statuses). Never sort - ids are
 *    UUID-style strings, so JS object key order stays insertion order.
 *
 * Probe evidence (2026-08-06, sandbox): `Default/User_getAll` and
 * `Deal/product_getAll` returned the full list even with `{limit: 2}` - these
 * dictionary endpoints IGNORE `limit`, so no upstream limit is possible. The
 * load protection is the tool-level per-section item cap, not a call parameter
 * (docs/security.md par. 3).
 */

export const METADATA_SECTIONS = [
  "processes",
  "users",
  "contactGroups",
  "dealGroups",
  "sources",
  "taskTypes",
  "taskStatuses",
  "products",
  "currentUser",
] as const;

export type MetadataSection = (typeof METADATA_SECTIONS)[number];

export interface IdName {
  id: string;
  name: string;
}

export interface ProcessStep {
  id: string;
  name: string;
}

/** A pipeline stage; Livespace calls its checkbox steps `stages` too. */
export interface ProcessStage {
  id: string;
  name: string;
  steps: ProcessStep[];
}

export interface ProcessInfo {
  id: string;
  name: string;
  stages: ProcessStage[];
}

export interface UserTeam {
  id: string;
  name: string;
  roles: string[];
}

export interface UserInfo {
  id: string;
  name: string;
  email: string;
  teams: UserTeam[];
}

export interface ProductInfo {
  id: string;
  name: string;
  sku: string;
  defaultPrice: string;
}

export interface CurrentUser {
  /** Resolved by email match against the user list; null when absent. */
  id: string | null;
  name: string;
  email: string;
  position: string;
  permissions: Record<string, boolean>;
  teams: UserTeam[];
}

export interface SectionDataMap {
  processes: ProcessInfo[];
  users: UserInfo[];
  contactGroups: IdName[];
  dealGroups: IdName[];
  sources: string[];
  taskTypes: IdName[];
  taskStatuses: IdName[];
  products: ProductInfo[];
  currentUser: CurrentUser;
}

export type MetadataFetchers = {
  [S in MetadataSection]: (opts?: { signal?: AbortSignal }) => Promise<SectionDataMap[S]>;
};

// Fixed wording only: upstream content must never reach an error message
// (docs/security.md par. 6).
function unexpectedShape(): LivespaceError {
  return new LivespaceError(
    "UPSTREAM_ERROR",
    "Livespace returned an unexpected shape for this dictionary.",
    "Report it on the issue tracker; the API may have changed.",
  );
}

/**
 * PHP serializes empty maps as `[]`. A NON-empty array where a record was
 * expected is an unknown upstream shape - fail the section cleanly.
 */
function asRecord(data: unknown): Record<string, unknown> {
  if (data === null || data === undefined) return {};
  if (Array.isArray(data)) {
    if (data.length === 0) return {};
    throw unexpectedShape();
  }
  if (typeof data === "object") return data as Record<string, unknown>;
  throw unexpectedShape();
}

function asName(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asArray(data: unknown): unknown[] {
  if (data === null || data === undefined) return [];
  if (Array.isArray(data)) return data;
  throw unexpectedShape();
}

/** Ids are opaque strings; the shape of an id is never validated. */
function readId(raw: unknown): string | null {
  if (raw === null || typeof raw !== "object") return null;
  const id = (raw as Record<string, unknown>)["id"];
  return id === null || id === undefined ? null : String(id);
}

function idNameFromRecord(data: unknown): IdName[] {
  return Object.entries(asRecord(data)).map(([id, value]) => ({
    id,
    name: asName(value),
  }));
}

/**
 * For dictionaries whose non-empty shape is unverified: accept both the record
 * form and an array of objects, reject anything else.
 */
function idNameTolerant(data: unknown): IdName[] {
  if (Array.isArray(data)) {
    const items: IdName[] = [];
    let sawObject = false;
    for (const element of data) {
      if (element !== null && typeof element === "object") sawObject = true;
      const id = readId(element);
      if (id === null) continue;
      items.push({ id, name: asName((element as Record<string, unknown>)["name"]) });
    }
    // Objects without an id are skipped, but an array carrying no object at
    // all (bare strings, numbers) is a shape we do not understand.
    if (data.length > 0 && !sawObject) throw unexpectedShape();
    return items;
  }
  const record = asRecord(data);
  for (const value of Object.values(record)) {
    if (typeof value !== "string") throw unexpectedShape();
  }
  return idNameFromRecord(record);
}

function mapRoles(data: unknown): string[] {
  const roles: string[] = [];
  for (const role of Array.isArray(data) ? data : []) {
    if (role === null || typeof role !== "object") continue;
    const name = asName((role as Record<string, unknown>)["name"]);
    if (name) roles.push(name);
  }
  return roles;
}

function mapTeams(data: unknown): UserTeam[] {
  const teams: UserTeam[] = [];
  for (const structure of Array.isArray(data) ? data : []) {
    const id = readId(structure);
    if (id === null) continue;
    const raw = structure as Record<string, unknown>;
    teams.push({ id, name: asName(raw["name"]), roles: mapRoles(raw["roles"]) });
  }
  return teams;
}

function mapProcesses(data: unknown): ProcessInfo[] {
  return Object.entries(asRecord(data)).map(([id, value]) => {
    const process = asRecord(value);
    const stages = Object.entries(asRecord(process["main_stages"])).map(
      ([stageId, stageValue]) => {
        const stage = asRecord(stageValue);
        return {
          id: stageId,
          name: asName(stage["name"]),
          steps: Object.entries(asRecord(stage["stages"])).map(([stepId, stepValue]) => ({
            id: stepId,
            name: asName(asRecord(stepValue)["name"]),
          })),
        };
      },
    );
    return { id, name: asName(process["name"]), stages };
  });
}

function mapUsers(data: unknown): UserInfo[] {
  if (!Array.isArray(data)) throw unexpectedShape();
  const users: UserInfo[] = [];
  for (const element of data) {
    const id = readId(element);
    if (id === null) continue;
    const raw = element as Record<string, unknown>;
    const fallback = [asName(raw["firstname"]), asName(raw["lastname"])]
      .filter(Boolean)
      .join(" ");
    users.push({
      id,
      name: asName(raw["name"]) || fallback,
      email: asName(raw["email"]),
      teams: mapTeams(raw["structures"]),
    });
  }
  return users;
}

function mapSources(data: unknown): string[] {
  return asArray(data).filter((entry): entry is string => typeof entry === "string");
}

function mapProduct(raw: unknown): ProductInfo | null {
  const id = readId(raw);
  if (id === null) return null;
  const product = raw as Record<string, unknown>;
  return {
    id,
    name: asName(product["name"]),
    sku: asName(product["sku"]),
    defaultPrice: asName(product["default_price"]),
  };
}

function mapProducts(data: unknown): ProductInfo[] {
  if (data === null || data === undefined) return [];
  if (Array.isArray(data)) {
    if (data.length === 0) return [];
    throw unexpectedShape();
  }
  if (typeof data !== "object") throw unexpectedShape();
  const wrapper = (data as Record<string, unknown>)["product"];
  if (wrapper === null || wrapper === undefined) return [];
  if (typeof wrapper !== "object") throw unexpectedShape();
  // Array form, PHP keyed-record form, or a lone product object.
  const items = Array.isArray(wrapper)
    ? wrapper
    : readId(wrapper) !== null
      ? [wrapper]
      : Object.values(wrapper as Record<string, unknown>);
  const products: ProductInfo[] = [];
  for (const item of items) {
    const product = mapProduct(item);
    if (product) products.push(product);
  }
  return products;
}

function normalizePermission(value: unknown): boolean | undefined {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0" || value === "" || value === null) {
    return false;
  }
  return undefined;
}

function mapPermissions(data: unknown): Record<string, boolean> {
  const permissions: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(asRecord(data))) {
    const normalized = normalizePermission(value);
    if (normalized !== undefined) permissions[key] = normalized;
  }
  return permissions;
}

export function createMetadataFetchers(
  client: Pick<LivespaceClient, "call">,
): MetadataFetchers {
  const call = (
    module: string,
    method: string,
    opts?: { signal?: AbortSignal },
  ): Promise<unknown> => client.call(module, method, {}, { signal: opts?.signal });

  return {
    processes: async (opts) => mapProcesses(await call("Deal", "process_getList", opts)),
    users: async (opts) => mapUsers(await call("Default", "User_getAll", opts)),
    contactGroups: async (opts) =>
      idNameFromRecord(await call("Contact", "getGroupList", opts)),
    dealGroups: async (opts) => idNameTolerant(await call("Deal", "getGroupList", opts)),
    sources: async (opts) => mapSources(await call("Default", "getSourceList", opts)),
    taskTypes: async (opts) => idNameFromRecord(await call("Todo", "getTypes", opts)),
    taskStatuses: async (opts) =>
      idNameFromRecord(await call("Todo", "getStatuses", opts)),
    products: async (opts) => mapProducts(await call("Deal", "product_getAll", opts)),
    currentUser: async (opts) => {
      const info = asRecord(await call("Default", "User_getInfo", opts));
      const email = asName(info["email"]);
      const fallback = [asName(info["firstname"]), asName(info["lastname"])]
        .filter(Boolean)
        .join(" ");
      // The id is resolved by the service layer from the cached `users`
      // section, so both sections cost one User_getAll per ttl.
      return {
        id: null,
        name: asName(info["name"]) || fallback,
        email,
        position: asName(info["position"]),
        permissions: mapPermissions(asRecord(info["app_settings"])["permission"]),
        teams: mapTeams(info["structures"]),
      };
    },
  };
}
