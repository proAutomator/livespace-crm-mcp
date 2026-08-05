import { describe, expect, test } from "bun:test";
import { readBodyWithCap } from "../../src/server/body-limit.js";

const CAP = 1024;

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe("readBodyWithCap", () => {
  test("declared oversize is rejected without reading the stream", async () => {
    const request = new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "content-length": String(CAP + 1) },
      body: "tiny",
    });
    const result = await readBodyWithCap(request, CAP);
    expect(result.kind).toBe("too_large");
  });

  test("stream exceeding the cap without Content-Length is rejected", async () => {
    const big = new Uint8Array(CAP + 1).fill(120);
    const request = new Request("http://localhost/mcp", {
      method: "POST",
      body: streamOf([big.slice(0, 600), big.slice(600)]),
    });
    const result = await readBodyWithCap(request, CAP);
    expect(result.kind).toBe("too_large");
  });

  test("body under the cap round-trips byte for byte", async () => {
    const payload = new TextEncoder().encode('{"jsonrpc":"2.0"}');
    const request = new Request("http://localhost/mcp", {
      method: "POST",
      body: streamOf([payload]),
    });
    const result = await readBodyWithCap(request, CAP);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.body).not.toBeNull();
      expect(new TextDecoder().decode(result.body!)).toBe('{"jsonrpc":"2.0"}');
    }
  });

  test("request without a body passes through as null", async () => {
    const request = new Request("http://localhost/mcp", { method: "POST" });
    const result = await readBodyWithCap(request, CAP);
    expect(result).toEqual({ kind: "ok", body: null });
  });
});
