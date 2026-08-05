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
    // Livespace expects auth fields INSIDE the `data` JSON for signed calls
    // (verified against the live API; separate form fields return 561).
    expect([...(calls[1]?.body.keys() ?? [])]).toEqual(["data"]);
    const dataPayload = JSON.parse(calls[1]?.body.get("data") ?? "{}") as Record<
      string,
      unknown
    >;
    expect(dataPayload["_api_auth"]).toBe("key");
    expect(dataPayload["_api_key"]).toBe("synthetic-key");
    expect(dataPayload["_api_session"]).toBe("sess-1");
    expect(dataPayload["_api_sha"]).toMatch(/^[0-9a-f]{40}$/);
    expect(dataPayload["type"]).toBe("company");
    expect(dataPayload["limit"]).toBe(5);
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

  test("redacts echoed _api_* auth fields from response data", async () => {
    // Default/ping echoes its request payload back, which now includes the
    // auth fields; they must never reach callers (docs/security.md par. 6).
    const calls: Call[] = [];
    const client = makeClient(
      [
        tokenEnvelope(),
        envelope({ check: "smoke", _api_key: "leaked", _api_sha: "leaked" }),
        tokenEnvelope(),
        envelope([{ id: "1", _api_session: "leaked" }, { id: "2" }]),
      ],
      calls,
    );

    const object = await client.call<Record<string, unknown>>("Default", "ping");
    expect(object).toEqual({ check: "smoke" });

    const array = await client.call<Array<Record<string, unknown>>>("Contact", "getAll");
    expect(array).toEqual([{ id: "1" }, { id: "2" }]);
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
