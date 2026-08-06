import { LivespaceError } from "../livespace/errors.js";

/**
 * Stateless pagination cursors.
 *
 * Nothing is stored server-side (docs/security.md par. 8), so a cursor is just
 * base64url-encoded JSON: `{v, k, o}` - schema version, the kind it belongs to,
 * and the item offset it resumes from. That means no TTL and no entropy
 * requirement: a tampered cursor only shifts the caller's own page window, and
 * every value it can carry is bounded and validated here.
 *
 * `k` vocabulary: a `RecordKind` (`"person" | "company" | "deal"`) for
 * `search_crm`; `"crm"` or `"tasks"` for `get_activity`. `o` is an item offset -
 * for tasks an ABSOLUTE ITEM INDEX, because `Todo/getTodoObjects` pages in fixed
 * 50-row blocks (`page = Math.floor(o / 50) + 1`, `skip = o % 50`).
 */

export interface CursorPayload {
  v: 1;
  k: string;
  o: number;
}

/** Matches the `cursor` bound in every tool inputSchema. */
const MAX_CURSOR_CHARS = 512;

/** Far past any page a caller can reasonably walk to, and keeps `o` sane. */
const MAX_OFFSET = 100_000;

const BASE64URL = /^[A-Za-z0-9_-]+$/;

// One fixed message for every rejection reason. Cursor text is caller-supplied
// (and may carry CRM-derived content), so none of it is echoed back
// (docs/security.md par. 6).
function invalidCursor(): LivespaceError {
  return new LivespaceError(
    "BAD_PARAMS",
    "The cursor is invalid or from an older server version.",
    "Start again without a cursor.",
  );
}

export function encodeCursor(payload: CursorPayload): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decodeBase64Url(cursor: string): string | null {
  if (!BASE64URL.test(cursor)) return null;
  const padded = cursor.replaceAll("-", "+").replaceAll("_", "/");
  try {
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

export function decodeCursor(cursor: string, expectedKind: string): CursorPayload {
  // Length first: an oversized cursor is rejected before any decoding work.
  if (typeof cursor !== "string" || cursor.length > MAX_CURSOR_CHARS) {
    throw invalidCursor();
  }

  const json = decodeBase64Url(cursor);
  if (json === null) throw invalidCursor();

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw invalidCursor();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalidCursor();
  }

  const { v, k, o } = parsed as Record<string, unknown>;
  if (v !== 1) throw invalidCursor();
  if (typeof k !== "string" || k !== expectedKind) throw invalidCursor();
  if (typeof o !== "number" || !Number.isInteger(o) || o < 0 || o > MAX_OFFSET) {
    throw invalidCursor();
  }

  // Rebuilt rather than passed through: unknown keys from a tampered or older
  // cursor never reach the caller.
  return { v: 1, k, o };
}
