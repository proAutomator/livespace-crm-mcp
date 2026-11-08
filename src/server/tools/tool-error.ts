import * as z from "zod/v4";
import { LivespaceError } from "../../livespace/errors.js";

export interface ToolError {
  code: string;
  message: string;
  hint: string;
  /** Sanitized JSON Pointers of the rejected inputs (API v2 only). */
  fields?: string[];
  /** Livespace request id, 32 hex, to quote to Livespace support. */
  requestId?: string;
}

/**
 * The `{code, message, hint}` shape every tool reports errors in. Strict on
 * purpose (the M3 idiom): a key nobody declared is a bug, not a field to pass
 * through. Tools that need one more key extend it - `kind` in search_crm,
 * `section` in crm_metadata.
 */
export const toolErrorSchema = z.strictObject({
  code: z.string(),
  message: z.string(),
  hint: z.string(),
  fields: z.array(z.string()).max(20).optional(),
  requestId: z.string().regex(/^[0-9a-f]{32}$/).optional(),
});

/**
 * What every tool runner returns: the short markdown line, the
 * schema-validated structured payload, and whether the call failed outright.
 * The two channels are separate so CRM-authored text never has to travel
 * through the text one (docs/security.md par. 4).
 */
export interface ToolRunResult {
  text: string;
  structured: Record<string, unknown>;
  isError: boolean;
}

/**
 * The one place every read tool turns a thrown value into an error entry.
 *
 * A `LivespaceError` is already sanitized: its code, message and hint are our
 * own fixed wording. Anything else - a bug, a runtime failure, a rejected
 * promise carrying an upstream body - collapses into the generic entry, because
 * its text may contain response bodies, stack traces or auth material and none
 * of that may reach the model (docs/security.md par. 6).
 */
export function toToolError(error: unknown): ToolError {
  if (error instanceof LivespaceError) {
    // `details` was sanitized where the error was built (v2/problems.ts).
    const { fields, requestId } = error.details;
    return {
      code: error.code,
      message: error.message,
      hint: error.hint,
      ...(fields === undefined || fields.length === 0 ? {} : { fields: [...fields] }),
      ...(requestId === undefined ? {} : { requestId }),
    };
  }
  return {
    code: "UPSTREAM_ERROR",
    message: "Unexpected server error while handling this request.",
    hint: "Retry; report it on the issue tracker if it persists.",
  };
}
