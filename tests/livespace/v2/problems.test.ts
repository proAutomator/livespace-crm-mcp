import { describe, expect, test } from "bun:test";
import { LivespaceError } from "../../../src/livespace/errors.js";
import {
  errorFromProblem,
  readRequestId,
  sanitizePointers,
} from "../../../src/livespace/v2/problems.js";

const REQUEST_ID = "0123456789abcdef0123456789abcdef";

/** A problem body as the v2 draft describes it, with synthetic text only. */
function problem(status: number, slug: string, extras: Record<string, unknown> = {}) {
  return {
    type: `https://api.livespace.io/problems/${slug}`,
    title: "SYNTHETIC upstream title",
    status,
    detail: "SYNTHETIC upstream detail",
    requestId: REQUEST_ID,
    ...extras,
  };
}

function map(
  status: number,
  slug: string,
  extras: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): LivespaceError {
  return errorFromProblem(status, problem(status, slug, extras), new Headers(headers));
}

describe("errorFromProblem mapping", () => {
  test.each([
    [400, "request-validation", "VALIDATION_ERROR", false],
    [401, "authentication-required", "AUTH_FAILED", false],
    [403, "insufficient-scope", "INSUFFICIENT_SCOPE", false],
    [403, "forbidden", "PERMISSION_DENIED", false],
    [404, "not-found", "NOT_FOUND", false],
    [405, "method-not-allowed", "UPSTREAM_ERROR", false],
    [406, "not-acceptable", "UPSTREAM_ERROR", false],
    [415, "unsupported-media-type", "UPSTREAM_ERROR", false],
    [422, "idempotency-key-reused", "UPSTREAM_ERROR", false],
    [409, "conflict", "CONFLICT", false],
    [422, "domain-validation", "VALIDATION_ERROR", false],
    [429, "too-many-requests", "RATE_LIMITED", true],
    [500, "internal-error", "UPSTREAM_ERROR", true],
    [503, "service-unavailable", "UPSTREAM_ERROR", true],
  ] as const)("%i %s -> %s (transport %p)", (status, slug, code, transport) => {
    const error = map(status, slug);
    expect(error).toBeInstanceOf(LivespaceError);
    expect(error.code).toBe(code);
    expect(error.transport).toBe(transport);
    expect(error.details.requestId).toBe(REQUEST_ID);
  });

  test("400 request-validation asks to fix the listed fields", () => {
    const error = map(400, "request-validation", { violations: { "/perPage": "SYNTHETIC" } });
    expect(error.details.fields).toEqual(["/perPage"]);
    expect(error.hint).toContain("listed fields");
    expect(error.hint).toContain("report it");
  });

  test("401 names the v2 key variable", () => {
    expect(map(401, "authentication-required").hint).toContain("LIVESPACE_API_V2_KEY");
  });

  test("403 insufficient-scope names a well-formed scope from WWW-Authenticate", () => {
    const error = map(403, "insufficient-scope", {}, {
      "www-authenticate": 'Bearer error="insufficient_scope", scope="crm:deal:write"',
    });
    expect(error.hint).toContain("crm:deal:write");
  });

  test("403 insufficient-scope never echoes a malformed scope", () => {
    for (const scope of ["crm:deal:write<script>", "SYNTHETIC injected", "crm:deal:admin"]) {
      const error = map(403, "insufficient-scope", {}, {
        "www-authenticate": `Bearer error="insufficient_scope", scope="${scope}"`,
      });
      expect(error.code).toBe("INSUFFICIENT_SCOPE");
      expect(error.hint).not.toContain(scope);
      expect(error.message).not.toContain(scope);
    }
  });

  test("403 forbidden explains BASIC visibility", () => {
    expect(map(403, "forbidden").hint).toContain("BASIC");
  });

  test("404 says unknown or not visible to the integration user", () => {
    expect(map(404, "not-found").hint).toContain(
      "unknown or not visible to the integration user",
    );
  });

  test("405, 406, 415 and a reused idempotency key are server bugs", () => {
    for (const [status, slug] of [
      [405, "method-not-allowed"],
      [406, "not-acceptable"],
      [415, "unsupported-media-type"],
      [422, "idempotency-key-reused"],
    ] as const) {
      expect(map(status, slug).hint).toContain("report it");
    }
  });

  test("409 conflict carries Retry-After when present", () => {
    const waiting = map(409, "conflict", {}, { "retry-after": "3" });
    expect(waiting.retryAfterMs).toBe(3000);
    expect(waiting.hint).toContain("3 s");
    expect(map(409, "conflict").retryAfterMs).toBeUndefined();
  });

  test("422 domain-validation keeps the fields", () => {
    const error = map(422, "domain-validation", { violations: { "/status": "SYNTHETIC" } });
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.details.fields).toEqual(["/status"]);
  });

  test("429 and 503 carry Retry-After for the retry loop", () => {
    expect(map(429, "too-many-requests", {}, { "retry-after": "2" }).retryAfterMs).toBe(2000);
    expect(map(503, "service-unavailable", {}, { "retry-after": "5" }).retryAfterMs).toBe(5000);
  });
});

describe("problem hygiene", () => {
  test("violation messages and detail never reach the error", () => {
    const error = map(422, "domain-validation", {
      detail: "SYNTHETIC upstream secret",
      violations: { "/name": "SYNTHETIC injected text" },
      conflicts: { resources: [{ reason: "SYNTHETIC conflict text" }] },
    });
    const surfaces = [error.message, error.hint, JSON.stringify(error)];
    for (const text of surfaces) {
      expect(text).not.toContain("SYNTHETIC upstream secret");
      expect(text).not.toContain("SYNTHETIC injected text");
      expect(text).not.toContain("SYNTHETIC upstream title");
      expect(text).not.toContain("SYNTHETIC conflict text");
    }
    expect(error.details.fields).toEqual(["/name"]);
  });

  test("pointers without a leading slash are normalized", () => {
    expect(sanitizePointers({ perPage: "x", "/owner/id": "y" })).toEqual([
      "/perPage",
      "/owner/id",
    ]);
    // The whole body is the empty pointer; a header is keyed by its name.
    expect(sanitizePointers({ "": "x", "Idempotency-Key": "y" })).toEqual([
      "/",
      "/Idempotency-Key",
    ]);
  });

  test("pointers with unexpected characters are dropped", () => {
    expect(
      sanitizePointers({ "/a b": "x", "/<script>": "x", "/ok": "x", "/x\n": "x" }),
    ).toEqual(["/ok"]);
    expect(sanitizePointers({ [`/${"a".repeat(201)}`]: "x" })).toEqual([]);
  });

  test("at most 20 pointers are kept", () => {
    const many = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`/field${i}`, "x"]),
    );
    expect(sanitizePointers(many)).toHaveLength(20);
  });

  test("non-object violations give no pointers", () => {
    for (const value of [undefined, null, "SYNTHETIC", 7, ["/a"]]) {
      expect(sanitizePointers(value)).toEqual([]);
    }
  });

  test("request id is kept only when it is 32 hex", () => {
    expect(readRequestId(REQUEST_ID)).toBe(REQUEST_ID);
    for (const value of [
      "unavailable",
      REQUEST_ID.toUpperCase(),
      `${REQUEST_ID}0`,
      "SYNTHETIC",
      7,
      null,
      undefined,
    ]) {
      expect(readRequestId(value)).toBeUndefined();
    }
  });

  test("the request id falls back to the X-Request-Id header", () => {
    const error = errorFromProblem(
      404,
      { ...problem(404, "not-found"), requestId: "unavailable" },
      new Headers({ "x-request-id": REQUEST_ID }),
    );
    expect(error.details.requestId).toBe(REQUEST_ID);
    const none = errorFromProblem(404, {}, new Headers({ "x-request-id": "SYNTHETIC" }));
    expect(none.details.requestId).toBeUndefined();
  });

  test("a non-problem body maps by status alone", () => {
    const html = "<html>SYNTHETIC gateway page</html>";
    expect(errorFromProblem(404, html, new Headers()).code).toBe("NOT_FOUND");
    expect(errorFromProblem(400, null, new Headers()).code).toBe("VALIDATION_ERROR");
    expect(errorFromProblem(409, [], new Headers()).code).toBe("CONFLICT");
    const gateway = errorFromProblem(502, html, new Headers());
    expect(gateway.code).toBe("UPSTREAM_ERROR");
    expect(gateway.transport).toBe(true);
    expect(gateway.message).not.toContain("SYNTHETIC");
    const teapot = errorFromProblem(418, html, new Headers());
    expect(teapot.code).toBe("UPSTREAM_ERROR");
    expect(teapot.transport).toBe(false);
  });

  test("a type outside the Livespace problem namespace is ignored", () => {
    const foreign = errorFromProblem(
      422,
      { ...problem(422, "domain-validation"), type: "https://synthetic.example/problems/idempotency-key-reused" },
      new Headers(),
    );
    // Mapped by status: 422 without a known type is a domain validation.
    expect(foreign.code).toBe("VALIDATION_ERROR");
  });

  test("a 403 without a problem type uses the WWW-Authenticate challenge", () => {
    const scope = errorFromProblem(
      403,
      null,
      new Headers({ "www-authenticate": 'Bearer error="insufficient_scope", scope="crm:person:read"' }),
    );
    expect(scope.code).toBe("INSUFFICIENT_SCOPE");
    expect(scope.hint).toContain("crm:person:read");
    expect(errorFromProblem(403, null, new Headers()).code).toBe("PERMISSION_DENIED");
  });
});
