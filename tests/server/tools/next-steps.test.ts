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

  test("no hint points at a tool that still takes ids of the old API", () => {
    // get_activity and the write tools read the old API until they move; a
    // hint to them would send the model into a not-found answer.
    for (const tool of ["search_crm", "get_records"]) {
      for (const context of contexts()) {
        const steps = nextSteps(tool, context).join(" ");
        for (const other of ["get_activity", "analyze", "update_records", "move_deals"]) {
          expect(steps).not.toContain(other);
        }
      }
    }
  });

  test("a hint never promises more than the call accepts", () => {
    const deal = nextSteps("search_crm", {
      kind: "deal",
      empty: false,
      hasMore: true,
      writesEnabled: false,
    }).join(" ");
    // 25 ids with three includes is 100 requests; the limit is 60.
    expect(deal).not.toMatch(/25 ids[^.]*include/u);
    expect(deal).toContain("60");
    // Without a single kind the next page needs one kind per call.
    const mixed = nextSteps("search_crm", { empty: false, hasMore: true, writesEnabled: false });
    expect(mixed[0]).toContain("one kind");
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

  test("a deal read points at the includes until they were asked for", () => {
    const context = { kind: "deal", empty: false, writesEnabled: false } as const;
    const steps = nextSteps("get_records", { ...context, hasMore: true }).join(" ");
    expect(steps).toContain("include");
    expect(steps).toContain("process");
    // Includes already asked for: the linked tasks are what is left.
    const asked = nextSteps("get_records", { ...context, hasMore: false }).join(" ");
    expect(asked).not.toContain("include adds");
    expect(asked).toContain("linkedTo");
  });

  test("an unknown tool has no next steps", () => {
    expect(
      nextSteps("SYNTHETIC unknown tool", { empty: false, hasMore: true, writesEnabled: true }),
    ).toEqual([]);
  });
});
