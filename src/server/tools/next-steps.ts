import type { V2Kind } from "../../livespace/v2/records.js";

/**
 * Next-step hints for the read tools: what a model usually wants after this
 * answer, named as the tool and argument to use.
 *
 * Every string here is written by this server. The function takes no record
 * and no CRM text, so a hint cannot carry any (docs/security.md par. 4).
 */

export interface NextStepContext {
  /** The record kind of the answer, when it has exactly one. */
  kind?: V2Kind;
  /** True when the answer carries no record. */
  empty: boolean;
  /**
   * Whether the write tools are listed. The write tools still take ids of the
   * old API until they move to API v2, so no hint points at them yet.
   */
  writesEnabled: boolean;
  /** True when further pages exist. */
  hasMore: boolean;
}

const MAX_STEPS = 3;

function searchSteps(context: NextStepContext): string[] {
  if (context.empty) return [];
  const steps: string[] = [];
  if (context.hasMore) {
    steps.push("search_crm with the same arguments and page + 1 reads the next page.");
  }
  steps.push("get_records with these ids reads the full records, up to 25 ids per call.");
  if (context.kind === "deal") {
    steps.push(
      'get_records with include ["process", "products", "tasks"] adds a deal\'s steps, budget lines and tasks.',
    );
  } else if (context.kind !== "task") {
    steps.push('get_records with include ["notes", "tasks"] adds recent notes and tasks.');
  }
  return steps;
}

function recordSteps(context: NextStepContext): string[] {
  if (context.empty) return [];
  if (context.kind === "task") {
    return ['search_crm with kinds ["tasks"] and filters.linkedTo lists the other tasks of a record.'];
  }
  const steps: string[] = [];
  if (context.kind === "deal") {
    steps.push(
      "get_records include adds process, products, budget, notes, calls, emails and tasks in the same call.",
    );
  } else {
    steps.push("get_records include adds notes, calls, emails and tasks in the same call.");
  }
  steps.push('get_activity with source "record" reads a longer history of one record.');
  return steps;
}

/** At most three fixed hints for the model, most useful first. */
export function nextSteps(tool: string, context: NextStepContext): string[] {
  const steps =
    tool === "search_crm"
      ? searchSteps(context)
      : tool === "get_records"
        ? recordSteps(context)
        : [];
  return steps.slice(0, MAX_STEPS);
}
