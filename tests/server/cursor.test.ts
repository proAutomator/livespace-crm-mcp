import { describe, expect, test } from "bun:test";
import { LivespaceError } from "../../src/livespace/errors.js";
import {
  decodeCursor,
  encodeCursor,
  type CursorPayload,
} from "../../src/server/cursor.js";

const INVALID_MESSAGE = "The cursor is invalid or from an older server version.";
const INVALID_HINT = "Start again without a cursor.";

/** Independent base64url encoder, so the tests do not lean on the codec itself. */
function b64url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/**
 * Builds a syntactically VALID cursor of an exact length by padding the payload.
 * Unpadded base64 lengths are never `1 mod 4`, so targets must respect that.
 */
function validCursorOfLength(target: number): string {
  for (let pad = 0; pad <= target; pad += 1) {
    const encoded = b64url(
      JSON.stringify({ v: 1, k: "person", o: 40, pad: "x".repeat(pad) }),
    );
    if (encoded.length === target) return encoded;
  }
  throw new Error(`could not build a valid cursor of length ${target}`);
}

function expectInvalid(cursor: string, expectedKind: string): LivespaceError {
  let caught: unknown;
  try {
    decodeCursor(cursor, expectedKind);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(LivespaceError);
  const error = caught as LivespaceError;
  expect(error.code).toBe("BAD_PARAMS");
  expect(error.message).toBe(INVALID_MESSAGE);
  expect(error.hint).toBe(INVALID_HINT);
  return error;
}

describe("encodeCursor", () => {
  test("emits base64url text only - no padding, no + or /", () => {
    for (let offset = 0; offset < 300; offset += 7) {
      const cursor = encodeCursor({ v: 1, k: "company", o: offset });
      expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  test("stays well inside the 512-char schema bound", () => {
    const cursor = encodeCursor({ v: 1, k: "tasks", o: 100_000 });
    expect(cursor.length).toBeLessThanOrEqual(512);
  });
});

describe("decodeCursor round-trip", () => {
  const cases: CursorPayload[] = [
    { v: 1, k: "person", o: 0 },
    { v: 1, k: "company", o: 20 },
    { v: 1, k: "deal", o: 199 },
    { v: 1, k: "crm", o: 40 },
    { v: 1, k: "tasks", o: 50 },
    { v: 1, k: "tasks", o: 100_000 },
  ];

  for (const payload of cases) {
    test(`round-trips ${payload.k} at offset ${payload.o}`, () => {
      expect(decodeCursor(encodeCursor(payload), payload.k)).toEqual(payload);
    });
  }
});

describe("decodeCursor rejections", () => {
  const rows: Array<[label: string, cursor: string, expectedKind: string]> = [
    ["empty string", "", "person"],
    ["whitespace only", "   ", "person"],
    ["non-base64url characters", "not base64!!", "person"],
    ["base64 padding characters", `${b64url('{"v":1,"k":"person","o":0}')}==`, "person"],
    ["standard base64 alphabet", "aGVsbG8/d29ybGQ+", "person"],
    ["valid base64 of invalid JSON", b64url("{not json"), "person"],
    ["valid base64 of empty text", b64url(""), "person"],
    ["JSON null", b64url("null"), "person"],
    ["JSON array", b64url("[]"), "person"],
    ["JSON number", b64url("123"), "person"],
    ["JSON string", b64url('"str"'), "person"],
    ["JSON empty string", b64url('""'), "person"],
    ["version 0", b64url('{"v":0,"k":"person","o":0}'), "person"],
    ["version 2", b64url('{"v":2,"k":"person","o":0}'), "person"],
    ["version as text", b64url('{"v":"1","k":"person","o":0}'), "person"],
    ["version missing", b64url('{"k":"person","o":0}'), "person"],
    ["kind mismatch", b64url('{"v":1,"k":"person","o":0}'), "company"],
    ["kind mismatch across families", b64url('{"v":1,"k":"crm","o":0}'), "tasks"],
    ["kind missing", b64url('{"v":1,"o":0}'), "person"],
    ["kind not a string", b64url('{"v":1,"k":7,"o":0}'), "7"],
    ["offset negative", b64url('{"v":1,"k":"person","o":-1}'), "person"],
    ["offset non-integer", b64url('{"v":1,"k":"person","o":1.5}'), "person"],
    ["offset too large", b64url('{"v":1,"k":"person","o":100001}'), "person"],
    ["offset as text", b64url('{"v":1,"k":"person","o":"10"}'), "person"],
    ["offset missing", b64url('{"v":1,"k":"person"}'), "person"],
    ["offset NaN-ish", b64url('{"v":1,"k":"person","o":null}'), "person"],
  ];

  for (const [label, cursor, expectedKind] of rows) {
    test(`rejects ${label}`, () => {
      expectInvalid(cursor, expectedKind);
    });
  }

  test("rejects raw input longer than 512 chars even when otherwise valid", () => {
    const oversized = validCursorOfLength(516);
    expect(oversized.length).toBe(516);
    expectInvalid(oversized, "person");
  });

  test("accepts a valid cursor sitting exactly on the 512-char bound", () => {
    const atBound = validCursorOfLength(512);
    expect(atBound.length).toBe(512);
    expect(decodeCursor(atBound, "person")).toEqual({ v: 1, k: "person", o: 40 });
  });

  test("never echoes cursor content back into the error", () => {
    const hostile = b64url(
      JSON.stringify({ v: 1, k: "SENSITIVE-synthetic marker", o: 0 }),
    );
    const error = expectInvalid(hostile, "person");
    expect(`${error.message} ${error.hint}`).not.toContain("SENSITIVE-synthetic");
    expect(error.stack ?? "").not.toContain("SENSITIVE-synthetic");
  });
});

describe("decodeCursor boundaries", () => {
  test("accepts offset 0 and the 100000 ceiling", () => {
    expect(decodeCursor(b64url('{"v":1,"k":"crm","o":0}'), "crm")).toEqual({
      v: 1,
      k: "crm",
      o: 0,
    });
    expect(decodeCursor(b64url('{"v":1,"k":"crm","o":100000}'), "crm")).toEqual({
      v: 1,
      k: "crm",
      o: 100_000,
    });
  });

  test("returns a normalized payload without extra keys", () => {
    const cursor = b64url('{"v":1,"k":"deal","o":20,"extra":"synthetic"}');
    expect(decodeCursor(cursor, "deal")).toEqual({ v: 1, k: "deal", o: 20 });
  });
});
