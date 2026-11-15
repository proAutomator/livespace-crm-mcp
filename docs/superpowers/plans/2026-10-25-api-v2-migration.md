# Livespace API v2 Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move livespace-crm-mcp from the signed-session API (v1.13) to the
Livespace public API v2 and make it a full power-user replacement of the
official Livespace MCP: the official MCP's whole scope, built as a few
task-shaped tools with batch operations, compact answers, next-step hints and
controlled writes (preview, human confirmation, verification).

**Architecture:** A new fetch-based v2 client in `src/livespace/v2/` becomes
the main backend: Bearer key, `meta`/`data`/`extra` envelope,
`application/problem+json` errors, burst and daily rate-limit tracking, a
request budget per tool call, response media types and `Idempotency-Key`.
Tools move to v2 one area per PR on an integration branch. The v1 client stays
only as an optional fallback for data v2 does not publish: the record wall and
system feed, deal probability and bulk stage reach. Release 0.2.0 requires a
v2 key.

**Tech Stack:** TypeScript 7 (strict), Bun >=1.3.14, Hono 4.13.11,
`@modelcontextprotocol/server` 2.3.1, Zod 4.6.6 (the 0.1.3 pins). No new
runtime dependency, no OpenAPI code generation.

**Spec:** the Livespace public API v2 OpenAPI 3.1.2 draft (`info.version`
2.0.0, 94 paths, 135 operations). It is a vendor draft kept in the
maintainer's working folder and is not redistributed here. Maintainer notes
outside this repo (`../.ai/`): the spec analysis, the live API test of
2026-10-25, the conclusions note with Kuba's decision of 2026-10-25, and the
official MCP read and write tests of 2026-10-12 and 2026-10-16. Executors
read this plan, `AGENTS.md` and `docs/security.md`; the facts they need from
those notes are copied into the sections below.

## Global Constraints

- Runtime dependencies stay exactly `@modelcontextprotocol/server` 2.3.1,
  `hono` 4.13.11, `zod` 4.6.6 (the 0.1.3 pins). `bun install --frozen-lockfile` and `bun audit`
  pass on every PR.
- English in code, comments, commits and docs. Docs and README use plain
  hyphens, never long dashes; run them through the `no-ai-slop` skill.
- No secrets and no real CRM data anywhere in the repo. Every fake
  credential contains the word `synthetic`. The fake v2 key is
  `ls_synthetic` + `"0".repeat(34)` (matches `^ls_[A-Za-z0-9_-]{43}$`).
  Fixture ids are UUID-shaped synthetic values such as
  `00000000-0000-4000-8000-000000000001`; fixture names start with
  `SYNTHETIC`.
- The v2 key travels only in the `Authorization: Bearer` header. It never
  appears in a URL, a log line, an error, a tool result or a test snapshot.
- Upstream text never reaches the model: problem `title`, `detail` and
  `violations` messages are dropped; only our fixed wording, sanitized JSON
  Pointer paths and a validated `requestId` pass through.
- Load discipline: at most 2 concurrent upstream requests and 150 ms between
  starts (the existing throttle), an explicit `perPage` on every list and
  search, bounded page loops, a request budget per tool call, and a daily
  reserve that refuses work before the shared account budget runs out.
- No delete operations. No `DELETE` request exists anywhere in the code
  (D5-B would add exactly one, budget line removal).
- Writes stay behind `LIVESPACE_MCP_ENABLE_WRITES=true`, `MCP_AUTH_TOKEN`,
  `MCP_REQUEST_STATE_KEY` and the signed elicitation confirmation. Batch caps:
  10 records per record-write call, 15 activities, 1 notification, 25 items
  per `sync_meeting_notes` call.
- Every new security test file joins `MAP_FILES` in
  `tests/security-contract.test.ts`, the `test:security` script in
  `package.json` and the regression map in `docs/security.md`.
- Live checks run only on the Livespace demo or sandbox account, never on a
  production CRM. Live writes touch only records named `SYNTHETIC ...`.
- Every tool keeps exact annotations, pinned in
  `tests/server/modern-wire.test.ts`: `move_deals` and `sync_meeting_notes`
  are `destructiveHint: true` (they change status and existing records),
  every write is `idempotentHint: false`.
- Each PR passes: `bun install --frozen-lockfile`, `bun audit`,
  `bun run typecheck`, `bun test`, `bun run test:security`,
  `git diff --check`, then the live smoke of its stage. Deviations go to
  "Execution notes" at the end of this file.
- Commits, pushes and PRs only when Kuba asks. Merges, releases and npm
  approval are Kuba's steps.

## Review Focus

1. **"Mine" without a human identity.** The v2 key is an integration user, so
   `GET /users/me` is not the person at the keyboard. `mine: true` with no
   resolvable `LIVESPACE_ACTING_USER_EMAIL` must refuse with a hint, never
   fall back to the integration user and return an empty "my deals" list.
   Test: PR3 Task 3 `mine without an acting user is refused, not empty`.
2. **Read-after-write staleness.** A `GET` right after a write can return the
   previous version. Verification compares the sent fields with the write
   response body, never with an immediate re-read. Test: PR6 Task 2
   `a stale re-read cannot mark an applied field as unapplied`.
3. **Tags and groups replace the whole set.** `PATCH` with `tags` drops every
   tag not sent. "Add tag X" must keep the existing tags, and a tag change
   made between preview and execution must surface as `recordsChanged`.
   Test: PR6 Task 3 `adding a tag keeps the tags already on the record`.
4. **The daily budget is shared by the whole account.** A 25-id
   `get_records` with includes or a wide `analyze` must not burn hundreds of
   requests other integrations of the customer depend on. Test: PR1 Task 3
   `a call over its request budget stops before the next request` and PR3
   Task 4 `includes that exceed the call budget are refused up front`.
5. **Retrying a create that has no idempotency.** `POST /people`,
   `/companies`, `/deals` and notes have no `Idempotency-Key`; a timeout after
   dispatch must report an unknown outcome and never resend. Tasks, calls and
   budget lines retry once with the same key. Test: PR1 Task 4
   `a timed-out create without a key is unknown and never resent`.

## How the PRs run

- Nine PRs (D4-A): each from its own branch into `feat/api-v2`, reviewed and
  merged by Kuba, then the next one starts from the updated integration
  branch. Stage 1 (reads) is PR1-PR4, stage 2 (analytics and process audit)
  PR5, stage 3 (writes) PR6-PR7, stage 4 (meeting notes flow) PR8, release
  PR9.
- PR1 is written at step level. PR2-PR9 name their files, interfaces and
  tests; every task in them runs the same five steps as PR1 (write the named
  failing tests, run red, implement, run green, commit). Before a PR starts,
  its executor reads the Execution notes, applies the live-check results it
  depends on, and writes any changed signature back into its section here
  (the milestone workflow in `AGENTS.md`).
- A fresh reviewer checks every PR before Kuba merges it, and the whole
  branch after PR4 and after PR8.

---

## Decisions for Kuba (before PR1)

**Decided 2026-10-25: Kuba accepted option A for D1 to D5.** The rest of
this section keeps the options for reference.

**D1. Access model of the v2 key** (changes `docs/security.md`). The v2 key
belongs to an integration user: it sees every active record, is not bound by
roles, and authors notes, tasks and step completions. In v1 the server ran
with one real user's permissions.

| Option | What it means | Cost |
|---|---|---|
| A (recommended) | Operator key, stated plainly. README and `docs/security.md` say the server sees everything the integration user sees and writes as the integration. Read-only installs use a key with only `read` scopes; write installs add `write` scopes, never `delete` and never `crm:sales-process:write`. A non-loopback bind with a v2 key needs the explicit `LIVESPACE_V2_SHARED_ACCESS=acknowledged`, so one HTTP endpoint cannot quietly hand admin-level visibility to a team. | Docs, one startup check, one test. |
| B | A plus best-effort owner scoping (`LIVESPACE_RECORD_SCOPE=owned`): searches add an owner filter for the acting user, reads by id drop records owned by others. | Not a security boundary (teams, followers and shared visibility are not modeled). Gives a false sense of safety; more code on every read path. |
| C | v2 for reads only until Livespace publishes per-user tokens; writes stay on v1 with real user attribution. | Blocks tags, reasons, linked tasks and step reopening; contradicts stage 3. |

**D2. Users without v2 and the release line.** v2 is a Labs feature enabled
per account, so most installs cannot use it yet.

| Option | What it means |
|---|---|
| A (recommended) | 0.2.0 requires `LIVESPACE_API_V2_KEY`; v1 credentials are an optional fallback. npm `latest` stays on 0.1.x until v2 is available to all accounts; 0.2.0 ships under the `next` dist-tag before that. 0.1.x gets security fixes only, from a `release/0.1` branch. |
| B | One package, two modes: without a v2 key the server runs the frozen 0.1 tool set. Two code paths and two test matrices until v1 is removed. |

**D3. Attribution of integration-authored writes.**

| Option | What it means |
|---|---|
| A (recommended) | Notes get a short footer `Added by livespace-crm-mcp for <acting user name>.` (`LIVESPACE_NOTE_FOOTER=off` disables it). Tasks default `assignee` and calls default `user` to the acting user. |
| B | No footer; attribution only documented. |

**D4. Delivery branch.** A (recommended): integration branch `feat/api-v2`
from `main`; every stage PR targets it; the final PR merges it into `main` as
0.2.0. B: PRs straight to `main`, which then needs dual-mode code during the
transition (D2-B).

**D5. Budget line removal.** A (recommended): keep "no delete" - budget lines
can be added and edited, removal stays in the Livespace UI. B: allow
`DELETE /deals/{id}/products/{lineId}` as an explicit, previewed operation.

---

## Facts from the v2 contract and the live test (2026-10-25)

- Base URL `https://<subdomain>.livespace.io/api/v2`. Header
  `Authorization: Bearer ls_...`. Key shape `^ls_[A-Za-z0-9_-]{43}$`.
- Success envelope `{meta: {version}, data, extra}`; `extra` is always an
  object. Lists carry `extra.page`, `perPage`, `totalCount`; searches add
  `totalCountExact` (exact up to 10 000) and `permissions`.
- Errors are `application/problem+json`: `type`, `title`, `status`, `detail`,
  `requestId`, optional `violations` (JSON Pointer -> message), `conflicts`,
  `supported`. Types: `authentication-required` (401),
  `insufficient-scope` (403, scope in `WWW-Authenticate`), `forbidden` (403),
  `not-found` (404, same body for unknown and inaccessible), `request-validation`
  (400), `domain-validation` (422), `conflict` (409), `idempotency-key-reused`
  (422), `too-many-requests` (429 + `Retry-After`), `service-unavailable`
  (503 + `Retry-After`), `internal-error` (500), plus 405/406/415.
- Closed contracts: an unknown query parameter or body key is 400.
  `perPage` default 100, max 500 (deal search with the extended type: 50;
  `GET /search`: 50, `page` max 200).
- Headers on counted requests: `X-RateLimit-Limit`, `-Remaining`, `-Reset`
  (epoch seconds), `-Daily-Remaining`; `X-Request-Id` (32 hex) on every
  response; `Idempotent-Replayed: true` on a replay. Provisional limits:
  100 requests per 10 s per key, daily 25 000 / 50 000 / 100 000 per
  account by tier, reset 00:00 UTC, shared by every key of the account.
- Media types: `application/vnd.ls-api.minimal.v2+json` (people, companies,
  deals, tasks: get and search), `application/vnd.ls-api.extended.v2+json`
  (deal search only). Actions by request `Content-Type`:
  `application/vnd.ls-api.deal-status.v2+json` (deal status and reasons via
  `PATCH /deals/{id}`), `...task-complete.v2+json`, `...task-reopen.v2+json`.
- `Idempotency-Key` (1-255 printable ASCII, 24 h) only on: calls, deal
  product and cost lines, relations, sales processes, tasks under a record,
  catalog creates. Not on `POST /people`, `/companies`, `/deals`, notes,
  notifications. Live: replay works for tasks and calls; a repeated note
  create made a duplicate.
- Writes answer the record as written; a `GET` right after can be stale.
  `PATCH /deals/{id}/process` and call creates read from the primary.
- Live (demo, 2026-10-25): 303 deals in one `perPage: 500` search, 0.95 s,
  about 1.6 KB per deal (v1: about 13 KB). Status works only through the
  deal-status content type; a `won` without required steps is 422 naming the
  step. Step reopening works (`completed: false`); closed deals refuse step
  changes with 422. Tags and note visibility write correctly. A task under a
  deal is linked to it; `assignee` is required on that tenant. Calls need
  `number` and `direction`. `GET /search` is still word-prefix only;
  `contains` in `*/searches` matches inside words. `/sales-processes` is 404
  on the demo; `/dictionaries/processes` (deprecated) answers with the full
  process config. `GET /users/me` uses snake_case (`first_name`,
  `time_zone`).
- Still missing in v2: wall/feed and system entries, stage history (only
  `stageChangedAt`, `statusChangedAt`, per-stage `completedAt`), probability,
  aggregations, attachments, notification read-back, filters on e-mail,
  phone, deal value, `stageChangedAt`, `lastActivity`, `id in`.

## Target architecture

### Config matrix (D2-A)

| `LIVESPACE_API_V2_KEY` | v1 key + secret | Result |
|---|---|---|
| set | absent | v2 mode. Wall/system feed and probability report `unavailable` with a hint. |
| set | set | v2 mode with fallback: system feed entries, probability and bulk stage reach come from v1. |
| absent | any | Startup refuses: "LIVESPACE_API_V2_KEY is required from 0.2.0; for the v1 API use livespace-crm-mcp@0.1". |

New variables: `LIVESPACE_API_V2_KEY` (required),
`LIVESPACE_ACTING_USER_EMAIL` (optional; required for `mine`, and for writes
when D3-A is chosen), `LIVESPACE_V2_DAILY_RESERVE` (integer 0-1 000 000,
default 5000; 0 disables the guard), `LIVESPACE_V2_SHARED_ACCESS` (D1-A, the
only accepted value is `acknowledged`), `LIVESPACE_NOTE_FOOTER` (D3-A,
`on`/`off`, default `on`, added in PR6). `LIVESPACE_API_KEY` and
`LIVESPACE_API_SECRET` become an optional pair (both or neither).

### File map

| Path | Responsibility | PR |
|---|---|---|
| `src/config/env.ts` | Parse and validate Livespace config (v2 key, optional v1 pair, acting user, reserve) | 1 |
| `src/config/server-env.ts` | D1-A non-loopback acknowledgement check | 1 |
| `src/livespace/errors.ts` | New codes and error details (`fields`, `requestId`) | 1 |
| `src/livespace/v2/media-types.ts` | Media and action content type constants | 1 |
| `src/livespace/v2/problems.ts` | `problem+json` -> `LivespaceError`, pointer sanitizing | 1 |
| `src/livespace/v2/budget.ts` | Rate-limit header tracking, daily reserve, per-call request budget | 1 |
| `src/livespace/v2/client.ts` | HTTP client: auth, envelope, retries, write semantics, idempotency | 1 |
| `src/livespace/v2/metadata.ts` | Dictionary fetchers (processes, users, reasons, tags, custom fields...) | 2 |
| `src/livespace/v2/filters.ts` | Filter tree builder, contract limits, day ranges in a time zone | 3 |
| `src/livespace/v2/records.ts` | v2 record shapes, mappers, search and get | 3 |
| `src/livespace/v2/timeline.ts` | Notes, calls, e-mails and tasks of a record; CRM-wide notes | 4 |
| `src/livespace/fallback.ts` | Optional v1 fallback: wall, feed, probability, stage reach | 4 |
| `src/livespace/v2/deal-sweep.ts` | Counting by `totalCount` and bounded deal sweeps for analyses | 5 |
| `src/livespace/process-audit.ts` | Pure process-audit and stalled-deal rules | 5 |
| `src/livespace/v2/writes.ts` | Creates and updates, tags read-modify-write, notes, calls, notifications | 6 |
| `src/livespace/v2/deal-moves.ts` | Step completion and reopening, status with reasons, win-gate preview | 7 |
| `src/livespace/v2/matching.ts` | Deterministic record matching for meeting notes | 8 |
| `src/server/tools/*.ts` | Existing tools switched to v2 deps, schemas extended | 2-6 |
| `src/server/tools/next-steps.ts` | Fixed next-step hints for read tools | 3 |
| `src/server/tools/move-deals.ts` | Replaces `move-deals-to-stage.ts` | 7 |
| `src/server/tools/sync-meeting-notes.ts` | Meeting notes to CRM in one previewed batch | 8 |
| `src/server/prompts/meeting-notes.ts` | MCP prompt that drives the flow | 8 |
| `tests/support/v2.ts` | Synthetic envelopes, problems, routed fetch, record builders | 1 |

v1 modules (`client.ts`, `crypto.ts`, `activity.ts`, the probability part of
`records.ts`, the stage-reach part of `stage-moves.ts`) survive only behind
`src/livespace/fallback.ts`. Everything else of v1 is deleted in the PR that
replaces it, and PR9 removes what is left unused.

### Tool surface 0.2.0

| Tool | Change |
|---|---|
| `health` | `/users/me`, daily budget left, backend mode, acting user |
| `crm_metadata` | 15 sections: full process config, reasons, tags, currencies, teams, positions, custom fields with options |
| `search_crm` | Server-side filters and sort, `totalCount`, `page`, `countOnly`, `mine`, owners, tags, groups, sources, custom-field filters, date ranges; new kind `tasks`; phrase search also over notes |
| `get_records` | `include`: process, products, budget, notes, calls, emails, tasks, wall (fallback); one call instead of a chain |
| `get_activity` | `record`: merged timeline (notes, calls, e-mails, tasks, optional system entries); `crm`: notes and tasks in a date range. Task lists move to `search_crm` |
| `analyze` | Same four analyses on v2 plus `process_audit` and `stalled_deals` |
| `create_records` | Tags, groups, owner, source, custom fields, budget lines, tasks under a record |
| `update_records` | Tag add/remove/set, owner, close date, custom fields, task complete/reopen |
| `move_deals` (renamed) | Stage by steps, step reopening, status with reasons, win-gate preview |
| `log_activities` | Note visibility, tags and date; calls on persons, companies and deals with idempotency |
| `notify_user` | `POST /notifications` |
| `sync_meeting_notes` (new) | Match or create companies, persons, deals; notes, tasks, moves; asks on ambiguity |

Official MCP benchmark coverage (version 0.3.0 as tested on 2026-10-12 and
2026-10-16; newer official tools join this table once verified):

| Official tool | Covered by |
|---|---|
| `get_person`, `get_company`, `get_deal` | `get_records` |
| `list_people`, `list_companies`, `list_deals`, tasks lists, "mine", custom-field filters | `search_crm` |
| `search_records` | `search_crm` phrase |
| `get_products_for_deal`, `get_process_for_deal` | `get_records` include |
| `get_notes`, `get_calls`, `get_emails` | `get_activity` record, `get_records` include |
| `get_dictionary`, `who_am_i` | `crm_metadata`, `health` |
| `create_*`, `update_*`, tasks writes | `create_records`, `update_records` |
| `complete_deal_steps`, deal status and reasons | `move_deals` |
| `add_note` | `log_activities` |
| `send_feedback` | not applicable |

### v2 client contract (PR1)

- Every request: `Authorization: Bearer <key>`, `Accept` (default
  `application/json`), `Content-Type` on bodies (default `application/json`),
  `Idempotency-Key` when given. Query arrays are comma-joined
  (`style: form, explode: false`). Path ids go only through `v2Path`, which
  percent-encodes each id.
- Envelope: a 2xx body must be an object with `data`; `extra` defaults to
  `{}`. A 204 has no body. Anything else is `UPSTREAM_ERROR` with fixed
  wording.
- Reads retry on 429, 503, 500, timeout and network errors, at most 3
  attempts, honoring `Retry-After` up to 10 s, else full jitter (200 ms base,
  2 s cap). Business errors (400, 401, 403, 404, 409 except idempotency, 422)
  never retry.
- Writes: a 429 is a known outcome and retries. Without an `Idempotency-Key`,
  any failure after dispatch (5xx, timeout, network, abort) is
  `WRITE_OUTCOME_UNKNOWN`. With a key, the client retries once with the same
  key; a 409 `conflict` with `Retry-After` (first request still running) waits
  and retries once; `Idempotent-Replayed: true` sets `replayed: true`.
- Every response feeds `RateLimitTracker`. Before a request: if the last
  burst `remaining` is 0 and `reset` is in the future, wait until reset (max
  10 s, else `RATE_LIMITED`); if `dailyRemaining <= dailyReserve`, throw
  `DAILY_BUDGET_LOW` (except `essential: true`, used only by `health`).
- Each HTTP attempt spends one unit of the call's `CallBudget`; exceeding it
  throws `CALL_BUDGET_EXCEEDED` before the request goes out. Default budgets:
  read tools 60, `analyze` 150, write tools 80, `sync_meeting_notes` 120.
- Staleness: write tools verify from the write response. A follow-up `GET` is
  allowed only for data the response does not carry, and its mismatch is
  reported as `verification: unavailable`, never as `unapplied`.

### `docs/security.md` changes

| Section | Change | PR |
|---|---|---|
| Principles 2 | Rewritten for the integration-user key (D1 outcome); minimal scope table per tool; never `delete` scopes | 1 |
| 1 Credential handling | Static Bearer key in a header only; shape validated at startup without echo; v1 pair optional | 1 |
| 2 Network exposure | D1-A: non-loopback bind with a v2 key needs `LIVESPACE_V2_SHARED_ACCESS=acknowledged` | 1 |
| 3 Load discipline | v2 limits, explicit `perPage`, page caps, per-call request budget, daily reserve protecting the shared account budget | 1 |
| 5 Write safety | Verification from write responses; idempotency keys; dedupe before non-idempotent creates; tags read-modify-write; attribution (D3); no delete stays (D5) | 6 |
| 6 Error hygiene | Problem bodies never forwarded; only fixed text, sanitized pointers, validated request id | 1 |
| 8 Data handling | Outbound traffic still only to `https://<subdomain>.livespace.io` (both APIs) | 1 |
| 10 Regression tests | New 18-22 below, plus requirement 6 and 8 reworded for `v2Path` and `perPage` | 1, 6 |

New required regression tests (numbered 18-22 because 0.1.3 added
requirement 17, the tool input element cap):

18. The v2 key appears only in the `Authorization` header: never in a URL,
    error, tool result or log line.
19. Problem bodies never reach the model: only fixed wording, sanitized
    pointers and a validated request id.
20. v2 load discipline: explicit `perPage`, bounded pages, per-call request
    budget and daily reserve refusal.
21. Non-idempotent writes never retry after dispatch; keyed writes retry
    only with the same key.
22. A non-loopback bind refuses to start without the shared access
    acknowledgement (D1-A only).

## Stage 0: live verification (before PR1)

Results go to the maintainer notes (Polish) and a data-free summary to
"Execution notes" here. The agent runs Q3-Q7, Q9, Q11 and Q12 with the demo
v2 key already in the local `.env` (read only, plus writes on `SYNTHETIC`
records). Q1, Q2, Q8 and Q10 need Kuba.

| # | Question | Probe | Decides |
|---|---|---|---|
| Q1 | Are v1 and v2 record ids equal? | Same deal by name via v1 `Deal/getAll` and v2 `POST /deals/searches`; needs v1 credentials for the demo account (Kuba: is the Keychain `livespace-api` sandbox the demo account?) | Whether the v1 fallback can be keyed by v2 ids at all |
| Q2 | Is the daily budget shared with the official MCP? | Read `X-RateLimit-Daily-Remaining`, Kuba runs 10 official MCP calls, read again | Default reserve and README warning |
| Q3 | Time zone and date bounds | `/users/me` `time_zone`; `between` with `from = to`; `createdAt` with a bare `YYYY-MM-DD` | `dayRange` implementation |
| Q4 | Does `GET /search` match e-mail or phone? | Search a SYNTHETIC person's e-mail | Person dedupe without v1 |
| Q5 | `owners anyOf [user]` and task `assignees` semantics | Compare with UI counts for one user | `mine` mapping |
| Q6 | Extended vs full deal rows | Same page with both types | When to request extended |
| Q7 | Rate-limit headers on every counted request | Log headers on 20 mixed calls | Tracker assumptions |
| Q8 | Who sees a `forMe` note written by the integration | Kuba checks in the UI | Default note visibility |
| Q9 | Task `assignee` = acting user | Create a task on the SYNTHETIC deal | Task defaults |
| Q10 | Official MCP tools of 2026-10-23 | Kuba runs the local proxy client | Benchmark table |
| Q11 | `/sales-processes` vs `/dictionaries/processes` | Both on the demo | Process source fallback |
| Q12 | Win-gate 422 pointers | `won` on the SYNTHETIC deal with open required steps | Mapping refusals to step ids in the preview |

---

## PR1: v2 foundation (stage 1, branch `feat/api-v2-client` -> `feat/api-v2`)

No tool changes. Delivers config, errors, budgets, the client, the security
contract for reads and a read-only live smoke.

### Task 1: Config for the v2 key, optional v1 pair, acting user and reserve

**Files:**
- Modify: `src/config/env.ts`, `src/config/server-env.ts`, `src/index.ts`, `scripts/smoke.ts`, `.env.example`
- Test: `tests/config/env.test.ts`, `tests/config/server-env.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface LivespaceV1Config { subdomain: string; apiKey: string; apiSecret: string }
  export interface LivespaceConfig {
    subdomain: string;
    v2ApiKey: string;
    v1: LivespaceV1Config | null;
    actingUserEmail: string | null;
    dailyReserve: number;
  }
  export const V2_KEY_SHAPE: RegExp; // /^ls_[A-Za-z0-9_-]{43}$/
  export const DAILY_RESERVE_DEFAULT = 5000;
  export function loadLivespaceConfig(env: Record<string, string | undefined>): LivespaceConfig;
  ```
  `LivespaceClient` (v1) now takes `LivespaceV1Config`.
  `ServerConfig` gains `v2SharedAccessAcknowledged: boolean`.
  Added in PR1: `export function loadLivespaceV1Config(env): LivespaceV1Config`
  (subdomain plus the full v1 pair, no v2 key) for `scripts/smoke.ts`.

- [x] **Step 1: Write the failing tests** in `tests/config/env.test.ts`:
  - `requires LIVESPACE_API_V2_KEY` - message names the variable and points
    to `livespace-crm-mcp@0.1` for v1-only use.
  - `rejects a malformed v2 key without echoing it` - with
    `"synthetic-not-a-v2-key"`, the message does not contain the value.
  - `accepts the synthetic v2 key` - `v2ApiKey` equals
    `"ls_synthetic" + "0".repeat(34)`.
  - `v1 credentials are optional but come as a pair` - neither: `v1: null`;
    only one of the two: throws naming the missing one.
  - `acting user email is optional, trimmed and shape-checked` - `" a@b.pl "`
    -> `"a@b.pl"`; `"not-an-email"` throws without echo.
  - `daily reserve defaults to 5000, accepts 0, rejects -1, 1.5 and 1000001`.
  In `tests/config/server-env.test.ts`:
  - `non-loopback bind with a v2 key needs the shared access acknowledgement`
    (D1-A) - `MCP_BIND_HOST=0.0.0.0` plus auth token and no
    `LIVESPACE_V2_SHARED_ACCESS` throws; `acknowledged` passes; any other
    value throws.

- [x] **Step 2: Run them, expect FAIL**
  Run: `bun test tests/config`
  Expected: the new cases fail on the missing fields and checks.

- [x] **Step 3: Implement** in `src/config/env.ts` and
  `src/config/server-env.ts`. Error messages name variables, never values.
  `src/index.ts` builds the v1 `LivespaceClient` only when `config.v1` is not
  null; every tool that still needs v1 is registered only when that client
  exists (the existing "deps present" pattern in `createServerFactory`).
  `scripts/smoke.ts` passes the v1 pair as before. `.env.example` documents
  the new variables, names only, with D1/D2 wording.

- [x] **Step 4: Run the tests, expect PASS**
  Run: `bun test tests/config && bun run typecheck`

- [x] **Step 5: Commit** (when Kuba asks)
  `git commit -m "feat(config): add the v2 key, optional v1 pair and daily reserve"`

### Task 2: Problem mapping and error details

**Files:**
- Create: `src/livespace/v2/media-types.ts`, `src/livespace/v2/problems.ts`
- Modify: `src/livespace/errors.ts`, `src/server/tools/tool-error.ts`
- Test: `tests/livespace/v2/problems.test.ts`, `tests/server/tools/tool-error.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // errors.ts
  export type LivespaceErrorCode = /* existing */ | "NOT_FOUND" | "CONFLICT"
    | "INSUFFICIENT_SCOPE" | "DAILY_BUDGET_LOW" | "CALL_BUDGET_EXCEEDED";
  export interface LivespaceErrorDetails { fields?: readonly string[]; requestId?: string }
  // LivespaceError constructor gains a 7th parameter: details: LivespaceErrorDetails = {}

  // media-types.ts
  export const MEDIA_JSON = "application/json";
  export const MEDIA_MINIMAL = "application/vnd.ls-api.minimal.v2+json";
  export const MEDIA_EXTENDED = "application/vnd.ls-api.extended.v2+json";
  export const CONTENT_DEAL_STATUS = "application/vnd.ls-api.deal-status.v2+json";
  export const CONTENT_TASK_COMPLETE = "application/vnd.ls-api.task-complete.v2+json";
  export const CONTENT_TASK_REOPEN = "application/vnd.ls-api.task-reopen.v2+json";
  export type V2MediaType = typeof MEDIA_JSON | typeof MEDIA_MINIMAL | typeof MEDIA_EXTENDED;
  export type V2ContentType = typeof MEDIA_JSON | typeof CONTENT_DEAL_STATUS
    | typeof CONTENT_TASK_COMPLETE | typeof CONTENT_TASK_REOPEN;

  // problems.ts
  export function errorFromProblem(status: number, body: unknown, headers: Headers): LivespaceError;
  export function sanitizePointers(violations: unknown): string[];
  export function readRequestId(value: unknown): string | undefined;

  // tool-error.ts
  export interface ToolError { code: string; message: string; hint: string; fields?: string[]; requestId?: string }
  ```
  As built: `LivespaceError` exposes `readonly details: LivespaceErrorDetails`.
  `parseRetryAfterMs` moved to `src/livespace/http-shared.ts` in this task,
  because `errorFromProblem` sets `retryAfterMs` on 409, 429 and 503.

Mapping (fixed wording; `transport` true only where marked):

| Status / type | Code | Hint names |
|---|---|---|
| 400 `request-validation` | `VALIDATION_ERROR` | "fix the listed fields; if they are not tool arguments, report it" |
| 401 | `AUTH_FAILED` | `LIVESPACE_API_V2_KEY` |
| 403 `insufficient-scope` | `INSUFFICIENT_SCOPE` | the missing scope from `WWW-Authenticate`, only when its shape is valid (below) |
| 403 `forbidden` | `PERMISSION_DENIED` | record visible only at BASIC level |
| 404 | `NOT_FOUND` | "unknown or not visible to the integration user" |
| 405, 406, 415, 422 `idempotency-key-reused` | `UPSTREAM_ERROR` | "server bug, report it" |
| 409 `conflict` | `CONFLICT` | retry after `Retry-After` when present |
| 422 `domain-validation` | `VALIDATION_ERROR` | the fields |
| 429 | `RATE_LIMITED`, transport | wait |
| 500, 503 | `UPSTREAM_ERROR`, transport | retry later |

A scope from `WWW-Authenticate` is surfaced only when it matches
`^crm:[a-z-]+:(read|write|delete)$`.
`sanitizePointers` keeps at most 20 keys, adds a leading `/` when missing
(the draft mixes both), and keeps only keys matching
`^/[A-Za-z0-9_.\-/]{0,200}$`. Messages are dropped. `readRequestId` accepts
only `^[0-9a-f]{32}$`.

- [x] **Step 1: Write the failing tests** in
  `tests/livespace/v2/problems.test.ts`:
  - one test per mapping row (status, type -> code, transport flag).
  - `violation messages and detail never reach the error` - body with
    `detail: "SYNTHETIC upstream secret"` and
    `violations: {"/name": "SYNTHETIC injected text"}`: neither string appears
    in `message` or `hint`; `details.fields` is `["/name"]`.
  - `pointers without a leading slash are normalized` (`perPage` ->
    `/perPage`).
  - `pointers with unexpected characters are dropped` (`"/a b"`,
    `"/<script>"`).
  - `request id is kept only when it is 32 hex`.
  - `a non-problem body maps by status alone`.
  In `tests/server/tools/tool-error.test.ts`:
  `toToolError copies fields and requestId from LivespaceError details`.

- [x] **Step 2: Run, expect FAIL** - `bun test tests/livespace/v2/problems.test.ts tests/server/tools/tool-error.test.ts`
- [x] **Step 3: Implement** the three files and the `ToolError` extension
  (`toolErrorSchema` gains optional `fields: z.array(z.string()).max(20)` and
  `requestId: z.string().regex(/^[0-9a-f]{32}$/)`).
- [x] **Step 4: Run, expect PASS**, plus `bun run typecheck`.
- [x] **Step 5: Commit** - `feat(v2): map problem responses to sanitized errors`

### Task 3: Rate-limit tracking, daily reserve and call budget

**Files:**
- Create: `src/livespace/v2/budget.ts`
- Test: `tests/livespace/v2/budget.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface RateLimitSnapshot {
    burstLimit: number | null; burstRemaining: number | null;
    burstResetAt: number | null; // epoch ms
    dailyRemaining: number | null; observedAt: number | null; // epoch ms
  }
  export class RateLimitTracker {
    constructor(now?: () => number);
    observe(headers: Headers): void;   // ignores absent or non-integer headers
    snapshot(): RateLimitSnapshot;
    /** ms to wait before the next request, 0 when none */
    burstWaitMs(): number;
    isDailyBudgetLow(reserve: number): boolean; // false while unknown
  }
  export const CALL_BUDGETS: { read: 60; analyze: 150; write: 80; sync: 120 };
  export class CallBudget {
    constructor(max: number);
    spend(): void; // throws LivespaceError CALL_BUDGET_EXCEEDED when used === max
    readonly used: number; readonly max: number;
  }
  ```
  As built: `new CallBudget(max)` throws `RangeError` unless `max` is a
  positive integer; `isDailyBudgetLow(0)` is always false (0 turns the guard
  off).

- [x] **Step 1: Write the failing tests:**
  - `observes burst and daily headers`.
  - `ignores missing or malformed headers and keeps the last good values`.
  - `waits until reset when the burst is spent` - remaining 0, reset in 3 s
    -> `burstWaitMs()` 3000; reset in the past -> 0.
  - `daily budget is low at or below the reserve, never while unknown`.
  - `a call over its request budget stops before the next request`
    (Review Focus 4) - `new CallBudget(2)`: two `spend()` pass, the third
    throws `CALL_BUDGET_EXCEEDED` whose hint says to narrow the request.
- [x] **Step 2: Run, expect FAIL** - `bun test tests/livespace/v2/budget.test.ts`
- [x] **Step 3: Implement** `budget.ts`.
- [x] **Step 4: Run, expect PASS**
- [x] **Step 5: Commit** - `feat(v2): track rate limits and budget each call`

### Task 4: The v2 HTTP client

**Files:**
- Create: `src/livespace/v2/client.ts`, `tests/support/v2.ts`
- Test: `tests/livespace/v2/client.test.ts`

**Interfaces:**
- Consumes: Task 2 (`errorFromProblem`, media types), Task 3 (tracker,
  `CallBudget`), `createThrottle` from `src/livespace/throttle.ts`,
  `cancelledError` from `src/livespace/errors.ts`.
- Produces:
  ```ts
  export interface V2Request {
    method: "GET" | "POST" | "PATCH";
    path: string; // from v2Path only
    query?: Record<string, string | number | boolean | readonly string[] | undefined>;
    body?: unknown;
    accept?: V2MediaType;
    contentType?: V2ContentType;
    idempotencyKey?: string;
  }
  export interface V2CallOptions {
    signal?: AbortSignal; write?: boolean; timeoutMs?: number;
    budget?: CallBudget; essential?: boolean;
  }
  export interface V2Response<T> {
    data: T; extra: Record<string, unknown>;
    requestId: string | null; replayed: boolean;
  }
  export interface LivespaceV2ClientConfig { subdomain: string; apiKey: string; dailyReserve: number }
  export class LivespaceV2Client {
    constructor(config: LivespaceV2ClientConfig, options?: LivespaceClientOptions);
    request<T>(req: V2Request, opts?: V2CallOptions): Promise<V2Response<T>>;
    rateLimit(): RateLimitSnapshot;
  }
  export function v2Path(template: string, ...ids: string[]): string; // "/deals/{}/process"
  export function newIdempotencyKey(): string; // "lcm-" + crypto.randomUUID()
  ```
  `tests/support/v2.ts` exports `SYNTHETIC_V2_KEY`, `v2Envelope(data, extra?)`,
  `v2Problem(status, type, extras?)`, `routedV2Fetch(routes, calls)` and
  `syntheticId(n: number)`.
  As built: the constructor takes `LivespaceV2ClientOptions`
  (`LivespaceClientOptions` plus `now?: () => number`, the clock for the burst
  window and the throttle); `LivespaceClientOptions` lives in
  `src/livespace/http-shared.ts` and the v1 client re-exports it.
  `tests/support/v2.ts` also exports `SYNTHETIC_REQUEST_ID`, `timeoutError()`
  and the `V2Call` and `V2Handler` types; an unrouted call answers 418.

The method union has no `DELETE` on purpose (Global Constraints).

- [x] **Step 1: Write the failing tests** in
  `tests/livespace/v2/client.test.ts`:
  - `sends the key only as a Bearer header` - URL is
    `https://synthetic.livespace.io/api/v2/users/me`, the key appears in no
    URL, and `Authorization` equals `Bearer ${SYNTHETIC_V2_KEY}`.
  - `encodes path ids` - `v2Path("/deals/{}", "../x")` is `/deals/..%2Fx`;
    a template with more or fewer `{}` than ids throws.
  - `joins query arrays with commas` - `types: ["person", "deal"]` ->
    `types=person,deal` (each element percent-encoded, the separator
    literal); `undefined` keys are omitted.
  - `sends the action content type` - `CONTENT_DEAL_STATUS` reaches the
    `Content-Type` header; `MEDIA_MINIMAL` reaches `Accept`.
  - `parses the envelope and defaults extra` and
    `rejects a 2xx body without data with fixed wording`.
  - `retries a read on 429 honoring Retry-After` (sleep spy gets 2000) and
    `on 503 and timeout up to three attempts`.
  - `does not retry 400, 404 or 422`.
  - `a timed-out create without a key is unknown and never resent`
    (Review Focus 5) - one fetch call, `WRITE_OUTCOME_UNKNOWN`.
  - `a keyed write retries once with the same key` - first attempt times out,
    second gets 201 with `Idempotent-Replayed: true`: two calls, same
    `Idempotency-Key`, `replayed: true`.
  - `a keyed write waits on 409 in progress, then retries once`.
  - `a write retries on 429, the outcome is known`.
  - `refuses when the daily budget is at the reserve` - after a response with
    `X-RateLimit-Daily-Remaining: 10` and reserve 100, the next request throws
    `DAILY_BUDGET_LOW` without calling fetch; `essential: true` still goes.
  - `spends the call budget per attempt, retries included`.
  - `the key never appears in errors or stderr` - force 401, 500, network
    error and timeout; scan `message`, `hint`, `JSON.stringify(error)` and
    captured `console.error` output for the key.
  - `cancellation before dispatch is CANCELLED, after dispatch of a write is
    unknown`.
- [x] **Step 2: Run, expect FAIL** - `bun test tests/livespace/v2/client.test.ts`
- [x] **Step 3: Implement** `client.ts`. Reuse the v1 client's
  `combineSignals`, `parseRetryAfterMs` and retry-delay logic by moving them
  to `src/livespace/http-shared.ts` (both clients import it; v1 tests stay
  green). Throttle: `createThrottle({maxConcurrent: 2, minIntervalMs: 150})`.
  Default timeout 30 s; large pages pass `timeoutMs`.
- [x] **Step 4: Run, expect PASS** - `bun test tests/livespace && bun run typecheck`
- [x] **Step 5: Commit** - `feat(v2): add the v2 HTTP client`

### Task 5: Security contract and read-only live smoke

**Files:**
- Modify: `docs/security.md` (rows marked PR1 above), `tests/security-contract.test.ts`, `package.json` (`test:security`), `README.md` (configuration section, D1/D2 wording), `.env.example`
- Create: `scripts/smoke-v2.ts`

- [x] **Step 1: Update `tests/security-contract.test.ts` first** - requirement
  count 22 (0.1.3 added requirement 17, so the new ones are 18-22), the new files
  `tests/livespace/v2/client.test.ts`, `tests/livespace/v2/problems.test.ts`,
  `tests/livespace/v2/budget.test.ts` in `MAP_FILES`.
- [x] **Step 2: Run, expect FAIL** - `bun test tests/security-contract.test.ts`
- [x] **Step 3: Edit `docs/security.md`, `package.json`, README and
  `.env.example`.** Requirement 6 names `v2Path`; requirement 8 names
  `perPage` and page caps.
- [x] **Step 4: Run the full gate** - `bun run test:security && bun test && bun run typecheck && git diff --check`
- [ ] **Step 5: Live smoke.** `scripts/smoke-v2.ts` reads
  `LIVESPACE_SUBDOMAIN` and `LIVESPACE_API_V2_KEY` from the environment (Bun
  loads the local `.env`; do not edit it) or from Keychain service
  `livespace-api`, account `api-v2-key`. It calls `GET /users/me` and one
  `POST /deals/searches` with `perPage: 1` and `MEDIA_MINIMAL`, prints only
  status, `totalCount`, `dailyRemaining` and `requestId` presence, never
  record content. Expected: two 200s.
  As built: environment only, no Keychain lookup (the maintainer's keys now
  reach processes through a secret manager that injects variables);
  `bun run smoke:v2` runs it.
- [x] **Step 6: Commit** - `docs(security): v2 key model, load discipline and error hygiene`

---

## PR2: health and crm_metadata on v2 (stage 1)

### Task 1: health

**Files:** modify `src/server/tools/health.ts`, `src/server/mcp.ts`,
`src/index.ts`; test `tests/server/tools/health.test.ts`,
`tests/server/modern-wire.test.ts`.

`HealthDeps.livespacePing` is replaced by
`v2Ping(opts) => Promise<{login: string; timeZone: string}>`
(`GET /users/me` with `essential: true`) and `rateLimit() =>
RateLimitSnapshot`. Output schema:

```ts
{ ok, version, protocol, readOnly,
  backend: { api: "v2", v1Fallback: boolean },
  livespace?: { reachable: boolean; integrationUser?: string; timeZone?: string;
                actingUser?: string | null; dailyRemaining?: number | null;
                dailyReserve: number } }
```

Tests: `checkLivespace reads users/me and reports the daily budget`,
`snake_case users/me fields map to camelCase output`,
`an unresolved acting user is reported as null with a hint`,
`health still answers when the daily budget is low`. Annotations unchanged.

### Task 2: v2 dictionary fetchers

**Files:** create `src/livespace/v2/metadata.ts`; test
`tests/livespace/v2/metadata.test.ts`.

```ts
export const V2_METADATA_SECTIONS = ["processes", "users", "teams", "contactGroups",
  "dealGroups", "sources", "positions", "dealReasons", "tags", "currencies",
  "taskTypes", "taskStatuses", "customFields", "products", "currentUser"] as const;
export interface StepConfig { id: string; name: string; description: string | null;
  weight: number; required: boolean; requiredItem: "none" | "note" | "file"; boundFields: number }
export interface StageConfig { id: string; name: string; description: string | null;
  durationDays: number | null; steps: StepConfig[] }
export interface ProcessConfig { id: string; name: string; selectable: boolean; isDefault: boolean;
  defaultLengthDays: number | null; productRequired: boolean; autoclose: boolean; stages: StageConfig[] }
export interface CustomFieldInfo { id: string; name: string; type: string; group: string;
  filterable: boolean; options: IdName[] }
export interface ReasonInfo { id: string; name: string; kind: "won" | "lost" | "outdated" }
export interface ActingUser { id: string; name: string; email: string }
export interface CurrentUserV2 { integrationLogin: string; timeZone: string; actingUser: ActingUser | null }
export type V2MetadataSection = (typeof V2_METADATA_SECTIONS)[number];
export interface V2SectionDataMap { processes: ProcessConfig[]; users: (IdName & { email: string; team: IdName | null })[];
  teams: IdName[]; contactGroups: IdName[]; dealGroups: IdName[]; sources: IdName[]; positions: IdName[];
  dealReasons: ReasonInfo[]; tags: string[]; currencies: IdName[]; taskTypes: IdName[]; taskStatuses: IdName[];
  customFields: Record<"person" | "company" | "deal" | "task", CustomFieldInfo[]>;
  products: (IdName & { sku: string | null })[]; currentUser: CurrentUserV2 }
export type V2MetadataFetchers = { [S in V2MetadataSection]:
  (opts?: { signal?: AbortSignal; budget?: CallBudget }) => Promise<V2SectionDataMap[S]> };
export function createV2MetadataFetchers(client: Pick<LivespaceV2Client, "request">,
  opts: { actingUserEmail: string | null }): V2MetadataFetchers;
```

Rules: stages and steps sorted by `sort`; `weight` = `scales`; `required` =
`mandatory.required`; `requiredItem` = `mandatory.item`; `durationDays` =
`duration.days` when `duration.enabled`, else null. `filterable` is true for
`text`, `textarea`, `checkbox`, `select`, `radio`, `multiselect`,
`multicheckbox`. Every dictionary request sends `perPage: 500`; loops stop
at 4 pages (2000 rows) and report `truncated`; tags take one page. Processes:
`GET /sales-processes`, and on `NOT_FOUND` `GET /dictionaries/processes`,
remembered for the process lifetime (Q11). `IdName` moves into this file
from the v1 `metadata.ts`. Products: `POST /products/searches`
`perPage: 500`, 2 pages max. Acting user: exact, case-insensitive e-mail match
in the users section.

Tests: one mapping test per section from synthetic payloads,
`every dictionary request carries perPage 500`, `page loops stop at four
pages and say truncated`, `processes fall back to the deprecated path on
404 once`, `custom fields of numeric and date type are not filterable`,
`the acting user resolves by case-insensitive e-mail`.

### Task 3: crm_metadata tool on v2

**Files:** modify `src/server/tools/crm-metadata.ts` (sections enum, output
schema, `MetadataService` over the v2 fetchers, `userQuery` unchanged),
`src/server/instructions.ts`, README tool section; delete
`src/livespace/metadata.ts` and its test once nothing imports them. Tests in
`tests/server/tools/crm-metadata.test.ts`: section selection, cache TTL
unchanged, `userQuery` over the new users shape, each section's output
validates against the schema.

### Task 4: live smoke and commit

`scripts/smoke-v2.ts` gains `health` and `crm_metadata` (all sections) through
the HTTP server with `LIVESPACE_MCP_READ_ONLY=true`. Record request counts per
section in Execution notes.

---

## PR3: search_crm and get_records on v2 (stage 1)

### Task 1: filter builder

**Files:** create `src/livespace/v2/filters.ts`; test
`tests/livespace/v2/filters.test.ts`.

```ts
export type FilterOperator = "eq" | "neq" | "contains" | "notContains" | "startsWith"
  | "gt" | "gte" | "lt" | "lte" | "between" | "in" | "nin" | "anyOf" | "allOf"
  | "noneOf" | "isEmpty" | "isNotEmpty";
export type FilterNode = { field: string; operator: FilterOperator; value?: unknown }
  | { and: FilterNode[] } | { or: FilterNode[] };
export function where(field: string, operator: FilterOperator, value?: unknown): FilterNode;
export function and(...nodes: FilterNode[]): FilterNode | undefined; // drops undefined, unwraps one
export function or(...nodes: FilterNode[]): FilterNode | undefined;
export function assertFilterLimits(node: FilterNode): void; // 5 levels, 50 conditions, 10 additionalFields.*, 200 values, 255 chars
export function dayRange(fromDay: string | undefined, toDay: string | undefined,
  timeZone: string): { from?: string; to?: string }; // inclusive days -> RFC 3339 with the zone's offset
```

Tests: limits (each one at the edge and one over), `dayRange` around a DST
change in `Europe/Warsaw` (2026-03-29 and 2026-10-25) and at a month end,
`and`/`or` unwrap and drop rules. Q3 (Execution notes): datetime fields
refuse a bare `YYYY-MM-DD`, so `dayRange` always sends RFC 3339 bounds
`<day>T00:00:00<offset>` and `<day>T23:59:59<offset>` in the integration
user's zone, with `between` for two bounds and `gte`/`lte` for one. Date
fields (`expectedCloseDate`) take bare days and skip `dayRange`.

### Task 2: v2 record shapes and mappers

**Files:** create `src/livespace/v2/records.ts`; modify
`src/server/tools/record-schemas.ts`; test `tests/livespace/v2/records.test.ts`.

```ts
export interface Ref { id: string; name: string }
export interface CustomFieldValue { id: string; name: string; type: string;
  value: string | number | boolean | string[] | null }
export interface PersonV2 { id: string; name: string; firstName: string; lastName: string;
  company: Ref | null; position: Ref | null; owner: Ref | null; emails: string[]; phones: string[];
  tags: string[]; groups: Ref[]; source: Ref | null; description: string | null;
  visibility: string; lastActivity: string | null; createdAt: string | null;
  updatedAt: string | null; customFields: CustomFieldValue[]; url: string }
export interface CompanyV2 { id: string; name: string; taxId: string | null; regon: string | null;
  owner: Ref | null; emails: string[]; phones: string[]; websites: string[]; tags: string[];
  groups: Ref[]; source: Ref | null; description: string | null; visibility: string;
  lastActivity: string | null; createdAt: string | null; updatedAt: string | null;
  customFields: CustomFieldValue[]; url: string }
export interface DealReasonV2 { kind: "won" | "lost" | "outdated"; name: string; note: string | null }
export interface DealV2 { id: string; name: string; number: string | null; status: string | null;
  value: number | null; currency: string | null; process: Ref | null; stage: Ref | null;
  owner: Ref | null; company: Ref | null; person: Ref | null; expectedCloseDate: string | null;
  statusChangedAt: string | null; stageChangedAt: string | null; lastActivity: string | null;
  createdAt: string | null; updatedAt: string | null; tags: string[]; groups: Ref[];
  source: Ref | null; description: string | null; visibility: string;
  reason: DealReasonV2 | null; probability: number | null; customFields: CustomFieldValue[]; url: string }
export interface TaskV2 { id: string; title: string; description: string | null; completed: boolean;
  completedAt: string | null; priority: "normal" | "high"; dueType: string; startsAt: string | null;
  endsAt: string | null; allDay: boolean | null; type: Ref | null; status: Ref | null;
  private: boolean; recurring: boolean; assignees: Ref[];
  links: { kind: "person" | "company" | "deal"; id: string; name: string }[];
  createdAt: string | null; updatedAt: string | null; url: string }
export type RecordV2 = PersonV2 | CompanyV2 | DealV2 | TaskV2;
export interface RecordV2Map { person: PersonV2; company: CompanyV2; deal: DealV2; task: TaskV2 }
export type V2Kind = keyof RecordV2Map;
export interface DealProcessV2 { process: Ref | null; currentStage: Ref | null;
  stages: { id: string; name: string; position: number; state: "completed" | "current" | "pending";
    completedAt: string | null; steps: { id: string; name: string; required: boolean; completed: boolean }[] }[] }
export interface BudgetLineV2 { id: string; product: Ref | null; quantity: number | null;
  unitPrice: number | null; value: number; currency: string; description: string | null }
export interface PhraseHit { kind: "person" | "company" | "deal" | "note"; id: string; name: string; url: string | null }
export interface RecordReader {
  search<K extends V2Kind>(kind: K, query: { filter?: FilterNode; sort?: { field: string; direction: "asc" | "desc" };
    page: number; perPage: number; media: V2MediaType }, opts: { signal?: AbortSignal; budget: CallBudget }):
    Promise<{ items: RecordV2Map[K][]; totalCount: number; totalCountExact: boolean }>;
  phrase(q: string, kinds: PhraseHit["kind"][], page: number, opts: { signal?: AbortSignal; budget: CallBudget }):
    Promise<{ hits: PhraseHit[]; totalCount: number }>;
  get<K extends V2Kind>(kind: K, id: string, opts: { signal?: AbortSignal; budget: CallBudget }):
    Promise<RecordV2Map[K] | null>; // NOT_FOUND -> null
  dealProcess(id: string, opts: { signal?: AbortSignal; budget: CallBudget }): Promise<DealProcessV2 | null>;
  dealLines(id: string, opts: { signal?: AbortSignal; budget: CallBudget }): Promise<BudgetLineV2[]>;
}
export function createV2RecordReader(client: Pick<LivespaceV2Client, "request">): RecordReader;
```

Mapping rules: `phones` = `phoneMobile` then `phoneLandline`; `emails` =
`communication.email`; `value` = `budget.value`; `reason` is the reason of the
current status only (a reopened deal reports none); `probability` is null
unless the fallback filled it; minimal media type rows map to the same
interfaces with absent fields omitted by `projectRecord`, which moves here
from the v1 `records.ts` with v2 field lists per detail level. Custom-field values
keep option names, not ids, for select types. The breaking output change is
listed for the 0.2.0 release notes.

Tests: one fixture per kind at full and minimal type, `a reopened deal
carries no stale reason` (the v1 caveat disappears), `a select custom field
maps to option names`, `missing nested refs map to null, not empty strings`.

### Task 3: search_crm on v2

**Files:** modify `src/server/tools/search-crm.ts`,
`src/livespace/v2/records.ts` (`searchRecords`, `searchPhrase`); delete the
v1 list paths and `src/server/cursor.ts` use in this tool; tests
`tests/server/tools/search-crm.test.ts`, `tests/livespace/v2/records.test.ts`.

Input (strict):
```ts
{ kinds?: ("persons"|"companies"|"deals"|"tasks"|"notes")[]; // notes only with phrase
  phrase?: string;            // 2-100, GET /search
  filters?: {
    mine?: boolean; ownerIds?: string[]; status?: "open"|"won"|"lost"|"outdated"|"all";
    processId?: string; stageIds?: string[]; companyId?: string; personId?: string;
    nameContains?: string; taxId?: string; tags?: string[]; groupIds?: string[];
    sourceIds?: string[]; createdFrom?: string; createdTo?: string;
    updatedFrom?: string; updatedTo?: string; statusChangedFrom?: string;
    statusChangedTo?: string; expectedCloseFrom?: string; expectedCloseTo?: string;
    customFields?: { fieldId: string; operator: "eq"|"contains"|"anyOf"|"allOf"|"noneOf"|"isEmpty"|"isNotEmpty"; value?: string | boolean | string[] }[]; // max 10
    completed?: boolean; overdue?: boolean; dueFrom?: string; dueTo?: string;
    taskTypeIds?: string[]; linkedTo?: { kind: "person"|"company"|"deal"; id: string } };
  sort?: { field: string; direction: "asc"|"desc" }; // validated per kind against the x-filter-fields sortable list
  detail?: "minimal"|"standard"|"full"; page?: number; perPage?: number; // 1-100, default 20
  countOnly?: boolean }
```
Output per kind: `{ items, totalCount, totalCountExact, page, perPage,
hasMore, hint?, nextSteps? }`. `countOnly` sends `perPage: 1` and returns no
items. `minimal` detail uses `MEDIA_MINIMAL`; `standard` and `full` use
`MEDIA_JSON` (Q6 could not show a difference for `MEDIA_EXTENDED`; revisit on
an account with deal custom fields). `mine` maps to `owners anyOf
[actingUser.id]` (tasks: `assignees anyOf`), per Q5. Filters that do not
apply to a kind are `BAD_PARAMS` naming the kind. `page > 1` needs exactly one
kind. Dates use `dayRange` with the integration user's time zone (Q3).

Tests: `mine without an acting user is refused, not empty` (Review Focus 1),
`mine maps to owners anyOf the acting user`, `each filter maps to its v2
field and operator` (table test), `custom field filters reject a
non-filterable field from metadata`, `sort outside the kind's sortable list is
refused`, `countOnly sends perPage 1 and returns totalCount`, `phrase search
joins types with commas and caps perPage at 50`, `every search sends an
explicit perPage` (security requirement 19), `status defaults to open for
deals and all includes outdated`.

### Task 4: get_records on v2 with includes

**Files:** modify `src/server/tools/get-records.ts`; create
`src/server/tools/next-steps.ts`; tests `tests/server/tools/get-records.test.ts`.

Input: `{ kind, ids (1-25), detail?, include?: ("process"|"products"|"budget"|"notes"|"calls"|"emails"|"tasks"|"wall")[] }`.
Includes are per record and capped: activity includes return the latest 5
entries each. `wall` needs the v1 fallback (PR4) and otherwise reports
`unavailable`. Request plan = `ids.length * (1 + includes.length)`; above
`CALL_BUDGETS.read` (60) the call is refused before any request with a hint to
split it. Per-id status stays `ok | not_found | error`; `not_found` says
"unknown or not visible to the integration user".

`next-steps.ts`: `export function nextSteps(tool: string, context: NextStepContext): string[]`
with `interface NextStepContext { kind?: V2Kind; empty: boolean; writesEnabled: boolean; hasMore: boolean }`
returns at most 3 fixed, server-authored strings (no CRM text), for example
after a deal read: "move_deals to change stage or status" (only when writes
are on).

Tests: `includes that exceed the call budget are refused up front` (Review
Focus 4), `process include maps stages, state and required steps`,
`products and budget includes map lines and totals`, `emails include needs
the e-mail scope and reports INSUFFICIENT_SCOPE per record`, `next steps never
contain record text`.

### Task 5: live smoke

`search_crm` (deals with `mine`, a tag, `countOnly` per stage), `get_records`
with all includes on the SYNTHETIC deal. Compare counts with the UI for one
stage. Record request counts.

---

## PR4: get_activity on v2 and the v1 fallback (stage 1)

### Task 1: timeline fetchers

**Files:** create `src/livespace/v2/timeline.ts`; test
`tests/livespace/v2/timeline.test.ts`.

```ts
export type TimelineEntryType = "note" | "call" | "email" | "task" | "system";
export interface TimelineEntry { type: TimelineEntryType; id: string | null; date: string | null;
  author: Ref | null; text: string; textTruncated: boolean; direction?: "incoming" | "outgoing";
  visibility?: string; tags?: string[]; completed?: boolean; url: string | null }
export interface TimelineReader {
  recordTimeline(kind: "person" | "company" | "deal", id: string,
    opts: { types: TimelineEntryType[]; perType: number; signal?: AbortSignal; budget?: CallBudget }):
    Promise<{ entries: TimelineEntry[]; truncated: boolean; unavailable: TimelineEntryType[] }>;
  crmNotes(opts: { dateFrom: string; dateTo: string; createdBy?: string; page: number; perPage: number;
    signal?: AbortSignal; budget?: CallBudget }): Promise<{ entries: TimelineEntry[]; totalCount: number }>;
}
```
Notes `/{kind}/{id}/notes`, calls `/{kind}/{id}/calls`, e-mails
`/{kind}/{id}/emails`, tasks `POST /tasks/searches` with `deals.id`,
`people.id` or `companies.id`. Merged and sorted by `date` desc, ties by
type then id. Text goes through the existing `stripHtml` and length cap.

### Task 2: v1 fallback module

**Files:** create `src/livespace/fallback.ts`; move the wall and feed code
from `src/livespace/activity.ts` behind it; test
`tests/livespace/fallback.test.ts`.

```ts
export interface LegacyFallback {
  systemEntries(kind: "person" | "company" | "deal", id: string,
    opts: { signal?: AbortSignal }): Promise<TimelineEntry[]>; // wall entries that are not notes
  dealProbabilities(dealIds: string[], opts: { signal?: AbortSignal }): Promise<Map<string, number>>;
  stageReach(processId: string, opts: { signal?: AbortSignal }): Promise<StageReach>;
}
/** How many deals of a process have reached each stage (furthest checked step), from one bounded v1 list. */
export interface StageReach { processId: string; reachedByStageId: Record<string, number>;
  dealsCounted: number; truncated: boolean }
export function createLegacyFallback(client: Pick<LivespaceClient, "call">): LegacyFallback;
```
Built only when `config.v1` is set and Q1 confirmed equal ids. If Q1 says the
ids differ, this task shrinks to `stageReach` (process-level, no ids) and the
other two report `unavailable`; record that in Execution notes.

### Task 3: get_activity on v2

Sources become `record` (merged timeline, `types` filter, `includeSystem`
needing the fallback) and `crm` (`GET /notes` with `dateFrom`/`dateTo` and
optional `mine` -> `createdBy` acting user, plus tasks updated in the range).
The `tasks` source is removed (task lists live in `search_crm`); its call
answers `BAD_PARAMS` with a hint to `search_crm` kind `tasks`. Tests:
`record timeline merges four sources newest first`, `a missing e-mail scope
leaves the other types and lists email as unavailable`, `crm notes send
inclusive datetime bounds in the account zone`, `includeSystem without the
fallback reports unavailable, not empty`.

### Task 4: live smoke and stage 1 review

Smoke all read tools through the server, read-only. Then a whole-branch
review of PR1-PR4 by a fresh reviewer before analytics start.

---

## PR5: analyze on v2, process audit, stalled deals (stage 2)

### Task 1: deal sweep and counts

**Files:** create `src/livespace/v2/deal-sweep.ts`; test
`tests/livespace/v2/deal-sweep.test.ts`.

```ts
export function countDeals(client, filter: FilterNode | undefined,
  opts: { budget: CallBudget; signal?: AbortSignal }): Promise<{ count: number; exact: boolean }>; // perPage 1
export function sweepDeals(client, filter: FilterNode | undefined,
  opts: { maxRows: number; budget: CallBudget; signal?: AbortSignal }):
  Promise<{ rows: DealV2[]; truncated: boolean; totalCount: number }>; // perPage 500, maxRows <= 2000
```

### Task 2: analyses on v2

**Files:** modify `src/server/tools/analyze.ts`, `src/livespace/aggregate.ts`;
tests `tests/server/analyze.test.ts`, `tests/livespace/aggregate-*.test.ts`.

- `pipeline_summary`: counts per stage by `countDeals` (one request per
  stage), sums from one bounded sweep; `basedOn` reports `exact`,
  `truncated` and requests spent.
- `stage_conversion`: `method: "reach"` from `LegacyFallback.stageReach` when
  available, else `method: "current_position"` (today's estimate). The output
  names the method.
- `activity_summary`: notes from `GET /notes` in the range, tasks from
  `POST /tasks/searches` by `updatedAt`; calls are absent (no CRM-wide call
  list) and listed in `unavailable`.
- `forecast_vs_realization`: won and lost by `statusChangedAt` and `status`;
  open by `expectedCloseDate`; weighted sum only with fallback probabilities,
  else `weighted: null` with the reason.

### Task 3: process_audit and stalled_deals

**Files:** create `src/livespace/process-audit.ts` (pure); test
`tests/livespace/process-audit.test.ts`.

```ts
export type AuditFinding = { rule: AuditRule; stageId?: string; stepId?: string; count?: number };
export type AuditRule = "stage_without_steps" | "no_required_step_before_won"
  | "stage_without_duration" | "open_deals_over_duration" | "deals_without_close_date"
  | "stage_holds_most_open_deals" | "required_step_needs_file";
export function auditProcess(config: ProcessConfig, openDeals: DealV2[], now: Date): {
  stages: { stageId: string; name: string; openDeals: number; medianDaysInStage: number | null;
    overDuration: number }[];
  findings: AuditFinding[] };
export function stalledDeals(deals: DealV2[], now: Date,
  opts: { idleDays: number; config: ProcessConfig[] }): { dealId: string; name: string;
  daysIdle: number | null; daysInStage: number | null; overStageDuration: boolean }[]; // top 50
```
Days in stage come from `stageChangedAt`; idle days from `lastActivity`.
`stage_holds_most_open_deals` fires above 50% of a process's open deals.
Findings carry ids and counts only, never names, so the text channel stays
free of CRM text.

Tests: one per rule (fires and does not fire), `a deal without
stageChangedAt counts as unknown, not zero days`, `stalled list is capped at
50 and sorted by idle days`.

### Task 4: tool wiring and live smoke

`analyze` enum gains `process_audit` (requires `processId`) and
`stalled_deals` (`idleDays` 1-365, default 14). Budget `CALL_BUDGETS.analyze`.
Smoke every analysis on the demo; record request counts against the 150 cap.

---

## PR6: record and activity writes on v2 (stage 3)

Before this PR: D3 and D5 decided, Q8 and Q9 answered, `docs/security.md`
section 5 rewritten (test-first in `tests/security-contract.test.ts`).

### Task 1: write fetchers

**Files:** create `src/livespace/v2/writes.ts`; delete `src/livespace/writes.ts`
when no tool imports it; test `tests/livespace/v2/writes.test.ts`.

```ts
export interface V2WriteFetchers {
  createPerson(input: PersonCreate, opts: WriteOpts): Promise<PersonV2>;
  createCompany(input: CompanyCreate, opts: WriteOpts): Promise<CompanyV2>;
  createDeal(input: DealCreate, opts: WriteOpts): Promise<DealV2>; // then budget lines, each keyed
  createTask(parent: { kind: "person" | "company" | "deal"; id: string }, input: TaskCreate,
    opts: WriteOpts): Promise<TaskV2>; // keyed
  updatePerson(id: string, patch: PersonPatch, opts: WriteOpts): Promise<PersonV2>;
  updateCompany(id: string, patch: CompanyPatch, opts: WriteOpts): Promise<CompanyV2>;
  updateDeal(id: string, patch: DealPatch, opts: WriteOpts): Promise<DealV2>;
  updateTask(id: string, patch: TaskPatch, opts: WriteOpts): Promise<TaskV2>; // resolves the parent via GET /tasks/{id}
  setTaskCompleted(id: string, completed: boolean, opts: WriteOpts): Promise<TaskV2>;
  addNote(target: NoteTarget, input: NoteCreate, opts: WriteOpts): Promise<NoteV2>;
  addCall(target: NoteTarget, input: CallCreate, opts: WriteOpts): Promise<CallV2>; // keyed + externalId
  addBudgetLine(dealId: string, line: BudgetLineCreate, opts: WriteOpts): Promise<BudgetLineV2>; // keyed
  updateBudgetLine(dealId: string, lineId: string, patch: BudgetLinePatch, opts: WriteOpts): Promise<BudgetLineV2>;
  sendNotification(input: NotificationCreate, opts: WriteOpts): Promise<{ id: string }>;
}
export interface WriteOpts { signal?: AbortSignal; budget: CallBudget; idempotencyKey?: string }
export interface NoteTarget { kind: "person" | "company" | "deal"; id: string }
```
Input types (`PersonCreate`, `DealPatch`, `TaskCreate`, `NoteCreate`,
`CallCreate`, `BudgetLineCreate`, `NotificationCreate`...) are the closed v2
request bodies with the v2 field names, with two changes: references are
plain ids (`companyId`, `ownerId`, `processId`...) that the fetcher wraps as
`{id}`, and `communication` is replaced by `emails` and `phones` arrays
(phones go to `phoneMobile`). `NoteV2`, `CallV2` map the v2 `Note` and `Call`
like the PR3 mappers (refs as `Ref`, dates as strings, `url`).
Tests: one request-shape test per method (method, path, content type, body
keys, `Idempotency-Key` present exactly on keyed methods), `no method issues
DELETE`, `task updates go through the parent path`.

### Task 2: verification from write responses

**Files:** modify `src/server/tools/write-support.ts`; tests
`tests/server/write-support.test.ts`.

`export function verifyFromResponse(sent: Record<string, unknown>, written: Record<string, unknown>): { applied: string[]; unapplied: string[] }`
compares normalized values (tags case-insensitive for persons and companies,
which Livespace stores lowercased; dates by day; numbers by value). A
re-read only covers fields absent from the response, and a mismatch there is
`verification: unavailable`.

Tests: `a stale re-read cannot mark an applied field as unapplied` (Review
Focus 2), `person tags compare case-insensitively`, `unknown outcome items are
never retried and say so`.

### Task 3: create_records and update_records on v2

New input fields: tags, groups, owner, source, description, visibility,
custom fields (`{fieldId, value}` checked against `customFields` metadata),
deal `expectedCloseDate` and budget lines, tasks with a required
`parent`, `assigneeId` (default acting user), `dueType`, `startsAt`,
`endsAt`, `priority`, `typeId`. Updates take `tags: {add?, remove?, set?}`
(exactly one form), and the plan reads the record, computes the full set and
sends it; the signed preview hashes the read state so a change in between
yields `recordsChanged`. Dedupe: company by `taxId eq`, then exact name;
person by e-mail through `GET /search` (Q4: it matches e-mail and phone),
then an exact, case-insensitive e-mail check on each person hit (at most 5
`GET /people/{id}` reads); with no e-mail, by exact first and last name
within the company. A name-only match is reported as `possibleDuplicate` and
needs `allowDuplicate: true`.

Tests: `adding a tag keeps the tags already on the record` (Review Focus 3),
`a tag changed between preview and execute returns recordsChanged`,
`a task without parent is refused with a hint`, `a custom field id unknown
to metadata is refused before any request`, `person dedupe confirms the
exact e-mail on search hits`, `a search hit with a different e-mail is not a
duplicate`.

### Task 4: log_activities and notify_user on v2

Notes: `visibility` (default from Q8, `all` if unanswered), `tags`, `date`,
footer per D3. Calls on all three kinds, `user` = acting user, keyed, with
`externalId` = the idempotency key's suffix (max 40 chars). Notifications:
`POST /notifications`, unknown recipient is `NOT_FOUND` (the local recipient
pre-check stays for a fast refusal), still reported as dispatched, never
delivered. Tests: `note footer names the acting user and can be turned off`,
`a call replay reports replayed, not a second call`, `notes have no
idempotency key and are not retried`.

### Task 5: live smoke on SYNTHETIC records, then commit

Every write kind once on the SYNTHETIC deal, person and company, with
preview, confirmation and verification. List created records in the
maintainer notes for cleanup.

---

## PR7: move_deals (stage 3)

**Files:** create `src/livespace/v2/deal-moves.ts`,
`src/server/tools/move-deals.ts`; delete `src/server/tools/move-deals-to-stage.ts`
and the v1 parts of `src/livespace/stage-moves.ts` (keep `computeStepDiff`
if it still fits the v2 process shape); tests
`tests/livespace/v2/deal-moves.test.ts`, `tests/server/move-deals.test.ts`.

Input item: `{ dealId, toStageId?, steps?: {stepId, completed}[], status?: { to: "open"|"won"|"lost"|"outdated", reasonId?, reasonNote? } }`,
at most 10 items. `toStageId` plans step flips from `GET /deals/{id}/process`
(forward completes the steps up to the target; backward needs
`allowBackwardDealIds` and reopens). Status uses `CONTENT_DEAL_STATUS`;
`reasonId` must be a reason of the target kind from `dealReasons`.

```ts
export interface WinGatePreview { blocked: boolean; openRequiredSteps: string[];
  productRequiredMissing: boolean; unknown: boolean }
export function previewWinGate(process: ProcessConfig, dealProcess: DealProcessV2,
  dealHasProducts: boolean): WinGatePreview; // requiredForWin fields unknown -> unknown: true
```
Order per item: steps first (one atomic `PATCH /deals/{id}/process`), then
status. A closed deal refuses step changes; the plan reopens it only when the
item also asks for `status.to: "open"` first. Verification from the PATCH
responses (the process response reads from the primary).

Tests: `won with open required steps is blocked in the preview`, `a 422 on
/status for won is reported as win gate refused with the open required steps
from a fresh process read` (Q12: the 422 names no step in its pointers),
`lost needs a lost reason id`,
`reopen clears the reason`, `backward move without allowBackward is blocked`,
`steps on a closed deal are blocked unless the item reopens it first`, `step
flips are sent in one request`. Instructions and README describe the rename;
`move_deals_to_stage` is gone in 0.2.0.

---

## PR8: meeting notes to CRM (stage 4)

### Task 1: matching

**Files:** create `src/livespace/v2/matching.ts`; test
`tests/livespace/v2/matching.test.ts`.

```ts
export type MatchOutcome = { status: "matched"; id: string }
  | { status: "ambiguous"; candidates: { id: string; name: string; url: string; reason: string }[] } // max 5
  | { status: "new" };
export function matchCompany(input: { id?: string; taxId?: string; name?: string }, deps): Promise<MatchOutcome>;
export function matchPerson(input: { id?: string; email?: string; firstName?: string; lastName?: string;
  companyId?: string }, deps): Promise<MatchOutcome>;
export function matchDeal(input: { id?: string; name?: string; companyId?: string; personId?: string }, deps): Promise<MatchOutcome>;
```
Rules, in order: explicit id (must exist) -> company `taxId eq` -> exact
name (case-insensitive) -> `contains` hits become `ambiguous`; person e-mail
per Q4 -> exact name within the company; deal: exact name among the
company's or person's open deals, more than one is `ambiguous`. `reason` is
fixed text ("same tax id", "same name"), never CRM text.

### Task 2: sync_meeting_notes tool

**Files:** create `src/server/tools/sync-meeting-notes.ts`; register in
`src/server/mcp.ts` (writes on); test `tests/server/sync-meeting-notes.test.ts`.

Input: `{ meeting: { title, date }, companies?, persons?, deals?, notes?, tasks?, dealMoves?, resolutions?, dryRun?, confirm? }`.
Each item has a local `ref` (`^[a-z][a-z0-9_-]{0,31}$`); persons, deals,
notes, tasks and moves point to others by `companyRef`, `personRef`,
`dealRef`, `targetRef` or by ids. At most 25 items. The preview lists per
ref `match | create | update | skip | ask` with candidates; any `ask`
without a matching `resolutions` entry (`{ref, choose: id | "create" | "skip"}`)
blocks execution and returns the questions. Execution runs in dependency
order (companies, persons, deals, budget lines, notes, tasks, moves), resolves
refs to created ids, reuses the PR6 and PR7 fetchers, and stops dependents of a
failed item as `not_attempted`. Budget `CALL_BUDGETS.sync`. The server never
reads the meeting text itself; the model extracts the items.

Tests: `an ambiguous company blocks execution and lists candidates`,
`resolutions turn asks into matches`, `refs resolve to ids created earlier in
the same run`, `a failed company skips its person and deal`, `a ref cycle or
unknown ref is refused`, `the same item twice is refused`.

### Task 3: prompt

**Files:** create `src/server/prompts/meeting-notes.ts`; register with the
SDK's prompt API (verify the exact `registerPrompt` signature in
`@modelcontextprotocol/server` 2.0.0 before writing the test; update
`conformance-baseline.yml` if the prompts capability changes the run). The
prompt `meeting_notes_to_crm(notes)` tells the model to call `crm_metadata`,
extract companies, persons, deals, notes and tasks, run
`sync_meeting_notes` as a preview, ask the user every question it returns,
then confirm. Tests: listed in `prompts/list` only when writes are on; the
argument is required.

### Task 4: live smoke

One synthetic meeting text with a known company, a new person and an
ambiguous deal name, end to end on the demo.

---

## PR9: cleanup, docs and release 0.2.0

- Delete v1 modules no longer imported (check with `bun run typecheck` and a
  search for each export); keep `fallback.ts` and what it needs.
- README: positioning as a power-user replacement of the official MCP
  (neutral wording), D1 access model, scope table, config matrix, migration
  notes from 0.1.x (renamed tool, removed `get_activity` tasks source,
  breaking output shapes, new required variable).
- `server.json`, `package.json` 0.2.0; `tests/release-metadata.test.ts` and
  `tests/package-contract.test.ts` pins; release notes.
- D2-A: `publish.yml` support for the `next` dist-tag (its own reviewed
  change; npm approval stays Kuba's).
- Full gate plus a final live smoke of all tools; then the `feat/api-v2` ->
  `main` PR for Kuba.

## Open questions

Q1-Q12 above, plus:

- Does Livespace plan per-user tokens for v2 (the spec mentions "user token"
  in 15 operation descriptions)? With them, D1 changes and `mine` needs no
  configured e-mail.
- The draft already deprecates `/dictionaries/processes`; when
  `/sales-processes` works on the demo, drop the fallback path.
- Final rate-limit numbers arrive "in the release note"; revisit
  `DAILY_RESERVE_DEFAULT` and `CALL_BUDGETS` then.

## Execution notes

Record deviations, live-check results without CRM data, and request counts
here as each PR runs.

### Stage 0, 2026-10-25 (demo account; reads plus writes on SYNTHETIC records)

59 requests (46 in the read run, 13 in the write run), slowest 0.6 s, no
`DELETE`. One new task on the SYNTHETIC deal, titled `SYNTHETIC ...`, listed
in the maintainer notes for cleanup. Q1, Q2, Q8 and Q10 wait for Kuba.

- **Q3 time zone and date bounds.** `GET /users/me` reports `time_zone`
  `Europe/Warsaw`. Datetime filter fields refuse a bare `YYYY-MM-DD` with 400
  (`eq`, `gte` and `between` alike). `between` is inclusive at both ends
  (from = to = a record's own instant matches it), `lte` is inclusive, `lt`
  exclusive, and a `+02:00` value is honored as the same instant. A Warsaw
  day as `T00:00:00+02:00` to `T23:59:59+02:00` matched. Relative tokens
  work only with `eq` (`eq thisMonth` and `eq last30days` match);
  `gte thisMonth` and tokens inside `between` are 400. `expectedCloseDate`
  takes a bare day with `eq` and `between`. PR3 Task 1 updated.
- **Q4 search by e-mail and phone.** `GET /search` with `types=person` found
  the SYNTHETIC person by the full e-mail, its local part, its domain, the
  phone as stored, the phone digits only and the last 9 digits. Hits carry
  no e-mail, so dedupe still confirms the exact address by reading the hit.
  PR6 Task 3 updated.
- **Q5 `mine`.** For the three users owning the most deals,
  `owners anyOf [user]` returned exactly the local count of `owners.users`
  from a full sweep (all 303 deals in one 480 KB request). Every demo deal
  has exactly one owner user and no owner team, so multi-owner behavior is
  still untested. Tasks: `assignees anyOf [user]` matched the local count for
  the two busiest assignees; `members anyOf` returned 0 for both. The PR3
  mapping holds for deals and tasks; persons and companies were not checked.
- **Q6 extended vs full.** The demo has no deal custom fields
  (`/dictionaries/deals/fields` is empty; people have two, numeric and
  text). Full and extended pages of 50 deals were byte-identical. Extended
  with `perPage: 51` is 400 on `/perPage`. PR3 Task 3 now uses `MEDIA_JSON`
  for full detail.
- **Q7 rate-limit headers.** Every counted response carried all four
  `X-RateLimit-*` headers and `X-Request-Id`, including 400, 404 and 406.
  `X-RateLimit-Limit` is 100. `X-RateLimit-Daily-Remaining` dropped by
  exactly one per counted request, refused ones included (49 956 -> 49 900),
  so the demo is on the 50 000 tier and a 4xx still costs budget. The absent
  route `/sales-processes` answered 404 without rate-limit headers and was not
  counted. Before this run the account had spent 43 requests that UTC day,
  consistent with the earlier v2 tests alone (baseline for Q2).
- **Q9 task assignee.** `POST /deals/{id}/tasks` with `assignee` set to the
  demo human user: 201, assignee set, linked to the deal, `createdBy` is the
  integration user. A `+01:00` start came back as the same instant in UTC.
  A replay with the same `Idempotency-Key`: 201, `Idempotent-Replayed: true`,
  same id. `GET /tasks/{id}` right after the create already showed the task
  with its assignee (one sample, no staleness seen).
- **Q11 process source.** `/sales-processes` and `/sales-processes/{id}` are
  404 (route absent); `/dictionaries/processes` and its `/{id}` are 200. Four
  processes: two `selectable: false`, one `isDefault`, each with exactly one
  required step, stage duration enabled on one stage of one process,
  `productRequired` false everywhere. PR2 keeps the fallback order; the
  first 404 costs no budget.
- **Q12 win gate.** `won` through the deal-status content type with one open
  required step: 422 `domain-validation` with a single violation on
  `/status`; the step is named only in the message text, which we drop, so
  the pointer cannot identify it. The same body as plain JSON is 400 on
  `/status`. The deal stayed `open`. PR7 updated: the preview computes open
  required steps from the process, and a 422 on `/status` is reported as a
  refused win gate with a fresh process read.

### PR1, 2026-11-08 (branch `feat/api-v2-client` into `feat/api-v2`)

`feat/api-v2` starts at `main` 2117ce5 (0.1.3 plus the Registry job) with
this plan as its first commit. Dependency pins are the 0.1.3 ones (SDK
2.3.1, hono 4.13.11, zod 4.6.6); Tech Stack and Global Constraints now say so.
Q1, Q2, Q8 and Q10 are still open; PR1 does not depend on them and keeps the
plan's defaults (reserve 5000, v1 fallback keyed by v2 ids still unverified).
The new security requirements are 18-22, not 17-21: 0.1.3 added
requirement 17 (tool input element cap).

Deviations and decisions:

- D1-A: `LIVESPACE_V2_SHARED_ACCESS` is required on every non-loopback bind
  (0.2.0 always has a v2 key) and strict everywhere: any value but
  `acknowledged` refuses to start, on loopback too.
- Without the v1 pair, `src/index.ts` registers only `health`, without its
  Livespace ping, until PR2 moves `health` to v2. `loadLivespaceV1Config` was
  added so `scripts/smoke.ts` needs no v2 key.
- The v2 client throttles each HTTP attempt (2 in flight, 150 ms between
  starts), not the whole retry loop as v1 does.
- `write` defaults to true for `POST` and `PATCH`. Every `POST .../searches`
  call site in PR2-PR8 must pass `write: false`, or a timed-out search reports
  `WRITE_OUTCOME_UNKNOWN` instead of retrying.
- Every 5xx counts as a transport failure. A `Retry-After` above 10 s is not
  retried, and a burst window above 10 s refuses with `RATE_LIMITED` before
  any request.
- A write answered 2xx with an unreadable body is `WRITE_OUTCOME_UNKNOWN`,
  not `UPSTREAM_ERROR`.
- Keyed writes: one resend after an unknown outcome, one more after a 409
  naming `Retry-After`, plus 429 retries, at most three attempts, always the
  same key. After an unknown attempt, any later failure or refusal (business
  error, budget, cancel) reports `WRITE_OUTCOME_UNKNOWN`.
- Redirects are not followed; a 3xx is `UPSTREAM_ERROR`.
- `v2Path` also encodes `!'()*` and refuses empty, `.` and `..` ids and text
  that cannot be encoded. `request()` refuses dot segments (`%2e` spellings
  included), empty segments and any method but `GET`, `POST` and `PATCH`.
- A problem `type` counts only under `https://api.livespace.io/problems/`.
  A missing scope is echoed only for an area the contract defines; the scope
  names are singular (`crm:deal:read`). `crm:deal:read` already covers the
  process dictionaries, so the scope table has no `crm:sales-process:read`.
- A daily count seen before 00:00 UTC counts as unknown after it, so the
  reserve clears at the reset instead of refusing until a restart.
- `scripts/smoke-v2.ts` reads the environment only (no Keychain lookup);
  `bun run smoke:v2` runs it.
- The CI conformance job starts the server with a synthetic v2 key; the run
  matches `conformance-baseline.yml`.

For later PRs:

- PR2: `health` calls with `essential: true`; `rateLimit().dailyRemaining`
  is null after the UTC reset until a counted response arrives.
- PR3: `get_records` `itemSchema` is strict and does not allow the `fields`
  and `requestId` keys `toToolError` now adds; extend it before v2 errors
  reach it. Consider making `budget` required for non-essential calls.
- PR4: the v1 and v2 clients each own a throttle; share one before the
  fallback runs both, or up to 4 requests are in flight.
- Deferred review minors: two requests released by one burst reset can
  start together (the burst sleep runs inside the throttle slot); a local
  clock more than 10 s behind the server turns a 429 into local refusals for
  the skew; `parseRetryAfterMs` accepts `""`, `1e3` and `0x10`;
  `maxAttempts` is not validated; a body is serialized after the budget unit
  is spent; no test boots `src/index.ts` with only the v2 key.

Gate: `bun install --frozen-lockfile`, `bun audit` (no vulnerabilities),
`bun run typecheck`, `bun test` (1332 pass), `bun run test:security` (1098
pass), `git diff --check`, MCP conformance against the baseline. A fresh
reviewer checked the branch; its Important findings are fixed with tests.

Live smoke (Task 5 Step 5): pending. The demo v2 key is no longer in a local
`.env`, and running `bun run smoke:v2` waits for the maintainer to inject it.
