import { describe, expect, test } from "bun:test";
import { buildInstructions } from "../../src/server/instructions.js";

describe("buildInstructions", () => {
  test("contains the operating-manual anchors", () => {
    const text = buildInstructions({ readOnly: false });
    expect(text).toContain("Livespace");
    expect(text).toContain("CRITICAL");
    expect(text).toContain("health");
    expect(text.length).toBeGreaterThan(200);
  });

  test("read-only mode is announced when active", () => {
    expect(buildInstructions({ readOnly: true })).toContain("read-only");
    expect(buildInstructions({ readOnly: false })).not.toContain(
      "read-only mode is ON",
    );
  });
});
