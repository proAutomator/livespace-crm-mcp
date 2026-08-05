import { describe, expect, test } from "bun:test";

describe("tooling", () => {
  test("bun:test and strict TS are wired up", () => {
    const values: readonly number[] = [1, 2, 3];
    expect(values.length).toBe(3);
  });
});
