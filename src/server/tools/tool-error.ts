import { LivespaceError } from "../../livespace/errors.js";

export interface ToolError {
  code: string;
  message: string;
  hint: string;
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
