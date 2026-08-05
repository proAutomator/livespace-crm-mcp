# M0b Tooling + M1 Signed Livespace Client - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bun/TypeScript tooling plus a fully tested, throttled, error-mapping Livespace API client with a live smoke script - the foundation every MCP tool will call.

**Architecture:** A zero-runtime-dependency client layer: portable WebCrypto SHA-1 signing, per-request `getToken` → signed call flow, response-envelope validation (`status && result`), a concurrency/interval throttle with exponential backoff, and an error taxonomy that maps Livespace result codes to `{code, message, hint}` without ever leaking upstream bodies. All unit tests run offline against an injected `fetch`; only `scripts/smoke.ts` touches the network.

**Tech Stack:** Bun (runtime + `bun:test`), TypeScript strict, GitHub Actions CI with gitleaks. No runtime dependencies in this plan.

## Global Constraints

- English for all code, comments, commits, and docs (AGENTS.md).
- TDD: failing test first, minimal implementation, green, commit (AGENTS.md).
- No secrets and no real CRM data anywhere - fixtures are synthetic (docs/security.md §9). Config error messages list variable **names**, never values (§1).
- Errors surfaced upward are `{code, message, hint}`; upstream response bodies, stack traces, and tokens MUST never appear in them (docs/security.md §6).
- Dependencies: **zero runtime deps** in this plan; dev deps only `typescript` and `@types/bun`, pinned exact (docs/security.md §7).
- Portability: use WebCrypto (`crypto.subtle`), not `node:crypto` - the same code must run on Bun, Node 20+, and later Cloudflare Workers.
- Unit tests MUST NOT touch the network; the live smoke script is manual-only and excluded from `bun test`.
- Throttle discipline is a Livespace ToS compliance requirement (§3): concurrency cap 2, ≥150 ms between request starts, exponential backoff, max 3 attempts.
- Commits happen only as part of Kuba-approved execution of this plan (AGENTS.md rule 7). Conventional commit messages.

**Precondition (before Task 1):** `git log --oneline` must show the skeleton commit (M0a files). If the repository has no commits yet, stop and ask Kuba to make the first commit & push - do not create the baseline commit yourself.

---

### Task 1: Bun tooling and CI

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.github/workflows/ci.yml`
- Test: `tests/tooling.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `bun test`, `bun run typecheck` commands; TS config with `strict` + `noUncheckedIndexedAccess`; CI that runs typecheck, tests, and gitleaks on every push/PR.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "livespace-streamable-mcp-server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "license": "MIT",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "bun test",
    "smoke": "bun run scripts/smoke.ts"
  }
}
```

`"private": true` prevents accidental `npm publish` until a deliberate release decision.

- [ ] **Step 2: Install dev dependencies with exact pins**

Run: `bun add --exact --dev typescript @types/bun`
Expected: `package.json` gains `devDependencies` with exact versions (no `^` or `~`), and `bun.lock` is created. Record the versions the registry returned; they are now the pinned versions.

- [ ] **Step 3: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["@types/bun"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "verbatimModuleSyntax": true
  },
  "include": ["src", "tests", "scripts"]
}
```

- [ ] **Step 4: Write a failing sanity test**

Create `tests/tooling.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

describe("tooling", () => {
  test("bun:test and strict TS are wired up", () => {
    const values: readonly number[] = [1, 2, 3];
    expect(values.length).toBe(3);
  });
});
```

- [ ] **Step 5: Run test and typecheck**

Run: `bun test && bun run typecheck`
Expected: 1 test passes; `tsc` exits 0 with no output. (This task's "failing state" is the commands not existing before Steps 1-3; from here on every task follows red→green.)

- [ ] **Step 6: Create `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun run typecheck
      - run: bun test

  gitleaks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Run gitleaks (redacted output)
        run: |
          curl -sSfL https://github.com/gitleaks/gitleaks/releases/download/v8.18.4/gitleaks_8.18.4_linux_x64.tar.gz | tar -xz gitleaks
          ./gitleaks detect --source . --no-banner --redact
```

`--redact` ensures a real leak never gets printed into public CI logs. The pinned binary avoids the gitleaks-action org-license requirement.

- [ ] **Step 7: Commit**

```bash
git add package.json bun.lock tsconfig.json tests/tooling.test.ts .github/workflows/ci.yml
git commit -m "chore: bun tooling, strict tsconfig, CI with gitleaks"
```

---

### Task 2: Config loading with fail-fast validation

**Files:**
- Create: `src/config/env.ts`
- Test: `tests/config/env.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface LivespaceConfig { subdomain: string; apiKey: string; apiSecret: string }` and `function loadLivespaceConfig(env: Record<string, string | undefined>): LivespaceConfig` (throws `Error` on missing/invalid config). Used by Task 6 (client) and Task 7 (smoke).

- [ ] **Step 1: Write the failing tests**

Create `tests/config/env.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { loadLivespaceConfig } from "../../src/config/env.js";

const VALID = {
  LIVESPACE_SUBDOMAIN: "acme-test",
  LIVESPACE_API_KEY: "synthetic-key-123",
  LIVESPACE_API_SECRET: "synthetic-secret-456",
};

describe("loadLivespaceConfig", () => {
  test("returns trimmed config for valid env", () => {
    const config = loadLivespaceConfig({ ...VALID, LIVESPACE_SUBDOMAIN: " acme-test " });
    expect(config).toEqual({
      subdomain: "acme-test",
      apiKey: "synthetic-key-123",
      apiSecret: "synthetic-secret-456",
    });
  });

  test("throws listing every missing variable name", () => {
    expect(() => loadLivespaceConfig({ LIVESPACE_SUBDOMAIN: "acme-test" })).toThrow(
      /LIVESPACE_API_KEY, LIVESPACE_API_SECRET/,
    );
  });

  test("never echoes provided values in errors", () => {
    try {
      loadLivespaceConfig({ ...VALID, LIVESPACE_SUBDOMAIN: "https://acme.livespace.io" });
      throw new Error("expected loadLivespaceConfig to throw");
    } catch (error) {
      expect(String(error)).not.toContain("acme.livespace.io");
      expect(String(error)).toContain("LIVESPACE_SUBDOMAIN");
    }
  });

  test.each(["https://acme.livespace.io", "acme.livespace.io", "acme test", ""])(
    "rejects invalid subdomain %p",
    (subdomain) => {
      expect(() => loadLivespaceConfig({ ...VALID, LIVESPACE_SUBDOMAIN: subdomain })).toThrow();
    },
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/config`
Expected: FAIL - module `src/config/env.js` not found.

- [ ] **Step 3: Implement `src/config/env.ts`**

```ts
export interface LivespaceConfig {
  subdomain: string;
  apiKey: string;
  apiSecret: string;
}

const SUBDOMAIN_RE = /^[a-z0-9][a-z0-9-]{0,62}$/i;

export function loadLivespaceConfig(
  env: Record<string, string | undefined>,
): LivespaceConfig {
  const subdomain = env["LIVESPACE_SUBDOMAIN"]?.trim() ?? "";
  const apiKey = env["LIVESPACE_API_KEY"]?.trim() ?? "";
  const apiSecret = env["LIVESPACE_API_SECRET"]?.trim() ?? "";

  const missing = (
    [
      ["LIVESPACE_SUBDOMAIN", subdomain],
      ["LIVESPACE_API_KEY", apiKey],
      ["LIVESPACE_API_SECRET", apiSecret],
    ] as const
  )
    .filter(([, value]) => value === "")
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(
      `Missing required configuration: ${missing.join(", ")}. ` +
        "Copy .env.example to .env and fill in the values.",
    );
  }

  if (!SUBDOMAIN_RE.test(subdomain)) {
    throw new Error(
      "LIVESPACE_SUBDOMAIN must be the bare subdomain name " +
        "(letters, digits, hyphens) without protocol or domain suffix.",
    );
  }

  return { subdomain, apiKey, apiSecret };
}
```

The subdomain regex is a security control: the value is interpolated into the request URL, so its shape MUST be constrained (docs/security.md §1).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/config && bun run typecheck`
Expected: all tests PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/config/env.ts tests/config/env.test.ts
git commit -m "feat: fail-fast config loading with subdomain shape validation"
```

---

### Task 3: Portable SHA-1 and request signature

**Files:**
- Create: `src/livespace/crypto.ts`
- Test: `tests/livespace/crypto.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `async function sha1Hex(input: string): Promise<string>` and `async function buildSignature(apiKey: string, token: string, apiSecret: string): Promise<string>`. Used by Task 6.

- [ ] **Step 1: Write the failing tests**

Create `tests/livespace/crypto.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/livespace/crypto.test.ts`
Expected: FAIL - module `src/livespace/crypto.js` not found.

- [ ] **Step 3: Implement `src/livespace/crypto.ts`**

```ts
export async function sha1Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function buildSignature(
  apiKey: string,
  token: string,
  apiSecret: string,
): Promise<string> {
  return sha1Hex(`${apiKey}${token}${apiSecret}`);
}
```

WebCrypto (`crypto.subtle`) on purpose - identical behavior on Bun, Node 20+, and Cloudflare Workers. SHA-1 here is Livespace's request-signing scheme, not our choice of hash for anything security-critical on our side.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/livespace/crypto.test.ts && bun run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/livespace/crypto.ts tests/livespace/crypto.test.ts
git commit -m "feat: portable sha1 and livespace signature"
```

---

### Task 4: Error taxonomy with recovery hints

**Files:**
- Create: `src/livespace/errors.ts`
- Test: `tests/livespace/errors.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type LivespaceErrorCode`, `class LivespaceError extends Error { code; hint; resultCode? }` with constructor `(code, message, hint, resultCode?)`, and `function errorFromEnvelope(resultCode: number): LivespaceError`. Used by Task 6; later reused by every MCP tool.

- [ ] **Step 1: Write the failing tests**

Create `tests/livespace/errors.test.ts`:

```ts
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

  test("is structurally unable to leak envelope bodies", () => {
    // The factory accepts only the numeric result code - there is no
    // parameter through which upstream body content could enter the error.
    expect(errorFromEnvelope.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/livespace/errors.test.ts`
Expected: FAIL - module `src/livespace/errors.js` not found.

- [ ] **Step 3: Implement `src/livespace/errors.ts`**

```ts
export type LivespaceErrorCode =
  | "AUTH_FAILED"
  | "PERMISSION_DENIED"
  | "NOT_LOGGED_IN"
  | "VALIDATION_ERROR"
  | "BAD_PARAMS"
  | "UNKNOWN_MODULE"
  | "UNKNOWN_METHOD"
  | "UPSTREAM_ERROR"
  | "NETWORK_ERROR"
  | "TIMEOUT";

export class LivespaceError extends Error {
  constructor(
    readonly code: LivespaceErrorCode,
    message: string,
    readonly hint: string,
    readonly resultCode?: number,
  ) {
    super(message);
    this.name = "LivespaceError";
  }
}

interface MappedError {
  code: LivespaceErrorCode;
  message: string;
  hint: string;
}

const RESULT_CODE_MAP: Record<number, MappedError> = {
  400: {
    code: "UPSTREAM_ERROR",
    message: "Livespace reported a general method error (400).",
    hint: "Check the call parameters and retry once.",
  },
  420: {
    code: "VALIDATION_ERROR",
    message: "Livespace rejected the request as invalid (420).",
    hint: "One or more field values are invalid for this method. Fix them and retry.",
  },
  500: {
    code: "UPSTREAM_ERROR",
    message: "Livespace reported a general API error (500).",
    hint: "Retry once; if it persists, reduce the request size.",
  },
  514: {
    code: "UNKNOWN_MODULE",
    message: "Unknown API module (514).",
    hint: "Server bug: the module name is wrong. Report it on the issue tracker.",
  },
  515: {
    code: "UNKNOWN_METHOD",
    message: "Unknown API method (515).",
    hint: "Server bug: the method name is wrong. Report it on the issue tracker.",
  },
  516: {
    code: "UPSTREAM_ERROR",
    message: "Unsupported output format (516).",
    hint: "Server bug in URL construction. Report it on the issue tracker.",
  },
  520: {
    code: "UPSTREAM_ERROR",
    message: "Livespace database error (520).",
    hint: "Retry with backoff; if it persists, the Livespace instance may be having issues.",
  },
  530: {
    code: "NOT_LOGGED_IN",
    message: "The API session is not authenticated (530).",
    hint: "The per-request auth token was rejected. This is usually transient - retry the call.",
  },
  540: {
    code: "PERMISSION_DENIED",
    message: "The API key's user lacks permission for this record or action (540).",
    hint:
      "This is a Livespace permission issue, not a call error. Use a record the key's " +
      "user can access, or adjust permissions in Livespace.",
  },
  550: {
    code: "BAD_PARAMS",
    message: "Livespace rejected the call parameters (550).",
    hint: "Check required parameters - e.g. Deal/getAll requires at least one condition.",
  },
  560: {
    code: "AUTH_FAILED",
    message: "Invalid auth method (560).",
    hint: "Server bug in the auth flow. Report it on the issue tracker.",
  },
  561: {
    code: "AUTH_FAILED",
    message: "Invalid auth parameters (561).",
    hint: "Verify LIVESPACE_API_KEY and LIVESPACE_API_SECRET.",
  },
  562: {
    code: "AUTH_FAILED",
    message: "Invalid API key (562).",
    hint: "Verify LIVESPACE_API_KEY (Livespace: Account settings -> API).",
  },
  563: {
    code: "AUTH_FAILED",
    message: "Authorization failed (563).",
    hint: "Verify the key/secret pair and that API access is enabled for this user.",
  },
  564: {
    code: "AUTH_FAILED",
    message: "General authorization error (564).",
    hint: "Verify credentials; if they are correct, retry later.",
  },
};

export function errorFromEnvelope(resultCode: number): LivespaceError {
  const mapped = RESULT_CODE_MAP[resultCode];
  if (mapped) {
    return new LivespaceError(mapped.code, mapped.message, mapped.hint, resultCode);
  }
  return new LivespaceError(
    "UPSTREAM_ERROR",
    `Livespace returned unexpected result code ${resultCode}.`,
    "Retry once; report the code on the issue tracker if it persists.",
    resultCode,
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/livespace/errors.test.ts && bun run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/livespace/errors.ts tests/livespace/errors.test.ts
git commit -m "feat: livespace error taxonomy with recovery hints"
```

---

### Task 5: Throttle with concurrency cap, spacing, and injectable time

**Files:**
- Create: `src/livespace/throttle.ts`
- Test: `tests/livespace/throttle.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface ThrottleOptions { maxConcurrent: number; minIntervalMs: number; sleep?: (ms: number) => Promise<void>; now?: () => number }` and `function createThrottle(opts: ThrottleOptions): <T>(fn: () => Promise<T>) => Promise<T>`. Used by Task 6.

- [ ] **Step 1: Write the failing tests**

Create `tests/livespace/throttle.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createThrottle } from "../../src/livespace/throttle.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("createThrottle", () => {
  test("never runs more than maxConcurrent tasks at once", async () => {
    const withSlot = createThrottle({ maxConcurrent: 2, minIntervalMs: 0 });
    let active = 0;
    let peak = 0;
    const gates = [deferred(), deferred(), deferred(), deferred()];

    const runs = gates.map((gate) =>
      withSlot(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await gate.promise;
        active -= 1;
      }),
    );

    await Promise.resolve();
    expect(peak).toBeLessThanOrEqual(2);
    for (const gate of gates) gate.resolve();
    await Promise.all(runs);
    expect(peak).toBe(2);
  });

  test("sleeps to keep minIntervalMs between task starts", async () => {
    const sleeps: number[] = [];
    const withSlot = createThrottle({
      maxConcurrent: 1,
      minIntervalMs: 150,
      now: () => 1_000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await withSlot(async () => {});
    await withSlot(async () => {});

    expect(sleeps).toEqual([150]);
  });

  test("propagates results and errors and frees the slot afterwards", async () => {
    const withSlot = createThrottle({ maxConcurrent: 1, minIntervalMs: 0 });
    await expect(withSlot(async () => "ok")).resolves.toBe("ok");
    await expect(
      withSlot(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(withSlot(async () => "still works")).resolves.toBe("still works");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/livespace/throttle.test.ts`
Expected: FAIL - module `src/livespace/throttle.js` not found.

- [ ] **Step 3: Implement `src/livespace/throttle.ts`**

```ts
export interface ThrottleOptions {
  maxConcurrent: number;
  minIntervalMs: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export function createThrottle(
  opts: ThrottleOptions,
): <T>(fn: () => Promise<T>) => Promise<T> {
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());

  let active = 0;
  let lastStart: number | undefined;
  const waiters: Array<() => void> = [];

  async function acquire(): Promise<void> {
    if (active >= opts.maxConcurrent) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    active += 1;
    if (lastStart !== undefined) {
      const wait = lastStart + opts.minIntervalMs - now();
      if (wait > 0) await sleep(wait);
    }
    lastStart = now();
  }

  function release(): void {
    active -= 1;
    waiters.shift()?.();
  }

  return async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
    await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/livespace/throttle.test.ts && bun run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/livespace/throttle.ts tests/livespace/throttle.test.ts
git commit -m "feat: request throttle with concurrency cap and spacing"
```

---

### Task 6: Signed Livespace client

**Files:**
- Create: `src/livespace/client.ts`
- Test: `tests/livespace/client.test.ts`

**Interfaces:**
- Consumes: `loadLivespaceConfig`/`LivespaceConfig` (Task 2), `buildSignature` (Task 3), `errorFromEnvelope`/`LivespaceError` (Task 4), `createThrottle` (Task 5).
- Produces: `class LivespaceClient` with `constructor(config: LivespaceConfig, options?: LivespaceClientOptions)` and `async call<T = unknown>(module: string, method: string, params?: Record<string, unknown>): Promise<T>`. `interface LivespaceClientOptions { fetchImpl?: typeof fetch; timeoutMs?: number; maxAttempts?: number; sleep?: (ms: number) => Promise<void> }`. This is the single entry point every future MCP tool uses.

- [ ] **Step 1: Write the failing tests**

Create `tests/livespace/client.test.ts`:

```ts
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
      [
        tokenEnvelope(),
        envelope({ internal: "SENSITIVE-DETAIL" }, 540, false),
      ],
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/livespace/client.test.ts`
Expected: FAIL - module `src/livespace/client.js` not found.

- [ ] **Step 3: Implement `src/livespace/client.ts`**

```ts
import type { LivespaceConfig } from "../config/env.js";
import { buildSignature } from "./crypto.js";
import { errorFromEnvelope, LivespaceError } from "./errors.js";
import { createThrottle } from "./throttle.js";

interface Envelope {
  data: unknown;
  error: unknown;
  result: number;
  status: boolean;
}

export interface LivespaceClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class LivespaceClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly withSlot: <T>(fn: () => Promise<T>) => Promise<T>;

  constructor(
    private readonly config: LivespaceConfig,
    options: LivespaceClientOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.sleep =
      options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    this.withSlot = createThrottle({
      maxConcurrent: 2,
      minIntervalMs: 150,
      sleep: this.sleep,
    });
  }

  async call<T = unknown>(
    module: string,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    return this.withSlot(async () => {
      const { token, sessionId } = await this.getToken();
      const sha = await buildSignature(this.config.apiKey, token, this.config.apiSecret);
      const body = new URLSearchParams({
        _api_auth: "key",
        _api_key: this.config.apiKey,
        _api_sha: sha,
        _api_session: sessionId,
        data: JSON.stringify(params),
      });
      const envelope = await this.post(
        `${this.baseUrl()}/${encodeURIComponent(module)}/${encodeURIComponent(method)}`,
        body,
      );
      if (envelope.status !== true || envelope.result !== 200) {
        throw errorFromEnvelope(envelope.result);
      }
      return envelope.data as T;
    });
  }

  private baseUrl(): string {
    return `https://${this.config.subdomain}.livespace.io/api/public/json`;
  }

  private async getToken(): Promise<{ token: string; sessionId: string }> {
    const body = new URLSearchParams({
      _api_auth: "key",
      _api_key: this.config.apiKey,
    });
    const envelope = await this.post(
      `${this.baseUrl()}/_Api/auth_call/_api_method/getToken`,
      body,
    );
    if (envelope.status !== true || envelope.result !== 200) {
      throw errorFromEnvelope(envelope.result);
    }
    const data = envelope.data as { token?: string; session_id?: string };
    if (!data.token || !data.session_id) {
      throw new LivespaceError(
        "AUTH_FAILED",
        "Livespace token response was malformed.",
        "Verify credentials; if they are correct, retry.",
      );
    }
    return { token: data.token, sessionId: data.session_id };
  }

  private async post(url: string, body: URLSearchParams): Promise<Envelope> {
    let lastError: LivespaceError | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const response = await this.fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: body.toString(),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (response.status >= 500) {
          lastError = new LivespaceError(
            "UPSTREAM_ERROR",
            `Livespace responded with HTTP ${response.status}.`,
            "Retry with backoff; reduce the request size if it persists.",
          );
        } else {
          return (await response.json()) as Envelope;
        }
      } catch (cause) {
        lastError =
          cause instanceof DOMException && cause.name === "TimeoutError"
            ? new LivespaceError(
                "TIMEOUT",
                `Livespace did not respond within ${this.timeoutMs} ms.`,
                "Retry; if it persists, reduce the request size.",
              )
            : new LivespaceError(
                "NETWORK_ERROR",
                "Network error while calling Livespace.",
                "Check connectivity and LIVESPACE_SUBDOMAIN, then retry.",
              );
      }
      if (attempt < this.maxAttempts) {
        await this.sleep(200 * 2 ** (attempt - 1));
      }
    }
    throw (
      lastError ??
      new LivespaceError(
        "NETWORK_ERROR",
        "Network error while calling Livespace.",
        "Check connectivity and retry.",
      )
    );
  }
}
```

Notes for the implementer:
- The catch block deliberately discards `cause` details - upstream error text never enters `LivespaceError` (docs/security.md §6).
- Retries happen per HTTP request, so a token fetch and its follow-up call each get up to `maxAttempts`.
- `encodeURIComponent` on module/method is defense-in-depth (docs/security.md §10.6); callers pass constants.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test && bun run typecheck`
Expected: full suite PASS (tooling + config + crypto + errors + throttle + client), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/livespace/client.ts tests/livespace/client.test.ts
git commit -m "feat: signed livespace client with retry and envelope mapping"
```

---

### Task 7: Live smoke script with Keychain fallback

**Files:**
- Create: `scripts/smoke.ts`
- Modify: `README.md` (add a "Development" section at the end, before "## Disclaimer")

**Interfaces:**
- Consumes: `loadLivespaceConfig` (Task 2), `LivespaceClient` (Task 6).
- Produces: `bun run smoke` - manual, network-touching verification against the sandbox account. Not part of `bun test`.

- [ ] **Step 1: Implement `scripts/smoke.ts`**

```ts
import { loadLivespaceConfig } from "../src/config/env.js";
import { LivespaceClient } from "../src/livespace/client.js";

// Reads the same macOS Keychain entries the local `livespace` skill uses
// (service "livespace-api", accounts subdomain / api-key / api-secret) so the
// sandbox credentials never need to exist in a file.
function keychain(account: string): string | undefined {
  if (process.platform !== "darwin") return undefined;
  const proc = Bun.spawnSync([
    "security",
    "find-generic-password",
    "-s",
    "livespace-api",
    "-a",
    account,
    "-w",
  ]);
  if (proc.exitCode !== 0) return undefined;
  const value = proc.stdout.toString().trim();
  return value === "" ? undefined : value;
}

const config = loadLivespaceConfig({
  LIVESPACE_SUBDOMAIN: process.env["LIVESPACE_SUBDOMAIN"] ?? keychain("subdomain"),
  LIVESPACE_API_KEY: process.env["LIVESPACE_API_KEY"] ?? keychain("api-key"),
  LIVESPACE_API_SECRET: process.env["LIVESPACE_API_SECRET"] ?? keychain("api-secret"),
});

const client = new LivespaceClient(config);

const ping = await client.call<Record<string, string>>("Default", "ping", {
  check: "smoke",
});
console.log(`ping: ${JSON.stringify(ping)}`);

const me = await client.call<{ name?: string; login?: string }>(
  "Default",
  "User_getInfo",
);
console.log(`connected as: ${me.name ?? "?"} (${me.login ?? "?"})`);
console.log("smoke: OK");
```

- [ ] **Step 2: Run the smoke script against the sandbox**

Run: `bun run smoke`
Expected output (sandbox account):

```
ping: {"check":"smoke"}
connected as: <sandbox user name> (<sandbox user login>)
smoke: OK
```

If it fails with AUTH_FAILED: credentials are missing from both env and Keychain - stop and report in `.ai/NOTIFY.md`. Do not paste credential values anywhere.

- [ ] **Step 3: Typecheck and full suite**

Run: `bun run typecheck && bun test`
Expected: clean typecheck; all tests PASS; `bun test` did NOT execute the smoke script (it lives in `scripts/`, not `tests/`).

- [ ] **Step 4: Add a Development section to `README.md`**

Insert before `## Disclaimer`:

```markdown
## Development

```bash
bun install
bun test            # offline unit tests
bun run typecheck
bun run smoke       # LIVE call against your Livespace account (uses .env or macOS Keychain)
```

`bun run smoke` performs real API calls (ping + current user) with your
credentials. Point it at a test instance, never at a production CRM.
```

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke.ts README.md
git commit -m "feat: live smoke script with keychain fallback"
```

---

## Execution notes (2026-08-05, all tasks done)

Two deviations from the plan as written, both found during execution:

1. **Lockfile:** Bun 1.1.34 has no text lockfile support, so the committed
   file is `bun.lockb` (binary), not `bun.lock`. CI's `--frozen-lockfile`
   works the same.
2. **Signed-call payload format:** the live smoke test returned 561. The API
   expects the `_api_*` auth fields INSIDE the `data` JSON together with the
   params, not as separate form fields (the plan's original shape). Fixed in
   Task 6 code and tests. Follow-up: `Default/ping` echoes the payload back,
   which would have exposed the auth fields to callers - the client now strips
   `_api_*` keys from response data, and the smoke script prints no raw
   responses.

## Self-Review

1. **Spec coverage:** M0b tooling (Task 1: package.json, tsconfig strict + `noUncheckedIndexedAccess`, CI with typecheck/test/gitleaks) ✔; M1 signed client (Tasks 2-6: getToken + SHA1 flow via WebCrypto, envelope `status && result` handling, `{code, message, hint}` mapping, throttle/concurrency/backoff) ✔; live smoke vs sandbox (Task 7) ✔. Explicit-`limit` enforcement is a tool-layer rule - lands with M4 tools, noted in `.ai/PLAN.md`.
2. **Placeholder scan:** every code step contains complete code; no TBD/TODO items.
3. **Type consistency:** `LivespaceConfig` (Task 2) is consumed by Tasks 6-7 under the same name; `sha1Hex`/`buildSignature` (Task 3) match Task 6 imports; `errorFromEnvelope`/`LivespaceError` (Task 4) match Task 6 usage; `createThrottle` options (Task 5) match Task 6's `{ maxConcurrent: 2, minIntervalMs: 150, sleep }` call.
