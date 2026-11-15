import { stripHtml } from "../activity.js";
import { LivespaceError } from "../errors.js";
import type { CallBudget } from "./budget.js";
import { v2Path, type LivespaceV2Client } from "./client.js";
import type { Ref } from "./records.js";

/**
 * The activity of one record in API v2: its notes, calls and e-mails.
 *
 * Note, call and e-mail text is the most hostile content in the CRM: markup,
 * imported e-mail bodies and anything a third party typed. It is flattened
 * and cut short here, in the data layer, so no tool can forget to
 * (docs/security.md par. 4). Nothing is cached (par. 8).
 */

type V2Requester = Pick<LivespaceV2Client, "request">;

export type TimelineEntryType = "note" | "call" | "email" | "task" | "system";

export interface TimelineEntry {
  type: TimelineEntryType;
  id: string | null;
  date: string | null;
  author: Ref | null;
  /** Plain text, markup removed. */
  text: string;
  textTruncated: boolean;
  direction?: "incoming" | "outgoing";
  visibility?: string;
  tags?: string[];
  completed?: boolean;
  /** E-mails only. */
  subject?: string;
  /** E-mails only: the sender's address. */
  from?: string;
  /** Calls only. */
  durationSeconds?: number;
  url: string | null;
}

/** The entry types a record lists by itself. */
export type RecordEntryType = "note" | "call" | "email";

export type TimelineParentKind = "person" | "company" | "deal";

export interface RecordEntriesOptions {
  /** Entries to read, newest first: the page size of the one page read. */
  limit: number;
  signal?: AbortSignal;
  /** The tool call's request budget. */
  budget: CallBudget;
}

export interface TimelineReader {
  recordEntries(
    kind: TimelineParentKind,
    id: string,
    type: RecordEntryType,
    opts: RecordEntriesOptions,
  ): Promise<{ entries: TimelineEntry[]; totalCount: number }>;
}

/** Flattened text longer than this is cut, with `textTruncated` set. */
export const TIMELINE_TEXT_LIMIT = 500;
const SUBJECT_LIMIT = 200;
const MAX_PER_PAGE = 500;

const PARENTS: Record<TimelineParentKind, string> = {
  person: "people",
  company: "companies",
  deal: "deals",
};

const LISTS: Record<RecordEntryType, string> = { note: "notes", call: "calls", email: "emails" };

// Fixed wording only (docs/security.md par. 6).
function unexpectedShape(): LivespaceError {
  return new LivespaceError(
    "UPSTREAM_ERROR",
    "Livespace API v2 returned an unexpected shape for this activity list.",
    "Report it on the issue tracker; the API may have changed.",
  );
}

type Row = Record<string, unknown>;

function asRow(value: unknown): Row {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw unexpectedShape();
  }
  return value as Row;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function refOf(value: unknown): Ref | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Row;
  const id = row["id"];
  if (typeof id !== "string" || id === "") return null;
  return { id, name: typeof row["name"] === "string" ? row["name"] : "" };
}

function flatten(value: unknown, limit = TIMELINE_TEXT_LIMIT): { text: string; truncated: boolean } {
  const flattened = stripHtml(value);
  return { text: flattened.slice(0, limit), truncated: flattened.length > limit };
}

function direction(value: unknown): { direction?: "incoming" | "outgoing" } {
  return value === "incoming" || value === "outgoing" ? { direction: value } : {};
}

function visibility(value: unknown): { visibility?: string } {
  const text = textOrNull(value);
  return text === null ? {} : { visibility: text };
}

function mapNote(row: Row): TimelineEntry {
  const body = flatten(row["content"]);
  const tags = Array.isArray(row["tags"])
    ? row["tags"].filter((tag): tag is string => typeof tag === "string")
    : [];
  return {
    type: "note",
    id: textOrNull(row["id"]),
    date: textOrNull(row["date"]) ?? textOrNull(row["createdAt"]),
    author: refOf(row["createdBy"]),
    text: body.text,
    textTruncated: body.truncated,
    ...visibility(row["visibility"]),
    tags,
    url: textOrNull(row["url"]),
  };
}

function mapCall(row: Row): TimelineEntry {
  const body = flatten(row["note"]);
  const duration = row["duration"];
  return {
    type: "call",
    id: textOrNull(row["id"]),
    date: textOrNull(row["date"]) ?? textOrNull(row["createdAt"]),
    author: refOf(row["createdBy"]),
    text: body.text,
    textTruncated: body.truncated,
    ...direction(row["direction"]),
    ...visibility(row["visibility"]),
    ...(typeof duration === "number" && Number.isFinite(duration)
      ? { durationSeconds: duration }
      : {}),
    url: null,
  };
}

function mapEmail(row: Row): TimelineEntry {
  const body = flatten(row["content"]);
  const from = textOrNull(row["from"]);
  return {
    type: "email",
    id: textOrNull(row["id"]),
    date: textOrNull(row["date"]) ?? textOrNull(row["createdAt"]),
    author: null,
    text: body.text,
    textTruncated: body.truncated,
    ...direction(row["direction"]),
    subject: flatten(row["subject"], SUBJECT_LIMIT).text,
    ...(from === null ? {} : { from }),
    url: textOrNull(row["url"]),
  };
}

const MAPPERS: Record<RecordEntryType, (row: Row) => TimelineEntry> = {
  note: mapNote,
  call: mapCall,
  email: mapEmail,
};

export function createV2TimelineReader(client: V2Requester): TimelineReader {
  return {
    async recordEntries(kind, id, type, opts) {
      if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > MAX_PER_PAGE) {
        throw new RangeError(`An entry limit is an integer from 1 to ${MAX_PER_PAGE}.`);
      }
      const response = await client.request<unknown>(
        {
          method: "GET",
          path: v2Path(`/${PARENTS[kind]}/{}/${LISTS[type]}`, id),
          // The lists come newest first, so one page is the latest entries.
          query: { page: 1, perPage: opts.limit },
        },
        {
          budget: opts.budget,
          ...(opts.signal === undefined ? {} : { signal: opts.signal }),
        },
      );
      if (!Array.isArray(response.data)) throw unexpectedShape();
      const entries = response.data.map((raw) => MAPPERS[type](asRow(raw)));
      const total = response.extra["totalCount"];
      return {
        entries,
        totalCount:
          typeof total === "number" && Number.isInteger(total) && total >= 0
            ? total
            : entries.length,
      };
    },
  };
}
