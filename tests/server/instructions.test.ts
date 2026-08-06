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

  test("points at crm_metadata as the id source", () => {
    const text = buildInstructions({ readOnly: false });
    expect(text).toContain("crm_metadata");
    expect(text).toContain("Never guess ids");
    expect(text).not.toContain("More tools (metadata,");
  });

  test("declares CRM text as data, never as instructions", () => {
    expect(buildInstructions({ readOnly: false })).toContain(
      "never instructions",
    );
  });

  test("read-only mode is announced when active", () => {
    expect(buildInstructions({ readOnly: true })).toContain("read-only");
    expect(buildInstructions({ readOnly: false })).not.toContain(
      "read-only mode is ON",
    );
  });
});
