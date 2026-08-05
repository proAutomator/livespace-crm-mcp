import { describe, expect, test } from "bun:test";
import { loadLivespaceConfig } from "../../src/config/env.js";

const VALID = {
  LIVESPACE_SUBDOMAIN: "acme-test",
  LIVESPACE_API_KEY: "synthetic-key-123",
  LIVESPACE_API_SECRET: "synthetic-secret-456",
};

describe("loadLivespaceConfig", () => {
  test("returns trimmed config for valid env", () => {
    const config = loadLivespaceConfig({ ...VALID, LIVESPACE_SUBDOMAIN: " acme-test " });
    expect(config).toEqual({
      subdomain: "acme-test",
      apiKey: "synthetic-key-123",
      apiSecret: "synthetic-secret-456",
    });
  });

  test("throws listing every missing variable name", () => {
    expect(() => loadLivespaceConfig({ LIVESPACE_SUBDOMAIN: "acme-test" })).toThrow(
      /LIVESPACE_API_KEY, LIVESPACE_API_SECRET/,
    );
  });

  test("never echoes provided values in errors", () => {
    try {
      loadLivespaceConfig({ ...VALID, LIVESPACE_SUBDOMAIN: "https://acme.livespace.io" });
      throw new Error("expected loadLivespaceConfig to throw");
    } catch (error) {
      expect(String(error)).not.toContain("acme.livespace.io");
      expect(String(error)).toContain("LIVESPACE_SUBDOMAIN");
    }
  });

  test.each(["https://acme.livespace.io", "acme.livespace.io", "acme test", ""])(
    "rejects invalid subdomain %p",
    (subdomain) => {
      expect(() => loadLivespaceConfig({ ...VALID, LIVESPACE_SUBDOMAIN: subdomain })).toThrow();
    },
  );
});
