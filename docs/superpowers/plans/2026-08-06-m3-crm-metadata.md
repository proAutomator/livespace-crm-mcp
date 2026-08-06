# M3 crm_metadata - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One read tool, `crm_metadata`, returning slim CRM dictionaries (processes with stages and steps, users, groups, sources, task types and statuses, products, datasets, current user) behind an in-memory TTL cache with single-flight and stale-if-error.

**Architecture:** Three new modules with clean seams. `src/server/cache.ts` is a generic TTL cache (no Livespace knowledge). `src/livespace/metadata.ts` holds the slim-shape types, the upstream fetchers, and the mappers from live-verified API shapes. `src/server/tools/crm-metadata.ts` is the tool: sections argument, per-section assembly with partial results, dual-channel output. `index.ts` builds the service once per process (cache state survives requests; the MCP protocol stays stateless - security.md par. 8 allows exactly this cache). Registration in `mcp.ts` next to `health`.

**Tech Stack:** unchanged (no new dependencies - security.md par. 7). Zod idiom `import * as z from "zod/v4"`, schemas as `z.object(...)`.

## Live-verified API shapes (probe run 2026-08-06 on the sandbox)

These are the REAL response shapes (field names verified live; values here are
synthetic). Do not trust the Postman docs over this section.

1. `Deal/process_getList` - record keyed by process id:
   `{ [processId]: { name: string, main_stages: { [stageId]: { name: string, stages: { [stepId]: { name: string } } } } } }`
   Livespace naming trap: `main_stages` are the pipeline stages; the nested
   `stages` are the checkbox STEPS inside a stage. Our slim shape calls them
   `stages` and `steps`.
2. `Default/User_getAll` - array of
   `{ id: string, login: string, email: string, firstname: string, lastname: string, name: string, phone: string | null, structures: [{ id, name, roles: [{ id, name }] }] }`
3. `Default/getDatasets` - `[]` on the sandbox (no custom fields defined).
   The non-empty shape is UNVERIFIED - the mapper must be defensive (see
   Task 2) and unknown shapes must surface as a section error, never a crash.
4. `Contact/getGroupList` - record `{ [groupId]: name }`.
5. `Deal/getGroupList` - `[]` on the sandbox; when non-empty, expected to be a
   record `{ [groupId]: name }` like the contact variant.
6. `Default/getSourceList` - `string[]` (plain names, NO ids).
7. `Todo/getTypes` - record `{ [typeId]: name }`.
8. `Todo/getStatuses` - record `{ [statusId]: name }`.
9. `Deal/product_getAll` - `{ product: [{ id, name, sku, default_price: string, change_price_by_user: boolean }] }`
   (note the `product` wrapper and the price as a STRING like "2500.00").
10. `Default/User_getInfo` - object with `login, email, firstname, lastname, user_role, position, name, phone, locale, lang, avatar, app_settings: { has_spaces, permission: { contact_add, company_add, deal_add, space_add, todo_add } }, structures: [...]`.
    There is NO `id` field - the current user's id must be found by matching
    `email` in the `users` section.

**PHP serialization trap (MUST handle everywhere):** empty collections arrive
as `[]` even where the non-empty form is a keyed object. Every record mapper
first normalizes: `Array.isArray(x) && x.length === 0` -> empty.

## Global Constraints

- All M0b-M2.5 constraints apply: English, TDD, `{code, message, hint}` errors, no secrets and no real CRM data anywhere (fixtures fully synthetic - invented names like "Synthetic Process A", ids like "proc-synthetic-1"; NEVER copy sandbox values), unit tests MUST NOT touch the network.
- IDs are opaque strings. Mappers MUST NOT validate or parse id formats.
- Upstream error bodies never reach results; section failures surface as `{section, code, message, hint}` entries (codes come from `LivespaceError`).
- Tool annotations: `readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false` (same rationale as `health`).
- Register tools inside the factory in `mcp.ts` only; `crm_metadata` registers AFTER `health` (deterministic tools/list order).
- Cancellation: the tool threads the request signal into every fetcher via the service (same `requestSignal(ctx)` helper `health` uses).
- No new runtime dependencies. No new env vars (TTLs are constants).
- Do not push. Commits stay local; Kuba pushes.

---

### Task 1: Generic TTL cache with single-flight and stale-if-error

**Files:**
- Create: `src/server/cache.ts`
- Create: `tests/server/cache.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:

```ts
export interface TtlCacheOptions {
  ttlMs: number;        // fresh window
  staleMaxMs: number;   // after ttl, errors may serve stale values up to this age
  now?: () => number;
  jitter?: () => number; // 0..1, scales +-10% of ttl per entry
}
export interface CacheHit<T> {
  value: T;
  asOf: number;   // epoch ms when the value was fetched
  stale: boolean; // true when served past ttl via stale-if-error
}
export function createTtlCache(opts: TtlCacheOptions): {
  get<T>(key: string, fetch: () => Promise<T>): Promise<CacheHit<T>>;
  invalidate(key: string): void;
};
```

Semantics: fresh hit -> cached value, `stale: false`. Expired or missing ->
run `fetch` with single-flight (concurrent `get`s for the same key await one
fetch). Fetch success -> store `{value, asOf: now()}` with per-entry expiry
`asOf + ttlMs * (0.9 + 0.2 * jitter())`. Fetch failure -> if a previous value
exists and `now() - asOf <= staleMaxMs`, return it with `stale: true`;
otherwise rethrow the fetch error. A failed fetch clears the in-flight slot so
the next call retries.

- [ ] **Step 1: Write the failing tests**

Create `tests/server/cache.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createTtlCache } from "../../src/server/cache.js";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("createTtlCache", () => {
  test("caches within ttl and refetches after expiry", async () => {
    const c = clock();
    let fetches = 0;
    const cache = createTtlCache({
      ttlMs: 1000,
      staleMaxMs: 5000,
      now: c.now,
      jitter: () => 0.5, // expiry exactly at asOf + ttlMs
    });
    const fetcher = async () => {
      fetches += 1;
      return `v${fetches}`;
    };

    const first = await cache.get("k", fetcher);
    expect(first).toEqual({ value: "v1", asOf: 1_000_000, stale: false });
    c.advance(999);
    expect((await cache.get("k", fetcher)).value).toBe("v1");
    expect(fetches).toBe(1);
    c.advance(2); // past expiry
    expect((await cache.get("k", fetcher)).value).toBe("v2");
    expect(fetches).toBe(2);
  });

  test("single-flight: concurrent gets share one fetch", async () => {
    const c = clock();
    let fetches = 0;
    let release!: (v: string) => void;
    const cache = createTtlCache({
      ttlMs: 1000,
      staleMaxMs: 5000,
      now: c.now,
      jitter: () => 0.5,
    });
    const fetcher = () => {
      fetches += 1;
      return new Promise<string>((resolve) => (release = resolve));
    };

    const a = cache.get("k", fetcher);
    const b = cache.get("k", fetcher);
    release("shared");
    expect((await a).value).toBe("shared");
    expect((await b).value).toBe("shared");
    expect(fetches).toBe(1);
  });

  test("stale-if-error: serves the old value within staleMaxMs", async () => {
    const c = clock();
    const cache = createTtlCache({
      ttlMs: 1000,
      staleMaxMs: 5000,
      now: c.now,
      jitter: () => 0.5,
    });
    let fail = false;
    const fetcher = async () => {
      if (fail) throw new Error("upstream down (synthetic)");
      return "good";
    };

    await cache.get("k", fetcher);
    fail = true;
    c.advance(2000); // expired but within staleMaxMs of asOf
    const hit = await cache.get("k", fetcher);
    expect(hit.value).toBe("good");
    expect(hit.stale).toBe(true);
    expect(hit.asOf).toBe(1_000_000);
  });

  test("stale-if-error: rethrows beyond staleMaxMs and after invalidate", async () => {
    const c = clock();
    const cache = createTtlCache({
      ttlMs: 1000,
      staleMaxMs: 5000,
      now: c.now,
      jitter: () => 0.5,
    });
    let fail = false;
    const fetcher = async () => {
      if (fail) throw new Error("upstream down (synthetic)");
      return "good";
    };

    await cache.get("k", fetcher);
    fail = true;
    c.advance(5001);
    await expect(cache.get("k", fetcher)).rejects.toThrow("upstream down");

    fail = false;
    await cache.get("k", fetcher); // repopulate
    cache.invalidate("k");
    fail = true;
    await expect(cache.get("k", fetcher)).rejects.toThrow("upstream down");
  });

  test("a failed fetch clears the in-flight slot so the next call retries", async () => {
    const c = clock();
    let fetches = 0;
    const cache = createTtlCache({
      ttlMs: 1000,
      staleMaxMs: 5000,
      now: c.now,
      jitter: () => 0.5,
    });
    const fetcher = async () => {
      fetches += 1;
      if (fetches === 1) throw new Error("boom (synthetic)");
      return "ok";
    };

    await expect(cache.get("k", fetcher)).rejects.toThrow("boom");
    expect((await cache.get("k", fetcher)).value).toBe("ok");
    expect(fetches).toBe(2);
  });

  test("jitter spreads expiry: jitter() = 1 extends the window +10%", async () => {
    const c = clock();
    let fetches = 0;
    const cache = createTtlCache({
      ttlMs: 1000,
      staleMaxMs: 5000,
      now: c.now,
      jitter: () => 1,
    });
    const fetcher = async () => {
      fetches += 1;
      return "v";
    };
    await cache.get("k", fetcher);
    c.advance(1050); // past ttl, within ttl * 1.1
    await cache.get("k", fetcher);
    expect(fetches).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/server/cache.test.ts`
Expected: FAIL with "Cannot find module .../cache.js"

- [ ] **Step 3: Implement `src/server/cache.ts`**

```ts
export interface TtlCacheOptions {
  ttlMs: number;
  staleMaxMs: number;
  now?: () => number;
  jitter?: () => number;
}

export interface CacheHit<T> {
  value: T;
  asOf: number;
  stale: boolean;
}

interface Entry {
  value: unknown;
  asOf: number;
  expiresAt: number;
}

// In-memory dictionary cache (docs/security.md par. 3 and par. 8): TTL with
// per-entry jitter so sections do not all expire at once, single-flight so a
// burst of tool calls costs one upstream fetch, and stale-if-error so a
// Livespace hiccup degrades to slightly old dictionaries instead of failing.
export function createTtlCache(opts: TtlCacheOptions): {
  get<T>(key: string, fetch: () => Promise<T>): Promise<CacheHit<T>>;
  invalidate(key: string): void;
} {
  const now = opts.now ?? (() => Date.now());
  const jitter = opts.jitter ?? Math.random;
  const entries = new Map<string, Entry>();
  const inFlight = new Map<string, Promise<Entry>>();

  async function fetchInto(key: string, fetch: () => Promise<unknown>): Promise<Entry> {
    const running = inFlight.get(key);
    if (running) return running;
    const promise = (async () => {
      const value = await fetch();
      const asOf = now();
      const entry: Entry = {
        value,
        asOf,
        expiresAt: asOf + opts.ttlMs * (0.9 + 0.2 * jitter()),
      };
      entries.set(key, entry);
      return entry;
    })();
    inFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      inFlight.delete(key);
    }
  }

  return {
    async get<T>(key: string, fetch: () => Promise<T>): Promise<CacheHit<T>> {
      const cached = entries.get(key);
      if (cached && now() < cached.expiresAt) {
        return { value: cached.value as T, asOf: cached.asOf, stale: false };
      }
      try {
        const entry = await fetchInto(key, fetch);
        return { value: entry.value as T, asOf: entry.asOf, stale: false };
      } catch (error) {
        if (cached && now() - cached.asOf <= opts.staleMaxMs) {
          return { value: cached.value as T, asOf: cached.asOf, stale: true };
        }
        throw error;
      }
    },
    invalidate(key: string): void {
      entries.delete(key);
    },
  };
}
```

- [ ] **Step 4: Run the cache tests, expect 6 pass**

Run: `bun test tests/server/cache.test.ts`

- [ ] **Step 5: Full suite, typecheck, commit**

Run: `bun test && bun run typecheck`

```bash
git add src/server/cache.ts tests/server/cache.test.ts
git commit -m "feat: TTL cache with single-flight, jittered expiry and stale-if-error"
```

---

### Task 2: Metadata types, mappers and fetchers

**Files:**
- Create: `src/livespace/metadata.ts`
- Create: `tests/livespace/metadata.test.ts`

**Interfaces:**
- Consumes: `LivespaceClient` (only `call<T>(module, method, params?, opts?)`), `LivespaceError` from `./errors.js`.
- Produces (Task 3 depends on these exact names):

```ts
export const METADATA_SECTIONS = [
  "processes", "users", "contactGroups", "dealGroups", "sources",
  "taskTypes", "taskStatuses", "products", "datasets", "currentUser",
] as const;
export type MetadataSection = (typeof METADATA_SECTIONS)[number];

export interface IdName { id: string; name: string }
export interface ProcessStep { id: string; name: string }
export interface ProcessStage { id: string; name: string; steps: ProcessStep[] }
export interface ProcessInfo { id: string; name: string; stages: ProcessStage[] }
export interface UserTeam { id: string; name: string; roles: string[] }
export interface UserInfo { id: string; name: string; email: string; teams: UserTeam[] }
export interface ProductInfo { id: string; name: string; sku: string; defaultPrice: string }
export interface CurrentUser {
  name: string;
  email: string;
  position: string;
  permissions: Record<string, boolean>;
  teams: UserTeam[];
}
export interface SectionDataMap {
  processes: ProcessInfo[];
  users: UserInfo[];
  contactGroups: IdName[];
  dealGroups: IdName[];
  sources: string[];
  taskTypes: IdName[];
  taskStatuses: IdName[];
  products: ProductInfo[];
  datasets: IdName[];
  currentUser: CurrentUser;
}
export type MetadataFetchers = {
  [S in MetadataSection]: (opts?: { signal?: AbortSignal }) => Promise<SectionDataMap[S]>;
};
export function createMetadataFetchers(
  client: Pick<LivespaceClient, "call">,
): MetadataFetchers;
```

Mapper rules (from the live-verified shapes above):

- Record normalization helper used by every record mapper:

```ts
function asRecord(data: unknown): Record<string, unknown> {
  if (Array.isArray(data)) {
    if (data.length === 0) return {};
    // A non-empty array where a record was expected is an unknown upstream
    // shape - fail the section cleanly rather than mis-mapping it.
    throw unexpectedShape();
  }
  if (data !== null && typeof data === "object") return data as Record<string, unknown>;
  throw unexpectedShape();
}
```

  where `unexpectedShape()` returns
  `new LivespaceError("UPSTREAM_ERROR", "Livespace returned an unexpected shape for this dictionary.", "Report it on the issue tracker; the API may have changed.")`.
- `processes`: map the `process_getList` record; each process `{ id: key, name, stages }`, each `main_stages` entry -> `{ id: key, name, steps }`, each nested `stages` entry -> `{ id: key, name }`. Missing/empty `main_stages` (also `[]`) -> `stages: []`.
- `users`: from the array; `{ id, name, email, teams }` where teams come from `structures` (`roles` mapped to their `name` strings). Tolerate missing `structures` (-> `[]`). Skip entries without an `id` (do not throw).
- `contactGroups`, `dealGroups`, `taskTypes`, `taskStatuses`: record of id -> name (values are strings) -> `IdName[]` sorted by name for stable output.
- `sources`: array of strings; non-string entries are dropped.
- `products`: unwrap the `product` array; `default_price` stays a string (`defaultPrice`); missing `sku` -> `""`.
- `datasets`: sandbox returns `[]`; defensively support (a) `[]` -> `[]`, (b) record id -> name -> `IdName[]`, (c) array of objects with `id` and `name` -> `IdName[]`. Anything else -> throw `unexpectedShape()` (surfaces as a section error in Task 3, never a crash).
- `currentUser`: `{ name, email, position: position ?? "", permissions, teams }` where `permissions` copies the boolean entries of `app_settings.permission` (tolerating absence -> `{}`).

Upstream calls (exact): `Deal/process_getList {}`, `Default/User_getAll {}`,
`Default/getDatasets {}`, `Contact/getGroupList {}`, `Deal/getGroupList {}`,
`Default/getSourceList {}`, `Todo/getTypes {}`, `Todo/getStatuses {}`,
`Deal/product_getAll {}`, `Default/User_getInfo {}` - all with
`{ signal }` passed through as the 4th `call` argument. These dictionary
endpoints take no `limit` parameter; the explicit-limit rule
(docs/security.md par. 3) applies to the M4 list tools.

- [ ] **Step 1: Write the failing tests**

Create `tests/livespace/metadata.test.ts` with synthetic fixtures exercising every rule above. Cover at minimum:

1. `processes`: two synthetic processes with nested stages/steps map to ordered arrays with ids taken from record keys; a process with `main_stages: []` (PHP empty) yields `stages: []`.
2. `users`: structures -> teams with role names; an entry without `id` is skipped; missing `structures` tolerated.
3. `contactGroups`: record -> sorted `IdName[]`; `[]` -> `[]`.
4. `dealGroups`: `[]` -> `[]`.
5. `sources`: `["Synthetic inbound", "Synthetic outbound"]` passes through; a non-string entry is dropped.
6. `taskTypes` / `taskStatuses`: record -> sorted `IdName[]`.
7. `products`: unwraps `product`, keeps `defaultPrice` as string.
8. `datasets`: `[]` -> `[]`; record form -> `IdName[]`; object-array form -> `IdName[]`; a number -> throws `LivespaceError` with code `UPSTREAM_ERROR`.
9. `currentUser`: maps name/email/position/permissions/teams; absent `app_settings` -> `permissions: {}`.
10. Fetchers call the right module/method and forward the signal: use a fake `call` recording `(module, method, params, opts)` and assert for two representative sections (e.g. `processes`, `currentUser`).

Fake client pattern:

```ts
function fakeClient(responses: Record<string, unknown>) {
  const calls: Array<{ module: string; method: string; opts?: unknown }> = [];
  return {
    calls,
    client: {
      call: (async (module: string, method: string, _params?: unknown, opts?: unknown) => {
        calls.push({ module, method, opts });
        const key = `${module}/${method}`;
        if (!(key in responses)) throw new Error(`no synthetic response for ${key}`);
        return responses[key];
      }) as Pick<import("../../src/livespace/client.js").LivespaceClient, "call">["call"],
    },
  };
}
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/livespace/metadata.test.ts`
Expected: FAIL with "Cannot find module .../metadata.js"

- [ ] **Step 3: Implement `src/livespace/metadata.ts`** per the Produces contract and mapper rules. Keep each mapper a small named function; export nothing beyond the Produces list.

- [ ] **Step 4: Run the metadata tests, expect green**

- [ ] **Step 5: Full suite, typecheck, commit**

```bash
git add src/livespace/metadata.ts tests/livespace/metadata.test.ts
git commit -m "feat: metadata mappers and fetchers for the crm_metadata dictionaries"
```

---

### Task 3: The crm_metadata tool module

**Files:**
- Create: `src/server/tools/crm-metadata.ts`
- Create: `tests/server/tools/crm-metadata.test.ts`

**Interfaces:**
- Consumes: `METADATA_SECTIONS`, `MetadataSection`, `SectionDataMap` from `../../livespace/metadata.js`; `LivespaceError` from `../../livespace/errors.js`.
- Produces (Task 4 depends on these exact names):

```ts
export interface SectionResult<S extends MetadataSection = MetadataSection> {
  data: SectionDataMap[S];
  asOf: number;
  stale: boolean;
}
export interface MetadataService {
  get<S extends MetadataSection>(
    section: S,
    opts?: { signal?: AbortSignal },
  ): Promise<SectionResult<S>>;
}
export const crmMetadataToolConfig: { title, description, inputSchema, outputSchema, annotations };
export interface CrmMetadataResult {
  text: string;
  structured: Record<string, unknown>;
  isError: boolean;
}
export async function runCrmMetadata(
  service: MetadataService,
  args: { sections?: MetadataSection[] },
  opts?: { signal?: AbortSignal; now?: () => number },
): Promise<CrmMetadataResult>;
```

Tool contract:

- `inputSchema`: `z.object({ sections: z.array(z.enum(METADATA_SECTIONS)).min(1).optional().describe("Dictionary sections to return (default: all). Fetch only what you need.") })`.
- `outputSchema`: `z.object({ sections: z.record(z.string(), z.object({ asOf: z.number(), ageMs: z.number(), stale: z.boolean(), data: z.unknown() })), errors: z.array(z.object({ section: z.string(), code: z.string(), message: z.string(), hint: z.string() })) })`.
- `annotations`: `readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false`.
- `description` (verbatim, teaches the traps):

```
Read CRM dictionaries: processes (with stages and their checkbox steps),
users and teams, contact/deal groups, sources, task types and statuses,
products, custom-field datasets, and the current user. ALWAYS take ids from
here instead of guessing. Notes: deal stage changes happen by completing
steps, not by setting a stage directly; sources have no ids (names only);
currentUser has no id - match its email in the users section. Results are
cached server-side for a few minutes (see asOf/ageMs/stale per section).
```

- `runCrmMetadata`: requested = `args.sections ?? [...METADATA_SECTIONS]`, deduplicated, in `METADATA_SECTIONS` order. Sections resolve via `Promise.all` (the client throttle serializes upstream load). Success -> `sections[name] = { asOf, ageMs: now() - asOf, stale, data }`. `LivespaceError` -> `errors` entry `{section, code, message, hint}`; unexpected error -> entry with code `UPSTREAM_ERROR` and a generic message (never the raw error text - docs/security.md par. 6). `isError` is true only when EVERY requested section failed.
- Markdown `text`: one line per section - counts for arrays (`processes: 2 (with stages and steps)`, `users: 33`), `currentUser: <name>`, stale marker ` (stale)` when set; failed sections listed as `<section>: ERROR <code> - <hint>`. First line: `CRM metadata (<n>/<m> sections ok)`.

- [ ] **Step 1: Write the failing tests**

Create `tests/server/tools/crm-metadata.test.ts` with a fake `MetadataService` (record of canned `SectionResult`s or throwers). Cover:

1. Default call returns all ten sections with `asOf`/`ageMs`/`stale` and data passthrough; `isError` false; text contains `users: 2` style counts.
2. `sections: ["processes", "currentUser"]` returns exactly those keys (and `errors: []`).
3. Duplicate sections in args are deduplicated.
4. One failing section (service throws `LivespaceError("UPSTREAM_ERROR", ...)`) -> other sections present, `errors` has the `{section, code, hint}` entry, `isError` false, text shows the ERROR line.
5. All requested sections failing -> `isError` true.
6. Non-`LivespaceError` failure -> generic `UPSTREAM_ERROR` entry whose message does NOT contain the thrown error text (assert with a marker string like "SENSITIVE-synthetic").
7. Stale section -> `stale: true` in structured data and `(stale)` in the text line.
8. The signal is forwarded to `service.get` (record opts in the fake).
9. `crmMetadataToolConfig.annotations` equals the constants above.

- [ ] **Step 2: Run to verify failure** (`bun test tests/server/tools/crm-metadata.test.ts` - module not found)

- [ ] **Step 3: Implement `src/server/tools/crm-metadata.ts`** per the contract.

- [ ] **Step 4: Run the tool tests, expect green**

- [ ] **Step 5: Full suite, typecheck, commit**

```bash
git add src/server/tools/crm-metadata.ts tests/server/tools/crm-metadata.test.ts
git commit -m "feat: crm_metadata tool with per-section partial results"
```

---

### Task 4: Wiring - service construction, registration, instructions, HTTP contract

**Files:**
- Modify: `src/server/mcp.ts` (AppDeps + registration)
- Modify: `src/index.ts` (build the service once per process)
- Modify: `src/server/instructions.ts` (quick start mentions crm_metadata + the id discipline)
- Modify: `tests/server/http.test.ts` or `tests/server/modern-wire.test.ts` (HTTP contract additions)
- Modify: `tests/server/instructions.test.ts` (updated expectations)

**Interfaces:**
- Consumes: `MetadataService`, `crmMetadataToolConfig`, `runCrmMetadata` (Task 3); `createTtlCache` (Task 1); `createMetadataFetchers` (Task 2).
- Produces: `AppDeps` gains `metadata?: MetadataService | undefined`. `createMetadataService(client)` lives in `src/index.ts`? No - put it in `src/server/tools/crm-metadata.ts` as:

```ts
export function createMetadataService(
  client: Pick<LivespaceClient, "call">,
  cacheOpts?: Partial<TtlCacheOptions>,
): MetadataService;
```

using `createTtlCache({ ttlMs: 5 * 60_000, staleMaxMs: 30 * 60_000, ...cacheOpts })` and `createMetadataFetchers(client)`; cache key = section name.

- [ ] **Step 1: Failing HTTP tests first**

Add to `tests/server/modern-wire.test.ts` (uses the modern era; `buildApp` deps gain a fake metadata service):

```ts
  test("crm_metadata is listed with read-only annotations and called end to end", async () => {
    const service = {
      get: async (section: string) => ({
        data: section === "currentUser"
          ? { name: "Synthetic User", email: "synthetic@example.com", position: "", permissions: {}, teams: [] }
          : [],
        asOf: 1_000,
        stale: false,
      }),
    };
    const instance = buildApp({
      config: BASE_CONFIG,
      version: "0.0.0-test",
      metadata: service as never,
    });
    const list = await jsonFromResponse(
      await instance.request(modernRequest({ method: "tools/list" })),
    );
    const tool = list.result.tools.find((t: any) => t.name === "crm_metadata");
    expect(tool).toBeDefined();
    expect(tool.annotations.readOnlyHint).toBe(true);
    expect(tool.annotations.openWorldHint).toBe(false);

    const call = await jsonFromResponse(
      await instance.request(
        modernRequest({
          method: "tools/call",
          name: "crm_metadata",
          params: { name: "crm_metadata", arguments: { sections: ["currentUser"] } },
          id: 9,
        }),
      ),
    );
    expect(call.result.resultType).toBe("complete");
    expect(call.result.structuredContent.sections.currentUser.data.name).toBe(
      "Synthetic User",
    );
    expect(call.result.structuredContent.errors).toEqual([]);
  });

  test("crm_metadata is absent when no metadata service is configured", async () => {
    const list = await jsonFromResponse(
      await app().request(modernRequest({ method: "tools/list" })),
    );
    expect(list.result.tools.map((t: any) => t.name)).not.toContain("crm_metadata");
  });
```

- [ ] **Step 2: Run to verify failure** (unknown deps key / tool missing)

- [ ] **Step 3: Wire it**

`src/server/mcp.ts`: `AppDeps` gains `metadata?: MetadataService | undefined`; after the `health` registration:

```ts
    if (deps.metadata) {
      const metadata = deps.metadata;
      server.registerTool("crm_metadata", crmMetadataToolConfig, async (args, ctx) => {
        const result = await runCrmMetadata(metadata, args, {
          signal: requestSignal(ctx),
        });
        return {
          content: [{ type: "text" as const, text: result.text }],
          structuredContent: result.structured,
          ...(result.isError ? { isError: true } : {}),
        };
      });
    }
```

`src/index.ts`: `metadata: createMetadataService(client)` in the `buildApp` deps.

`src/server/instructions.ts`: replace the "More tools ... arrive in later milestones" bullet with:

```
- Call "crm_metadata" before anything that needs CRM ids (processes, stages
  and steps, users, groups, task types/statuses, products). Fetch only the
  sections you need. Never guess ids - always take them from crm_metadata.
```

and keep the milestone note for the remaining tools. Update
`tests/server/instructions.test.ts` expectations accordingly (inspect the
existing assertions first and keep their style).

- [ ] **Step 4: Full suite + typecheck, expect green**

- [ ] **Step 5: Commit**

```bash
git add src/server/mcp.ts src/index.ts src/server/instructions.ts src/server/tools/crm-metadata.ts tests/server/modern-wire.test.ts tests/server/instructions.test.ts
git commit -m "feat: register crm_metadata behind a per-process cached service"
```

(`crm-metadata.ts` appears again because `createMetadataService` lands here.)

---

### Task 5: Docs and final gates

**Files:**
- Modify: `README.md` (status note: crm_metadata is live; tool list wording)
- Modify: `docs/superpowers/plans/2026-08-06-m3-crm-metadata.md` (execution notes)

- [ ] **Step 1: README** - in the status blockquote, change "`health` is live, read tools are next" to "`health` and `crm_metadata` (CRM dictionaries) are live; search and read tools are next". No other README changes.

- [ ] **Step 2: Full gates**

Run: `bun test && bun run typecheck && bun audit`
Expected: all green (about 110+ tests).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: crm_metadata in the status note"
```

- [ ] **Step 4: Execution notes** - record deviations in this plan doc under Execution notes (the orchestrator commits this with the handoff).

---

## Live smoke (orchestrator runs this, not a subagent)

`MCP_PORT=3021 bun run dev` with Keychain credentials, then a modern-era
`tools/call crm_metadata` with `sections: ["processes","currentUser"]` and a
full call without arguments; verify counts match the sandbox (2 processes,
33 users, 0 datasets, 9 products) and that a second call returns the same
`asOf` (cache hit). Never against a production CRM.

## Execution notes

(fill in during execution)
