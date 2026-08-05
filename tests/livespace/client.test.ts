import { describe, expect, test } from "bun:test";
import { LivespaceClient } from "../../src/livespace/client.js";
import { LivespaceError } from "../../src/livespace/errors.js";
import type { LivespaceConfig } from "../../src/config/env.js";

const CONFIG: LivespaceConfig = {
  subdomain: "acme-test",
  apiKey: "synthetic-key",
  apiSecret: "synthetic-secret",
};

type Call = { url: string; body: URLSearchParams };

function envelope(data: unknown, result = 200, status = true): Response {
  return new Response(JSON.stringify({ data, error: null, result, status }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function tokenEnvelope(): Response {
  return envelope({ token: "tok-1", session_id: "sess-1" });
}

function makeFetch(responses: Response[], calls: Call[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: new URLSearchParams(String(init?.body ?? "")),
    });
    const next = responses.shift();
    if (!next) throw new Error("test fetch: no more queued responses");
    return next;
  }) as typeof fetch;
}

function makeClient(responses: Response[], calls: Call[]) {
  return new LivespaceClient(CONFIG, {
    fetchImpl: makeFetch(responses, calls),
    sleep: async () => {},
  });
}

describe("LivespaceClient.call", () => {
  test("performs getToken then the signed call and returns envelope data", async () => {
    const calls: Call[] = [];
    const client = makeClient(
      [tokenEnvelope(), envelope({ items: [1, 2, 3] })],
      calls,
    );

    const data = await client.call<{ items: number[] }>("Contact", "getAll", {
      type: "company",
      limit: 5,
    });

    expect(data).toEqual({ items: [1, 2, 3] });
    expect(calls.length).toBe(2);
    expect(calls[0]?.url).toBe(
      "https://acme-test.livespace.io/api/public/json/_Api/auth_call/_api_method/getToken",
    );
    expect(calls[1]?.url).toBe(
      "https://acme-test.livespace.io/api/public/json/Contact/getAll",
    );
    expect(calls[1]?.body.get("_api_auth")).toBe("key");
    expect(calls[1]?.body.get("_api_key")).toBe("synthetic-key");
    expect(calls[1]?.body.get("_api_session")).toBe("sess-1");
    expect(calls[1]?.body.get("_api_sha")).toMatch(/^[0-9a-f]{40}$/);
    expect(JSON.parse(calls[1]?.body.get("data") ?? "{}")).toEqual({
      type: "company",
      limit: 5,
    });
  });

  test("fetches a fresh token for every logical call", async () => {
    const calls: Call[] = [];
    const client = makeClient(
      [tokenEnvelope(), envelope({}), tokenEnvelope(), envelope({})],
      calls,
    );

    await client.call("Default", "ping");
    await client.call("Default", "ping");

    expect(calls.map((c) => c.url.endsWith("getToken"))).toEqual([
      true,
      false,
      true,
      false,
    ]);
  });

  test("maps business errors and never leaks the envelope body", async () => {
    const calls: Call[] = [];
    const client = makeClient(
      [tokenEnvelope(), envelope({ internal: "SENSITIVE-DETAIL" }, 540, false)],
      calls,
    );

    try {
      await client.call("Deal", "get", { id: "x" });
      throw new Error("expected call to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(LivespaceError);
      const le = error as LivespaceError;
      expect(le.code).toBe("PERMISSION_DENIED");
      expect(le.message).not.toContain("SENSITIVE-DETAIL");
      expect(le.hint).not.toContain("SENSITIVE-DETAIL");
    }
  });

  test("retries HTTP 5xx with backoff and then succeeds", async () => {
    const calls: Call[] = [];
    const sleeps: number[] = [];
    const client = new LivespaceClient(CONFIG, {
      fetchImpl: makeFetch(
        [
          new Response("bad gateway", { status: 502 }),
          tokenEnvelope(),
          envelope({ ok: true }),
        ],
        calls,
      ),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const data = await client.call<{ ok: boolean }>("Default", "ping");

    expect(data).toEqual({ ok: true });
    expect(sleeps).toEqual([200]);
    expect(calls.length).toBe(3);
  });

  test("gives up after maxAttempts with a mapped error", async () => {
    const calls: Call[] = [];
    const client = new LivespaceClient(CONFIG, {
      fetchImpl: makeFetch(
        [
          new Response("x", { status: 500 }),
          new Response("x", { status: 500 }),
          new Response("x", { status: 500 }),
        ],
        calls,
      ),
      maxAttempts: 3,
      sleep: async () => {},
    });

    await expect(client.call("Default", "ping")).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
    });
    expect(calls.length).toBe(3);
  });
});
