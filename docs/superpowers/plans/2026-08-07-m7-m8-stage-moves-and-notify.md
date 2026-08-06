# M7+M8 - `move_deals_to_stage` and `notify_user` Implementation Plan (rev. 2 after critique panel)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execute ONLY your assigned task; do not touch files outside its list. If a step conflicts with reality, record the deviation in your report instead of improvising.

**Goal:** The last two v1 tools: `move_deals_to_stage` (stage position derived by checking/unchecking process steps, minimal per-deal diff computed from the DEAL'S OWN live step state, per-deal backward gating, approval strings that disclose the destructive scale) and `notify_user` (single in-app notification, recipient validated, human-editable message in the elicitation form, honest `dispatched`-not-`sent` reporting, module-scope send budget).

**Architecture:** Task 1 widens `src/server/tools/write-support.ts` with the two item shapes the new tools need (`NoWriteItem` "unchanged" -> ok without dispatch or re-read; `ActionWriteItem` for dispatch-only actions) and adds a deal `stageId` comparator to `verifyApplied`. `src/livespace/stage-moves.ts` owns the pure step-diff math over the deal's own `stages_all`/`substages_all`/`substages` (NOT the cached dictionary - staleness would mis-number positions); `src/livespace/writes.ts` gains `moveDealSteps`, `sendNotification`, `recordUrl` and the records mappers gain `url`. Tools in `src/server/tools/move-deals-to-stage.ts` / `notify-user.ts`, registered after log_activities (11 tools; read-only 6).

**Tech Stack:** unchanged; every M6 convention binding.

## Live-verified API evidence (M7 probes 1-2, M8 probes 1-3, 2026-08-07, sandbox)

1. **The stage IS the furthest checked step.** `Deal/editDeal {deal: {id,
   stages: {<step_id>: 1|0}}}`: all steps of stage 0 checked -> deal at
   stage 0; stages 0-1 + first step of 2 -> stage 2; stages 0-1 only ->
   stage 1; everything unchecked -> stage EMPTY (the pre-pipeline state).
2. **Step edits MERGE** - only send the flips.
3. **Foreign-process step ids -> 420** with a per-step upstream error map.
4. **Step state is readable off `Deal/get`**: `stages_all` (stage_id ->
   name, ALL stages, emission order = pipeline order), `substages_all`
   (stage_id -> {step_id: name}, ALL steps), `substages` (CHECKED only).
   The deal's own definition is the diff's source of truth; the cached
   dictionary only resolves the caller's stageId to a process+position
   and can be up to 30 min stale.
5. `Crm/notification_send` requires `{user_id, text, type, url}`
   (progressive 550 named each). All four -> 200, data `[]`. `type`
   accepts 1/2/3/"success"/"warning" indistinguishably; the tool always
   sends 1. NO read-back API (3 candidates -> 540): delivery is
   unverifiable by API.
6. **A bogus `user_id` -> 200 SILENTLY.** Recipient MUST be validated
   against the cached `users` section; even then the id-space assumption
   (User_getAll id == notification recipient id) is unverifiable by API -
   the done gate records a pending HUMAN check of the sandbox UI bell.
7. Record deep links, ALL THREE verified off live records' `url` fields:
   `https://<sub>.livespace.io/Deal/deal/details/api_id/<id>`,
   `.../Contact/contact/details/api_id/<id>`,
   `.../Contact/company/details/api_id/<id>` (M8 probe 3).
8. `Deal/get` not-found is **550** (540 on contacts); both map to null in
   the step-state reader, nothing else does.
9. M6 machinery carries over: WRITE_BATCH_CAP, WRITE_BUDGET_MS,
   RATE_LIMITED halts plan AND execute, PLAN_BUDGET_EXPIRED, abort
   audit, VERIFICATION_UNAVAILABLE/UNCHECKED advisories, decideConfirm.

## Global Constraints

- Everything the M6 plan's Global Constraints say.
- `move_deals_to_stage`: `.max(WRITE_BATCH_CAP)` deal ids (the shared
  constant, = 10); annotations `{readOnlyHint: false, destructiveHint:
  true, idempotentHint: true, openWorldHint: false}`.
- `notify_user`: ONE notification per call; annotations
  `{readOnlyHint: false, destructiveHint: false, idempotentHint: false,
  openWorldHint: false}`; module-scope send budget: max 5 dispatches per
  rolling 10 minutes AND max 1 per recipient per minute, refused BEFORE
  any dispatch with fixed wording (clock-stub tested).
- **Backward moves are gated PER DEAL**: `allowBackwardDealIds:
  string[]` - every listed id must also be in `dealIds` (else
  BAD_PARAMS); a backward deal not listed is `blocked` with fixed
  wording. No call-level blanket permission.
- **Guards fail closed**: a deal is movable only when `status === "open"`
  exactly AND its `processId` is non-empty and equals the target stage's
  process; anything else (empty, unknown, mismatch) -> `blocked`.
- **Approval strings disclose scale, counts only** (templates below).
- **Fabricated-completion disclosure**: the move tool's description AND
  the instructions writes section state in fixed wording that a forward
  move marks intermediate steps as completed and a backward move
  un-marks them - the checkboxes stop being evidence of work done.
- `docs/security.md` par. 5 gains the third verification case: a write
  whose upstream exposes no read-back reports verification unavailable by
  construction and is never retried on unknown outcome (notify_user).
- Baseline: 931 tests. TDD, commit per task, push at milestone end
  (standing goal).

## Design decisions locked by probe evidence and the critique panel

- **Item taxonomy widening (Task 1, write-support.ts)**:
  `NoWriteItem {index, action, kind, status: "unchanged", view?}` ->
  executePlan emits `{status: "ok"}` with the view, NO dispatch, NO
  re-read, NO advisory. `ActionWriteItem {index, action, kind, status:
  "action", perform}` -> dispatch only, `verification: "unavailable"`
  with a caller-supplied advisory (notify passes
  NOTIFICATION_UNVERIFIABLE). `WriteItemPlan.status` gains
  `"move" | "unchanged" | "action"`. `ItemResult` is NOT widened: tools
  merge per-index detail into their own result rows after executePlan
  (the create-records duplicate-id precedent).
- **Move verification through the existing seam**: `APPLIED_CHECKS.deal`
  gains `stageId` (trimmed-exact vs mapped `stageId`); each move item
  carries `sent: {stageId: targetStageId}` - target reached -> verified;
  missed -> `unappliedFields: ["stageId"]`.
- **computeStepDiff** is TOTAL (never throws), signature
  `computeStepDiff(state: DealStepState, target: {processId: string; position: number; stages: ProcessStagePlanEntry[]}, allowBackward: boolean): StepDiff`.
  Precedence: wrong-process -> closed-deal (status !== "open" exactly,
  incl. "") -> state-conflict -> empty-target -> direction.
  `currentPosition = max(positionOf(state.stageId), furthestCheckedPosition)`;
  when `positionOf(state.stageId)` and the furthest checked step DISAGREE
  on the stage, the deal is `blocked` with reason `"state-conflict"`
  (par. 5: ambiguity does nothing). A checked step id unknown to the
  deal's own definition -> also `state-conflict`. Target stage with zero
  steps -> `{kind: "blocked", reason: "empty-target"}` at the pure level
  AND Task 2 rejects the whole call BAD_PARAMS before any read (the
  metadata already knows).
  Up-move: check only UNCHECKED steps of stages 0..k-1 (never re-send
  checked ones, never any 0s) + first step of k iff k holds none.
  Down-move (per-deal flag): uncheck exactly the checked steps in stages
  k+1.. (no 1s except the first-step top-up when k holds none).
  Already at k -> `{kind: "unchanged"}`.
- **The diff source is the DEAL** (evidence 4): `readDealStepState`
  parses `stages_all`/`substages_all`/`substages` (PHP [] normalization
  at every level) into
  `DealStepState {processId, status, stageId, stageName, substageName, order: ProcessStagePlanEntry[], checked: Record<string, string[]>}`
  - plain JSON containers ONLY (no Map/Set - hashArgs serializes them to
  {}). 540/550 -> null; every OTHER error propagates (RATE_LIMITED halts
  the plan loop exactly as create_records does; PLAN_BUDGET_EXPIRED on
  deadline; abort checked between reads).
- **previewDigest binds the actual flips**: the plan item summary is
  plain JSON
  `{dealId, targetStageId, flips: Record<string, 0|1>, stepsChecked, stepsUnchecked, before: {stageId, stageName, substageName}}` -
  two different flip sets can never hash alike. Step ids in
  structuredContent are fine; text and elicitation stay counts-only.
- **Approval/preview templates (fixed, counts only)**: elicitation
  `Move N deal(s) to a pipeline stage: F forward, B backward, U unchanged. C step(s) will be marked done, X step(s) un-marked. Approve?`;
  preview line
  `move_deals_to_stage preview: N deal(s) - F forward, B backward, U unchanged, K blocked. C step(s) to mark done, X to un-mark. Re-call with confirm: true to execute.`;
  execute line
  `move_deals_to_stage: attempted A of N - moved M, unchanged U, blocked K, errors E, unknown W, not attempted P.`
  Blocked counts derive from PLAN indices (executePlan reports blocked
  items as errors - the tool subtracts them from `errors` and
  `attempted`).
- **notify_user flow**: recipient validated against the cached users
  section (miss -> NOT_FOUND + crm_metadata hint + the staleness caveat
  in the description); record (when given) fetched via getRecord (null ->
  NOT_FOUND); the deep link PREFERS the record's own `url` (records.ts
  maps it; empty conventions apply) and falls back to `recordUrl`
  construction (all three patterns verified - evidence 7); no record ->
  CRM root. Elicitation form has TWO fields: `confirm` (boolean) and
  `text` (string, default = the planned message) - the human SEES and may
  EDIT the body; the accepted text replaces the planned one at execute
  (validated by the same 1..500 bound; out-of-bound -> declined preview
  with fixed wording). The notify tool reads its own accepted content
  (the shared reader only knows `{confirm}`). Result:
  `{dispatched: true, urlKind: "record" | "root", textLength: n}` with
  verification "unavailable" + new fixed advisory
  `NOTIFICATION_UNVERIFIABLE {code: "NOTIFICATION_UNVERIFIABLE", message: "Livespace exposes no read-back for notifications; delivery cannot be confirmed.", hint: "Do not resend; confirm with the recipient another way."}`.
  The message body travels UPSTREAM and into structuredContent
  (`textPreview` capped at 100 chars) - NEVER into result.text or the
  fixed elicitation line.
- **Deps, fetcher-shaped**:
  `MoveDealsToStageDeps {deals: {readStepState(dealId, opts): Promise<DealStepState | null>}; writes: WriteFetchers; records: Pick<RecordFetchers, "getRecord">; metadata: MetadataService; codec}`
  (reader built by `createDealStepReader(client)` in stage-moves.ts);
  `NotifyUserDeps {writes; records: Pick<RecordFetchers, "getRecord">; metadata: MetadataService; codec; subdomain: string}`.
  `AppDeps` gains `dealSteps?` and `subdomain?`; `src/index.ts` threads
  both (subdomain from LivespaceConfig). Missing dep -> tool not
  registered (mirrors the M6 gating); wire fixtures updated.

---

### Task 1: Machinery widening + step-diff math + fetchers

**Files:**
- Modify: `src/server/tools/write-support.ts` (NoWriteItem, ActionWriteItem,
  WriteItemPlan.status widening, NOTIFICATION_UNVERIFIABLE)
- Modify: `tests/server/write-support.test.ts` (new item rows)
- Create: `src/livespace/stage-moves.ts`
- Modify: `src/livespace/writes.ts` (`moveDealSteps`, `sendNotification`,
  `recordUrl`, `stageId` comparator in APPLIED_CHECKS.deal; write-flag
  table rows)
- Modify: `src/livespace/records.ts` + `src/server/tools/record-schemas.ts`
  (map `url` on person/company/deal records; schemas gain the optional
  string)
- Test: `tests/livespace/stage-moves.test.ts`; extend
  `tests/livespace/writes.test.ts`, `tests/livespace/records.test.ts`

**Produces (exact):** the design-decision shapes above, plus
`flattenDealStages(state raw parse) -> ProcessStagePlanEntry[]` internal,
`createDealStepReader(client: Pick<LivespaceClient, "call">): {readStepState}`.

**Steps:**
- [ ] Failing tests:
  1. write-support: NoWriteItem -> `{status: "ok"}`, zero dispatch/read
     calls, no advisory; ActionWriteItem -> perform called, verification
     "unavailable" with the SUPPLIED advisory; both statuses accepted in
     WriteItemPlan.
  2. verifyApplied deal stageId rows: reached -> `{[], ["stageId"], true}`;
     missed -> `{["stageId"], ["stageId"], true}`; null re-read ->
     verified false.
  3. records: `url` mapped verbatim on all three kinds; absent -> "";
     schemas parse.
  4. readDealStepState: keyed shapes parse into plain-JSON state; [] at
     outer AND inner levels; checked steps as arrays; 550 -> null AND
     540 -> null; RATE_LIMITED propagates (not null); status carried.
  5. computeStepDiff table over ONE pinned synthetic fixture (4 stages x
     2 steps, ids `stage-synthetic-0..3`/`step-synthetic-{0a..3b}`),
     EVERY row `toStrictEqual` on the whole StepDiff (exact flips key
     set):
     a. fresh deal (no checks) -> stage 2: flips = all four steps of
        0-1 at 1 + step-2a at 1, ONLY 1s;
     b. up-move with some pre-checked steps: only the unchecked gaps
        sent;
     c. up-move where target already holds a checked step: no target
        top-up;
     d. already at target -> unchanged;
     e. down-move without the per-deal flag -> blocked
        backward-needs-flag;
     f. down-move with flag, target holds a checked step -> flips are
        0s ONLY (exact set = checked steps above target);
     g. down-move with flag, target holds none -> 0s above + step-Xa
        at 1;
     h. wrong process -> blocked wrong-process (precedence over closed);
     i. status "won"/""/unknown -> blocked closed-deal;
     j. stage_id position ABOVE furthest checked (disagreement) ->
        blocked state-conflict;
     k. checked step id absent from the deal's own definition ->
        blocked state-conflict;
     l. empty-target (zero steps) -> blocked empty-target.
  6. moveDealSteps/sendNotification wire pins (`Deal/editDeal {deal:
     {id, stages}}`, `Crm/notification_send {user_id, text, type: 1,
     url}`, both `{write: true}`, table rows added); recordUrl exact
     strings for all three kinds (evidence 7).
- [ ] Implement; suite+typecheck green.
- [ ] Commit: `feat: step-diff math, stage-move and notification fetchers`

### Task 2: `move_deals_to_stage`

**Files:**
- Create: `src/server/tools/move-deals-to-stage.ts`
- Test: `tests/server/move-deals-to-stage.test.ts`

**Input schema**: `dealIds: z.array(z.string().min(1).max(64)).min(1).max(WRITE_BATCH_CAP)`,
`stageId: z.string().min(1).max(64)`,
`allowBackwardDealIds: z.array(z.string().min(1).max(64)).max(WRITE_BATCH_CAP).optional()`,
`dryRun`, `confirm`.

**Runner rules:** duplicate dealIds -> BAD_PARAMS; allowBackwardDealIds
not a subset of dealIds -> BAD_PARAMS; stageId resolved via metadata
(NOT_FOUND + hint); zero-step target -> BAD_PARAMS BEFORE any read;
argsHash over `{dealIds, stageId, allowBackwardDealIds}`. PLAN: per deal
`deps.deals.readStepState` with the M6 loop contract (abort between
reads, deadline -> PLAN_BUDGET_EXPIRED blocks the rest, RATE_LIMITED
blocks this and the rest, null -> blocked NOT_FOUND); computeStepDiff
with per-deal backward flag; plan items per the pinned summary shape;
aggregates (forward, backward, unchangedCount, stepsToCheck,
stepsToUncheck) on the structured plan root. Execute: move items as
RecordWriteItems (kind deal, `sent: {stageId}`, perform = moveDealSteps)
+ NoWriteItems for unchanged; tool merges per-index
`{before, after, stepsChecked, stepsUnchecked, moved}` into result rows
after executePlan; blocked counts derived from plan indices (subtracted
from errors/attempted in the text). Templates exactly as the design
decision.

**Steps:**
- [ ] Failing tests: schema matrix (caps via the constant, 11th id
  rejected); duplicate ids; subset rule; unknown stage; zero-step target
  (BAD_PARAMS, zero reads); per-deal blocked paths incl. state-conflict
  and closed-"" (fail-closed); unchanged -> ok row with moved false and
  ZERO write calls; up/down execute rows (flips forwarded verbatim,
  re-read verification through stageId comparator, before/after
  merged); mixed batch: forward deal + backward-flagged deal + backward-
  unflagged deal -> flagged moves, unflagged blocked; digest row: sibling
  step flipped between rounds (fake reader returns different checked
  map) -> recordsChanged re-preview, zero writes; RATE_LIMITED plan halt
  (one read recorded); deadline halt; approval + preview + execute
  templates char-exact incl. the blocked-vs-errors split (one blocked +
  one failing deal fixture); output-schema safeParse all variants;
  elicitation message char-exact; text purity; CANCELLED; 420 marker.
- [ ] Implement; suite+typecheck green.
- [ ] Commit: `feat: move_deals_to_stage with minimal step diffs`

### Task 3: `notify_user` + registration + docs

**Files:**
- Create: `src/server/tools/notify-user.ts`
- Modify: `src/server/mcp.ts`, `src/index.ts` (AppDeps: `dealSteps`,
  `subdomain`; register both tools; order ends move_deals_to_stage,
  notify_user)
- Modify: `src/server/instructions.ts` (both tools; the fabricated-
  completion disclosure; notify honesty)
- Modify: `docs/security.md` (par. 5 third verification case)
- Modify: `tests/server/modern-wire.test.ts` (sweep 9 -> 11; read-only 6;
  fixtures gain the new deps)
- Modify: `README.md` (all v1 tools live; move/notify described)
- Test: `tests/server/notify-user.test.ts`; extend
  `tests/server/write-registration.test.ts`, instructions test, security
  docs test

**Input schema**: `userId 1..64`, `text 1..500`, `recordKind enum
person/company/deal optional`, `recordId 1..64 optional` (kind XOR-with
id -> both or neither), `dryRun`, `confirm`.

**Runner rules:** send budget FIRST (5/10 min rolling + 1/recipient/min,
clock-stubbed, fixed wording, refused before metadata); recipient
validated via cached users (miss -> NOT_FOUND + staleness caveat);
record fetch when given (null -> NOT_FOUND); url = record.url || recordUrl
fallback || CRM root; plan = one ActionWriteItem; elicitation form
`{confirm: boolean, text: string default planned}` read by a LOCAL
acceptedContent schema; accepted text re-validated 1..500 (violation ->
declined preview, fixed wording); execute dispatches
`sendNotification`; result `{dispatched, urlKind, textLength}` +
NOTIFICATION_UNVERIFIABLE advisory; `textPreview` (<= 100 chars) in
structured only.

**Steps:**
- [ ] Failing tests: schema matrix incl. kind/id pairing; unknown
  user/record; url preference order (record.url wins; empty falls back
  to constructed; no record -> root); send-budget rows (cap refusal,
  per-recipient refusal, window expiry allows again); elicitation form
  carries BOTH fields with the planned text as default; accepted edited
  text is what dispatches; accepted out-of-bound text -> declined, zero
  dispatches; declined/cancelled -> zero dispatches; execute wire pin
  (`type: 1`, url verbatim); dispatched honesty (never `sent`,
  advisory attached, verification "unavailable"); text purity (the body
  NEVER in result.text/elicitation line; textPreview capped);
  registration order 11; read-only 6 + refusal both tools; annotations
  sweep; instructions rows (disclosure line + notify honesty + both
  names); security.md third-case wording present, old absolute gone;
  README updated; output-schema safeParse; CANCELLED.
- [ ] Implement; suite+typecheck green.
- [ ] Commit: `feat: notify_user with validated recipient and deep link`

---

## Done gate (orchestrator, not a task)

- Full suite + typecheck + audit green; read-only lists 6 tools.
- Live smoke (sandbox, real MCP client, SYNTHETIC fixtures, ledger +
  raw-delete cleanup):
  1. deal in Outbound -> move UP to stage 2 (confirmed): upstream
     stage_name verified, flips only 1s, stepsChecked matches; re-run ->
     unchanged, moved false, zero flips;
  2. backward WITHOUT the per-deal flag -> blocked; WITH flag -> lands at
     stage 1, steps above unchecked (verified via raw substages read);
  3. MIXED map path: from a state whose only checked step sits in stage
     3, move down to empty-holding stage 1 with the flag -> one editDeal
     carrying both 0s and 1s; raw re-read confirms stage 1 + first step
     checked;
  4. wrong-process deal blocked; closed deal blocked;
  5. notify_user to the demo admin with the deal link (confirmed) ->
     dispatched true, urlKind record; bogus userId -> NOT_FOUND before
     dispatch; dryRun dispatches nothing; send budget kicks in on the
     6th rapid call;
  6. text channels counts-only throughout; cleanup verified per id.
- **Pending HUMAN check recorded in NOTIFY.md**: Kuba glances at the
  sandbox UI bell to confirm the smoke notification actually rendered
  (the id-space assumption is unverifiable by API - evidence 6).
- Execution notes appended; push (standing goal).
