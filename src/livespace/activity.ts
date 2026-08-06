import type { LivespaceClient } from "./client.js";
import { LivespaceError } from "./errors.js";
import { asName } from "./records.js";

/**
 * Activity reads: the wall of a single record and the CRM-wide feed.
 *
 * Wall and feed text is the most hostile content in the whole API - it carries
 * HTML, imported e-mail bodies and anything a third party typed into the CRM.
 * Two rules follow from that (docs/security.md par. 4):
 *
 * 1. `stripHtml` flattens the markup here, in the data layer, so no tool can
 *    forget to do it.
 * 2. The flattened text stays DATA. It never reaches a text channel; the tools
 *    put it in structured fields only.
 *
 * Field names come from live probes on a sandbox account (2026-08-06), recorded
 * in the M4 plan doc. Nothing here is cached - record data is never cached
 * (docs/security.md par. 8), so this module must never import the server cache.
 */

/**
 * Local cap per wall. `getWall` also RECEIVES a `limit`, but whether upstream
 * honours it is unverified (the sandbox walls were too small to tell), so the
 * local cap is the authoritative one - an endpoint that ignores the limit must
 * never blow up a response.
 */
export const WALL_ENTRY_CAP = 50;

/** Flattened text longer than this is cut, with `textTruncated` set. */
const TEXT_LIMIT = 500;

export interface WallEntry {
  type: string;
  text: string;
  textTruncated: boolean;
  date: string;
  authorName: string;
  isPublic: boolean;
  commentCount: number;
  /** Feed-only: the CRM feed names the record it belongs to. Walls leave "". */
  objectName: string;
  objectType: string;
}

export interface RecordWallOptions {
  kind: "person" | "company" | "deal";
  id: string;
  signal?: AbortSignal;
}

export interface RecordWallPage {
  entries: WallEntry[];
  truncated: boolean;
  totalEntries: number;
}

export interface CrmFeedOptions {
  dateFrom: string;
  dateTo: string;
  limit: number;
  offset: number;
  signal?: AbortSignal;
}

export interface CrmFeedPage {
  items: WallEntry[];
  hasMore: boolean;
  rawCount: number;
}

export interface ActivityFetchers {
  recordWall(opts: RecordWallOptions): Promise<RecordWallPage>;
  crmFeed(opts: CrmFeedOptions): Promise<CrmFeedPage>;
}

// Fixed wording only: upstream content must never reach an error message
// (docs/security.md par. 6).
function unexpectedShape(): LivespaceError {
  return new LivespaceError(
    "UPSTREAM_ERROR",
    "Livespace returned an unexpected shape for this activity.",
    "Report it on the issue tracker; the API may have changed.",
  );
}

/** PHP serializes empty maps as `[]`, so an array is never a record here. */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

const ENTITY_PATTERN = /&(?:amp|lt|gt|quot|#39);/gu;

const TAG_PATTERN = /<[^>]*>/gu;

/**
 * Flattens CRM HTML to plain text in a fixed order:
 *
 * 1. decode the five entities in ONE pass (chained replacements would cascade
 *    `&amp;lt;` into a live `<`),
 * 2. strip `<...>` spans until the result stops changing,
 * 3. collapse whitespace and trim.
 *
 * Decode-then-strip means markup can never survive the flattening. The cost is
 * that markup which arrived deliberately escaped ("&lt;b&gt;") is dropped as
 * well, and that a tag-shaped span of prose ("a < b and c > d") loses its
 * middle. That trade is accepted: dropping text is safe, leaking live markup
 * into an LLM context is not.
 */
export function stripHtml(value: unknown): string {
  if (typeof value !== "string") return "";
  const decoded = value.replace(ENTITY_PATTERN, (entity) => ENTITIES[entity] ?? entity);
  let stripped = decoded;
  for (;;) {
    // A removed tag becomes a space so `<p>a</p><p>b</p>` does not glue words.
    const next = stripped.replace(TAG_PATTERN, " ");
    if (next === stripped) break;
    stripped = next;
  }
  return stripped.replace(/\s+/gu, " ").trim();
}

/** Upstream booleans arrive as `true`, `1` or `"1"` depending on the endpoint. */
function asBool(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

function asCount(value: unknown): number {
  const count = Number(value);
  return Number.isFinite(count) ? count : 0;
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = asName(value);
    if (text) return text;
  }
  return "";
}

/**
 * One wall or feed row. The wall spells the comment count `comment_count` and
 * the feed `comments_count`; the author is `user_name` on a wall and
 * `creator_name` in the feed. Feed-only fields stay "" on a record wall.
 */
function mapEntry(data: Record<string, unknown>): WallEntry {
  const flattened = stripHtml(data["text"]);
  const truncated = flattened.length > TEXT_LIMIT;
  return {
    type: asName(data["type_name"]),
    text: truncated ? flattened.slice(0, TEXT_LIMIT) : flattened,
    textTruncated: truncated,
    date: firstString(data["date"], data["created"]),
    authorName: firstString(data["user_name"], data["creator_name"]),
    isPublic: asBool(data["is_public"]),
    commentCount: asCount(data["comment_count"] ?? data["comments_count"]),
    objectName: asName(data["object_name"]),
    objectType: asName(data["object_type"]),
  };
}

/**
 * Wall payloads are keyed (`{wall: [...]}`, `{items: [...]}`). A missing key is
 * an empty page; PHP also serializes an empty result as a bare `[]`.
 */
function unwrapList(payload: unknown, key: string): unknown[] {
  if (payload === null || payload === undefined) return [];
  if (Array.isArray(payload)) return payload;
  const data = asRecord(payload);
  if (data === null) throw unexpectedShape();
  const inner = data[key];
  if (inner === null || inner === undefined) return [];
  if (Array.isArray(inner)) return inner;
  throw unexpectedShape();
}

/** Rows that are not records are dropped, but they still count as raw rows. */
function mapRows(raw: unknown[]): WallEntry[] {
  const entries: WallEntry[] = [];
  for (const row of raw) {
    const data = asRecord(row);
    if (data === null) continue;
    entries.push(mapEntry(data));
  }
  return entries;
}

const WALL_ENDPOINTS = {
  person: { module: "Contact", type: "contact" },
  company: { module: "Contact", type: "company" },
  deal: { module: "Deal", type: "deal" },
} as const;

export function createActivityFetchers(
  client: Pick<LivespaceClient, "call">,
): ActivityFetchers {
  const call = (
    module: string,
    method: string,
    params: Record<string, unknown>,
    opts?: { signal?: AbortSignal },
  ): Promise<unknown> => client.call(module, method, params, { signal: opts?.signal });

  return {
    recordWall: async (opts) => {
      const endpoint = WALL_ENDPOINTS[opts.kind];
      const payload = await call(
        endpoint.module,
        "getWall",
        { type: endpoint.type, id: opts.id, limit: WALL_ENTRY_CAP },
        opts,
      );
      const raw = unwrapList(payload, "wall");
      const totalEntries = raw.length;
      return {
        entries: mapRows(raw).slice(0, WALL_ENTRY_CAP),
        truncated: totalEntries > WALL_ENTRY_CAP,
        totalEntries,
      };
    },

    crmFeed: async (opts) => {
      const payload = await call(
        "Wall",
        "getList",
        {
          date_from: opts.dateFrom,
          date_to: opts.dateTo,
          limit: opts.limit,
          offset: opts.offset,
        },
        opts,
      );
      // The RAW page comes back unfiltered: the tool applies the type filter and
      // its cursor math advances by the raw row count, so filtered pages never
      // re-deliver rows.
      const raw = unwrapList(payload, "items");
      const rawCount = raw.length;
      return {
        items: mapRows(raw).slice(0, opts.limit),
        hasMore: rawCount >= opts.limit,
        rawCount,
      };
    },
  };
}
