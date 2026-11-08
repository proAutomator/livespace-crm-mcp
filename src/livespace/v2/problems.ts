import {
  LivespaceError,
  type LivespaceErrorCode,
  type LivespaceErrorDetails,
} from "../errors.js";
import { parseRetryAfterMs } from "../http-shared.js";

/**
 * API v2 failures arrive as RFC 9457 `application/problem+json`. Everything in
 * such a body is upstream text, so only three things pass into a
 * `LivespaceError` (docs/security.md par. 6): our own fixed wording chosen by
 * status and problem type, the JSON Pointer paths of `violations` after
 * sanitizing, and a request id in its documented shape. `title`, `detail`,
 * violation messages, `conflicts` and `supported` are dropped.
 */

const PROBLEM_NAMESPACE = "https://api.livespace.io/problems/";
const MAX_POINTERS = 20;
const POINTER_RE = /^\/[A-Za-z0-9_.\-/]{0,200}$/;
const REQUEST_ID_RE = /^[0-9a-f]{32}$/;
/** The scope areas the v2 contract defines; anything else is never echoed. */
const SCOPE_RE =
  /^crm:(call|company|cost-catalog|deal|email|note|notification|person|product-catalog|sales-process|task):(read|write|delete)$/;

type ProblemType =
  | "authentication-required"
  | "insufficient-scope"
  | "forbidden"
  | "not-found"
  | "method-not-allowed"
  | "not-acceptable"
  | "unsupported-media-type"
  | "request-validation"
  | "domain-validation"
  | "too-many-requests"
  | "service-unavailable"
  | "internal-error"
  | "http-error"
  | "conflict"
  | "idempotency-key-reused";

const PROBLEM_TYPES: ReadonlySet<string> = new Set<ProblemType>([
  "authentication-required",
  "insufficient-scope",
  "forbidden",
  "not-found",
  "method-not-allowed",
  "not-acceptable",
  "unsupported-media-type",
  "request-validation",
  "domain-validation",
  "too-many-requests",
  "service-unavailable",
  "internal-error",
  "http-error",
  "conflict",
  "idempotency-key-reused",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The documented type URI only; anything else counts as no type at all. */
function problemType(value: unknown): ProblemType | undefined {
  if (typeof value !== "string" || !value.startsWith(PROBLEM_NAMESPACE)) return undefined;
  const slug = value.slice(PROBLEM_NAMESPACE.length);
  return PROBLEM_TYPES.has(slug) ? (slug as ProblemType) : undefined;
}

/** Only the documented 32 lowercase hex shape; `unavailable` and the rest drop. */
export function readRequestId(value: unknown): string | undefined {
  return typeof value === "string" && REQUEST_ID_RE.test(value) ? value : undefined;
}

/**
 * The keys of a `violations` object as safe JSON Pointers. The draft mixes
 * `/perPage` and `perPage`, so a missing leading slash is added (the empty
 * key, the whole body, becomes `/`). Keys with any other character are
 * dropped, never escaped, and at most 20 are kept. The messages are ignored.
 */
export function sanitizePointers(violations: unknown): string[] {
  if (!isRecord(violations)) return [];
  const pointers: string[] = [];
  for (const key of Object.keys(violations)) {
    const pointer = key.startsWith("/") ? key : `/${key}`;
    if (!POINTER_RE.test(pointer)) continue;
    pointers.push(pointer);
    if (pointers.length === MAX_POINTERS) break;
  }
  return pointers;
}

/**
 * `Bearer error="insufficient_scope", scope="crm:deal:write"`: the scopes the
 * challenge names, each surfaced only as a documented `crm:<area>:<level>`
 * with an area the contract defines. The second value tells whether the challenge reported a missing
 * scope at all.
 */
function challengeScopes(header: string | null): { insufficient: boolean; scopes: string[] } {
  if (header === null) return { insufficient: false, scopes: [] };
  const insufficient = /error="insufficient_scope"/.test(header);
  const quoted = /scope="([^"]{0,200})"/.exec(header)?.[1] ?? "";
  const scopes = quoted
    .split(" ")
    .filter((scope) => SCOPE_RE.test(scope))
    .slice(0, 5);
  return { insufficient, scopes };
}

interface Mapped {
  code: LivespaceErrorCode;
  message: string;
  hint: string;
  transport?: boolean;
}

const REPORT_IT = "Server bug: report it on the issue tracker.";

function mapProblem(
  status: number,
  type: ProblemType | undefined,
  headers: Headers,
  retryAfterMs: number | undefined,
): Mapped {
  // fetch always reports an integer status; anything else is never echoed.
  const shown = Number.isInteger(status) ? String(status) : "unknown";
  switch (status) {
    case 400:
      return {
        code: "VALIDATION_ERROR",
        message: "Livespace API v2 rejected the request as invalid (400).",
        hint:
          "Fix the listed fields and retry; if they are not tool arguments, " +
          `the server built the request wrong. ${REPORT_IT}`,
      };
    case 401:
      return {
        code: "AUTH_FAILED",
        message: "Livespace API v2 did not accept the key (401).",
        hint:
          "Verify LIVESPACE_API_V2_KEY (Livespace: Settings -> API v2) and that " +
          "the key is still active.",
      };
    case 403: {
      const challenge = challengeScopes(headers.get("www-authenticate"));
      if (type === "insufficient-scope" || (type === undefined && challenge.insufficient)) {
        return {
          code: "INSUFFICIENT_SCOPE",
          message: "The API v2 key lacks a scope this request needs (403).",
          hint:
            challenge.scopes.length > 0
              ? `Add the scope ${challenge.scopes.join(", ")} to the key in Livespace, ` +
                "or use a tool that does not need it."
              : "Add the missing scope to the key in Livespace, or use a tool " +
                "that does not need it.",
        };
      }
      return {
        code: "PERMISSION_DENIED",
        message: "Livespace refused access to this record (403).",
        hint:
          "The integration user sees this record only at BASIC level. Open it " +
          "in Livespace or work with another record.",
      };
    }
    case 404:
      return {
        code: "NOT_FOUND",
        message: "The record or resource was not found (404).",
        hint:
          "It is unknown or not visible to the integration user. Take ids from " +
          "search_crm or crm_metadata instead of guessing them.",
      };
    case 405:
    case 406:
    case 415:
      return {
        code: "UPSTREAM_ERROR",
        message: `Livespace API v2 refused the request format (${shown}).`,
        hint: REPORT_IT,
      };
    case 409:
      return {
        code: "CONFLICT",
        message: "The request conflicts with the current state in Livespace (409).",
        hint:
          retryAfterMs !== undefined
            ? `Retry after ${Math.ceil(retryAfterMs / 1000)} s.`
            : "Re-read the record and retry with its current state.",
      };
    case 422:
      if (type === "idempotency-key-reused") {
        return {
          code: "UPSTREAM_ERROR",
          message: "Livespace refused a reused idempotency key (422).",
          hint: REPORT_IT,
        };
      }
      return {
        code: "VALIDATION_ERROR",
        message: "Livespace refused the change under its business rules (422).",
        hint:
          "Fix the listed fields: their values break a Livespace rule for this " +
          "record. Check them against crm_metadata and the record's current state.",
      };
    case 429:
      return {
        code: "RATE_LIMITED",
        message: "Livespace API v2 rate-limited the request (429).",
        hint: "Wait before retrying; reduce request frequency if it persists.",
        transport: true,
      };
    default:
      if (status >= 500) {
        return {
          code: "UPSTREAM_ERROR",
          message: `Livespace API v2 responded with HTTP ${shown}.`,
          hint: "Retry later; reduce the request size if it persists.",
          transport: true,
        };
      }
      return {
        code: "UPSTREAM_ERROR",
        message: `Livespace API v2 rejected the request (HTTP ${shown}).`,
        hint: REPORT_IT,
      };
  }
}

/** One failed v2 response (status >= 400) as a sanitized `LivespaceError`. */
export function errorFromProblem(
  status: number,
  body: unknown,
  headers: Headers,
): LivespaceError {
  const problem = isRecord(body) ? body : {};
  const type = problemType(problem["type"]);
  const retryAfterMs = parseRetryAfterMs(headers.get("retry-after"));
  const mapped = mapProblem(status, type, headers, retryAfterMs);

  const fields = sanitizePointers(problem["violations"]);
  const requestId =
    readRequestId(problem["requestId"]) ?? readRequestId(headers.get("x-request-id"));
  const details: LivespaceErrorDetails = {
    ...(fields.length > 0 ? { fields } : {}),
    ...(requestId === undefined ? {} : { requestId }),
  };
  return new LivespaceError(
    mapped.code,
    mapped.message,
    mapped.hint,
    undefined,
    retryAfterMs,
    mapped.transport ?? false,
    details,
  );
}
