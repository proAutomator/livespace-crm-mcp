import { describe, expect, test } from "bun:test";
import {
  DAILY_RESERVE_DEFAULT,
  loadLivespaceConfig,
  loadLivespaceV1Config,
  V2_KEY_SHAPE,
} from "../../src/config/env.js";

/** Matches the v2 key shape; the word "synthetic" keeps gitleaks quiet. */
const SYNTHETIC_V2_KEY = "ls_synthetic" + "0".repeat(34);

const VALID = {
  LIVESPACE_SUBDOMAIN: "acme-test",
  LIVESPACE_API_V2_KEY: SYNTHETIC_V2_KEY,
};

const V1_PAIR = {
  LIVESPACE_API_KEY: "synthetic-key-123",
  LIVESPACE_API_SECRET: "synthetic-secret-456",
};

function errorOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return String(error);
  }
  throw new Error("expected the call to throw");
}

describe("loadLivespaceConfig", () => {
  test("returns trimmed config for valid env", () => {
    const config = loadLivespaceConfig({
      ...VALID,
      ...V1_PAIR,
      LIVESPACE_SUBDOMAIN: " acme-test ",
      LIVESPACE_API_V2_KEY: ` ${SYNTHETIC_V2_KEY} `,
    });
    expect(config).toEqual({
      subdomain: "acme-test",
      v2ApiKey: SYNTHETIC_V2_KEY,
      v1: {
        subdomain: "acme-test",
        apiKey: "synthetic-key-123",
        apiSecret: "synthetic-secret-456",
      },
      actingUserEmail: null,
      dailyReserve: 5000,
    });
  });

  test("throws listing every missing required variable name", () => {
    expect(() => loadLivespaceConfig({})).toThrow(
      /LIVESPACE_SUBDOMAIN, LIVESPACE_API_V2_KEY/,
    );
  });

  test("requires LIVESPACE_API_V2_KEY", () => {
    const message = errorOf(() =>
      loadLivespaceConfig({ LIVESPACE_SUBDOMAIN: "acme-test", ...V1_PAIR }),
    );
    expect(message).toContain("LIVESPACE_API_V2_KEY");
    expect(message).toContain("livespace-crm-mcp@0.1");
  });

  test("rejects a malformed v2 key without echoing it", () => {
    const message = errorOf(() =>
      loadLivespaceConfig({ ...VALID, LIVESPACE_API_V2_KEY: "synthetic-not-a-v2-key" }),
    );
    expect(message).toContain("LIVESPACE_API_V2_KEY");
    expect(message).not.toContain("synthetic-not-a-v2-key");
  });

  test.each([
    "ls_synthetic" + "0".repeat(33),
    "ls_synthetic" + "0".repeat(35),
    "LS_synthetic" + "0".repeat(34),
    "ls_synthetic" + "0".repeat(33) + "!",
  ])("rejects a v2 key of the wrong shape %#", (key) => {
    expect(() => loadLivespaceConfig({ ...VALID, LIVESPACE_API_V2_KEY: key })).toThrow(
      /LIVESPACE_API_V2_KEY/,
    );
  });

  test("accepts the synthetic v2 key", () => {
    expect(V2_KEY_SHAPE.test(SYNTHETIC_V2_KEY)).toBe(true);
    expect(loadLivespaceConfig(VALID).v2ApiKey).toBe("ls_synthetic" + "0".repeat(34));
  });

  test("v1 credentials are optional but come as a pair", () => {
    expect(loadLivespaceConfig(VALID).v1).toBeNull();
    const onlyKey = errorOf(() =>
      loadLivespaceConfig({ ...VALID, LIVESPACE_API_KEY: "synthetic-key-123" }),
    );
    expect(onlyKey).toContain("LIVESPACE_API_SECRET");
    expect(onlyKey).not.toContain("synthetic-key-123");
    const onlySecret = errorOf(() =>
      loadLivespaceConfig({ ...VALID, LIVESPACE_API_SECRET: "synthetic-secret-456" }),
    );
    expect(onlySecret).toContain("LIVESPACE_API_KEY");
    expect(onlySecret).not.toContain("synthetic-secret-456");
    // Blank values count as absent, so a pair of blanks is no pair at all.
    expect(
      loadLivespaceConfig({ ...VALID, LIVESPACE_API_KEY: " ", LIVESPACE_API_SECRET: "" }).v1,
    ).toBeNull();
  });

  test("acting user email is optional, trimmed and shape-checked", () => {
    expect(loadLivespaceConfig(VALID).actingUserEmail).toBeNull();
    expect(
      loadLivespaceConfig({ ...VALID, LIVESPACE_ACTING_USER_EMAIL: " a@b.pl " })
        .actingUserEmail,
    ).toBe("a@b.pl");
    const message = errorOf(() =>
      loadLivespaceConfig({ ...VALID, LIVESPACE_ACTING_USER_EMAIL: "not-an-email" }),
    );
    expect(message).toContain("LIVESPACE_ACTING_USER_EMAIL");
    expect(message).not.toContain("not-an-email");
  });

  test("daily reserve defaults to 5000, accepts 0, rejects -1, 1.5 and 1000001", () => {
    expect(DAILY_RESERVE_DEFAULT).toBe(5000);
    expect(loadLivespaceConfig(VALID).dailyReserve).toBe(5000);
    expect(
      loadLivespaceConfig({ ...VALID, LIVESPACE_V2_DAILY_RESERVE: "0" }).dailyReserve,
    ).toBe(0);
    expect(
      loadLivespaceConfig({ ...VALID, LIVESPACE_V2_DAILY_RESERVE: " 1000000 " }).dailyReserve,
    ).toBe(1_000_000);
    for (const raw of ["-1", "1.5", "1000001", "1e3", "abc"]) {
      expect(() =>
        loadLivespaceConfig({ ...VALID, LIVESPACE_V2_DAILY_RESERVE: raw }),
      ).toThrow(/LIVESPACE_V2_DAILY_RESERVE/);
    }
  });

  test("never echoes provided values in errors", () => {
    const message = errorOf(() =>
      loadLivespaceConfig({ ...VALID, LIVESPACE_SUBDOMAIN: "https://acme.livespace.io" }),
    );
    expect(message).not.toContain("acme.livespace.io");
    expect(message).toContain("LIVESPACE_SUBDOMAIN");
  });

  test.each(["https://acme.livespace.io", "acme.livespace.io", "acme test", ""])(
    "rejects invalid subdomain %p",
    (subdomain) => {
      expect(() => loadLivespaceConfig({ ...VALID, LIVESPACE_SUBDOMAIN: subdomain })).toThrow();
    },
  );
});

describe("loadLivespaceV1Config", () => {
  test("the v1 smoke needs the subdomain and the full pair, not a v2 key", () => {
    expect(
      loadLivespaceV1Config({ LIVESPACE_SUBDOMAIN: " acme-test ", ...V1_PAIR }),
    ).toEqual({
      subdomain: "acme-test",
      apiKey: "synthetic-key-123",
      apiSecret: "synthetic-secret-456",
    });
    expect(() => loadLivespaceV1Config({ LIVESPACE_SUBDOMAIN: "acme-test" })).toThrow(
      /LIVESPACE_API_KEY, LIVESPACE_API_SECRET/,
    );
    const message = errorOf(() =>
      loadLivespaceV1Config({ ...V1_PAIR, LIVESPACE_SUBDOMAIN: "https://acme.livespace.io" }),
    );
    expect(message).toContain("LIVESPACE_SUBDOMAIN");
    expect(message).not.toContain("acme.livespace.io");
  });
});
