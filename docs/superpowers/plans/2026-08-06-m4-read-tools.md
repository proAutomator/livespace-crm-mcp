# M4 Read Tools - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execute ONLY your assigned task; do not touch files outside its list. If a step conflicts with reality, record the deviation in your report instead of improvising.

**Goal:** Three read tools - `search_crm` (phrase and filter search over contacts, companies, deals), `get_records` (batch fetch by id with detail levels and optional activity wall), `get_activity` (record wall, CRM-wide feed, or task list) - with server-side sorting, stateless cursors, explicit upstream limits, and the M3 output discipline (partial results, counts-only text channel).

**Architecture:** Two new Livespace modules and three tool modules. `src/livespace/records.ts` owns record types, detail-level mappers and list/search/get fetchers for persons, companies, deals and tasks. `src/livespace/activity.ts` owns wall mappers (record wall + CRM feed) with HTML stripping. `src/server/cursor.ts` is a tiny stateless cursor codec. Tools live in `src/server/tools/{search-crm,get-records,get-activity}.ts`. NO caching of record data - security.md par. 8 permits only the M3 dictionary cache; every record read goes upstream. Registration order in `mcp.ts`: health, crm_metadata, search_crm, get_records, get_activity (deterministic).

**Tech Stack:** unchanged, no new dependencies. Zod idiom as in M3 (`z.strictObject` per-tool schemas, per-section/per-kind envelopes, never bare unions of similar shapes - zod picks the first match and strips fields).

## Live-verified API evidence (probe runs 2026-08-06 on the sandbox)

Field names and behavior verified live. Values below are synthetic.

1. `Contact/getAllSimple {type: "contact"|"company", limit, offset}` -
   wrapper key FOLLOWS THE TYPE: `{contact: [...]}` or `{company: [...]}`.
   `limit` and `offset` are HONORED (verified: limit 2 -> 2 items; offset
   shifts ids). Person items: `firstname, lastname, company_name, created,
   modified, email, phone, cell, fax, address_*, id, name,
   deal_count: {all, open, won, lost, outdated}, tags, contact_id, url`.
   Company items: `name, nip, regon, phone, cell, fax, email, created,
   modified, id, deal_count, tags, company_id, url`.
2. `Contact/getAll {type, names, condition: "like", limit, offset}` - same
   wrapper, richer items (~57 keys: adds `type, note, last_active_date,
   gender, firstname_vocative, www, owner_id/name/email/phone, source_id,
   source_name, groups, groups_id, tags, phones, emails, addresses,
   relations, dataset, company, company_id, company_nip, creator_*,
   modifier_*`).
3. `Contact/get {type, id}` - `{contact: {...}}` single object, same ~57
   keys.
4. `Deal/getAll {status, limit, offset}` + optional `names, processes,
   stages, owner_login, modified` - `{deal: [...]}`, ~80 keys per item;
   `limit`/`offset` HONORED; an `order` param is ACCEPTED AND IGNORED
   (verified: identical ids with and without) - sorting is entirely ours.
   Key fields: `id, name, status, status_name, created, modified, date_end,
   currency, probability` (STRING with a POLISH COMMA decimal, e.g. "5,00"),
   `value, budget, products, costs, process_id, process_name, stage_id,
   stage_name, substage_id, substage_name, stages_all, substages, owner_id,
   owner_name, owner_email, company_id, company_name, contact_id,
   contact_name, tags, groups, source_id, source_name, note, note_html,
   creator_*, modifier_*, profit_*/cost_*/gain_* families`.
5. `Deal/get {id}` - `{deal: {...}}` same shape.
6. `Todo/getTodoObjects {todo: {getWholeList: "0"|"1", isCompleted: "0"|"1",
   page: "1", datesPeriod: {from, to}}}` - `{todo: [...]}`, EXACTLY 50 per
   page (page-based pagination, stringly-typed params). Items: `id, title,
   description, type_id, type_name, status_id, status_name, is_completed,
   is_private, priority, date_from, date_to, is_all_day, has_cycle,
   objects: [{object_type, object_id, object_name}], created, modified,
   invited, creator_*, role_* (dynamic role keys)`.
7. `Todo/get {id}` - `{todo: {...}}`.
8. `Contact/getWall {type: "contact"|"company", id}` and
   `Deal/getWall {type: "deal", id}` - `{wall: [...]}`; items carry
   `text` (CONTAINS HTML - anchors etc.), `created, date, type_name,
   is_public, comment_count, comments, user_id, user_name` and more.
   Empty wall is `{wall: []}`.
9. `Wall/getList {date_from, date_to, limit, offset}` - `{items: [...]}`;
   `limit`/`offset` HONORED (verified 1/5 + offset shift). Item keys:
   `id (NUMBER - not a UUID), type_name ("activity"|"email"|...), is_public,
   text, date, creator_login, creator_name, object_name, object_type,
   comments_count, comments`. NOTE: the feed references its record by NAME
   and TYPE only - there is NO object id in the feed items.
10. `Search/getResult {q, object_type}` - REQUIRED params discovered via
    validation errors: `q` and `object_type`. `object_type` accepts
    `"contact"`, `"company"`, `"deal"` (both `"all"` and `"todo"` are 420) -
    cross-type search means one call per kind. Response wrapper follows the
    type: `{contact: [...]}` etc. Hit shape: `{id, name, number, icon,
    description, modified, details, term}` (details: small per-type object
    or absent; description carries e.g. the company name for a person).
    Matching is word-prefix based.

**Pagination reality:** no total counts anywhere upstream. `hasMore` can only
be a heuristic: a full page MAY have more.

**PHP trap and id rules from M3 still apply** (empty `[]` where records are
expected; ids are opaque strings EXCEPT `Wall/getList` item ids which are
numbers - coerce with `String()`).

## Global Constraints

- All M0b-M3 constraints apply (English, TDD, synthetic fixtures, no real CRM data or sandbox values in the repo, unit tests offline, `{code, message, hint}` errors only, no new deps/env vars).
- CRM-authored strings NEVER enter the markdown text channel (counts and fixed wording only); CRM data lives in `structuredContent` (M3 rule, security.md par. 4).
- NO caching of record data (security.md par. 8) - the M3 cache stays dictionary-only.
- EVERY upstream list call sends an explicit `limit` (these endpoints honor it - probe evidence above; security.md par. 3 and par. 10.8). Tool-level caps: `limit` arg 1-100 (default 20); `get_records` batch <= 25 ids; `includeWall` allowed only for <= 5 records per call.
- Wall/feed `text` is stripped of HTML tags and truncated to 500 chars (with a `textTruncated` flag) before it enters `structuredContent`.
- Sorting is server-side within a bounded fetch window (no upstream sort exists): when `sortBy` is set, fetch `SORT_WINDOW = 200` items (one upstream call), sort, slice the requested page from the window, and set `sortWindowTruncated: true` when the window came back full. Without `sortBy`, fetch exactly the page (limit/offset passthrough).
- Cursors are STATELESS: base64url of JSON `{v: 1, k: <kind>, o: <offset>}` - no server state, no TTL (nothing stored - par. 8), tampering can only change an offset, which yields at worst an empty page for the same principal. Invalid cursor -> `LivespaceError("BAD_PARAMS", "The cursor is invalid or from an older server version.", "Start again without a cursor.")`.
- Cancellation: request signal threads into every fetcher (M3 pattern via `requestSignal(ctx)`); abort maps to CANCELLED at the tool seam (use the shared `cancelledError()` and signal-state checks, as fixed in M3).
- Annotations on all three tools: `readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false`. (Reads are idempotent; results may change upstream between calls, which idempotentHint does not promise away.)
- Tool registration AFTER crm_metadata, in the order: search_crm, get_records, get_activity.
- Do not push. Commits stay local; Kuba pushes.

---

### Task 1: Record types and detail-level mappers (`src/livespace/records.ts` part 1)

**Files:**
- Create: `src/livespace/records.ts`
- Create: `tests/livespace/records.test.ts`

**Interfaces:**
- Consumes: `LivespaceError` from `./errors.js`.
- Produces (later tasks depend on these exact names):

```ts
export const RECORD_KINDS = ["person", "company", "deal", "task"] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];
export type DetailLevel = "minimal" | "standard" | "full";

export interface PersonRecord {
  id: string; name: string; email: string; phone: string;
  companyName: string; companyId: string | null;
  ownerName: string; ownerId: string | null;
  tags: string[]; source: string; note: string;
  created: string; modified: string; lastActiveDate: string;
  dealCount: { all: number; open: number; won: number; lost: number } | null;
  // full adds: cell, www, address (single flattened string), groups: string[]
  cell?: string; www?: string; address?: string; groups?: string[];
}
export interface CompanyRecord {
  id: string; name: string; nip: string; email: string; phone: string;
  ownerName: string; ownerId: string | null;
  tags: string[]; source: string; note: string;
  created: string; modified: string;
  dealCount: { all: number; open: number; won: number; lost: number } | null;
  www?: string; address?: string; groups?: string[];
}
export interface DealRecord {
  id: string; name: string; status: string;
  value: number | null; currency: string; probability: number | null;
  processId: string; processName: string;
  stageId: string; stageName: string; substageId: string; substageName: string;
  companyId: string | null; companyName: string;
  contactId: string | null; contactName: string;
  ownerId: string | null; ownerName: string;
  dateEnd: string; created: string; modified: string; lastActiveDate: string;
  tags: string[]; source: string; note: string;
  groups?: string[]; creatorName?: string; statusChangeDate?: string;
}
export interface TaskRecord {
  id: string; title: string; description: string;
  typeId: string; typeName: string; statusId: string | null; statusName: string;
  isCompleted: boolean; isPrivate: boolean; priority: number;
  dateFrom: string; dateTo: string; isAllDay: boolean;
  linkedRecords: Array<{ kind: string; id: string; name: string }>;
  created: string; modified: string;
}
export interface RecordDataMap {
  person: PersonRecord; company: CompanyRecord; deal: DealRecord; task: TaskRecord;
}
export function mapPerson(raw: unknown, detail: DetailLevel): PersonRecord;
export function mapCompany(raw: unknown, detail: DetailLevel): CompanyRecord;
export function mapDeal(raw: unknown, detail: DetailLevel): DealRecord;
export function mapTask(raw: unknown, detail: DetailLevel): TaskRecord;
export function parseCommaDecimal(value: unknown): number | null;
```

Mapper rules:

- All string reads via the M3-style `asName` guard (`typeof v === "string" ? v : ""`); ids via `raw.id != null ? String(raw.id) : skip/null`; a top-level element without an id is skipped in lists and `unexpectedShape()` in single-get.
- `parseCommaDecimal`: `"5,00"` -> `5`; `"1 234,50"` (spaces) -> `1234.5`; plain numbers pass; `""`/null/garbage -> `null`. Used for `probability` and deal `value` (deal `value` upstream may be a string, number, or object - when it is an object or absent, use `parseCommaDecimal(raw.budget?.…)`? NO: keep it simple and honest - read `raw.value` if string/number else `null`; the budget/products/costs families stay OUT of M4 slim shapes entirely).
- Detail levels are WHITELISTS applied in the mapper: `minimal` = id, name/title, plus per kind: person/company -> email, companyName/nip; deal -> status, value, currency, stageName, ownerName; task -> typeName, isCompleted, dateFrom. `standard` = the non-optional fields of each interface. `full` = standard + the optional fields. Minimal/standard/full all return the SAME interface with unused fields as empty strings/absent optionals - tests pin the exact field sets.
- `linkedRecords` for tasks maps `objects[]` (`object_type` -> kind, `object_id` -> id via String, `object_name` -> name), tolerating `[]`/absent. Dynamic `role_*` keys are IGNORED.
- Tags: array of strings; upstream `tags` may be `[]`, array of strings, or array of objects with `name` - map tolerantly, drop non-conforming entries.
- PHP-empty tolerance at every nested read (M3 rule).
- `dealCount`: map the numeric fields, tolerate absence -> `null`. Coerce `number | numeric-string` with `Number()`, non-finite -> 0.
- Wrapper unwrapping does NOT belong to mappers (fetchers do it - Task 2). Mappers take a raw record object.

- [ ] **Step 1: failing tests** - `tests/livespace/records.test.ts` with synthetic fixtures mirroring the probe key lists. Required cases: (1) person standard mapping incl. dealCount and tags-as-objects tolerance; (2) person minimal whitelist EXACTLY (assert unused standard fields are empty); (3) person full adds address flattening (street + city + postcode joined, skipping empties); (4) company mapping incl. nip; (5) deal standard: probability "5,00" -> 5, value string "1 234,50" -> 1234.5, stage/substage ids+names, status_name ignored in favor of `status`; (6) deal with value as object -> `value: null` (not NaN, no crash); (7) task mapping incl. linkedRecords from objects[], role_* ignored, statusId null tolerated; (8) parseCommaDecimal table test; (9) list-position skip: an element without id is skipped by callers - export mappers so a null-id raw returns `null`? NO - mappers throw on missing id; Task 2's list fetchers filter such elements BEFORE mapping. Test that mapDeal on an idless raw throws `LivespaceError` UPSTREAM_ERROR with the fixed unexpected-shape message.
- [ ] **Step 2: run to verify failure**
- [ ] **Step 3: implement**
- [ ] **Step 4: green + full suite + typecheck**
- [ ] **Step 5: commit** `feat: record types and detail-level mappers for the read tools`

---

### Task 2: Record fetchers (`src/livespace/records.ts` part 2)

**Files:**
- Modify: `src/livespace/records.ts`
- Modify: `tests/livespace/records.test.ts`

**Interfaces:**
- Consumes: Task 1 exports; `LivespaceClient` (`call` only).
- Produces:

```ts
export interface ListPage<T> { items: T[]; hasMore: boolean }
export interface RecordFetchers {
  listPersons(opts: { limit: number; offset: number; namesLike?: string; detail: DetailLevel; signal?: AbortSignal }): Promise<ListPage<PersonRecord>>;
  listCompanies(opts: same): Promise<ListPage<CompanyRecord>>;
  listDeals(opts: { limit: number; offset: number; status?: string; processId?: string; stageId?: string; ownerLogin?: string; modifiedFrom?: string; namesLike?: string; detail: DetailLevel; signal?: AbortSignal }): Promise<ListPage<DealRecord>>;
  listTasks(opts: { page: number; completed?: boolean; dateFrom?: string; dateTo?: string; signal?: AbortSignal }): Promise<ListPage<TaskRecord>>;
  searchPhrase(opts: { q: string; kind: "person" | "company" | "deal"; signal?: AbortSignal }): Promise<SearchHit[]>;
  getRecord<K extends RecordKind>(kind: K, id: string, detail: DetailLevel, opts?: { signal?: AbortSignal }): Promise<RecordDataMap[K] | null>;
}
export interface SearchHit { id: string; name: string; description: string; modified: string; kind: string }
export function createRecordFetchers(client: Pick<LivespaceClient, "call">): RecordFetchers;
```

Upstream mapping (exact):

- `listPersons`/`listCompanies`: WITHOUT `namesLike` -> `Contact/getAllSimple {type, limit, offset}` for `minimal`; `Contact/getAll {type, limit, offset}` for `standard`/`full` (richer source). WITH `namesLike` -> `Contact/getAll {type, names, condition: "like", limit, offset}`. Unwrap `{contact: [...]}` / `{company: [...]}` per type; `[]`-tolerant; elements without id filtered out before mapping. `hasMore = items.length === limit`.
- `listDeals`: `Deal/getAll {status: opts.status ?? "open", limit, offset, ...optional processes/stages/owner_login/modified/names}` (upstream param names: `processes`, `stages`, `owner_login`, `modified`, `names`). REMEMBER: the endpoint requires >= 1 condition - `status` default guarantees it. Unwrap `{deal: [...]}`.
- `listTasks`: `Todo/getTodoObjects {todo: {getWholeList: "0", isCompleted: completed === undefined ? undefined-omit : completed ? "1" : "0", page: String(page), datesPeriod?}}`. Page size upstream is FIXED at 50: `hasMore = items.length === 50`. (Cursor math for tasks uses pages, not offsets - Task 4.)
- `searchPhrase`: `Search/getResult {q, object_type}` with object_type `contact|company|deal` mapped from kind; unwrap the type-keyed array; map to `SearchHit` (ids String-coerced, strings guarded); `[]`-tolerant.
- `getRecord`: `Contact/get {type, id}` / `Deal/get {id}` / `Todo/get {id}`; unwrap the single-object wrapper (`contact`/`deal`/`todo`). A 400/404-style "not found" from upstream: Livespace signals missing records via an error envelope or an empty object - detect an empty/idless payload and return `null` (the tool layer reports per-id `not_found`); a real `LivespaceError` propagates.
- Every fetcher passes `{ signal }` as the 4th client arg and sends the explicit numeric `limit` upstream (tasks: page).

- [ ] **Step 1: failing tests** with the M3 `fakeClient` pattern. Required cases: (1) endpoint table for all fetchers asserting exact `(module, method)` and the explicit limit/page params present; (2) wrapper unwrap per type + `[]` tolerance; (3) getAllSimple-vs-getAll selection by detail and namesLike; (4) deals default status "open" and optional params only when provided; (5) tasks stringly params ("0"/"1", page as string) and datesPeriod only when dates given; (6) hasMore heuristics (full page -> true, short page -> false; tasks at exactly 50); (7) searchPhrase object_type mapping + hit mapping; (8) getRecord unwrap + not-found -> null + LivespaceError propagation unchanged; (9) signal forwarded on every call (table-driven).
- [ ] **Steps 2-4: fail -> implement -> green + gates**
- [ ] **Step 5: commit** `feat: record fetchers with explicit limits and phrase search`

---

### Task 3: Activity module (`src/livespace/activity.ts`)

**Files:**
- Create: `src/livespace/activity.ts`
- Create: `tests/livespace/activity.test.ts`

**Interfaces:**
- Consumes: `LivespaceClient`, `LivespaceError`, `asName`-style guards (duplicate the tiny guard locally or export it from records.ts - exporting from records.ts is preferred: add `export function asName(v: unknown): string` there in Task 1).
- Produces:

```ts
export interface WallEntry {
  type: string;           // type_name passthrough, e.g. "activity", "email"
  text: string;           // HTML-stripped, <= 500 chars
  textTruncated: boolean;
  date: string;
  authorName: string;
  isPublic: boolean;
  commentCount: number;
  // feed-only fields (record wall leaves them empty):
  objectName: string; objectType: string;
}
export function stripHtml(value: unknown): string; // tags out, entities &amp;/&lt;/&gt;/&quot;/&#39; decoded, whitespace collapsed
export interface ActivityFetchers {
  recordWall(opts: { kind: "person" | "company" | "deal"; id: string; signal?: AbortSignal }): Promise<WallEntry[]>;
  crmFeed(opts: { dateFrom: string; dateTo: string; limit: number; offset: number; typeName?: string; signal?: AbortSignal }): Promise<{ items: WallEntry[]; hasMore: boolean }>;
}
export function createActivityFetchers(client: Pick<LivespaceClient, "call">): ActivityFetchers;
```

Rules:

- `recordWall`: `Contact/getWall {type: "contact"|"company", id}` for person/company, `Deal/getWall {type: "deal", id}` for deals. Unwrap `{wall: [...]}`, `[]`-tolerant. Map: `type_name -> type`, `text -> stripHtml + truncate 500 (+flag)`, `date ?? created -> date`, `user_name -> authorName`, `is_public` (number 0/1 OR boolean - normalize) `-> isPublic`, `comment_count ?? comments_count -> commentCount` (Number-coerced), objectName/objectType empty.
- `crmFeed`: `Wall/getList {date_from, date_to, limit, offset}`; unwrap `{items: [...]}`; item ids are NUMBERS upstream - not exposed in `WallEntry` at all (the feed has no per-record ids; the NAME-ONLY reference limitation must be stated in the tool description). `creator_name -> authorName`, `object_name/object_type` pass through (guarded). `typeName` filter is applied SERVER-SIDE-LOCALLY after fetch (upstream filter param unverified - do not send unverified params), and the description of get_activity must say type filtering narrows the returned page, not the search.
- `stripHtml`: remove `<...>` tags via iterative replace (no regex catastrophes - a simple state machine or repeated replace until stable), decode the five basic entities, collapse runs of whitespace to single spaces, trim.

- [ ] **Step 1: failing tests**: (1) stripHtml table (anchor tag from the probe pattern, nested tags, entities, whitespace, non-string -> ""); (2) truncation at 500 with flag; (3) recordWall endpoint mapping per kind + wrapper/`[]` tolerance + is_public number vs boolean; (4) crmFeed mapping incl. NUMBER id absence from output, hasMore heuristic, local typeName filter; (5) signal forwarding; (6) LivespaceError propagation.
- [ ] **Steps 2-4: fail -> implement -> green + gates**
- [ ] **Step 5: commit** `feat: activity wall and CRM feed fetchers with HTML stripping`

---

### Task 4: Stateless cursor codec (`src/server/cursor.ts`)

**Files:**
- Create: `src/server/cursor.ts`
- Create: `tests/server/cursor.test.ts`

**Interfaces:**

```ts
export interface CursorPayload { v: 1; k: string; o: number } // kind + offset (or page for tasks)
export function encodeCursor(payload: CursorPayload): string;              // base64url(JSON)
export function decodeCursor(cursor: string, expectedKind: string): CursorPayload; // throws LivespaceError BAD_PARAMS on garbage, wrong version, kind mismatch, negative/non-integer offset, or offset > 100_000
```

Stateless by design: nothing is stored (security.md par. 8), so no TTL and
no entropy are needed - tampering can only change the offset of the
caller's OWN next page. The offset ceiling prevents absurd upstream
offsets.

- [ ] **Step 1: failing tests**: round-trip; garbage/empty/non-base64/valid-b64-invalid-json -> BAD_PARAMS with the fixed message; kind mismatch -> BAD_PARAMS; negative, float and > 100_000 offsets rejected; v !== 1 rejected.
- [ ] **Steps 2-4: fail -> implement -> green + gates**
- [ ] **Step 5: commit** `feat: stateless pagination cursor codec`

---

### Task 5: `search_crm` tool (`src/server/tools/search-crm.ts`)

**Files:**
- Create: `src/server/tools/search-crm.ts`
- Create: `tests/server/tools/search-crm.test.ts`

**Interfaces:**
- Consumes: `RecordFetchers`, `SearchHit`, records types (Tasks 1-2); cursor codec (Task 4); `LivespaceError`, `cancelledError` from errors.
- Produces:

```ts
export const searchCrmToolConfig: { title; description; inputSchema; outputSchema; annotations };
export async function runSearchCrm(
  fetchers: RecordFetchers,
  args: SearchCrmArgs,
  opts?: { signal?: AbortSignal },
): Promise<{ text: string; structured: Record<string, unknown>; isError: boolean }>;
```

Contract:

- `inputSchema` (`z.strictObject`): `{ kinds?: array of enum ["persons","companies","deals"] min 1 (default all three); phrase?: string 2-100 chars; filters?: strictObject { status?: enum open|won|lost, processId?, stageId?, ownerLogin?, modifiedFrom? (ISO date string), namesLike? 2-100 }; detail?: enum minimal|standard|full (default "standard" - phrase mode ignores it, hits are fixed-shape); sortBy?: enum name|modified|value|dateEnd (value/dateEnd deals-only - schema allows, runner validates kind compatibility); sortDir?: enum asc|desc (default desc for dates, asc for name); limit?: int 1-100 default 20; cursor?: string }`.
  Cross-field runner rules (each -> BAD_PARAMS error result, not a throw): phrase and filters are mutually EXCLUSIVE (phrase mode uses Search/getResult which takes no filters); at least one of phrase/filters present; cursor only with exactly ONE kind (multi-kind first pages have no stable continuation); sortBy=value/dateEnd only when kinds == ["deals"]; filters.status/processId/stageId/ownerLogin/modifiedFrom only when kinds includes "deals" (namesLike applies to all kinds).
- Phrase mode: fan out `searchPhrase` per requested kind (each in its own try/catch like M3 sections); per-kind envelope `{hits, count}`; no pagination (upstream search has none observed) - `limit` applies locally per kind.
- Filter mode: per kind list fetch. Offset from cursor (kind-checked) or 0. `sortBy` set -> fetch `SORT_WINDOW = 200` (single call at offset 0 - cursor with sortBy is BAD_PARAMS "sorted results do not paginate; narrow the filters instead"), sort locally (name: localeCompare; modified/dateEnd: string compare desc-capable; value: numeric with nulls last), slice `limit`, `sortWindowTruncated = window.length === 200`. No sortBy -> plain `limit/offset` passthrough with `nextCursor = encodeCursor({v:1, k: kind, o: offset + items.length})` when `hasMore`.
- Result `structured`: `{ results: { persons?: {...}, companies?: {...}, deals?: {...} }, errors: [...] }` - per-kind envelope `{ items|hits, count, hasMore?, nextCursor?, sortWindowTruncated? }`, strictObject per kind (M3 lesson - no unions of look-alike shapes). Text channel: counts only (`search_crm (2/2 kinds ok)`, `persons: 5 (more available)`, `deals: ERROR ...`).
- All-kinds-CANCELLED rethrow + empty-guard (M3 pattern), non-LivespaceError -> generic entry.

- [ ] **Step 1: failing tests** (fake fetchers recording calls): (1) phrase fan-out per kind + per-kind isolation on failure; (2) mutual exclusion and other cross-field rules -> BAD_PARAMS entries; (3) filter mode passthrough paging + nextCursor round-trip (decode it in the test); (4) sortBy window: fetch called with limit 200/offset 0, local sort applied (fixture out of order), slice to limit, truncation flag; (5) sort correctness incl. value nulls-last and desc; (6) cursor kind mismatch -> BAD_PARAMS; (7) text channel counts-only incl. hostile record names (no CRM strings in text); (8) inputSchema safeParse matrix (strict, bad kind, phrase length, limit bounds); (9) outputSchema accepts a real result and rejects a bogus kind key; (10) all-cancelled rethrow; (11) signal forwarded.
- [ ] **Steps 2-4: fail -> implement -> green + gates**
- [ ] **Step 5: commit** `feat: search_crm with phrase and filter modes, server-side sort and cursors`

---

### Task 6: `get_records` tool (`src/server/tools/get-records.ts`)

**Files:**
- Create: `src/server/tools/get-records.ts`
- Create: `tests/server/tools/get-records.test.ts`

Contract:

- `inputSchema` (strict): `{ kind: enum person|company|deal|task; ids: array of string min 1 max 25; detail?: enum (default standard); includeWall?: boolean (default false) }`. Runner rule: `includeWall` only when `ids.length <= 5` (load discipline) and kind != task (tasks have no wall) -> else BAD_PARAMS result. Dedup ids preserving order.
- Fan-out per id (own try/catch): `getRecord(kind, id, detail)`; found -> `{ id, status: "ok", record }`; `null` -> `{ id, status: "not_found" }` with a fixed hint ("The id does not exist or the API key's user cannot see it - take ids from search_crm or crm_metadata."); error -> `{ id, status: "error", code, message, hint }`. With `includeWall`, fetch `recordWall` per found record into `record.wall` (WallEntry[]; wall failure degrades to `wallError: {code, hint}` on that item, not item failure).
- `structured`: `{ kind, items: [...], summary: { requested, ok, notFound, failed } }`. Text: counts only. `isError` only when EVERY id failed (not_found counts as a resolved answer, NOT a failure).
- All-cancelled rethrow; parallel fan-out relies on the client throttle for upstream discipline.

- [ ] **Step 1: failing tests**: (1) batch fan-out with mixed ok/not_found/error incl. exact per-item envelopes and summary math; (2) dedup preserving order; (3) includeWall attaches walls, degrades per item on wall failure, rejected for >5 ids and for tasks; (4) isError semantics (all failed vs not_found-only); (5) schema matrix (strict, 26 ids rejected, empty ids rejected); (6) counts-only text with hostile names; (7) all-cancelled rethrow; (8) signal forwarding to both record and wall fetchers.
- [ ] **Steps 2-4: fail -> implement -> green + gates**
- [ ] **Step 5: commit** `feat: get_records batch tool with per-item results and optional walls`

---

### Task 7: `get_activity` tool (`src/server/tools/get-activity.ts`)

**Files:**
- Create: `src/server/tools/get-activity.ts`
- Create: `tests/server/tools/get-activity.test.ts`

Contract:

- `inputSchema` (strict), discriminated by `source`:
  `{ source: enum record|crm|tasks;
     record?: strictObject { kind: enum person|company|deal, id: string } (required when source=record);
     dateFrom?: string; dateTo?: string;   // REQUIRED when source=crm (upstream requires the range); optional for tasks
     typeName?: string;                     // crm only - local narrowing, documented
     completed?: boolean;                   // tasks only
     limit?: int 1-100 default 20; cursor?: string }`
  Runner cross-field validation -> BAD_PARAMS results (record required iff source=record; dates required for crm; completed only for tasks; cursor only for crm/tasks).
- source=record: `recordWall` (no pagination upstream - return up to `limit` entries with `truncated` flag).
- source=crm: `crmFeed` with limit/offset paging + nextCursor (kind "crm"); NOTE in description: feed entries reference records BY NAME ONLY (upstream has no ids there) and `typeName` narrows the fetched page locally.
- source=tasks: `listTasks` (Task 2) - page-based: cursor payload `o` is the PAGE number (kind "tasks", starting at 1); `limit` slices the 50-item page locally; `hasMore` from the fetcher; nextCursor advances the page only when the local slice exhausted the upstream page.
- `structured`: `{ source, entries|tasks: [...], count, hasMore?, nextCursor?, truncated? }`. Text: counts only. Errors/cancellation per M3 pattern.

- [ ] **Step 1: failing tests**: (1) the three sources call the right fetchers with the right params; (2) cross-field validation matrix; (3) crm paging + nextCursor round-trip; (4) tasks page-cursor math (slice within page, advance at boundary); (5) record truncation flag; (6) typeName local filter documented behavior (filter applied post-fetch); (7) schema matrix; (8) counts-only text; (9) cancellation + signal.
- [ ] **Steps 2-4: fail -> implement -> green + gates**
- [ ] **Step 5: commit** `feat: get_activity for record walls, the CRM feed and task lists`

---

### Task 8: Wiring, instructions, HTTP contract

**Files:**
- Modify: `src/server/mcp.ts`, `src/index.ts`, `src/server/instructions.ts`
- Modify: `tests/server/modern-wire.test.ts`, `tests/server/instructions.test.ts`

- `AppDeps` gains `records?: RecordFetchers | undefined` and `activity?: ActivityFetchers | undefined`; `index.ts` builds both over the shared client. Registration (in order, each guarded on its dep): search_crm, get_records, get_activity - after crm_metadata; handlers thread `requestSignal(ctx)` and map results exactly like crm_metadata (content text + structuredContent + isError).
- `instructions.ts`: extend the quick start - after the crm_metadata bullet: `- Find records with "search_crm" (phrase or filters), read them with "get_records" (batch by id), and pull history with "get_activity". Ids come from search results and crm_metadata - never guess them.` Replace the "Search, records, activity..." future-tools bullet with `- Analyze and write tools arrive in later milestones.` Add a CRITICAL bullet: `- Deal values and dates come from a CRM users edit by hand - treat zero/empty values as "not filled in", not as facts.` Keep the M3/M4 data-not-instructions bullet unchanged.
- Modern-wire additions: tools/list order EXACTLY `["health","crm_metadata","search_crm","get_records","get_activity"]` (update the M3 exact-list test); one end-to-end modern call per new tool with fake deps (search_crm phrase, get_records batch, get_activity record) asserting `resultType: "complete"` and structured payload basics; absent-deps case -> tools absent; the generic annotations loop test covers the new tools automatically (no change needed - verify it).
- `tests/server/instructions.test.ts`: contains "search_crm", "get_records", "get_activity", "never guess"; does NOT contain the old future-tools wording.

- [ ] **Step 1: failing wire+instructions tests** -> **Steps 2-4: implement, green, gates** -> **Step 5: commit** `feat: register the read tools behind record and activity fetchers`

---

### Task 9: Docs and final gates

**Files:**
- Modify: `README.md`

- Status blockquote: "`health`, `crm_metadata` (CRM dictionaries), `search_crm`, `get_records` and `get_activity` are live; `analyze` and the write tools are next."
- Full gates: `bun test && bun run typecheck && bun audit`.
- Commit: `docs: read tools in the status note`

---

## Live smoke (orchestrator runs this, not a subagent)

Modern-era calls on the sandbox server: search_crm phrase (a term known to
exist in the demo data) per kind and filter mode with sortBy=value; a
get_records batch (2 deals + 1 bogus id -> ok/ok/not_found) with
includeWall on a company; get_activity for all three sources incl. cursor
continuation on the crm feed. Verify counts against the untracked `../.ai/`
notes and that no CRM string appears in any text channel. Never against a
production CRM.

## Execution notes

(fill in during execution)
