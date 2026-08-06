import { describe, expect, test } from "bun:test";
import { LivespaceError } from "../../src/livespace/errors.js";
import {
  asBool,
  asCount,
  asName,
  asRecord,
  unexpectedShape,
  unwrapList,
} from "../../src/livespace/shape.js";

// Every value below is invented. No CRM data, no sandbox values (AGENTS.md).

const badShape = () => unexpectedShape("record");

describe("asName", () => {
  test("passes strings through and turns everything else into an empty string", () => {
    expect(asName("Synthetic")).toBe("Synthetic");
    expect(asName("")).toBe("");
    for (const value of [null, undefined, 7, true, {}, [], { name: "x" }]) {
      expect(asName(value)).toBe("");
    }
  });
});

describe("asRecord", () => {
  test("accepts plain objects and rejects everything else", () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    // PHP serializes an empty map as `[]`, so an array is never a record.
    for (const value of [null, undefined, [], [1], "x", 7, true]) {
      expect(asRecord(value)).toBeNull();
    }
  });
});

describe("asBool", () => {
  test("reads the three truthy spellings upstream uses", () => {
    for (const value of [true, 1, "1"]) expect(asBool(value)).toBe(true);
    for (const value of [false, 0, "0", "", null, undefined, "true", 2]) {
      expect(asBool(value)).toBe(false);
    }
  });
});

describe("asCount", () => {
  test("coerces numbers and numeric strings, and falls back to zero", () => {
    expect(asCount(7)).toBe(7);
    expect(asCount("7")).toBe(7);
    expect(asCount(0)).toBe(0);
    for (const value of [null, undefined, "seven", {}, [1, 2], NaN, Infinity]) {
      expect(asCount(value)).toBe(0);
    }
  });
});

describe("unexpectedShape", () => {
  test("names the subject and carries no upstream content", () => {
    const error = unexpectedShape("activity");
    expect(error).toBeInstanceOf(LivespaceError);
    expect(error.code).toBe("UPSTREAM_ERROR");
    expect(error.message).toBe(
      "Livespace returned an unexpected shape for this activity.",
    );
    expect(error.hint).toBe("Report it on the issue tracker; the API may have changed.");
  });
});

describe("unwrapList", () => {
  test("reads the first key that carries a list", () => {
    expect(unwrapList({ company: [1, 2] }, ["company", "contact"], badShape)).toEqual([
      1, 2,
    ]);
    expect(unwrapList({ contact: [3] }, ["company", "contact"], badShape)).toEqual([3]);
  });

  test("treats the empty payload shapes as an empty page", () => {
    for (const payload of [null, undefined, [], {}, { contact: null }]) {
      expect(unwrapList(payload, ["contact"], badShape)).toEqual([]);
    }
  });

  test("passes a bare array straight through", () => {
    expect(unwrapList([1, 2], ["contact"], badShape)).toEqual([1, 2]);
  });

  test("a wrapper holding something other than a list is a shape error", () => {
    expect(() => unwrapList({ contact: "nope" }, ["contact"], badShape)).toThrow(
      "Livespace returned an unexpected shape for this record.",
    );
    expect(() => unwrapList("nope", ["contact"], badShape)).toThrow(
      "Livespace returned an unexpected shape for this record.",
    );
  });
});
