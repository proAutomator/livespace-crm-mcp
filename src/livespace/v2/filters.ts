import { LivespaceError } from "../errors.js";

/**
 * The filter tree of the API v2 searches (`POST /people/searches`,
 * `/companies/searches`, `/deals/searches`, `/tasks/searches`).
 *
 * The contract is closed and counts every refused request against the
 * account's daily budget, so the limits it names are checked here, before a
 * request goes out (docs/security.md par. 3). A refusal uses fixed wording
 * and never repeats a filter value (par. 6).
 */

export type FilterOperator =
  | "eq"
  | "neq"
  | "contains"
  | "notContains"
  | "startsWith"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "between"
  | "in"
  | "nin"
  | "anyOf"
  | "allOf"
  | "noneOf"
  | "isEmpty"
  | "isNotEmpty";

export interface FilterCondition {
  field: string;
  operator: FilterOperator;
  value?: unknown;
}

export type FilterNode = FilterCondition | { and: FilterNode[] } | { or: FilterNode[] };

/** The limits of the contract: a search over any of them answers 400. */
export const FILTER_LIMITS = {
  depth: 5,
  conditions: 50,
  customFieldConditions: 10,
  listValues: 200,
  stringLength: 255,
} as const;

const CUSTOM_FIELD_PREFIX = "additionalFields.";

export function where(field: string, operator: FilterOperator, value?: unknown): FilterNode {
  return value === undefined ? { field, operator } : { field, operator, value };
}

function group(kind: "and" | "or", nodes: (FilterNode | undefined)[]): FilterNode | undefined {
  const kept: FilterNode[] = [];
  for (const node of nodes) {
    if (node === undefined) continue;
    // A group of the same kind adds a level and no meaning: its members move up.
    const inner = (node as Record<string, unknown>)[kind];
    if (Array.isArray(inner)) kept.push(...(inner as FilterNode[]));
    else kept.push(node);
  }
  if (kept.length === 0) return undefined;
  if (kept.length === 1) return kept[0];
  return kind === "and" ? { and: kept } : { or: kept };
}

/** Every node must match. Drops `undefined`, unwraps a single node. */
export function and(...nodes: (FilterNode | undefined)[]): FilterNode | undefined {
  return group("and", nodes);
}

/** Any node may match. Drops `undefined`, unwraps a single node. */
export function or(...nodes: (FilterNode | undefined)[]): FilterNode | undefined {
  return group("or", nodes);
}

function tooWide(what: string): LivespaceError {
  return new LivespaceError(
    "BAD_PARAMS",
    `The filter is over a Livespace limit: ${what}.`,
    "Use fewer or shorter filter values, or split the request into several calls.",
  );
}

function checkString(value: unknown): void {
  if (typeof value === "string" && value.length > FILTER_LIMITS.stringLength) {
    throw tooWide(`at most ${FILTER_LIMITS.stringLength} characters per value`);
  }
}

function checkValue(value: unknown): void {
  if (Array.isArray(value)) {
    if (value.length > FILTER_LIMITS.listValues) {
      throw tooWide(`at most ${FILTER_LIMITS.listValues} values per list`);
    }
    value.forEach(checkString);
    return;
  }
  if (value !== null && typeof value === "object") {
    // The `{from, to}` of a `between`.
    Object.values(value).forEach(checkString);
    return;
  }
  checkString(value);
}

/**
 * Refuses a tree the API would answer 400 for: more than 5 levels (a lone
 * condition is one level, each group around it one more), 50 conditions, 10
 * conditions on custom fields, 200 values in a list or 255 characters in a
 * string, and a group without members.
 */
export function assertFilterLimits(node: FilterNode): void {
  let conditions = 0;
  let customFieldConditions = 0;
  const walk = (current: FilterNode, depth: number): void => {
    if (depth > FILTER_LIMITS.depth) {
      throw tooWide(`at most ${FILTER_LIMITS.depth} levels of nesting`);
    }
    const members =
      "and" in current ? current.and : "or" in current ? current.or : undefined;
    if (members !== undefined) {
      if (members.length === 0) throw tooWide("a group needs at least one condition");
      for (const member of members) walk(member, depth + 1);
      return;
    }
    const condition = current as FilterCondition;
    conditions += 1;
    if (conditions > FILTER_LIMITS.conditions) {
      throw tooWide(`at most ${FILTER_LIMITS.conditions} conditions`);
    }
    if (condition.field.startsWith(CUSTOM_FIELD_PREFIX)) {
      customFieldConditions += 1;
      if (customFieldConditions > FILTER_LIMITS.customFieldConditions) {
        throw tooWide(
          `at most ${FILTER_LIMITS.customFieldConditions} custom-field conditions`,
        );
      }
    }
    checkValue(condition.value);
  };
  walk(node, 1);
}

const DAY_SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/u;

interface Day {
  year: number;
  month: number;
  day: number;
}

function badDay(): LivespaceError {
  return new LivespaceError(
    "BAD_PARAMS",
    "A date filter is not a real calendar day.",
    "Send an existing day as YYYY-MM-DD, for example 2026-01-31.",
  );
}

/** A real calendar day, or a refusal: `2026-02-30` must not roll into March. */
function parseDay(value: string): Day {
  const match = DAY_SHAPE.exec(value);
  if (match === null) throw badDay();
  const day: Day = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  const date = new Date(Date.UTC(day.year, day.month - 1, day.day));
  if (
    date.getUTCFullYear() !== day.year ||
    date.getUTCMonth() !== day.month - 1 ||
    date.getUTCDate() !== day.day
  ) {
    throw badDay();
  }
  return day;
}

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  try {
    if (timeZone === "") throw new RangeError("empty time zone");
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    // Fixed wording: the zone name is upstream text (docs/security.md par. 6).
    throw new LivespaceError(
      "UPSTREAM_ERROR",
      "Livespace reported an account time zone this server cannot use for day filters.",
      "Drop the date filters and retry; report it on the issue tracker.",
    );
  }
}

/** Minutes the zone is ahead of UTC at one instant. */
function offsetMinutes(formatter: Intl.DateTimeFormat, utcMs: number): number {
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(utcMs))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  const local = Date.UTC(
    parts["year"] ?? 0,
    (parts["month"] ?? 1) - 1,
    parts["day"] ?? 1,
    parts["hour"] ?? 0,
    parts["minute"] ?? 0,
    parts["second"] ?? 0,
  );
  return Math.round((local - utcMs) / 60_000);
}

const pad = (value: number, width = 2): string => String(value).padStart(width, "0");

/** `<day>T<time><offset>` for a wall-clock time of the zone. */
function zonedInstant(
  formatter: Intl.DateTimeFormat,
  day: Day,
  hour: number,
  minute: number,
  second: number,
): string {
  const wall = Date.UTC(day.year, day.month - 1, day.day, hour, minute, second);
  // The offset depends on the instant and the instant on the offset: guess
  // with the offset at the wall time read as UTC, then correct once. That is
  // exact everywhere except inside a clock change, which midnight and
  // 23:59:59 only touch in the few zones that switch at midnight.
  let offset = offsetMinutes(formatter, wall);
  const corrected = offsetMinutes(formatter, wall - offset * 60_000);
  if (corrected !== offset) offset = corrected;
  const sign = offset < 0 ? "-" : "+";
  const absolute = Math.abs(offset);
  return (
    `${pad(day.year, 4)}-${pad(day.month)}-${pad(day.day)}` +
    `T${pad(hour)}:${pad(minute)}:${pad(second)}` +
    `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
  );
}

/**
 * Inclusive days as RFC 3339 bounds in one time zone: the day starts at
 * `00:00:00` and ends at `23:59:59` on the zone's own clock, each with the
 * offset that holds at that moment. Datetime filter fields refuse a bare
 * `YYYY-MM-DD` and `between` and `lte` are inclusive (live check Q3), so this
 * is how "created in March" is asked.
 */
export function dayRange(
  fromDay: string | undefined,
  toDay: string | undefined,
  timeZone: string,
): { from?: string; to?: string } {
  if (fromDay === undefined && toDay === undefined) return {};
  const formatter = zoneFormatter(timeZone);
  return {
    ...(fromDay === undefined
      ? {}
      : { from: zonedInstant(formatter, parseDay(fromDay), 0, 0, 0) }),
    ...(toDay === undefined ? {} : { to: zonedInstant(formatter, parseDay(toDay), 23, 59, 59) }),
  };
}

/**
 * The condition for an inclusive day range on one field: `between` for two
 * bounds, `gte` or `lte` for one, nothing for none. With a time zone the
 * field is a datetime and gets RFC 3339 bounds; without one it is a date
 * field (`expectedCloseDate`), which takes the bare days.
 */
export function dayBounds(
  field: string,
  fromDay: string | undefined,
  toDay: string | undefined,
  timeZone?: string,
): FilterNode | undefined {
  if (fromDay === undefined && toDay === undefined) return undefined;
  if (fromDay !== undefined) parseDay(fromDay);
  if (toDay !== undefined) parseDay(toDay);
  if (fromDay !== undefined && toDay !== undefined && fromDay > toDay) {
    throw new LivespaceError(
      "BAD_PARAMS",
      "A date range ends before it starts.",
      "Swap the two dates, or widen the period.",
    );
  }
  const { from, to } =
    timeZone === undefined
      ? {
          ...(fromDay === undefined ? {} : { from: fromDay }),
          ...(toDay === undefined ? {} : { to: toDay }),
        }
      : dayRange(fromDay, toDay, timeZone);
  if (from !== undefined && to !== undefined) return where(field, "between", { from, to });
  if (from !== undefined) return where(field, "gte", from);
  return where(field, "lte", to);
}
