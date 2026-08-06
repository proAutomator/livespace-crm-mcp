import * as z from "zod/v4";
import { LivespaceError } from "../../livespace/errors.js";

export interface ToolError {
  code: string;
  message: string;
  hint: string;
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
    return { code: error.code, message: error.message, hint: error.hint };
  }
  return {
    code: "UPSTREAM_ERROR",
    message: "Unexpected server error while handling this request.",
    hint: "Retry; report it on the issue tracker if it persists.",
  };
}
