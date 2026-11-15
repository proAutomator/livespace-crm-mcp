import { describe, expect, test } from "bun:test";
import { nextSteps, type NextStepContext } from "../../../src/server/tools/next-steps.js";

const KINDS = [undefined, "person", "company", "deal", "task"] as const;

function contexts(): NextStepContext[] {
  const all: NextStepContext[] = [];
  for (const kind of KINDS) {
    for (const empty of [true, false]) {
      for (const hasMore of [true, false]) {
        for (const writesEnabled of [true, false]) {
          all.push({ ...(kind === undefined ? {} : { kind }), empty, hasMore, writesEnabled });
        }
      }
    }
  }
  return all;
}

describe("nextSteps", () => {
  test("answers at most three fixed strings for every tool and context", () => {
    for (const tool of ["search_crm", "get_records", "SYNTHETIC unknown tool"]) {
      for (const context of contexts()) {
        const steps = nextSteps(tool, context);
        expect(steps.length).toBeLessThanOrEqual(3);
        for (const step of steps) {
          expect(step.length).toBeGreaterThan(0);
          expect(step.length).toBeLessThanOrEqual(200);
        }
        expect(new Set(steps).size).toBe(steps.length);
      }
    }
  });

  test("a search with more pages points at the next page first", () => {
    const steps = nextSteps("search_crm", {
      kind: "deal",
      empty: false,
      hasMore: true,
      writesEnabled: false,
    });
    expect(steps[0]).toContain("page");
    expect(steps.join(" ")).toContain("get_records");
  });

  test("an empty result suggests nothing to read", () => {
    expect(
      nextSteps("search_crm", { kind: "deal", empty: true, hasMore: false, writesEnabled: true }),
    ).toEqual([]);
    expect(
      nextSteps("get_records", { kind: "deal", empty: true, hasMore: false, writesEnabled: true }),
    ).toEqual([]);
  });

  test("a deal read points at the includes and the history", () => {
    const context = { kind: "deal", empty: false, writesEnabled: false } as const;
    const steps = nextSteps("get_records", { ...context, hasMore: true }).join(" ");
    expect(steps).toContain("include");
    expect(steps).toContain("get_activity");
    // Includes already asked for: only the history is left to point at.
    const asked = nextSteps("get_records", { ...context, hasMore: false }).join(" ");
    expect(asked).not.toContain("include");
    expect(asked).toContain("get_activity");
  });

  test("a task read has no history to point at", () => {
    const steps = nextSteps("get_records", {
      kind: "task",
      empty: false,
      hasMore: false,
      writesEnabled: false,
    }).join(" ");
    expect(steps).not.toContain("get_activity");
  });

  test("an unknown tool has no next steps", () => {
    expect(
      nextSteps("SYNTHETIC unknown tool", { empty: false, hasMore: true, writesEnabled: true }),
    ).toEqual([]);
  });
});
