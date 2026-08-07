# M9 - Security Regression and Documentation Hardening Plan (rev. 2 after Sol critique)

> **For agentic workers:** Execute only the assigned task and do not touch
> files outside its list. If a step conflicts with the repository, report the
> conflict instead of widening scope. Do not commit or push unless Kuba asks.

**Goal:** Close every remaining evidence gap in `docs/security.md` section 10,
leave an executable requirement-to-test map, and finish README plus server
instructions for the complete 11-tool v1 surface.

**Architecture:** One narrow runtime fix replaces the count-evicting consumed
confirmation set with a TTL-aware store: an accepted or declined requestState
cannot become replayable while the signed state can still be valid. The rest
of the security work strengthens existing transport, client and registration
tests, corrects one impossible `limit` absolute in binding docs, and adds a
focused `test:security` gate. Documentation makes the real confirmation
contract explicit: elicitation is mandatory when the client supports it,
while a non-elicitation client can execute directly with `confirm: true` and
therefore must preview first.

**Baseline:** 1085 tests pass, typecheck passes, `main` equals `origin/main` at
`b790e23`. Two independent Sol audits were completed before this plan. No live
API probe is needed to design M9 because the milestone changes no Livespace
request shape; the done gate still runs the existing sandbox smoke.

## Confirmed audit findings

1. Section 10.2 is nearly covered, but the invalid bearer branch does not pin
   the required `WWW-Authenticate` header. Malformed and empty bearer forms are
   not in the regression table.
2. Section 10.4 strongly covers tool results, mapped errors and raw bearer
   removal from the SDK principal. It does not capture stderr during an
   upstream failure and therefore does not prove the words "or logs".
3. Section 10.8 says every list call always sends `limit`. That is impossible
   for `Todo/getTodoObjects`, which exposes fixed 50-row pages and no `limit`
   parameter. Several dictionary endpoints also ignore `limit`. The binding
   rule must require an explicit limit where supported and bounded pages or
   local caps everywhere else.
4. Annotation correctness is covered by exact per-tool unit tests and partial
   wire tests. One exact 11-tool wire matrix will make the proof local and
   prevent disagreement between registration and exported configs.
5. User ids currently travel inside POST data. The only id placed in a URL is
   the notification fallback link, which already percent-encodes it. A hostile
   id through the real client seam will pin both halves of that invariant.
6. `src/server/instructions.ts` says write tools never write on the first call.
   That is false for a client without elicitation when the call already carries
   `confirm: true`. The implementation is intentional; the wording must change.
7. README omits required public-bind variables, TLS termination, the no-OAuth
   constraint, a precise write-outcome contract and a complete 11-tool table.
8. Consumed confirmation JTI values are evicted after 512 entries. The oldest
   signed state then becomes replayable even when its five-minute codec TTL has
   not expired. Replay safety must be TTL-aware, not count-evicting.

## Global constraints

- `docs/security.md` remains binding. Do not weaken runtime guards.
- TDD for every changed contract: add or strengthen the assertion, observe the
  focused test, then make the smallest implementation or documentation edit.
- Fixtures stay synthetic. Every fake credential contains `synthetic`.
- Never print a credential, raw upstream response or real CRM record.
- Code, comments and repository docs are English.
- README and instructions follow the `no-ai-slop` skill and use only ASCII
  hyphens, never em or en dashes.
- Read-only instructions must still name none of the five write tools.
- M10 is excluded: no public flip, registry metadata, runtime adapter, release,
  external message, commit or push.

---

### Task 1: Make requestState replay protection TTL-safe

**Files:**

- Modify: `tests/server/write-support.test.ts`
- Modify: `src/server/tools/write-support.ts`

**Produces:** consumed confirmation JTI values stay blocked for at least the
full requestState TTL, regardless of how many later confirmations are used.
Expired entries are purged so storage is bounded by the valid-time window, not
by an eviction rule that can restore a replay.

**Steps:**

- [x] Replace the test that documents "the 513th entry evicts the oldest" with
  failing tests that prove:
  1. a JTI burns on first use;
  2. after more than 512 different later JTI values, the oldest is still
     rejected;
  3. an entry can be purged only after `CONFIRMATION_TTL_SECONDS` has elapsed;
  4. purging expired entries does not unburn any unexpired sibling.
- [x] Replace the `Set` and `CONSUMED_JTI_LIMIT` with a `Map<jti, expiresAt>`.
  Purge expired entries before lookup, record a new entry until
  `now + CONFIRMATION_TTL_SECONDS`, and never evict an unexpired entry.
- [x] Keep `decideConfirm` behavior unchanged: accepted and declined verified
  states both consume their JTI before any write can execute.
- [x] Run write-support tests and typecheck.

### Task 2: Complete the section 10 regression contract

**Files:**

- Modify: `tests/server/http.test.ts`
- Modify: `tests/livespace/client.test.ts`
- Modify: `tests/server/modern-wire.test.ts`
- Create: `tests/security-contract.test.ts`
- Modify: `docs/security.md`
- Modify: `AGENTS.md`
- Modify: `package.json`

**Produces:**

- exact authentication challenge checks for every rejected bearer form;
- one wire-level upstream-body and bearer-token leak test covering both the
  HTTP response and captured stderr;
- proof that a hostile user id stays in POST data and never enters the request
  URL, alongside the existing encoded fallback-link test;
- exact annotations for all 11 tools over `tools/list`;
- an eight-row section 10 test map and a focused `bun run test:security` gate;
- a truthful load-discipline rule for endpoints without a usable `limit`.

**Steps:**

- [x] Strengthen `tests/server/http.test.ts` first:
  1. table-test missing authorization, wrong bearer, empty bearer and a
     non-Bearer scheme;
  2. every row returns 401 and exactly `Bearer realm="mcp"` in
     `WWW-Authenticate`;
  3. an authenticated `health` call whose injected upstream throws an error
     containing `SENSITIVE-synthetic-upstream-body` and
     `synthetic-bearer-token-log-marker` returns neither marker and captured
     stderr contains neither marker;
  4. the wrong-token rejection also emits neither the supplied token nor any
     other stderr line.
- [x] Add a `LivespaceClient` test with an opaque id containing `/`, `?`, `#`
  and `..`: the signed-call URL does not contain the raw id and gains no query
  or hash from it, while the parsed `data` body contains the exact id. Keep the
  existing `recordUrl` percent-encoding test.
- [x] Replace the modern-wire "four booleans" check with an exact object map
  for all 11 tools:
  - six reads: `{readOnlyHint: true, destructiveHint: false,
    idempotentHint: true, openWorldHint: false}`;
  - `create_records`, `log_activities`, `notify_user`: non-read-only,
    non-destructive, non-idempotent, closed-world;
  - `update_records`: non-read-only, destructive, non-idempotent,
    closed-world;
  - `move_deals_to_stage`: non-read-only, destructive, idempotent,
    closed-world.
- [x] Add failing document contract tests in `tests/security-contract.test.ts`:
  1. section 10 contains exactly eight numbered map rows;
  2. the map names the concrete regression files for each row;
  3. sections 3 and 10 name the fixed-page Todo exception and bounded-page
     rule instead of promising `limit` on an endpoint that has none;
  4. `package.json` exposes `test:security` and its command includes every
     file named by the focused contract.
- [x] Amend `docs/security.md`:
  1. section 3 requires explicit limits where the endpoint supports them and
     bounded pages/local caps where it does not or ignores them;
  2. section 10.8 uses the same rule and names `Todo/getTodoObjects` as a
     fixed-page example;
  3. below section 10, add an eight-row `Requirement | Regression proof` table
     with exact test paths and test names;
  4. document `bun run test:security` as the focused command, while `bun test`
     remains the complete gate.
- [x] Amend the matching list-endpoint absolute in `AGENTS.md` to the same
  binding rule: explicit limits where supported; bounded fixed pages or local
  caps for `Todo/getTodoObjects` and limit-ignoring dictionary endpoints.
- [x] Add `test:security` to `package.json` with the mapped config, auth,
  client, metadata, records, activity, aggregate, writes, HTTP, modern-wire,
  write-registration, tool-error and security-contract test files. It must
  also include the tool-boundary tests
  `tests/server/tools/search-crm.test.ts`,
  `tests/server/tools/get-activity.test.ts` and
  `tests/server/analyze.test.ts`, not only their lower-level fetchers.
- [x] Run the focused suite and typecheck.

### Task 3: Make server instructions complete and truthful

**Files:**

- Modify: `tests/server/instructions.test.ts`
- Modify: `src/server/instructions.ts`

**Produces:** a compact operating manual for health, five CRM read tools and
five write tools, with the real elicitation-first and fallback behavior.

**Steps:**

- [x] Add failing instruction tests before editing the string:
  1. reject the sentence "never write on the first call";
  2. require the exact split between an elicitation-capable client and direct
     `confirm: true` execution on a non-elicitation client;
  3. require "preview first" for that fallback, `recordsChanged`,
     `unknown_outcome`, and a warning not to retry a write blindly;
  4. pin each read tool's central contract: metadata ids and cache freshness;
     search phrase XOR filters plus sort-window truncation; get-records one
     kind, 25 ids and five walls; get-activity sources plus count/returned;
     analyze named windows and null/truncation behavior;
  5. pin each write tool's main limit and irreversible or unverifiable case;
  6. reject em and en dashes in both read-write and read-only output.
- [x] Restructure the text into `Quick start`, `Read tools`, `Writing`,
  `CRITICAL` and `Error handling` without decorative headings or repetition.
- [x] Preserve the read-only branch: it announces the kill-switch and omits
  every write tool name and the entire Writing section.
- [x] Describe signed elicitation state narrowly: accepted state is bound to
  the request and single-use; changed records cause a new preview. Do not
  imply those guarantees apply to the direct fallback.
- [x] Keep CRM-authored text out of instructions examples and preserve the
  data-not-instructions warning.
- [x] Run instruction tests and typecheck.

### Task 4: Finalize README for the 11-tool v1 surface

**Files:**

- Create: `tests/readme.test.ts`
- Modify: `README.md`

**Produces:** a README that can take an operator from requirements to a local
server, explains every tool and its main bound, and states the network and
write safety limits without overclaiming.

**Steps:**

- [x] Add failing README contract tests first:
  1. an exact 11-row tool table contains `health`, five CRM reads and five
     writes, with the important batch/window limit for each bounded tool;
  2. requirements name Bun 1.3.14 and single-user API credentials with no
     OAuth;
  3. configuration covers `MCP_ALLOWED_HOSTS`,
     `MCP_ALLOWED_ORIGIN_HOSTNAMES`, bearer behavior on loopback, TLS
     termination and operator responsibility for `.env` at rest;
  4. write safety says elicitation-first, explains direct `confirm: true`,
     `recordsChanged`, `unknown_outcome`, verification unavailable and the
     notification exception;
  5. v1 limits name no delete/merge, no tags/custom-field writes, task linking,
     immutable logged activities, bounded analyses, point-in-time conversion,
     API-vs-UI ids and the Bun-only runtime;
  6. the file contains no em or en dash and no false first-call guarantee.
- [x] Keep the opening direct. State "11 tools total" once and replace the
  ambiguous ten-tool list with one table.
- [x] Add a short `Install and run` flow before development commands: copy the
  env template, install, start, connect to `/mcp`, call `health`, then
  `crm_metadata`.
- [x] Add a `Write safety` section that separates elicitation from the fallback
  and distinguishes `verified`, `unavailable`, `unknown_outcome` and
  `not_attempted` without turning it into protocol documentation.
- [x] Expand network configuration only as far as the binding threat model:
  fail-closed public bind, host and origin allowlists, bearer on every `/mcp`
  request when configured, and TLS outside the Bun process.
- [x] Add a compact `v1 limits` section. Do not promise Node, Workers, OAuth,
  tags, datasets or registry publication.
- [x] Preserve disclaimer, attribution, author, issue and security-reporting
  links.
- [x] Run README tests and the full suite.

### Task 5: Independent verification and milestone close

**Files:**

- Modify: this plan, adding `## Execution notes`
- Modify outside the repo: `../.ai/PLAN.md`, `../.ai/TODO.md`,
  `../.ai/HANDOFF.md`; touch `../.ai/NOTIFY.md` only for a new human action

**Steps:**

- [x] Give the complete uncommitted diff to a fresh Sol verifier. Ask it to
  check all eight section 10 obligations, documentation truth against code,
  secret/fixture hygiene, no-ai-slop patterns and scope drift. It must not edit.
- [x] Skeptically reproduce or refute every verifier finding before changing
  files. Apply only confirmed fixes and rerun the affected focused tests.
- [x] Run final gates from the repository:
  1. `bun run test:security`;
  2. `bun test`;
  3. `bun run typecheck`;
  4. `bun audit`;
  5. scan the changed repository files for em/en dashes, fake credentials
     without `synthetic`, real CRM data and accidental secret-shaped values;
  6. run `bun run smoke` against the macOS-Keychain sandbox only.
- [x] Check README and instructions directly against the `no-ai-slop` eval and
  fix any failed item before handoff.
- [x] Record exact test counts, audit result, smoke result, verifier verdict and
  deviations under `Execution notes`.
- [x] Update `.ai` state. Leave M10 and the public flip pending Kuba's decision.

## Execution notes

Completed 2026-08-07. Kuba explicitly requested one M9 commit. The commit is
created with his configured Git identity, rebased onto the current remote tip,
and left unpushed.

### TDD and implementation

- The old count-bounded consumed-JTI set failed two new replay tests. A
  TTL-aware `Map<jti, expiresAt>` now keeps every consumed state burned for
  the full five-minute validity window, even after more than 512 later uses.
- New security-contract tests first failed on the missing section 10 map,
  impossible all-endpoint `limit` absolute and absent focused command. The
  binding docs now distinguish explicit upstream limits, fixed Todo pages and
  local dictionary caps.
- New instruction tests first failed on the incomplete operating manual and
  false first-call wording. The final text separates elicitation-capable and
  direct fallback clients and covers all 11 tools.
- Five of six new README contract tests failed against the old README. The
  final README has one exact 11-tool table, complete network configuration,
  truthful write outcomes and explicit v1 limits.

### Independent verification

Two fresh Sol verifiers reviewed the complete uncommitted diff without editing
it. Their three reproducible findings were fixed and rechecked:

1. The focused security gate omitted the direct dictionary-cap regression in
   `tests/server/tools/crm-metadata.test.ts`. The file is now in the section 10
   map, its contract test and `test:security`.
2. README described `verification: unavailable` as uncertain dispatch. It now
   preserves the successful-write status and names the possible independent
   check failures.
3. Instructions said an elicitation-capable client always prompts, overlooking
   `dryRun: true`. The claim now applies only to non-dry-run requests.

Both final verifier verdicts were clean.

### Final gates

- `bun run test:security`: 887 pass, 0 fail, 4039 expectations, 24 files.
- `bun test`: 1102 pass, 0 fail, 4713 expectations, 40 files.
- README plus instruction contracts: 25 pass, 0 fail, 117 expectations.
- `bun run typecheck`: pass.
- `bun audit`: no vulnerabilities found.
- `git diff --check`: clean.
- Direct no-ai-slop and long-dash scans: clean. The only long-dash glyphs are
  the negative-test regex literals themselves.
- `bun run smoke`: sandbox ping and current-user read both passed. No CRM
  value or credential was recorded here.
- Pinned gitleaks 8.18.4: 97-commit history and current worktree both clean.

The local branch started at `04cfe51`. During final verification the remote
advanced to `0b74675` through three user-authored README commits. Their latest
title and byline are preserved. After Kuba explicitly requested the M9 commit,
it was created with his configured Git identity and rebased onto that remote
tip. No push was made. The public flip, package publication, Registry
publication and Livespace heads-up remain external M10 approval gates.
