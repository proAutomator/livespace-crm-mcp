# M6 Write Tools - Implementation Plan (rev. 2 after critique panel)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execute ONLY your assigned task; do not touch files outside its list. If a step conflicts with reality, record the deviation in your report instead of improvising.

**Goal:** Three write tools - `create_records`, `update_records`, `log_activities` - with human-in-the-loop confirmation (elicitation-first, single-use signed state), dryRun, read-based dedupe defaults, post-write verification that separates "write failed" from "write succeeded but unverifiable", bounded batches that fit client timeouts, and read-only gating.

**Architecture:** `src/livespace/writes.ts` owns typed write fetchers (wrapped payloads, string-array contact fields, `{write: true}` single dispatch) plus `verifyApplied` (sent-vs-stored comparison over the M4 mapped records, which Task 1 extends with person `emails`/`phones` arrays). `src/server/tools/write-support.ts` owns shared machinery: plan building, dedupe, preview shaping, the confirm state machine (`decideConfirm`), the `requestState` codec (single-use `jti`, plan digest), wall-clock budget and per-item execution. The three tools are thin modules over it. `src/server/mcp.ts` gains a write registration path (InputRequiredResult passthrough) gated on `!readOnly`; `docs/security.md` par. 5 is amended where probe evidence contradicts its wording. Registration order: health, crm_metadata, search_crm, get_records, get_activity, analyze, create_records, update_records, log_activities.

**Tech Stack:** unchanged, no new dependencies. SDK 2.0.0 MRTR surface (verified in type defs): `createRequestStateCodec` (HMAC-SHA256, key >= 32 bytes, `bind`), `inputRequired({inputRequests, requestState})`, `inputRequired.elicit`, `acceptedContent(responses, key, schema)`, `ctx.mcpReq.requestState<T>()`, `ctx.mcpReq.inputResponses`, `CLIENT_CAPABILITIES_META_KEY`, `isInputRequiredResult`.

## Live-verified API evidence (probe rounds 1-13, 2026-08-06, sandbox)

Write endpoints take WRAPPED payloads and answer with an ECHO of the input
plus a generated `id` - the echo proves nothing about persistence
(evidence 2). All values below are synthetic.

1. Endpoints verified working:
   - `Contact/addContact {contact: {...}}`, `Contact/editContact {contact: {id, ...}}`
   - `Contact/addCompany {company: {...}}`, `Contact/editCompany {company: {id, ...}}`
   - `Deal/addDeal {deal: {name, company: {id} | contact: {id}, process_id?, budget?}}`,
     `Deal/editDeal {deal: {id, ...}}`
   - `Todo/addTodo {todo: {title, date?, description?}}`, `Todo/editTodo {todo: {id, ...}}`
   - `Contact/addContactNote {contact: {id, note}}` -> `{... wall_item_id}` (PERSONS ONLY - see 15)
   - `Contact/addCompanyNote {company: {id, note}}` -> company wall verified (probe 13)
   - `Deal/addDealNote {deal: {id, note}}` -> `{... wall_item_id}`
   - `Contact/addContactCall {contact: {id, phone, direction, note?, date?}}`,
     `direction` in `incoming | outgoing`; the `date` PERSISTS (wall entry
     type "telefon" carries the sent timestamp - probe 12e)
   - Deletes exist (`deleteContact`/`deleteCompany`/`deleteDeal`/`removeTodo`,
     wrapped ids) - probe cleanup ONLY, never a tool (par. 5).
2. **THE ECHO LIES.** Scalar `email`/`phone` on addContact: 200 + echo,
   stores NOTHING. `date_from`/`date_to` on addTodo: echoed, dropped.
   Post-write re-read comparison is a correctness feature.
3. Persisting contact fields: `emails: ["a@b"]`, `phones: ["+48..."]` as
   STRING ARRAYS (stored as `{value|number, type, id}` objects). Scalars
   `firstname`, `lastname`, `note` persist. `tags` do NOT persist in any
   probed shape - OUT of v1. Person->company link persists via
   `company: {id}` on create AND edit (probe 12c; re-read `company_id`).
4. Edits MERGE (partial updates safe): verified on contact (firstname edit
   left lastname/emails), company (nip left name), deal (value edit left
   name), todo (title left completion).
5. Deal `value` is computed from budget lines ONLY:
   `budget: [{product_id | product_name, price, amount}]` - product_id
   (catalog id, 10 products on sandbox) verified at CREATE (111x3=333);
   product_name (custom line) verified at CREATE (200x2=400, probe 12b)
   and at EDIT (300). Direct `value` never persists. Budget EDIT
   append-vs-replace semantics unprobed - budget is CREATE-ONLY in v1.
6. `Deal/addDeal` REQUIRES `company: {id}` or `contact: {id}` (nested;
   scalar company_id -> 420). Optional `process_id` SCALAR selects the
   pipeline process (verified: deal landed in the named non-default
   process - probe 12b); `process: {id}` is ignored. Without process_id
   the deal lands in the FIRST process, stage empty, owner = key's user.
7. Deal `status` transitions `won`/`lost`/`open` via editDeal verified;
   `status_change_date` stamped upstream. NO lost reasons in the API
   (4 dictionary candidates 540; reason params silently ignored).
8. Todo: the date WRITE key is the SCALAR `date` - datetime
   ("2026-09-20 10:00:00", stored exactly, `date_type: 0`) AND date-only
   ("2026-09-26" -> stored as 00:00:00, `is_all_day: true` - probe 12f)
   both persist. `date_from`/`date_to`/`datesPeriod`/`date_type` on write
   are dropped. `description` persists; `priority` does not round-trip
   (sent 2, read 1) - not exposed. `is_completed: "1"|"0"` via editTodo
   verified. Task->record links via `objects: [...]` do NOT persist
   (echoed, re-read `[]` - probe 12d) - task links OUT of v1, documented.
9. Note visibility is NOT controllable (`access`/`is_public`/`visibility`
   all ignored; everything lands `is_public: 1`) - notes are public-only
   and the description says so.
10. `__check_if_exists` DOES NOT dedupe (5 variants) - dedupe is OURS,
    read-based: `Contact/getAll {type: "contact", emails: <email>}` is an
    EXACT, CASE-INSENSITIVE filter (probe 12g: stored mixed-case matched
    by lower/upper queries; unique -> 1 row, nonexistent -> 0). Companies:
    `{type: "company", names: <name>, condition: "like"}` then LOCAL
    case-insensitive exact-name compare; like-page ordering is UNVERIFIED,
    so the lookup pages up to 25 rows and a name sharing a prefix with
    more than 25 rows may still slip through (documented caveat).
11. Unknown payload keys are SILENTLY ACCEPTED (200) - our schemas stay
    strict; the verifier catches what slips.
12. `_wall` is NOT SENT on any write (rev. 2 decision): its only plausible
    effect is suppressing the CRM feed entry, i.e. hiding agent-made
    changes from the operator's audit trail. The flag's actual effect was
    unverifiable on the quiet sandbox anyway.
13. Write latency: one logical call = 2 HTTP round-trips (token + signed
    dispatch), 0.5-2 s through the throttle. A create/update item costs
    up to 3 logical calls (plan lookup, write, re-read) = 1.5-6 s;
    the batch caps below follow from the MCP client's 60 s default
    request timeout.
14. M2.5 client semantics: `{write: true}` single-dispatch;
    WRITE_OUTCOME_UNKNOWN after dispatch; 429 -> RATE_LIMITED (rejected
    before processing).
15. `Contact/addContactNote` with a COMPANY id -> 420 (probe 12a) -
    company notes MUST use `addCompanyNote` (probe 13).

## Global Constraints

- **Read-only mode**: `config.readOnly` -> the three write tools are NOT
  REGISTERED (absent from tools/list) AND the instructions' writes section
  is not emitted; a direct tools/call to them is refused (both
  regression-tested).
- **No delete, no merge** in the tool surface (par. 5).
- **Batch caps from timeout arithmetic** (evidence 13): create/update
  <= 10 items TOTAL per call (<= 10 per kind array); log_activities
  <= 15 items total. Par. 3's 50 is a ceiling, not a target.
- **Write budget**: `WRITE_BUDGET_MS = 45_000` per call, checked BETWEEN
  items (never mid-dispatch); on expiry remaining items report
  `not_attempted`.
- **A RATE_LIMITED item stops the batch**: the failing item is `error`,
  every remaining item `not_attempted` (never hammer an upstream that
  said stop).
- **Abort accountability**: the abort signal is checked between items
  only. Before the CANCELLED throw, ONE stderr audit line with counts and
  written ids only (no names, no payloads - par. 6):
  `write batch cancelled after N applied item(s): ids=[...]`.
- **Item status is decided by the WRITE outcome only.** A failed or null
  re-read NEVER turns an applied write into an error: the item stays `ok`
  with `verification: "unavailable"` and a fixed hint (re-read before
  writing again, never retry the write). `unappliedFields` appears only
  from a SUCCESSFUL re-read comparison.
- **Writes never suppress the CRM feed** (no `_wall` param - evidence 12):
  the wall/feed entry is the operator's audit trail of agent activity.
- **Upstream `envelope.error` is never read or surfaced**: write 420s stay
  the generic VALIDATION_ERROR `{code, message, hint}` (par. 6); one
  marker regression test per tool.
- Counts-only text channel (par. 4) AND counts-only elicitation messages:
  the string a human approves contains counts and kind words ONLY - never
  names, ids, or field values (a CRM/model-authored string in the approval
  prompt is an injection channel to the human).
- Confirmation is elicitation-first: on an elicitation-capable client a
  write executes ONLY after an accepted `confirm: true` elicitation
  response with a verified, unconsumed, matching requestState. The model
  cannot self-confirm there (`confirm: true` argument is ignored in favor
  of the prompt). On non-elicitation clients `confirm: true` is the
  execute trigger (documented).
- requestState: signed (HMAC key >= 32 bytes), payload
  `{tool, argsHash, previewDigest, jti}`, `ttlSeconds: 300`, single-use
  (`jti` consumed at execute, bounded FIFO set of 512). Key from
  `MCP_REQUEST_STATE_KEY`; when it is absent AND (`MCP_AUTH_TOKEN` is set
  OR the bind host is non-loopback) startup FAILS (fail-closed); loopback
  dev falls back to a per-process random key with a stderr note.
- Errors `{code, message, hint}` via `toToolError`; CANCELLED contract as
  in M5; every write call carries `{write: true}` (behavioral table test,
  not a source scan).
- Annotations: create_records / log_activities
  `{readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false}`;
  update_records the same with `destructiveHint: true`. Wire sweep: 9
  tools registered normally, 6 in read-only.
- Synthetic fixtures ("synthetic" marker); no live calls in unit tests;
  TDD; one commit per task; suite green before each commit. Baseline: 644.

## Design decisions locked by probe evidence and the critique panel

- **The confirm state machine** (all inputs explicit, every path tested):
  `decideConfirm({confirm, dryRun, state, argsHash, tool, elicitedConfirm, clientSupportsElicitation})`
  where `state = {tool, argsHash, previewDigest, jti} | undefined` (the
  verified codec payload) and `elicitedConfirm` comes from
  `acceptedContent(ctx.mcpReq.inputResponses, "confirm", z.strictObject({confirm: z.boolean()}))?.confirm`.
  1. `dryRun && confirm` -> BAD_PARAMS.
  2. `dryRun` -> preview (state, if any, is ignored).
  3. `state` present: `state.tool !== tool` -> BAD_PARAMS ("this
     confirmation belongs to another tool"); `state.argsHash !== argsHash`
     -> BAD_PARAMS ("arguments changed since the preview"); `jti` already
     consumed -> BAD_PARAMS ("this confirmation was already used");
     `elicitedConfirm !== true` (missing, declined, cancelled, or false)
     -> DECLINED preview: the normal preview result with the fixed line
     "Confirmation was declined; nothing was written." - never execute,
     never re-elicit;
     otherwise -> execute (with the digest check below).
  4. no state, `clientSupportsElicitation` -> input-required (REGARDLESS
     of `confirm` - the model cannot bypass the human prompt).
  5. no state, no elicitation, `confirm` -> execute.
  6. otherwise -> preview with `requiresConfirmation: true`.
- **TOCTOU is closed on the state path, accepted on the confirm-arg
  path**: at execute-with-state the plan is RECOMPUTED (fresh lookups,
  fresh before-values) and `hashArgs(plan.items)` is compared with the
  minted `previewDigest`; mismatch -> NO write, fresh preview with the
  fixed line "Records changed since the preview; review and confirm
  again." (and a fresh requestState). The confirm-arg path recomputes and
  executes (documented: preview advisory, execution re-validates).
- **Single-use confirmations**: `jti` (16 random bytes hex) consumed at
  the moment execution starts; replay -> BAD_PARAMS. Bounded FIFO
  (512 entries) is sound under the single-process deployment model the
  codec key already assumes.
- **Capability probe, exact**: import `CLIENT_CAPABILITIES_META_KEY`;
  `caps = ctx?.mcpReq?.envelope?.[CLIENT_CAPABILITIES_META_KEY]`; return
  true iff `caps.elicitation` is a non-null plain object AND (it has no
  keys OR `"form" in it`). Anything else - undefined ctx, legacy era,
  url-only elicitation - false, falling back to the universal preview
  (returning inputRequired to a client that cannot elicit is a hard
  protocol error, never risk it).
- **Dedupe defaults**: person items check EVERY provided email
  (trim+lowercase before lookup; the filter itself is case-insensitive -
  evidence 10); first hit is the verdict. In-batch dedupe: a later item
  sharing any normalized email with an earlier item becomes
  `skipped_duplicate` (existingId filled after the earlier create).
  Companies: lookup pages up to 25 like-rows, local case-insensitive
  exact compare; the >25-prefix caveat is documented. A dedupe hit turns
  the item `skipped_duplicate` with `existingId` unless
  `allowDuplicate: true`.
- **Verification separates outcomes** (par. 5 amended accordingly in
  Task 6): `verifyApplied` returns
  `{unappliedFields, comparedFields, verified}` (see execution note 1 -
  `comparedFields` was added during the fix round);
  comparators are pinned: emails compare as sets case-insensitively after
  trim; phones compare digits-only (upstream may strip separators);
  numbers within 0.01; booleans normalized ("1"/"0"/true/false); task
  date compares the full normalized timestamp (date-only -> 00:00:00);
  deal budget compares sum(price*amount) to mapped value within 0.01;
  person companyId against mapped `companyId`; scalars trimmed-exact.
  A sent field with no comparator (a person's firstname/lastname) is
  compared by nothing, so `verification: "verified"` is never spoken
  about it.
- **WRITE_OUTCOME_UNKNOWN resolution is conservative**: creates - only
  when the plan-time exact-email lookup RAN and returned NULL and the
  item's email set is unique within the batch; a resolution hit whose id
  equals any known pre-existing id stays `unknown_outcome`. Updates - we
  own the id: re-read + verifyApplied, and the verdict is read over
  `comparedFields` alone: at least one compared field landed -> `ok` +
  `resolvedByReread` (partially -> plus unappliedFields); none landed,
  or nothing was comparable at all -> `unknown_outcome`. Notes/calls: no
  resolution (stay `unknown_outcome`).
- **log_activities verifies through walls**: after execution, ONE
  `getWall` per DISTINCT target record (bounded by the batch cap);
  a note is `verified` when its `wallItemId` (or, failing that, an entry
  of type "notatka" carrying the sent text) appears; a call when a
  "telefon" entry with the sent timestamp appears. Wall-read failure ->
  `verification: "unavailable"`, item stays `ok`.
- **Deal creation**: `companyId` XOR `contactId` (runner); optional
  `processId` (scalar `process_id` upstream - evidence 6) validated
  against the cached metadata processes section (unknown -> NOT_FOUND
  with the crm_metadata hint, fetchers untouched); budget lines eachs
  exactly one of `productId`/`productName`. Deal updates v1: `name`,
  `status` only.
- **Preview is data**: `WriteItemPlan {index, action, kind, status:
  "create" | "update" | "note" | "call" | "skipped_duplicate" | "blocked",
  summary, dedupe?: {existingId}, before?, error?}` - `blocked` carries a
  `ToolError` (e.g. NOT_FOUND target) and is skipped at execute.
- **isError rule**: true only when >= 1 item was ATTEMPTED and EVERY
  attempted item failed (`error`/`unknown_outcome`); an all-skipped batch
  is a success.

---

### Task 1: Person record arrays + write fetchers + verifier

**Files:**
- Modify: `src/livespace/records.ts` (PersonRecord + mapPerson gain
  `emails: string[]`, `phones: string[]` extracted from the stored
  `{value|number}` objects; STANDARD_OMITTED/minimal untouched - the new
  arrays ride the full record)
- Modify: `src/server/tools/record-schemas.ts` (person schema + get_records
  output schema accept the two arrays)
- Create: `src/livespace/writes.ts`
- Test: `tests/livespace/writes.test.ts`; extend
  `tests/livespace/records.test.ts` (mapper arrays) - check get_records
  tests still green (schema widened, not narrowed)

**Interfaces** (exact exports Tasks 2-5 rely on):
- `interface PersonWrite { firstname: string; lastname?: string; emails?: string[]; phones?: string[]; note?: string; companyId?: string }`
- `interface CompanyWrite { name: string; nip?: string }`
- `interface BudgetLineWrite { productId?: string; productName?: string; price: number; amount: number }`
- `interface DealWrite { name: string; companyId?: string; contactId?: string; processId?: string; budget?: BudgetLineWrite[] }`
- `interface TaskWrite { title: string; date?: string; description?: string }`
- `PersonUpdate/CompanyUpdate/DealUpdate/TaskUpdate` = id + optional
  fields as rev. 2 scopes them (deal: name/status; task: title, date,
  description, isCompleted).
- `interface WriteFetchers`:
  `createPerson/createCompany/createDeal/createTask`,
  `updatePerson/updateCompany/updateDeal/updateTask`,
  `addNote(kind: "person" | "company" | "deal", id, note, opts): Promise<{wallItemId: string | null}>`,
  `addCall(personId, {phone, direction, note?, date?}, opts): Promise<void>`,
  `findPersonByEmail(email, opts): Promise<{id, name} | null>` (normalizes
  trim+lowercase before the call),
  `findCompanyByName(name, opts): Promise<{id, name} | null>` (pages up to
  25 like-rows, local case-insensitive exact),
  `createWriteFetchers(client)`.
- `verifyApplied(kind: RecordKind, sent: Record<string, unknown>, reread: RecordDataMap[RecordKind] | null): { unappliedFields: string[]; verified: boolean }`

**Behavior:** payload mapping per evidence (string arrays; `company: {id}`
for person link; deal `company|contact: {id}` + scalar `process_id` +
budget key mapping; task scalar `date`; NO `_wall` anywhere); note routing
person -> `addContactNote {contact}`, company -> `addCompanyNote
{company}` (evidence 15), deal -> `addDealNote {deal}`; every write
`{write: true, signal}`; find* are reads (no flag); creates parse the
echoed id (missing -> unexpectedShape); comparators exactly as the design
decision lists them; null reread -> `{unappliedFields: [], verified: false}`.

**Steps:**
- [ ] Failing tests (recording fakes, toStrictEqual on full calls):
  1. mapper: raw person with `emails: [{value: "A@b.c"}]`,
     `phones: [{number: "+48 1"}]` maps to `emails: ["A@b.c"]`,
     `phones: ["+48 1"]`; absent -> `[]`; get_records person schema
     parses a full record with the arrays.
  2. createPerson full payload incl. `company: {id}` when companyId set,
     string arrays, NO `_wall` key anywhere, `{write: true}`.
  3. createDeal: XOR link shapes; `process_id` scalar present only when
     given; budget maps productId -> product_id, productName ->
     product_name.
  4. createTask: scalar `date` passthrough for both datetime and
     date-only forms; never emits date_from.
  5. updates: only provided fields + id; isCompleted -> "1"/"0".
  6. addNote routing: person -> addContactNote {contact}, company ->
     addCompanyNote {company} (verbatim endpoint pin), deal ->
     addDealNote {deal}; wallItemId from echo, null when absent.
  7. addCall mapping with date; direction both values.
  8. behavioral write-flag table: EVERY WriteFetchers method invoked
     against the fake; write methods recorded `opts.write === true`;
     findPersonByEmail/findCompanyByName recorded `opts.write !== true`.
  9. findPersonByEmail: normalizes case+trim before calling; `limit: 2`;
     0 rows -> null.
  10. findCompanyByName: exact match found on a like-page ROW 12 of 25
      (ordering-independence); different-name like-hit -> null.
  11. verifyApplied: emails case-insensitive set (sent
      "Jan@Synthetic.example" vs stored "jan@synthetic.example" -> no
      unapplied); phones digits-only ("+48 123 456 789" vs
      "+48123456789" -> no unapplied); dropped email -> ["emails"];
      budget sum 2x33.33*3 vs stored 199.98 within tolerance... (pin the
      exact fixture: lines summing 99.99 vs stored 99.99); boolean
      isCompleted true vs mapped true from "1"; task date-only sent
      "2026-09-26" vs stored dateFrom "2026-09-26 00:00:00" -> no
      unapplied; null reread -> `{unappliedFields: [], verified: false}`;
      sent note dropped -> `{["note"], verified: true}`.
  12. creates reject on id-less echo; signal forwarded everywhere.
- [ ] Implement; full suite + typecheck green.
- [ ] Commit: `feat: write fetchers, person contact arrays, applied-field verifier`

### Task 2: Write-support layer

**Files:**
- Create: `src/server/tools/write-support.ts`
- Modify: `src/config/server-env.ts` (`MCP_REQUEST_STATE_KEY` optional
  string >= 32 chars when present; startup RULE: absent AND (authToken
  set OR non-loopback bind) -> config error, fail-closed)
- Test: `tests/server/write-support.test.ts`; extend
  `tests/config/server-env.test.ts` (or the existing config test file -
  locate it) with the key rules

**Interfaces** (Tasks 3-5 rely on):
- `WRITE_BATCH_CAP = 10`, `ACTIVITY_BATCH_CAP = 15`, `WRITE_BUDGET_MS = 45_000`
- `hashArgs(value: unknown): Promise<string>` - SHA-256 hex over
  canonical JSON (sorted keys, arrays in order); the TOOLS hash only the
  item arrays (confirm/dryRun stripped) - pinned by tests.
- `interface WriteState { tool: string; argsHash: string; previewDigest: string; jti: string }`
- `buildWriteCodec(config): RequestStateCodec<WriteState>` -
  `ttlSeconds: 300`, `bind: ctx => method + "\0" + (principal ?? "")`.
- `clientSupportsElicitation(ctx: unknown): boolean` - exactly as the
  design decision specifies (literal `CLIENT_CAPABILITIES_META_KEY` read,
  form-mode rule).
- `readElicitedConfirm(ctx: unknown): boolean | undefined` - the
  `acceptedContent` wrapper.
- `consumeJti(jti: string): boolean` - false when already consumed;
  bounded FIFO 512 (module scope).
- `type ConfirmDecision = { mode: "preview" | "input-required" | "execute" | "declined" } | ToolError`
- `decideConfirm(opts)` per the state machine (all six rules).
- `interface WriteItemPlan { index: number; action: string; kind: string; status: "create" | "update" | "note" | "call" | "skipped_duplicate" | "blocked"; summary: Record<string, unknown>; dedupe?: { existingId: string }; before?: Record<string, unknown>; error?: ToolError }`
- `interface ItemResult { index: number; action: string; kind: string; status: "ok" | "skipped_duplicate" | "error" | "unknown_outcome" | "not_attempted"; id?: string; existingId?: string; resolvedByReread?: boolean; verification?: "verified" | "unavailable"; unappliedFields?: string[]; before?: Record<string, unknown>; after?: Record<string, unknown>; error?: ToolError }`
- `executePlan(deps, items: ExecutableItem[], opts: {signal?, deadlineAt: number}): Promise<ItemResult[]>`

**Behavior:** execution sequential in order; between items check (in this
order) abort signal (-> stderr audit line + throw cancelledError), then
deadline (-> remaining `not_attempted`); RATE_LIMITED -> item `error`,
remaining `not_attempted`; write-then-verify per the Global Constraint
(re-read wrapped in try/catch; failure -> `verification: "unavailable"`,
status stays ok); unknown-outcome resolution per the design decision
(creates guarded, updates by re-read); `skipped_duplicate`/`blocked`
never write.

**Steps:**
- [ ] Failing tests:
  1. decideConfirm FULL matrix, one test per row: dryRun+confirm;
     dryRun+state; state tool-mismatch; state hash-mismatch; state jti
     consumed; state + elicitedConfirm undefined / false -> declined
     (never execute); state + elicitedConfirm true -> execute;
     no-state + elicitation-capable + confirm true -> input-required
     (model cannot self-confirm); no-state + elicitation-capable +
     confirm absent -> input-required; no-state + no-elicitation +
     confirm -> execute; plain call -> preview.
  2. hashArgs: stable under key order; array order matters; strips
     nothing itself (the caller strips confirm/dryRun - pinned in Task 3).
  3. capability probe: TRUE for `{elicitation: {}}` and
     `{elicitation: {form: {}}}` (literal meta key string in the
     fixture); FALSE for url-only `{elicitation: {url: {}}}`, missing
     envelope, empty caps, undefined ctx.
  4. jti: first consume true, second false; 513th insert evicts the
     oldest (evicted jti consumable again - documented bound).
  5. executePlan: create ok path (write -> re-read -> verified, after
     present); re-read THROWS -> status ok + verification unavailable +
     no unappliedFields; re-read null -> same.
  6. duplicate/blocked items never write; order preserved.
  7. error isolation; RATE_LIMITED stops the batch (item 3 not_attempted,
     zero further write calls).
  8. deadline: items after expiry -> not_attempted (Date.now stub, M5
     clock-stub recipe).
  9. abort between items: items 3..N zero calls, stderr line matches
     `/^write batch cancelled after 2 applied item\(s\): ids=\[/`, then
     rejects CANCELLED; pre-aborted -> rejects before any write.
  10. unknown-outcome: create resolved only under the guard (three
      negative cases: lookup never ran, lookup had hit, email shared in
      batch); update resolver full/partial/none matrix.
  11. codec: mint->verify round-trip; tamper -> throws; key A vs key B;
      expired (ttl stub) -> throws.
  12. config: key < 32 chars -> error; absent + authToken -> error;
      absent + non-loopback -> error; absent + loopback dev -> ok.
- [ ] Implement; suite + typecheck green.
- [ ] Commit: `feat: write-support with confirm state machine and budgets`

### Task 3: `create_records`

**Files:**
- Create: `src/server/tools/create-records.ts`
- Test: `tests/server/create-records.test.ts`

**Input schema** (caps `.max(10)` per array; total <= 10 in the runner):
person item `{firstname 1..200, lastname? ..200, emails? string[3..320]
max 5, phones? string[3..40] max 5, note? ..5000, companyId? 1..64,
allowDuplicate?}`; company `{name 1..300, nip? ..20, allowDuplicate?}`;
deal `{name 1..300, companyId?, contactId?, processId? 1..64, budget?
max 20 lines {productId? 1..64, productName? 1..300, price finite,
amount > 0 <= 100000}}`; task `{title 1..300, date? regex
`^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$`, description? ..5000}`;
plus `dryRun?`, `confirm?`.

**Runner rules** (BAD_PARAMS unless noted): >= 1 item; total <= 10; deal
XOR link; budget line XOR product key; task date calendar-valid
(isCalendarDate on the date part, year 1900-2100) normalized (date-only ->
"00:00:00", minutes -> ":00"); `processId` validated against the cached
metadata processes section when present (unknown -> NOT_FOUND with the
crm_metadata hint, nothing fetched beyond metadata); argsHash =
`hashArgs({persons, companies, deals, tasks})` (confirm/dryRun stripped -
pinned); dedupe per design (every email, in-batch, companies);
`decideConfirm` drives preview / input-required / declined / execute.
- Preview structured: `{plan, requiresConfirmation?: true, declined?:
  true, errors: []}`; text
  `create_records preview: N item(s) (P persons, C companies, D deals, T tasks), K duplicate(s) skipped. Re-call with confirm: true to execute.`
  / declined adds `Confirmation was declined; nothing was written.`
- Elicitation message (fixed, counts only):
  `Create N CRM record(s) (P persons, C companies, D deals, T tasks). K duplicate(s) will be skipped. Approve?`
- Execute: ExecutableItems in declaration order; answer `{results, counts:
  {ok, skippedDuplicate, error, unknownOutcome, notAttempted}}`; text
  `create_records: attempted A of N - ok O, skipped K, errors E, unknown U, not attempted M.`;
  isError per the attempted-rule.
- Output schema: ONE strictObject; optional `plan`, optional
  `results`+`counts`, optional flags; `errors` required. InputRequired
  results are SDK-shaped and not schema-validated - the plan/preview/
  execute/failure structured payloads all safeParse (direct assertions).

**Steps:**
- [ ] Failing tests: schema matrix (root object, strict, 10-cap boundary
  + 11th rejected at schema, item bounds, date regex forms); runner
  matrix (total 6+5 across kinds -> BAD_PARAMS; XOR violations both
  ways; bad calendar date; unknown processId -> NOT_FOUND, metadata
  consulted, zero write-fetcher calls); dedupe (multi-email item - fake
  find hit on the SECOND email -> skipped; in-batch same-email pair ->
  second skipped with existingId after first executes; allowDuplicate
  bypass); argsHash strips confirm/dryRun (two calls differing only
  there produce the same minted state - fake codec records payloads);
  decideConfirm wiring incl. declined path (fixed line, no writes) and
  self-confirm override on elicitation-capable ctx; elicitation message
  char-exact vs a marker-name fixture (marker absent); execute path
  order + counts + text; digest mismatch at execute-with-state (fake
  find changes between rounds) -> no writes, fresh preview; 420-marker
  regression (fake rejects with LivespaceError VALIDATION_ERROR whose
  message field is OUR fixed wording; assert a marker string from a
  simulated envelope body never reaches structured/text - construct via
  the client's own error mapping); output-schema safeParse per variant
  (preview, declined, execute mixed statuses incl. not_attempted,
  failure) + unknown-key rejection; text purity with marker names;
  CANCELLED.
- [ ] Implement; suite + typecheck green.
- [ ] Commit: `feat: create_records with dedupe and confirm flow`

### Task 4: `update_records`

**Files:**
- Create: `src/server/tools/update-records.ts`
- Test: `tests/server/update-records.test.ts`

**Input schema**: persons `{id, firstname?, lastname?, emails?, phones?,
note?, companyId?}`, companies `{id, name?, nip?}`, deals `{id, name?,
status? enum}`, tasks `{id, title?, date?, description?, isCompleted?}`;
same bounds as Task 3; caps 10; dryRun/confirm.

**Runner rules:** >= 1 field beside id per item; same id twice in one
kind -> BAD_PARAMS (ambiguity -> nothing - par. 5); task date
calendar-valid + normalized (the M5 defect class - explicit rule); PLAN
reads every target via `getRecord` (missing -> plan item `blocked` +
NOT_FOUND, skipped at execute; before-values captured for sent fields +
id + name); flow via decideConfirm; elicitation message
`Update N CRM record(s) (P persons, C companies, D deals, T tasks). Approve?`;
execute -> update, re-read, verifyApplied; after limited to sent fields.

**Steps:**
- [ ] Failing tests (named, mirror Task 3's specificity): schema matrix
  (caps boundary, per-kind shapes, status enum, date regex); no-op item
  -> BAD_PARAMS; duplicate id in kind -> BAD_PARAMS; duplicate id across
  kinds allowed (person + deal can share nothing - ids are per-kind);
  bad calendar date on task update -> BAD_PARAMS; plan phase: getRecord
  per target, blocked NOT_FOUND item visible in preview and skipped at
  execute (fake asserts zero update calls for it), before-values only
  for sent fields; preview/declined/input-required wiring (shared
  machinery - two smoke rows of the matrix, not all); execute: won
  transition sends status "won"; isCompleted false -> "0"; re-read diff
  -> after + unappliedFields propagate; verification unavailable path;
  output-schema safeParse (preview with blocked item, execute mixed,
  failure); elicitation message char-exact; text purity; 420 marker;
  CANCELLED.
- [ ] Implement; suite + typecheck green.
- [ ] Commit: `feat: update_records with before-after verification`

### Task 5: `log_activities`

**Files:**
- Create: `src/server/tools/log-activities.ts`
- Test: `tests/server/log-activities.test.ts`

**Input schema**: notes `[{kind enum person/company/deal, id 1..64, note
1..5000}]` max 15; calls `[{personId 1..64, phone 3..40, direction enum,
note? ..5000, date? datetime regex}]` max 15; total <= 15; dryRun/confirm.

**Runner rules:** call date calendar-valid + normalized; flow via
decideConfirm; elicitation message
`Log N activit(y/ies) (X notes, Y calls). Approve?`; execute per item;
after execution ONE getWall per distinct target record; notes verified by
wallItemId (fallback: type "notatka" + sent text present), calls by type
"telefon" + sent timestamp; wall failure -> verification unavailable.

**Steps:**
- [ ] Failing tests (named): schema matrix (15-cap, enums, phone bounds,
  date regex); routing pins (person -> addContactNote, company ->
  addCompanyNote - endpoint strings asserted verbatim, deal ->
  addDealNote); call mapping incl. date; per-item error isolation;
  wall verification: grouped getWall called ONCE for two notes on the
  same record; wallItemId match -> verified; wall read throws ->
  ok + unavailable; missing wallItemId + text fallback path; preview/
  declined/execute wiring rows; public-only wording pinned in the
  description test; output-schema safeParse per variant; elicitation
  message char-exact; text purity; 420 marker; CANCELLED.
- [ ] Implement; suite + typecheck green.
- [ ] Commit: `feat: log_activities for notes and calls`

### Task 6: Registration, gating, requestState wiring, docs

**Files:**
- Modify: `src/server/mcp.ts`, `src/server/app.ts`, `src/index.ts`
- Modify: `src/server/instructions.ts` (writes section ONLY when
  `!readOnly`; read-only keeps the standalone disabled-note)
- Modify: `docs/security.md` (par. 5 amendments: dedupe bullet ->
  read-based exact lookup wording + the `__check_if_exists` probe fact;
  re-read bullet -> "re-reads and reports before -> after; when the
  follow-up read itself fails the item reports verification:
  unavailable instead of masking an applied write")
- Modify: `.env.example`, `README.md` (MCP_REQUEST_STATE_KEY line each)
- Modify: `tests/server/modern-wire.test.ts` (annotations sweep 6 -> 9
  with write deps present; tools/list order; read-only stays 6; extend
  the `meta()` helper to accept clientCapabilities overrides)
- Test: `tests/server/write-registration.test.ts`; extend
  `tests/server/instructions.test.ts`

**Behavior:** `AppDeps.writes?`; index.ts builds writes only when
`!readOnly`; factory registers the three tools when
`!config.readOnly && writes && records && metadata` (deal processId
validation needs metadata); write handlers may return InputRequiredResult
- passthrough via `isInputRequiredResult` (dual-channel wrapping only for
ToolRunResult); `requestState: {verify: codec.verify}` wired into the
McpServer options (verify the exact SDK seam name in code and record it
in the execution notes).

**Steps:**
- [ ] Failing tests:
  1. tools/list: 9 tools exact order with writes; 6 in read-only; 6 when
     `writes` absent; write tools carry their annotations (destructive
     only on update_records).
  2. read-only direct calls: tools/call each write tool -> refused, fake
     write fetchers never called.
  3. end-to-end preview: tools/call create_records (no confirm, no
     elicitation caps) -> structured plan + requiresConfirmation.
  4. end-to-end MRTR two rounds: round 1 with elicitation-capable meta ->
     input_required result (assert `isInputRequiredResult` shape on the
     wire, requestState present, elicitation message char-exact); round 2
     re-post with `requestState` + inputResponses accept
     `{confirm: true}` -> fakes record exactly one write per item;
     decline round 2 -> zero writes + declined preview; accepted
     `{confirm: false}` -> zero writes; tampered state -> the SDK's
     frozen -32602; replayed (same jti) second round 2 -> BAD_PARAMS,
     zero writes.
  5. instructions: read-only contains NONE of the three tool names;
     normal contains all three + confirm/dryRun + public-only notes +
     no-delete lines; stale "Write tools arrive in a later milestone."
     gone.
  6. cache regression regex over writes.ts, write-support.ts and the
     three tool modules.
  7. security.md amendments present (string assertions on the new
     wording, old wording absent).
- [ ] Implement; full suite + typecheck + `bun audit` green.
- [ ] Commit: `feat: register write tools behind read-only gate`

---

## Done gate (orchestrator, not a task)

- Full suite + typecheck + audit green; read-only smoke (env flag) -> 6
  tools and refused write calls.
- Live smoke on the sandbox (port 3021, real MCP client, SYNTHETIC names,
  ledger file of every created id, raw-delete cleanup at the end with
  per-id success reporting; a failed cleanup is a FAILED smoke):
  1. preview (no confirm) -> plan visible; PAIRED negative+positive
     control: exact-email query returns 0 rows now, and 1 row after the
     confirmed create (proves the query sees what it claims absent);
  2. confirmed create batch (<= 10): person with emails+phones+company
     link (re-read verification: verified, no unapplied), company, deal
     with processId + productName budget line (value = sum upstream),
     task with date-only (visible in a datesPeriod window);
  3. duplicate person (same email, case-flipped) -> skipped_duplicate
     with existingId; allowDuplicate -> created (then cleaned);
  4. update_records: firstname (before/after; no comparator exists for
     it, so that item reports verification "unavailable" with the
     VERIFICATION_UNCHECKED advisory - see execution note 1), deal -> won
     (status_change_date stamped), task isCompleted; empty
     unappliedFields on the two verifiable items;
  5. log_activities: note on the deal + company note + outgoing call with
     date -> wall entries verified (types notatka/telefon), verification
     "verified";
  6. dryRun -> 0 rows via the paired-control query;
  7. bogus deal companyId -> that item errors, siblings succeed;
  8. no CRM name in any text channel; per-call wall clock recorded (all
     under 60 s; batch sizes at the cap).
- Execution notes appended to this doc.

---

## Execution notes

Found by the adversarial verification round after Task 8 and fixed on the
same branch. Each note names what the plan said, what the code did, and
what changed.

1. **Verification claimed what it never compared.** `verifyApplied`
   answered `{unappliedFields: [], verified: true}` for any successful
   re-read, including one where every sent field was skipped for lack of
   a comparator - a person update naming only `firstname` is the case by
   design. Two things followed: a WRITE_OUTCOME_UNKNOWN person update
   that never landed resolved to `ok` + `resolvedByReread` +
   `verification: "verified"` with an identical before/after pair, and
   the ordinary applied path stamped "verified" on the same vacuous
   comparison. The verdict now carries `comparedFields`; the
   unknown-outcome resolver is decided by those fields alone (zero of
   them is zero evidence, and an uncheckable field can no longer pad the
   count past a compared field that missed); and an applied write with
   nothing comparable reports `verification: "unavailable"` with a
   second advisory, `VERIFICATION_UNCHECKED` - the existing
   VERIFICATION_UNAVAILABLE says "the follow-up read did not answer",
   which is false when the read answered and had nothing to compare.
