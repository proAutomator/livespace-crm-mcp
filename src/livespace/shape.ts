import { LivespaceError } from "./errors.js";

/**
 * Shape helpers shared by the record and activity fetchers.
 *
 * Both read the same PHP-flavoured JSON: booleans that arrive as `true`, `1` or
 * `"1"` depending on the endpoint, empty maps serialized as `[]`, and lists
 * hidden behind a wrapper key named after the thing that was asked for. One copy
 * of those rules means one place to fix when the next endpoint surprises us.
 *
 * `metadata.ts` deliberately does NOT use these. Its `asRecord` throws where
 * this one returns `null`, because a malformed dictionary is a hard failure
 * while a malformed row in a list is just a row to skip.
 */

/** PHP serializes empty maps as `[]`, so an array is never a record here. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function asName(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Upstream booleans arrive as `true`, `1` or `"1"` depending on the endpoint. */
export function asBool(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

export function asCount(value: unknown): number {
  const count = Number(value);
  return Number.isFinite(count) ? count : 0;
}

/**
 * A step map, however PHP serialized it: an id-keyed record (the normal shape),
 * an empty `[]` (an empty map), or a bare list of ids. The KEY is the step id;
 * the value is the display name and is not read. Shared by the record mapper
 * and the stage-move reader so both tools see the same steps on one deal.
 */
export function stepIds(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter(
      (entry): entry is string => typeof entry === "string" && entry !== "",
    );
  }
  const record = asRecord(value);
  if (record === null) return [];
  return Object.keys(record).filter((key) => key !== "");
}

/**
 * Fixed wording only: upstream content must never reach an error message
 * (docs/security.md par. 6). `subject` names what was being read - "record",
 * "activity" - so each caller keeps the message it always had.
 */
export function unexpectedShape(subject: string): LivespaceError {
  return new LivespaceError(
    "UPSTREAM_ERROR",
    `Livespace returned an unexpected shape for this ${subject}.`,
    "Report it on the issue tracker; the API may have changed.",
  );
}

/**
 * Unwraps a list from a keyed payload, trying each key in turn. A missing
 * wrapper means an empty page, and PHP also serializes an empty result as a bare
 * `[]`. A wrapper that holds something other than a list is a shape error, not
 * an empty page - staying silent there would hide an API change.
 *
 * `onBadShape` is passed in rather than thrown here so each module keeps its own
 * wording.
 */
export function unwrapList(
  payload: unknown,
  keys: readonly string[],
  onBadShape: () => LivespaceError,
): unknown[] {
  if (payload === null || payload === undefined) return [];
  if (Array.isArray(payload)) return payload;
  const data = asRecord(payload);
  if (data === null) throw onBadShape();
  for (const key of keys) {
    const inner = data[key];
    if (inner === null || inner === undefined) continue;
    if (Array.isArray(inner)) return inner;
    throw onBadShape();
  }
  return [];
}
