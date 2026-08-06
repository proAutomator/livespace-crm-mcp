import { describe, expect, test } from "bun:test";
import { errorFromEnvelope, LivespaceError } from "../../src/livespace/errors.js";

describe("errorFromEnvelope", () => {
  test("maps 540 to PERMISSION_DENIED with an actionable hint", () => {
    const error = errorFromEnvelope(540);
    expect(error).toBeInstanceOf(LivespaceError);
    expect(error.code).toBe("PERMISSION_DENIED");
    expect(error.resultCode).toBe(540);
    expect(error.message).toContain("permission");
    expect(error.hint).toContain("Livespace");
  });

  test("maps 562 to AUTH_FAILED pointing at the API key", () => {
    const error = errorFromEnvelope(562);
    expect(error.code).toBe("AUTH_FAILED");
    expect(error.hint).toContain("LIVESPACE_API_KEY");
  });

  test("maps 550 to BAD_PARAMS and mentions the getAll condition rule", () => {
    const error = errorFromEnvelope(550);
    expect(error.code).toBe("BAD_PARAMS");
    expect(error.hint).toContain("at least one condition");
  });

  test("unknown codes fall back to UPSTREAM_ERROR and keep the code", () => {
    const error = errorFromEnvelope(999);
    expect(error.code).toBe("UPSTREAM_ERROR");
    expect(error.message).toContain("999");
  });

  test("a non-numeric result code is sanitized out of the message", () => {
    const error = errorFromEnvelope("DROP TABLE (synthetic)" as never);
    expect(error.code).toBe("UPSTREAM_ERROR");
    expect(error.message).toContain("unknown");
    expect(error.message).not.toContain("DROP TABLE");
    expect(error.message).not.toContain("synthetic");
  });

  test("is structurally unable to leak envelope bodies", () => {
    // The factory accepts only the numeric result code - there is no
    // parameter through which upstream body content could enter the error.
    expect(errorFromEnvelope.length).toBe(1);
  });
});
