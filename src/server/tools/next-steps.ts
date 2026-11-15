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
  /**
   * search_crm: further pages exist. get_records: the call asked for no
   * include, so related data is left to ask for.
   */
  hasMore: boolean;
}

const MAX_STEPS = 3;

function searchSteps(context: NextStepContext): string[] {
  if (context.empty) return [];
  const steps: string[] = [];
  if (context.hasMore) {
    steps.push(
      context.kind === undefined
        ? "search_crm with one kind per call and page 2 reads the next page of that kind."
        : "search_crm with the same arguments and page + 1 reads the next page.",
    );
  }
  steps.push("get_records with these ids reads the full records, up to 25 ids per call.");
  if (context.kind === "deal") {
    steps.push(
      'get_records with include ["process", "products", "tasks"] adds a deal\'s steps, budget lines and tasks; ids times (1 + includes) must stay within 60.',
    );
  } else if (context.kind !== "task") {
    steps.push(
      'get_records with include ["notes", "tasks"] adds recent notes and tasks; ids times (1 + includes) must stay within 60.',
    );
  }
  return steps;
}

// No hint names get_activity, analyze or a write tool yet: they still read
// the old API and may not know the ids these tools return.
function recordSteps(context: NextStepContext): string[] {
  if (context.empty) return [];
  const linked =
    'search_crm with kinds ["tasks"] and filters.linkedTo lists every task of a record.';
  if (context.kind === "task") return [linked];
  const steps: string[] = [];
  if (context.hasMore) {
    steps.push(
      context.kind === "deal"
        ? "get_records include adds process, products, budget, notes, calls, emails and tasks in the same call."
        : "get_records include adds notes, calls, emails and tasks in the same call.",
    );
  }
  steps.push(linked);
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
