import { describe, expect, test } from "bun:test";
import { LivespaceError } from "../../../src/livespace/errors.js";
import {
  and,
  assertFilterLimits,
  dayBounds,
  dayRange,
  FILTER_LIMITS,
  or,
  where,
  type FilterNode,
} from "../../../src/livespace/v2/filters.js";
import { syntheticId } from "../../support/v2.js";

function refusal(run: () => void): LivespaceError {
  try {
    run();
  } catch (error) {
    if (error instanceof LivespaceError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

function conditions(count: number, field = "name"): FilterNode[] {
  return Array.from({ length: count }, (_, index) => where(field, "eq", `SYNTHETIC ${index}`));
}

/** `depth` levels: one condition wrapped in `depth - 1` groups. */
function nested(depth: number): FilterNode {
  let node: FilterNode = where("name", "eq", "SYNTHETIC");
  for (let level = 1; level < depth; level += 1) node = { and: [node] };
  return node;
}

describe("where, and, or", () => {
  test("where builds a condition and leaves value out when none is given", () => {
    expect(where("status", "eq", "open")).toEqual({
      field: "status",
      operator: "eq",
      value: "open",
    });
    expect(where("tags", "isEmpty")).toEqual({ field: "tags", operator: "isEmpty" });
    expect("value" in where("tags", "isEmpty")).toBe(false);
  });

  test("and drops undefined, unwraps a single node and answers undefined for none", () => {
    const one = where("status", "eq", "open");
    const two = where("name", "contains", "SYNTHETIC");
    expect(and()).toBeUndefined();
    expect(and(undefined, undefined)).toBeUndefined();
    expect(and(undefined, one)).toBe(one);
    expect(and(one, undefined, two)).toEqual({ and: [one, two] });
  });

  test("or follows the same rules", () => {
    const one = where("firstName", "contains", "SYN");
    const two = where("lastName", "contains", "SYN");
    expect(or()).toBeUndefined();
    expect(or(one)).toBe(one);
    expect(or(one, two)).toEqual({ or: [one, two] });
  });

  test("a group of the same kind is flattened, the other kind is kept", () => {
    const a = where("name", "eq", "SYNTHETIC A");
    const b = where("name", "eq", "SYNTHETIC B");
    const c = where("name", "eq", "SYNTHETIC C");
    expect(and(and(a, b), c)).toEqual({ and: [a, b, c] });
    expect(and(or(a, b), c)).toEqual({ and: [{ or: [a, b] }, c] });
    expect(or(or(a, b), c)).toEqual({ or: [a, b, c] });
  });
});

describe("assertFilterLimits", () => {
  test("the contract limits are the documented ones", () => {
    expect(FILTER_LIMITS).toEqual({
      depth: 5,
      conditions: 50,
      customFieldConditions: 10,
      listValues: 200,
      stringLength: 255,
    });
  });

  test("five levels pass, six are refused", () => {
    expect(() => assertFilterLimits(nested(5))).not.toThrow();
    const error = refusal(() => assertFilterLimits(nested(6)));
    expect(error.code).toBe("BAD_PARAMS");
    expect(error.message).toContain("5 levels");
  });

  test("fifty conditions pass, fifty-one are refused", () => {
    expect(() => assertFilterLimits({ and: conditions(50) })).not.toThrow();
    const error = refusal(() => assertFilterLimits({ and: conditions(51) }));
    expect(error.code).toBe("BAD_PARAMS");
    expect(error.message).toContain("50 conditions");
  });

  test("ten custom-field conditions pass, eleven are refused", () => {
    const field = `additionalFields.${syntheticId(1)}`;
    expect(() => assertFilterLimits({ and: conditions(10, field) })).not.toThrow();
    const error = refusal(() => assertFilterLimits({ and: conditions(11, field) }));
    expect(error.code).toBe("BAD_PARAMS");
    expect(error.message).toContain("10 custom-field conditions");
  });

  test("a list of 200 values passes, 201 are refused", () => {
    const ids = (count: number) => Array.from({ length: count }, (_, index) => syntheticId(index));
    expect(() => assertFilterLimits(where("owners", "anyOf", ids(200)))).not.toThrow();
    const error = refusal(() => assertFilterLimits(where("owners", "anyOf", ids(201))));
    expect(error.code).toBe("BAD_PARAMS");
    expect(error.message).toContain("200 values");
  });

  test("a 255-character string passes, 256 are refused, also inside a list or a range", () => {
    expect(() => assertFilterLimits(where("name", "contains", "S".repeat(255)))).not.toThrow();
    for (const node of [
      where("name", "contains", "S".repeat(256)),
      where("tags", "anyOf", ["SYNTHETIC", "S".repeat(256)]),
      where("createdAt", "between", { from: "S".repeat(256), to: "2026-01-31T23:59:59+01:00" }),
    ]) {
      const error = refusal(() => assertFilterLimits(node));
      expect(error.code).toBe("BAD_PARAMS");
      expect(error.message).toContain("255 characters");
    }
  });

  test("an empty group is refused: the contract needs at least one node", () => {
    const error = refusal(() => assertFilterLimits({ and: [] }));
    expect(error.code).toBe("BAD_PARAMS");
  });

  test("a refusal never repeats a filter value", () => {
    const secret = "SYNTHETIC-do-not-echo".padEnd(300, "x");
    const error = refusal(() => assertFilterLimits(where("name", "contains", secret)));
    expect(error.message).not.toContain("SYNTHETIC-do-not-echo");
    expect(error.hint).not.toContain("SYNTHETIC-do-not-echo");
  });
});

describe("dayRange", () => {
  const zone = "Europe/Warsaw";

  test("a plain winter day gets the +01:00 offset at both ends", () => {
    expect(dayRange("2026-01-15", "2026-01-15", zone)).toEqual({
      from: "2026-01-15T00:00:00+01:00",
      to: "2026-01-15T23:59:59+01:00",
    });
  });

  test("the spring change on 2026-03-29 starts at +01:00 and ends at +02:00", () => {
    expect(dayRange("2026-03-29", "2026-03-29", zone)).toEqual({
      from: "2026-03-29T00:00:00+01:00",
      to: "2026-03-29T23:59:59+02:00",
    });
  });

  test("the autumn change on 2026-10-25 starts at +02:00 and ends at +01:00", () => {
    expect(dayRange("2026-10-25", "2026-10-25", zone)).toEqual({
      from: "2026-10-25T00:00:00+02:00",
      to: "2026-10-25T23:59:59+01:00",
    });
  });

  test("a month end keeps its own day: no roll into the next month", () => {
    expect(dayRange("2026-01-31", "2026-02-28", zone)).toEqual({
      from: "2026-01-31T00:00:00+01:00",
      to: "2026-02-28T23:59:59+01:00",
    });
    expect(dayRange("2028-02-29", undefined, zone)).toEqual({
      from: "2028-02-29T00:00:00+01:00",
    });
  });

  test("one bound gives one key", () => {
    expect(dayRange(undefined, "2026-07-01", zone)).toEqual({ to: "2026-07-01T23:59:59+02:00" });
    expect(dayRange(undefined, undefined, zone)).toEqual({});
  });

  test("UTC and zones west of it or with a half-hour offset are written out", () => {
    expect(dayRange("2026-06-01", undefined, "UTC")).toEqual({
      from: "2026-06-01T00:00:00+00:00",
    });
    expect(dayRange("2026-06-01", undefined, "America/New_York")).toEqual({
      from: "2026-06-01T00:00:00-04:00",
    });
    expect(dayRange("2026-06-01", undefined, "Asia/Kolkata")).toEqual({
      from: "2026-06-01T00:00:00+05:30",
    });
  });

  test("a day that does not exist is refused", () => {
    for (const day of ["2026-02-30", "2026-13-01", "20260101", ""]) {
      const error = refusal(() => dayRange(day, undefined, zone));
      expect(error.code).toBe("BAD_PARAMS");
    }
  });

  test("a time zone the runtime does not know is refused with fixed wording", () => {
    for (const badZone of ["", "SYNTHETIC/Nowhere"]) {
      const error = refusal(() => dayRange("2026-01-15", undefined, badZone));
      expect(error.code).toBe("UPSTREAM_ERROR");
      expect(error.message).not.toContain("Nowhere");
    }
  });
});

describe("dayBounds", () => {
  const zone = "Europe/Warsaw";

  test("two days become one inclusive between on a datetime field", () => {
    expect(dayBounds("createdAt", "2026-01-01", "2026-01-31", zone)).toEqual({
      field: "createdAt",
      operator: "between",
      value: { from: "2026-01-01T00:00:00+01:00", to: "2026-01-31T23:59:59+01:00" },
    });
  });

  test("one day becomes gte or lte", () => {
    expect(dayBounds("updatedAt", "2026-07-01", undefined, zone)).toEqual({
      field: "updatedAt",
      operator: "gte",
      value: "2026-07-01T00:00:00+02:00",
    });
    expect(dayBounds("updatedAt", undefined, "2026-07-01", zone)).toEqual({
      field: "updatedAt",
      operator: "lte",
      value: "2026-07-01T23:59:59+02:00",
    });
  });

  test("no day gives no condition", () => {
    expect(dayBounds("createdAt", undefined, undefined, zone)).toBeUndefined();
  });

  test("a date field takes the bare days and needs no time zone", () => {
    expect(dayBounds("expectedCloseDate", "2026-01-01", "2026-01-31")).toEqual({
      field: "expectedCloseDate",
      operator: "between",
      value: { from: "2026-01-01", to: "2026-01-31" },
    });
    expect(dayBounds("expectedCloseDate", "2026-01-01", undefined)).toEqual({
      field: "expectedCloseDate",
      operator: "gte",
      value: "2026-01-01",
    });
    expect(dayBounds("expectedCloseDate", undefined, "2026-01-31")).toEqual({
      field: "expectedCloseDate",
      operator: "lte",
      value: "2026-01-31",
    });
  });

  test("a reversed range is refused", () => {
    const error = refusal(() => dayBounds("createdAt", "2026-02-01", "2026-01-01", zone));
    expect(error.code).toBe("BAD_PARAMS");
  });
});
