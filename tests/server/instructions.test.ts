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

  test("names the read tools and where their ids come from", () => {
    const text = buildInstructions({ readOnly: false });
    expect(text).toContain("search_crm");
    expect(text).toContain("get_records");
    expect(text).toContain("get_activity");
    expect(text).toContain("Ids come from search results and crm_metadata");
    expect(text).not.toContain("Search, records, activity");
  });

  test("the data-not-instructions warning covers walls and imported e-mail", () => {
    const text = buildInstructions({ readOnly: false });
    expect(text).toContain("wall");
    expect(text).toContain("e-mail");
  });

  test("warns that hand-kept deal values and dates may be empty", () => {
    expect(buildInstructions({ readOnly: false })).toContain("not filled in");
  });

  test("read-only mode is announced when active", () => {
    expect(buildInstructions({ readOnly: true })).toContain("read-only");
    expect(buildInstructions({ readOnly: false })).not.toContain(
      "read-only mode is ON",
    );
  });
});
