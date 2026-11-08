import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { LivespaceError } from "../../../src/livespace/errors.js";
import { CallBudget } from "../../../src/livespace/v2/budget.js";
import {
  LivespaceV2Client,
  newIdempotencyKey,
  v2Path,
  type LivespaceV2ClientOptions,
  type V2Request,
} from "../../../src/livespace/v2/client.js";
import {
  CONTENT_DEAL_STATUS,
  MEDIA_MINIMAL,
} from "../../../src/livespace/v2/media-types.js";
import {
  routedV2Fetch,
  SYNTHETIC_REQUEST_ID,
  SYNTHETIC_V2_KEY,
  syntheticId,
  timeoutError,
  v2Envelope,
  v2Problem,
  type V2Call,
  type V2Handler,
} from "../../support/v2.js";

const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);
const ME: V2Request = { method: "GET", path: "/users/me" };
const CREATE_PERSON: V2Request = {
  method: "POST",
  path: "/people",
  body: { firstName: "SYNTHETIC", lastName: "Person" },
};
const CREATE_TASK: V2Request = {
  method: "POST",
  path: v2Path("/deals/{}/tasks", syntheticId(1)),
  body: { title: "SYNTHETIC task" },
  idempotencyKey: "lcm-synthetic-0001",
};

interface Harness {
  client: LivespaceV2Client;
  calls: V2Call[];
  /** Every wait the client asked for: retry backoff, throttle spacing, burst. */
  sleeps: number[];
  /** The fake clock at each fetch, epoch ms. */
  times: number[];
}

/**
 * A client on a fake clock that only moves when the client sleeps, so retry
 * waits, the 150 ms throttle spacing and burst waits are all visible.
 */
function harness(
  routes: Record<string, V2Handler | V2Handler[]>,
  options: Partial<LivespaceV2ClientOptions> & { dailyReserve?: number } = {},
): Harness {
  const calls: V2Call[] = [];
  const sleeps: number[] = [];
  const times: number[] = [];
  const clock = { now: NOW };
  const routed = routedV2Fetch(routes, calls);
  const { dailyReserve, ...rest } = options;
  const client = new LivespaceV2Client(
    { subdomain: "synthetic", apiKey: SYNTHETIC_V2_KEY, dailyReserve: dailyReserve ?? 100 },
    {
      fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) => {
        times.push(clock.now);
        return routed(input, init);
      }) as typeof fetch,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock.now += ms;
      },
      // 0.9 keeps jittered waits (180 ms, 360 ms) past the 150 ms spacing.
      random: () => 0.9,
      now: () => clock.now,
      ...rest,
    },
  );
  return { client, calls, sleeps, times };
}

const ok = (data: unknown = { id: syntheticId(1) }, headers: Record<string, string> = {}) =>
  () => v2Envelope(data, {}, { headers });
const created = (headers: Record<string, string> = {}) =>
  () => v2Envelope({ id: syntheticId(2) }, {}, { status: 201, headers });
const problem = (status: number, type: string, headers: Record<string, string> = {}) =>
  () => v2Problem(status, type, {}, headers);
const throwing = (value: unknown): V2Handler => () => {
  throw value;
};

async function failure(promise: Promise<unknown>): Promise<LivespaceError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(LivespaceError);
    return error as LivespaceError;
  }
  throw new Error("expected the request to fail");
}

describe("LivespaceV2Client requests", () => {
  test("sends the key only as a Bearer header", async () => {
    const { client, calls } = harness({ "GET /users/me": ok() });
    await client.request(ME);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.url).toBe("https://synthetic.livespace.io/api/v2/users/me");
    expect(call!.url).not.toContain(SYNTHETIC_V2_KEY);
    expect(call!.headers.get("authorization")).toBe(`Bearer ${SYNTHETIC_V2_KEY}`);
    expect(call!.headers.get("accept")).toBe("application/json");
    expect(call!.headers.has("content-type")).toBe(false);
    expect(call!.body).toBeUndefined();
  });

  test("does not follow redirects, so the key never leaves for another host", async () => {
    const { client, calls } = harness({
      "GET /users/me": () =>
        new Response(null, { status: 302, headers: { location: "https://synthetic.example/" } }),
    });
    const error = await failure(client.request(ME));
    expect(calls[0]!.init.redirect).toBe("manual");
    expect(error.code).toBe("UPSTREAM_ERROR");
    expect(calls).toHaveLength(1);
  });

  test("encodes path ids", () => {
    expect(v2Path("/deals/{}", "../x")).toBe("/deals/..%2Fx");
    expect(v2Path("/deals/{}/process", syntheticId(1))).toBe(
      `/deals/${syntheticId(1)}/process`,
    );
    expect(v2Path("/deals/{}/products/{}", "a b", "c?d")).toBe("/deals/a%20b/products/c%3Fd");
    expect(() => v2Path("/deals/{}/products/{}", "x")).toThrow();
    expect(() => v2Path("/deals/{}", "x", "y")).toThrow();
    expect(() => v2Path("/users/me", "x")).toThrow();
  });

  test("refuses ids that are empty or dot segments", () => {
    for (const id of ["", ".", ".."]) {
      expect(() => v2Path("/deals/{}", id)).toThrow(LivespaceError);
    }
  });

  test("refuses a path that did not come from v2Path", async () => {
    const { client, calls } = harness({});
    for (const path of [
      "users/me",
      "/deals?x=1",
      "/deals/a b",
      "//synthetic.example/x",
      "/deals#x",
      "/deals/../users/me",
      "/deals/./x",
      "/deals/%2e%2E/users/me",
      "/deals/.%2e",
    ]) {
      await expect(client.request({ method: "GET", path })).rejects.toThrow();
    }
    expect(calls).toHaveLength(0);
  });

  test("joins query arrays with commas", async () => {
    const { client, calls } = harness({ "GET /search": ok([]) });
    await client.request({
      method: "GET",
      path: "/search",
      query: {
        q: "SYNTHETIC a&b",
        types: ["person", "deal", "a,b"],
        perPage: 50,
        exact: false,
        page: undefined,
      },
    });
    const url = calls[0]!.url;
    expect(url).toBe(
      "https://synthetic.livespace.io/api/v2/search?q=SYNTHETIC%20a%26b" +
        "&types=person,deal,a%2Cb&perPage=50&exact=false",
    );
    expect(url).not.toContain("page=");
  });

  test("sends the action content type", async () => {
    const id = syntheticId(3);
    const { client, calls } = harness({ [`PATCH /deals/${id}`]: ok({ id }) });
    await client.request(
      {
        method: "PATCH",
        path: v2Path("/deals/{}", id),
        body: { status: "won" },
        contentType: CONTENT_DEAL_STATUS,
        accept: MEDIA_MINIMAL,
      },
      { write: true },
    );
    const call = calls[0]!;
    expect(call.method).toBe("PATCH");
    expect(call.headers.get("content-type")).toBe(CONTENT_DEAL_STATUS);
    expect(call.headers.get("accept")).toBe(MEDIA_MINIMAL);
    expect(JSON.parse(call.body!)).toEqual({ status: "won" });
  });

  test("a body defaults to application/json", async () => {
    const { client, calls } = harness({ "POST /people": created() });
    await client.request(CREATE_PERSON, { write: true });
    expect(calls[0]!.headers.get("content-type")).toBe("application/json");
    expect(calls[0]!.headers.has("idempotency-key")).toBe(false);
  });

  test("never sends DELETE or another method outside the union", async () => {
    const { client, calls } = harness({});
    for (const method of ["DELETE", "PUT", "delete"]) {
      await expect(
        client.request({ method, path: "/people" } as unknown as V2Request),
      ).rejects.toThrow();
    }
    expect(calls).toHaveLength(0);
  });

  test("refuses a malformed idempotency key before any request", async () => {
    const { client, calls } = harness({});
    for (const key of ["", "a b", "x".repeat(256), "ą"]) {
      await expect(
        client.request({ ...CREATE_TASK, idempotencyKey: key }, { write: true }),
      ).rejects.toThrow();
    }
    expect(calls).toHaveLength(0);
  });

  test("newIdempotencyKey is lcm- plus a UUID", () => {
    const key = newIdempotencyKey();
    expect(key).toMatch(/^lcm-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(newIdempotencyKey()).not.toBe(key);
  });
});

describe("LivespaceV2Client responses", () => {
  test("parses the envelope and defaults extra", async () => {
    const { client } = harness({
      "GET /users/me": () =>
        new Response(JSON.stringify({ meta: { version: "2.0.0" }, data: { login: "SYNTHETIC" } }), {
          status: 200,
          headers: { "x-request-id": SYNTHETIC_REQUEST_ID },
        }),
      "POST /deals/searches": () =>
        v2Envelope([{ id: syntheticId(1) }], { page: 1, perPage: 1, totalCount: 7 }),
    });
    expect(await client.request(ME)).toEqual({
      data: { login: "SYNTHETIC" },
      extra: {},
      requestId: SYNTHETIC_REQUEST_ID,
      replayed: false,
    });
    const page = await client.request<{ id: string }[]>({
      method: "POST",
      path: "/deals/searches",
      body: { perPage: 1 },
    });
    expect(page.data).toEqual([{ id: syntheticId(1) }]);
    expect(page.extra).toEqual({ page: 1, perPage: 1, totalCount: 7 });
  });

  test("a non-object extra becomes an empty object and a bad request id null", async () => {
    const { client } = harness({
      "GET /users/me": () =>
        new Response(JSON.stringify({ data: {}, extra: ["SYNTHETIC"] }), {
          status: 200,
          headers: { "x-request-id": "SYNTHETIC" },
        }),
    });
    const response = await client.request(ME);
    expect(response.extra).toEqual({});
    expect(response.requestId).toBeNull();
  });

  test("a 204 has no body", async () => {
    const { client } = harness({ "GET /users/me": () => new Response(null, { status: 204 }) });
    const response = await client.request(ME);
    expect(response.data).toBeUndefined();
    expect(response.extra).toEqual({});
  });

  test("rejects a 2xx body without data with fixed wording", async () => {
    for (const body of [
      JSON.stringify({ meta: {}, result: "SYNTHETIC leaked text" }),
      JSON.stringify(["SYNTHETIC leaked text"]),
      "<html>SYNTHETIC leaked text</html>",
    ]) {
      const { client, calls } = harness({
        "GET /users/me": () => new Response(body, { status: 200 }),
      });
      const error = await failure(client.request(ME));
      expect(error.code).toBe("UPSTREAM_ERROR");
      expect(error.transport).toBe(false);
      expect(JSON.stringify(error)).not.toContain("SYNTHETIC leaked text");
      expect(error.message).not.toContain("SYNTHETIC leaked text");
      expect(calls).toHaveLength(1);
    }
  });

  test("a write answered 2xx with an unreadable body is unknown, not retried", async () => {
    const { client, calls } = harness({
      "POST /people": () => new Response("<html>SYNTHETIC</html>", { status: 201 }),
    });
    const error = await failure(client.request(CREATE_PERSON, { write: true }));
    expect(error.code).toBe("WRITE_OUTCOME_UNKNOWN");
    expect(calls).toHaveLength(1);
  });

  test("problem responses map through errorFromProblem with the request id", async () => {
    const { client } = harness({
      "GET /users/me": () =>
        v2Problem(400, "request-validation", { violations: { "/perPage": "SYNTHETIC" } }),
    });
    const error = await failure(client.request(ME));
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.details).toEqual({ fields: ["/perPage"], requestId: SYNTHETIC_REQUEST_ID });
  });

  test("updates the rate-limit snapshot from every response", async () => {
    const { client } = harness({
      "GET /users/me": [
        ok({}, {
          "x-ratelimit-limit": "100",
          "x-ratelimit-remaining": "99",
          "x-ratelimit-reset": String(NOW / 1000 + 10),
          "x-ratelimit-daily-remaining": "49900",
        }),
        problem(404, "not-found", { "x-ratelimit-daily-remaining": "49899" }),
      ],
    });
    await client.request(ME);
    expect(client.rateLimit()).toMatchObject({ burstRemaining: 99, dailyRemaining: 49900 });
    await failure(client.request(ME));
    expect(client.rateLimit()).toMatchObject({ dailyRemaining: 49899 });
    expect(client.rateLimit().observedAt).toBeGreaterThan(NOW);
  });
});

describe("LivespaceV2Client retries", () => {
  test("retries a read on 429 honoring Retry-After", async () => {
    const { client, calls, sleeps } = harness({
      "GET /users/me": [problem(429, "too-many-requests", { "retry-after": "2" }), ok()],
    });
    await client.request(ME);
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([2000]);
  });

  test("a Retry-After above 10 s is not waited out", async () => {
    const { client, calls, sleeps } = harness({
      "GET /users/me": [problem(429, "too-many-requests", { "retry-after": "60" }), ok()],
    });
    const error = await failure(client.request(ME));
    expect(error.code).toBe("RATE_LIMITED");
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  test("retries on 503 and timeout up to three attempts", async () => {
    const unavailable = harness({
      "GET /users/me": [
        problem(503, "service-unavailable"),
        problem(503, "service-unavailable"),
        problem(503, "service-unavailable"),
        ok(),
      ],
    });
    const error = await failure(unavailable.client.request(ME));
    expect(error.code).toBe("UPSTREAM_ERROR");
    expect(unavailable.calls).toHaveLength(3);
    // Full jitter: random 0.9 of the 200 ms and 400 ms caps.
    expect(unavailable.sleeps).toEqual([180, 360]);

    const slow = harness({
      "GET /users/me": [throwing(timeoutError()), throwing(timeoutError()), ok()],
    });
    await slow.client.request(ME);
    expect(slow.calls).toHaveLength(3);

    const always = harness({
      "GET /users/me": [throwing(timeoutError()), throwing(timeoutError()), throwing(timeoutError())],
    });
    expect((await failure(always.client.request(ME))).code).toBe("TIMEOUT");
    expect(always.calls).toHaveLength(3);
  });

  test("a network error on a read retries", async () => {
    const { client, calls } = harness({
      "GET /users/me": [throwing(new TypeError("SYNTHETIC socket")), ok()],
    });
    await client.request(ME);
    expect(calls).toHaveLength(2);
  });

  test("does not retry 400, 404 or 422", async () => {
    for (const [status, type] of [
      [400, "request-validation"],
      [404, "not-found"],
      [422, "domain-validation"],
    ] as const) {
      const { client, calls } = harness({
        "GET /users/me": [problem(status, type), ok()],
      });
      await failure(client.request(ME));
      expect(calls).toHaveLength(1);
    }
  });

  test("a timed-out create without a key is unknown and never resent", async () => {
    const { client, calls } = harness({
      "POST /people": [throwing(timeoutError()), created()],
    });
    const error = await failure(client.request(CREATE_PERSON, { write: true }));
    expect(error.code).toBe("WRITE_OUTCOME_UNKNOWN");
    expect(calls).toHaveLength(1);
  });

  test("a create without a key is unknown after a 5xx or a network error", async () => {
    for (const handler of [
      problem(500, "internal-error"),
      problem(503, "service-unavailable", { "retry-after": "1" }),
      throwing(new TypeError("SYNTHETIC socket")),
    ]) {
      const { client, calls } = harness({ "POST /people": [handler, created()] });
      const error = await failure(client.request(CREATE_PERSON, { write: true }));
      expect(error.code).toBe("WRITE_OUTCOME_UNKNOWN");
      expect(calls).toHaveLength(1);
    }
  });

  test("a keyed write retries once with the same key", async () => {
    const path = `POST /deals/${syntheticId(1)}/tasks`;
    const { client, calls } = harness({
      [path]: [throwing(timeoutError()), created({ "idempotent-replayed": "true" })],
    });
    const response = await client.request(CREATE_TASK, { write: true });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.headers.get("idempotency-key")).toBe("lcm-synthetic-0001");
    expect(calls[1]!.headers.get("idempotency-key")).toBe("lcm-synthetic-0001");
    expect(response.replayed).toBe(true);
  });

  test("a keyed write whose retry also fails is unknown", async () => {
    const path = `POST /deals/${syntheticId(1)}/tasks`;
    const { client, calls } = harness({
      [path]: [throwing(timeoutError()), problem(503, "service-unavailable"), created()],
    });
    const error = await failure(client.request(CREATE_TASK, { write: true }));
    expect(error.code).toBe("WRITE_OUTCOME_UNKNOWN");
    expect(calls).toHaveLength(2);
  });

  test("a keyed write refused after an unknown first attempt stays unknown", async () => {
    const path = `POST /deals/${syntheticId(1)}/tasks`;
    const { client } = harness({
      [path]: [throwing(timeoutError()), problem(422, "domain-validation")],
    });
    expect((await failure(client.request(CREATE_TASK, { write: true }))).code).toBe(
      "WRITE_OUTCOME_UNKNOWN",
    );
  });

  test("a keyed write waits on 409 in progress, then retries once", async () => {
    const path = `POST /deals/${syntheticId(1)}/tasks`;
    const waiting = harness({
      [path]: [problem(409, "conflict", { "retry-after": "1" }), created()],
    });
    await waiting.client.request(CREATE_TASK, { write: true });
    expect(waiting.calls).toHaveLength(2);
    expect(waiting.sleeps).toEqual([1000]);
    expect(waiting.calls[1]!.headers.get("idempotency-key")).toBe("lcm-synthetic-0001");

    const twice = harness({
      [path]: [
        problem(409, "conflict", { "retry-after": "1" }),
        problem(409, "conflict", { "retry-after": "1" }),
        created(),
      ],
    });
    expect((await failure(twice.client.request(CREATE_TASK, { write: true }))).code).toBe(
      "CONFLICT",
    );
    expect(twice.calls).toHaveLength(2);
  });

  test("a 409 without Retry-After or without a key is not retried", async () => {
    const path = `POST /deals/${syntheticId(1)}/tasks`;
    const noWait = harness({ [path]: [problem(409, "conflict"), created()] });
    expect((await failure(noWait.client.request(CREATE_TASK, { write: true }))).code).toBe(
      "CONFLICT",
    );
    expect(noWait.calls).toHaveLength(1);

    const noKey = harness({
      "POST /people": [problem(409, "conflict", { "retry-after": "1" }), created()],
    });
    expect((await failure(noKey.client.request(CREATE_PERSON, { write: true }))).code).toBe(
      "CONFLICT",
    );
    expect(noKey.calls).toHaveLength(1);
  });

  test("a write retries on 429, the outcome is known", async () => {
    const { client, calls, sleeps } = harness({
      "POST /people": [problem(429, "too-many-requests", { "retry-after": "1" }), created()],
    });
    const response = await client.request(CREATE_PERSON, { write: true });
    expect(response.data).toEqual({ id: syntheticId(2) });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([1000]);
  });

  test("a write rejected with 400 or 422 is a known refusal", async () => {
    const { client, calls } = harness({
      "POST /people": [problem(422, "domain-validation"), created()],
    });
    expect((await failure(client.request(CREATE_PERSON, { write: true }))).code).toBe(
      "VALIDATION_ERROR",
    );
    expect(calls).toHaveLength(1);
  });
});

describe("LivespaceV2Client budgets", () => {
  const DAILY_LOW = { "x-ratelimit-daily-remaining": "10" };

  test("refuses when the daily budget is at the reserve", async () => {
    const { client, calls } = harness({ "GET /users/me": [ok({}, DAILY_LOW), ok(), ok()] });
    await client.request(ME);
    const error = await failure(client.request(ME));
    expect(error.code).toBe("DAILY_BUDGET_LOW");
    expect(error.hint).toContain("LIVESPACE_V2_DAILY_RESERVE");
    expect(calls).toHaveLength(1);
    await client.request(ME, { essential: true });
    expect(calls).toHaveLength(2);
  });

  test("consecutive requests start at least 150 ms apart", async () => {
    const { client, times } = harness({ "GET /users/me": [ok(), ok(), ok()] });
    await client.request(ME);
    await client.request(ME);
    await client.request(ME);
    expect(times).toEqual([NOW, NOW + 150, NOW + 300]);
  });

  test("a zero reserve never refuses", async () => {
    const { client, calls } = harness(
      { "GET /users/me": [ok({}, { "x-ratelimit-daily-remaining": "0" }), ok()] },
      { dailyReserve: 0 },
    );
    await client.request(ME);
    await client.request(ME);
    expect(calls).toHaveLength(2);
  });

  test("spends the call budget per attempt, retries included", async () => {
    const { client, calls } = harness({
      "GET /users/me": [
        problem(503, "service-unavailable"),
        problem(503, "service-unavailable"),
        ok(),
      ],
    });
    const budget = new CallBudget(2);
    const error = await failure(client.request(ME, { budget }));
    expect(error.code).toBe("CALL_BUDGET_EXCEEDED");
    expect(calls).toHaveLength(2);
    expect(budget.used).toBe(2);
  });

  test("waits for the burst window before the next request", async () => {
    const spent = {
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(NOW / 1000 + 3),
    };
    const { client, calls, times } = harness({ "GET /users/me": [ok({}, spent), ok()] });
    await client.request(ME);
    await client.request(ME);
    expect(calls).toHaveLength(2);
    expect(times[1]).toBe(NOW + 3000);
  });

  test("a burst window longer than 10 s is refused without a request", async () => {
    const spent = {
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(NOW / 1000 + 30),
    };
    const { client, calls } = harness({ "GET /users/me": [ok({}, spent), ok()] });
    await client.request(ME);
    expect((await failure(client.request(ME))).code).toBe("RATE_LIMITED");
    expect(calls).toHaveLength(1);
  });
});

describe("LivespaceV2Client secrecy and cancellation", () => {
  const spies: Array<{ mockRestore: () => void }> = [];
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  test("the key never appears in errors or stderr", async () => {
    const output: string[] = [];
    for (const method of ["error", "warn", "log", "info", "debug"] as const) {
      spies.push(
        spyOn(console, method).mockImplementation((...args: unknown[]) => {
          output.push(args.map(String).join(" "));
        }),
      );
    }
    const { client } = harness({
      "GET /users/me": [
        problem(401, "authentication-required", {
          "www-authenticate": 'Bearer error="invalid_token"',
        }),
        ...Array.from({ length: 3 }, () => problem(500, "internal-error")),
        ...Array.from({ length: 3 }, () => throwing(new TypeError(`SYNTHETIC ${SYNTHETIC_V2_KEY}`))),
        ...Array.from({ length: 3 }, () => throwing(timeoutError())),
      ],
    });
    const errors: LivespaceError[] = [];
    for (let i = 0; i < 4; i += 1) errors.push(await failure(client.request(ME)));
    expect(errors.map((error) => error.code)).toEqual([
      "AUTH_FAILED",
      "UPSTREAM_ERROR",
      "NETWORK_ERROR",
      "TIMEOUT",
    ]);
    for (const error of errors) {
      for (const text of [error.message, error.hint, JSON.stringify(error), String(error)]) {
        expect(text).not.toContain(SYNTHETIC_V2_KEY);
      }
    }
    expect(output.join("\n")).not.toContain(SYNTHETIC_V2_KEY);
  });

  test("cancellation before dispatch is CANCELLED, after dispatch of a write is unknown", async () => {
    const before = harness({ "POST /people": created() });
    const aborted = new AbortController();
    aborted.abort();
    expect(
      (await failure(before.client.request(CREATE_PERSON, { write: true, signal: aborted.signal })))
        .code,
    ).toBe("CANCELLED");
    expect(before.calls).toHaveLength(0);

    const hanging: V2Handler = (call) =>
      new Promise<Response>((_, reject) => {
        const signal = call.init.signal!;
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });

    const writeAbort = new AbortController();
    const write = harness({ "POST /people": hanging });
    const pendingWrite = write.client.request(CREATE_PERSON, {
      write: true,
      signal: writeAbort.signal,
    });
    while (write.calls.length === 0) await Bun.sleep(1);
    writeAbort.abort();
    expect((await failure(pendingWrite)).code).toBe("WRITE_OUTCOME_UNKNOWN");
    expect(write.calls).toHaveLength(1);

    const readAbort = new AbortController();
    const read = harness({ "GET /users/me": hanging });
    const pendingRead = read.client.request(ME, { signal: readAbort.signal });
    while (read.calls.length === 0) await Bun.sleep(1);
    readAbort.abort();
    expect((await failure(pendingRead)).code).toBe("CANCELLED");
    expect(read.calls).toHaveLength(1);
  });

  test("a per-call timeout reaches the fetch signal", async () => {
    const { client } = harness({
      "GET /users/me": (call) =>
        new Promise<Response>((_, reject) => {
          const signal = call.init.signal!;
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    }, { maxAttempts: 1 });
    const error = await failure(client.request(ME, { timeoutMs: 5 }));
    expect(error.code).toBe("TIMEOUT");
    expect(error.message).toContain("5 ms");
  });
});
