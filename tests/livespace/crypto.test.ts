import { describe, expect, test } from "bun:test";
import { buildSignature, sha1Hex } from "../../src/livespace/crypto.js";

describe("sha1Hex", () => {
  test("matches the known SHA-1 vector for 'abc'", async () => {
    expect(await sha1Hex("abc")).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
  });

  test("matches the known SHA-1 vector for the empty string", async () => {
    expect(await sha1Hex("")).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709");
  });
});

describe("buildSignature", () => {
  test("is SHA1(apiKey + token + apiSecret)", async () => {
    expect(await buildSignature("a", "b", "c")).toBe(await sha1Hex("abc"));
  });
});
