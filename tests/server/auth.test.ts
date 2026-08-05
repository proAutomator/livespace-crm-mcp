import { describe, expect, test } from "bun:test";
import { principalFromToken, tokensEqual } from "../../src/server/auth.js";

describe("tokensEqual", () => {
  test("equal tokens compare true, different tokens false", async () => {
    expect(await tokensEqual("synthetic-token-a", "synthetic-token-a")).toBe(true);
    expect(await tokensEqual("synthetic-token-a", "synthetic-token-b")).toBe(false);
    expect(await tokensEqual("synthetic-token-a", "synthetic-token-a-longer")).toBe(
      false,
    );
  });
});

describe("principalFromToken", () => {
  test("is deterministic and never contains the raw token", async () => {
    const principal = await principalFromToken("synthetic-bearer-token");
    expect(principal).toMatch(/^bearer:[0-9a-f]{16}$/);
    expect(principal).not.toContain("synthetic-bearer-token");
    expect(await principalFromToken("synthetic-bearer-token")).toBe(principal);
    expect(await principalFromToken("synthetic-other-token")).not.toBe(principal);
  });
});
