import { describe, expect, test } from "bun:test";
import { LivespaceClient, TOKEN_TIMEOUT_MS } from "../../src/livespace/client.js";
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

/** A distinct session per token fetch, so replayed signatures are visible. */
function tokenEnvelopeFor(nth: number): Response {
  return envelope({ token: `tok-${nth}`, session_id: `sess-${nth}` });
}

function isTokenUrl(url: string): boolean {
  return url.endsWith("getToken");
}

function timeoutException(): DOMException {
  return new DOMException("The operation timed out.", "TimeoutError");
}

/**
 * Routes token and signed calls separately: tokens answer with a fresh session,
 * signed calls follow a queue. Nothing here sleeps or hits the network.
 */
function routedFetch(
  calls: Call[],
  signedResponses: Array<Response | (() => never)>,
  onToken: (nth: number) => Response | (() => never) = tokenEnvelopeFor,
): typeof fetch {
  let tokens = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: new URLSearchParams(String(init?.body ?? "")) });
    if (isTokenUrl(url)) {
      tokens += 1;
      const answer = onToken(tokens);
      if (typeof answer === "function") answer();
      return answer;
    }
    const next = signedResponses.shift();
    if (!next) throw new Error("test fetch: no more queued signed responses");
    if (typeof next === "function") next();
    return next;
  }) as typeof fetch;
}

function signedBody(calls: Call[], index: number): Record<string, unknown> {
  return JSON.parse(calls[index]?.body.get("data") ?? "{}") as Record<string, unknown>;
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

function makeClient(
  responses: Response[],
  calls: Call[],
  extra: Partial<
    import("../../src/livespace/client.js").LivespaceClientOptions
  > = {},
) {
  return new LivespaceClient(CONFIG, {
    fetchImpl: makeFetch(responses, calls),
    sleep: async () => {},
    random: () => 1,
    ...extra,
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

  test("keeps an opaque user id in POST data and out of the request URL", async () => {
    const calls: Call[] = [];
    const client = makeClient([tokenEnvelope(), envelope({ ok: true })], calls);
    const id = "person-synthetic/../opaque?id=1#fragment";

    await client.call("Contact", "get", { id });

    const url = new URL(calls[1]?.url ?? "https://invalid.synthetic");
    expect(calls[1]?.url).not.toContain(id);
    expect(url.search).toBe("");
    expect(url.hash).toBe("");
    expect(signedBody(calls, 1)["id"]).toBe(id);
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

  test("every retry attempt is signed with a freshly minted session", async () => {
    // The 561 bug: the signed body was minted once and replayed, so the second
    // attempt reused a session Livespace had already consumed.
    const calls: Call[] = [];
    const client = new LivespaceClient(CONFIG, {
      fetchImpl: routedFetch(calls, [
        new Response("bad gateway", { status: 502 }),
        envelope({ ok: true }),
      ]),
      sleep: async () => {},
      random: () => 1,
    });

    await expect(client.call("Default", "ping")).resolves.toEqual({ ok: true });

    expect(calls.map((c) => isTokenUrl(c.url))).toEqual([true, false, true, false]);
    const first = signedBody(calls, 1);
    const second = signedBody(calls, 3);
    expect(first["_api_session"]).toBe("sess-1");
    expect(second["_api_session"]).toBe("sess-2");
    expect(second["_api_sha"]).not.toBe(first["_api_sha"]);
  });

  test("retries HTTP 5xx with backoff and then succeeds", async () => {
    const calls: Call[] = [];
    const sleeps: number[] = [];
    const client = new LivespaceClient(CONFIG, {
      fetchImpl: routedFetch(calls, [
        new Response("bad gateway", { status: 502 }),
        envelope({ ok: true }),
      ]),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 1,
    });

    const data = await client.call<{ ok: boolean }>("Default", "ping");

    expect(data).toEqual({ ok: true });
    expect(sleeps).toEqual([200]);
    expect(calls.length).toBe(4); // token, signed, token, signed
  });

  test("read retry delay uses full jitter: random() scales the capped backoff", async () => {
    const calls: Call[] = [];
    const sleeps: number[] = [];
    const client = new LivespaceClient(CONFIG, {
      fetchImpl: routedFetch(calls, [
        new Response("x", { status: 500 }),
        new Response("x", { status: 500 }),
        envelope({ ok: true }),
      ]),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0.5,
    });

    await client.call("Default", "ping");
    expect(sleeps).toEqual([100, 200]); // floor(0.5 * 200), floor(0.5 * 400)
  });

  test("Retry-After on 5xx overrides the jittered delay (capped)", async () => {
    const calls: Call[] = [];
    const sleeps: number[] = [];
    const client = new LivespaceClient(CONFIG, {
      fetchImpl: routedFetch(calls, [
        new Response("slow down", { status: 503, headers: { "retry-after": "1" } }),
        envelope({ ok: true }),
      ]),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 1,
    });

    await client.call("Default", "ping");
    expect(sleeps).toEqual([1000]);
  });

  test("HTTP 429 maps to RATE_LIMITED and is retried for reads", async () => {
    const calls: Call[] = [];
    const client = new LivespaceClient(CONFIG, {
      fetchImpl: routedFetch(calls, [
        new Response("limited", { status: 429 }),
        envelope({ ok: true }),
      ]),
      sleep: async () => {},
      random: () => 1,
    });

    await expect(client.call("Default", "ping")).resolves.toEqual({ ok: true });
    expect(calls.length).toBe(4);
  });

  test("Retry-After rides the 429 error onto the next sleep", async () => {
    const calls: Call[] = [];
    const sleeps: number[] = [];
    const client = new LivespaceClient(CONFIG, {
      fetchImpl: routedFetch(calls, [
        new Response("limited", { status: 429, headers: { "retry-after": "1" } }),
        envelope({ ok: true }),
      ]),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 1,
    });

    await client.call("Default", "ping");
    expect(sleeps).toEqual([1000]);
  });

  test("a token business failure fails fast: one token call, no signed call", async () => {
    for (const [result, code] of [
      [561, "AUTH_FAILED"],
      [520, "UPSTREAM_ERROR"],
    ] as const) {
      const calls: Call[] = [];
      const sleeps: number[] = [];
      const client = new LivespaceClient(CONFIG, {
        fetchImpl: routedFetch(calls, [], () =>
          envelope({ internal: "SENSITIVE-DETAIL" }, result, false),
        ),
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        random: () => 1,
      });

      await expect(client.call("Default", "ping")).rejects.toMatchObject({ code });
      expect(calls.length).toBe(1);
      expect(calls.every((c) => isTokenUrl(c.url))).toBe(true);
      expect(sleeps).toEqual([]);
    }
  });

  test("a token transport failure retries the whole composite attempt", async () => {
    const calls: Call[] = [];
    const client = new LivespaceClient(CONFIG, {
      fetchImpl: routedFetch(calls, [envelope({ ok: true })], (nth) =>
        nth === 1
          ? () => {
              throw new TypeError("socket hang up (synthetic)");
            }
          : tokenEnvelopeFor(nth),
      ),
      sleep: async () => {},
      random: () => 1,
    });

    await expect(client.call("Default", "ping")).resolves.toEqual({ ok: true });
    expect(calls.map((c) => isTokenUrl(c.url))).toEqual([true, true, false]);
  });

  test("write calls are not retried: HTTP 500 after send maps to WRITE_OUTCOME_UNKNOWN", async () => {
    const calls: Call[] = [];
    const client = makeClient(
      [tokenEnvelope(), new Response("x", { status: 500 })],
      calls,
    );

    await expect(
      client.call("Contact", "addContact", { firstname: "Syn" }, { write: true }),
    ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" });
    expect(calls.length).toBe(2); // one token fetch + exactly one write attempt
  });

  test("write network failure maps to WRITE_OUTCOME_UNKNOWN without retry", async () => {
    const calls: Call[] = [];
    let writeAttempts = 0;
    const flakyFetch: typeof fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      calls.push({
        url: String(input),
        body: new URLSearchParams(String(init?.body ?? "")),
      });
      if (String(input).endsWith("getToken")) return tokenEnvelope();
      writeAttempts += 1;
      throw new TypeError("socket hang up (synthetic)");
    }) as typeof fetch;
    const client = new LivespaceClient(CONFIG, {
      fetchImpl: flakyFetch,
      sleep: async () => {},
      random: () => 1,
    });

    await expect(
      client.call("Contact", "addContact", {}, { write: true }),
    ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" });
    expect(writeAttempts).toBe(1);
  });

  test("write rejected by 429 maps to RATE_LIMITED (safe to retry explicitly)", async () => {
    const calls: Call[] = [];
    const client = makeClient(
      [tokenEnvelope(), new Response("limited", { status: 429 })],
      calls,
    );

    await expect(
      client.call("Contact", "addContact", {}, { write: true }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  test("a write survives a token transport failure in the prepare phase", async () => {
    // The token fetch is a safe read even inside a write: nothing has been
    // dispatched yet, so the composite attempt may be retried.
    const calls: Call[] = [];
    const client = new LivespaceClient(CONFIG, {
      fetchImpl: routedFetch(calls, [envelope({ id: "contact-synthetic-1" })], (nth) =>
        nth === 1
          ? () => {
              throw new TypeError("socket hang up (synthetic)");
            }
          : tokenEnvelopeFor(nth),
      ),
      sleep: async () => {},
      random: () => 1,
    });

    await expect(
      client.call("Contact", "addContact", { firstname: "Syn" }, { write: true }),
    ).resolves.toEqual({ id: "contact-synthetic-1" });
    expect(calls.filter((c) => !isTokenUrl(c.url)).length).toBe(1);
  });

  test("a signed-dispatch timeout on a write maps to WRITE_OUTCOME_UNKNOWN", async () => {
    const calls: Call[] = [];
    const client = new LivespaceClient(CONFIG, {
      fetchImpl: routedFetch(calls, [
        () => {
          throw timeoutException();
        },
      ]),
      sleep: async () => {},
      random: () => 1,
    });

    await expect(
      client.call("Contact", "addContact", {}, { write: true }),
    ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" });
    expect(calls.filter((c) => !isTokenUrl(c.url)).length).toBe(1);
  });

  test("a per-call timeoutMs governs the signed dispatch", async () => {
    const calls: Call[] = [];
    const client = new LivespaceClient(CONFIG, {
      fetchImpl: routedFetch(calls, [
        () => {
          throw timeoutException();
        },
      ]),
      sleep: async () => {},
      random: () => 1,
      maxAttempts: 1,
    });

    await expect(
      client.call("Deal", "getAll", { limit: 200 }, { timeoutMs: 1234 }),
    ).rejects.toMatchObject({
      code: "TIMEOUT",
      message: expect.stringContaining("1234 ms"),
    });
  });

  test("a per-call timeoutMs never widens the token attempt", async () => {
    const calls: Call[] = [];
    const client = new LivespaceClient(CONFIG, {
      fetchImpl: routedFetch(calls, [], () => () => {
        throw timeoutException();
      }),
      sleep: async () => {},
      random: () => 1,
      maxAttempts: 1,
    });

    await expect(
      client.call("Deal", "getAll", { limit: 200 }, { timeoutMs: 60_000 }),
    ).rejects.toMatchObject({
      code: "TIMEOUT",
      message: expect.stringContaining(`${TOKEN_TIMEOUT_MS} ms`),
    });
    expect(TOKEN_TIMEOUT_MS).toBe(10_000);
  });

  test("without an override the signed dispatch uses the 30 s client default", async () => {
    const calls: Call[] = [];
    const client = new LivespaceClient(CONFIG, {
      fetchImpl: routedFetch(calls, [
        () => {
          throw timeoutException();
        },
      ]),
      sleep: async () => {},
      random: () => 1,
      maxAttempts: 1,
    });

    await expect(client.call("Default", "ping")).rejects.toMatchObject({
      code: "TIMEOUT",
      message: expect.stringContaining("30000 ms"),
    });
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

  test("pre-aborted signal cancels before any network call", async () => {
    const calls: Call[] = [];
    const client = makeClient([tokenEnvelope(), envelope({})], calls);
    const controller = new AbortController();
    controller.abort();

    await expect(
      client.call("Default", "ping", {}, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(calls.length).toBe(0);
  });

  test("abort during the request maps to CANCELLED and is not retried", async () => {
    const calls: Call[] = [];
    const controller = new AbortController();
    const abortingFetch: typeof fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      calls.push({
        url: String(input),
        body: new URLSearchParams(String(init?.body ?? "")),
      });
      controller.abort();
      throw new DOMException("The operation was aborted.", "AbortError");
    }) as typeof fetch;
    const client = new LivespaceClient(CONFIG, {
      fetchImpl: abortingFetch,
      sleep: async () => {},
    });

    await expect(
      client.call("Default", "ping", {}, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(calls.length).toBe(1);
  });

  test("gives up after maxAttempts exhausted on the signed dispatch", async () => {
    const calls: Call[] = [];
    const client = new LivespaceClient(CONFIG, {
      fetchImpl: routedFetch(calls, [
        new Response("x", { status: 500 }),
        new Response("x", { status: 500 }),
        new Response("x", { status: 500 }),
      ]),
      maxAttempts: 3,
      sleep: async () => {},
      random: () => 1,
    });

    await expect(client.call("Default", "ping")).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
    });
    // Every attempt re-signs: token, signed, token, signed, token, signed.
    expect(calls.map((c) => isTokenUrl(c.url))).toEqual([
      true, false, true, false, true, false,
    ]);
  });

  test("a write that never dispatches is not WRITE_OUTCOME_UNKNOWN", async () => {
    const calls: Call[] = [];
    let tokenAttempts = 0;
    const client = new LivespaceClient(CONFIG, {
      fetchImpl: routedFetch(calls, [], () => {
        tokenAttempts += 1;
        return () => {
          throw new TypeError("socket hang up (synthetic)");
        };
      }),
      maxAttempts: 3,
      sleep: async () => {},
      random: () => 1,
    });

    await expect(
      client.call("Contact", "addContact", {}, { write: true }),
    ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    // Prepare-phase failures retry even for writes; nothing was dispatched.
    expect(tokenAttempts).toBe(3);
    expect(calls.every((c) => isTokenUrl(c.url))).toBe(true);
  });

  test("a write aborted after the signed dispatch is WRITE_OUTCOME_UNKNOWN", async () => {
    const calls: Call[] = [];
    const controller = new AbortController();
    const client = new LivespaceClient(CONFIG, {
      fetchImpl: routedFetch(calls, [
        (() => {
          controller.abort();
          throw new DOMException("The operation was aborted.", "AbortError");
        }) as never,
      ]),
      sleep: async () => {},
      random: () => 1,
    });

    // The signed POST left the building; a caller abort cannot make the
    // outcome known again (docs/security.md par. 5).
    await expect(
      client.call("Contact", "addContact", {}, { write: true, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "WRITE_OUTCOME_UNKNOWN" });
    expect(calls.filter((c) => !isTokenUrl(c.url)).length).toBe(1);
  });
});
