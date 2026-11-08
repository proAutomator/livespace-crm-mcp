import { describe, expect, test } from "bun:test";
import { LivespaceError } from "../../../src/livespace/errors.js";
import { toolErrorSchema, toToolError } from "../../../src/server/tools/tool-error.js";

const GENERIC = {
  code: "UPSTREAM_ERROR",
  message: "Unexpected server error while handling this request.",
  hint: "Retry; report it on the issue tracker if it persists.",
};

describe("toToolError", () => {
  test("a LivespaceError passes its own mapped fields through", () => {
    const error = new LivespaceError(
      "PERMISSION_DENIED",
      "The API key's user lacks permission for this record or action (540).",
      "Use a record the key's user can access.",
      540,
    );

    expect(toToolError(error)).toEqual({
      code: "PERMISSION_DENIED",
      message: "The API key's user lacks permission for this record or action (540).",
      hint: "Use a record the key's user can access.",
    });
  });

  test("toToolError copies fields and requestId from LivespaceError details", () => {
    const error = new LivespaceError(
      "VALIDATION_ERROR",
      "Livespace API v2 rejected the request as invalid (400).",
      "Fix the listed fields.",
      undefined,
      undefined,
      false,
      { fields: ["/perPage", "/filters/0"], requestId: "0123456789abcdef0123456789abcdef" },
    );

    const entry = toToolError(error);
    expect(entry).toEqual({
      code: "VALIDATION_ERROR",
      message: "Livespace API v2 rejected the request as invalid (400).",
      hint: "Fix the listed fields.",
      fields: ["/perPage", "/filters/0"],
      requestId: "0123456789abcdef0123456789abcdef",
    });
    expect(toolErrorSchema.parse(entry)).toEqual(entry);
  });

  test("a LivespaceError without details adds no keys", () => {
    const entry = toToolError(new LivespaceError("NOT_FOUND", "synthetic", "synthetic"));
    expect(Object.keys(entry).sort()).toEqual(["code", "hint", "message"]);
  });

  test("the schema bounds fields and pins the request id shape", () => {
    const base = { code: "X", message: "synthetic", hint: "synthetic" };
    expect(toolErrorSchema.safeParse({ ...base, requestId: "SYNTHETIC" }).success).toBe(false);
    expect(
      toolErrorSchema.safeParse({ ...base, fields: Array.from({ length: 21 }, () => "/a") })
        .success,
    ).toBe(false);
  });

  test("anything else becomes the fixed generic entry", () => {
    const leaky = new Error("SENSITIVE-synthetic upstream body");
    leaky.stack = "Error: SENSITIVE-synthetic upstream body\n    at synthetic";

    const entry = toToolError(leaky);

    expect(entry).toEqual(GENERIC);
    expect(JSON.stringify(entry)).not.toContain("SENSITIVE-synthetic");
  });

  test("non-Error throws map to the generic entry too", () => {
    const thrown: unknown[] = [
      "SENSITIVE-synthetic string reason",
      7,
      null,
      undefined,
      { message: "SENSITIVE-synthetic object" },
      ["SENSITIVE-synthetic array"],
    ];

    for (const value of thrown) {
      const entry = toToolError(value);
      expect(entry).toEqual(GENERIC);
      expect(JSON.stringify(entry)).not.toContain("SENSITIVE-synthetic");
    }
  });

  test("the entry carries no section field and no extra keys", () => {
    expect(Object.keys(toToolError(new Error("synthetic"))).sort()).toEqual([
      "code",
      "hint",
      "message",
    ]);
  });
});
