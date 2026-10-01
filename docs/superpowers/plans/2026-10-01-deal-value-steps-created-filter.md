# Deal value source, checked steps, status reasons and a created-date filter

Status: implemented and verified locally (tests and read-only sandbox check);
not committed.
Base: `22ccc0e795f7a90b847aa3b07c5adf18678b364d` (branch
`fix/deal-value-steps-created-filter`).

## Problem

A read-only review of a second account found four gaps in the deal reads:

1. `value` is 0 on every deal there, while the value shown in the UI arrives in
   `value_final`. `search_crm`, `get_records` and `analyze` (`pipeline_summary`,
   `forecast_vs_realization`) therefore report zero everywhere on such an
   account.
2. `substages` (the process steps marked done) are not exposed, so a
   process-discipline review cannot see which steps were checked.
3. `search_crm` filters deals by modification date only.
4. Won, lost and outdated reasons are not exposed.

No data from that account enters this repository. Every fixture below is
synthetic.

## Verified inputs (sandbox probes, 2026-10-01, read-only)

- `Deal/getAll` (list mode) and `Deal/get` both return `value` (number),
  `value_final` (string or null), `substages`, `substages_all`, `stages_all`
  and, when set, `won_reason_name`/`won_reason_note`/`lost_reason_name`/
  `lost_reason_note`. List mode needs no extra call for any field below.
- On the sandbox, which uses budget lines, `value` is non-zero on every deal
  and `value_final` is `"0.00"` or `null`. It is never non-zero.
  The second account shows the mirror image: `value: 0`, non-zero
  `value_final`. The API PDF says a deal's `price` is "optional if products are
  switched off", which matches two value modes per account.
  Consequence: "prefer `value_final`" alone would zero every sandbox deal. The
  rule is: a non-zero `value_final` wins, otherwise `value`, otherwise a zero
  `value_final`, otherwise null.
- `substages` maps stage id -> `{stepId: stepName}` of CHECKED steps; a stage
  with none is `[]` (PHP empty map). `substages_all` has the same shape with
  every step. `stages_all` maps stage id -> stage name. Key order follows the
  process order.
- Reasons: list mode carried `lost_reason_name` on every lost deal and on a
  few open (reopened) deals; notes were empty strings. `Deal/get` carries the same
  keys. No outdated deals exist on the sandbox, so `outdated_reason_*` is
  mapped from the field names observed on the second account but is not
  sandbox-verified.
- `Deal/getAll` honors a NESTED `created` condition, unlike the flat
  `created_from` recorded as ignored in `2026-08-06-m5-analyze.md`:
  - `created: "D"` and `created: {from: "D"}` return deals created on or after
    D (inclusive).
  - `created: {to: "D"}` excludes deals created on D itself (D means D 00:00).
    `{from: "D 00:00:00", to: "D 23:59:59"}` returns exactly the deals of day
    D.
  - `created: {from: "not-a-date"}` is silently ignored and returns the
    unfiltered list. Dates must be validated before the call.
  - `status: "all"` combines with `created` (open, won and lost rows).

## Design

### 1. Deal value (`src/livespace/records.ts`)

```ts
function dealValue(data: Record<string, unknown>): number | null {
  const final = parseCommaDecimal(data["value_final"]);
  if (final !== null && final !== 0) return final;
  return parseCommaDecimal(data["value"]) ?? final;
}
```

`mapDeal` uses it for `value`. Every consumer (search sort, projections,
`analyze` sums and weighted forecast, the budget write verifier) reads the
mapped `value`, so one change covers them. The budget verifier keeps working on
budget-line accounts because `value_final` is zero there.

### 2. Checked steps and reasons (full detail only)

New `DealRecord` fields:

```ts
export interface CheckedStep {
  stageId: string;
  stageName: string;
  stepId: string;
  name: string;
}
checkedSteps: CheckedStep[];
wonReasonName: string;
wonReasonNote: string;
lostReasonName: string;
lostReasonNote: string;
outdatedReasonName: string;
outdatedReasonNote: string;
```

`checkedSteps` flattens `substages` in process order: stages as `stages_all`
lists them, steps as `substages_all` lists them, the same sources the
stage-move reader orders by. Step maps are read with the stage-move reader's
`stepIds` (moved to `shape.ts`), which also accepts a bare list of ids.
Checked stages or steps those lists do not name are reported after the rest.
`stageName` comes from `stages_all` ("" when absent); a step name comes from
the checked map, then from `substages_all`. Malformed levels are skipped
(PHP serializes empty maps as `[]` at every level). All seven keys join `STANDARD_OMITTED.deal`, so they
appear only at `detail: "full"` in both `get_records` and `search_crm`.
`dealSchema` mirrors them. Reason notes are CRM text and stay in
`structuredContent` only.

### 3. `createdFrom` / `createdTo` deal filters (`search_crm`)

- Input: `filters.createdFrom` and `filters.createdTo`, each
  `YYYY-MM-DD` (schema regex), inclusive, deals only.
- Runner rules (BAD_PARAMS with a hint, no fetch): each must be a real
  calendar date within 1900-01-01..2100-12-31, and `createdFrom <= createdTo`.
  Without this, upstream would silently ignore a bad date.
- `DealListOptions` gains `createdFrom`/`createdTo`; `listDeals` sends
  `created: {from: createdFrom}` and/or `to: "<createdTo> 23:59:59"`.
- The deal-only filter list and its hint include both keys.

## Tests (red first)

`tests/livespace/records.test.ts`:
- value table: non-zero `value_final` beats `value` (string with dot decimals,
  comma decimals); `value_final` `"0.00"`/null falls back to `value`; zero
  `value_final` fills in for absent `value`; both absent -> null; unparseable
  `value_final` falls back.
- `checkedSteps` mapping, stage names, `[]` stages, non-object junk, absent.
- reasons mapped; absent -> "".
- `DEAL_RAW`/`DEAL`/`DEAL_EMPTY` gain the new keys; standard omits them;
  full matches the schema key set (existing test).
- fetcher call table: `listDeals` with `createdFrom`+`createdTo`, and each one
  alone.
- list fetcher: a deal row with `value: 0` and non-zero `value_final` maps to
  the final value.

`tests/server/tools/search-crm.test.ts`:
- created filters forwarded; deal-only rule covers them; invalid calendar
  date, out-of-range date and reversed range return BAD_PARAMS without a fetch.

`tests/server/tools/get-records.test.ts` / `tests/support/records.ts`:
- builder gains the new keys; full deal output carries `checkedSteps`, standard
  does not.

## Live check (sandbox, read-only)

Run the server read-only against the sandbox and call: `search_crm` deals with
`createdFrom`/`createdTo` (count matches a local filter), `get_records` deal
full (non-empty `checkedSteps`, reasons on a lost deal), `analyze
pipeline_summary` (non-zero sums unchanged on the budget-line sandbox).

## Execution notes

- Every test was written first and seen failing for the expected reason:
  value cases (5 red: `value_final` ignored), checked steps/reasons (9 red:
  fields and schema keys missing), created filters (9 red: params and rules
  missing), description/instruction/README contracts (4 red).
- `tests/server/tools/get-records.test.ts` builds the standard deal
  projection by hand; its helper now deletes the seven new full-only keys.
- `isCalendarDate` is a fifth local copy, following the existing per-tool
  idiom (analyze, create/update records, log activities). Extracting a shared
  helper is a separate refactor.
- Gates after review fixes: 1200 tests, 971 security tests, typecheck and
  `git diff --check` pass. `bun audit` fails with 18 advisories (hono, fast-uri, ip-address,
  undici) published after the last green CI; `package.json` and `bun.lock`
  are unchanged here, so the fix belongs in a separate dependency update.
- Live check on the sandbox, read-only, through the running server
  (MCP 2026-07-28 requests, six read tools listed):
  - `createdFrom`/`createdTo` over a quarter, `status: "all"`: the count
    equals a local filter over the raw `Deal/getAll` pages.
  - A single day as both bounds returned exactly that day's deals; `createdTo`
    alone matched the local "on or before" count. An invalid calendar date
    returned BAD_PARAMS without an upstream call.
  - `search_crm` at full detail (one page of deals): every `value` equals
    the raw `value`, every `checkedSteps` list equals the raw `substages`
    steps in `stages_all`/`substages_all` order, and some deals have checked
    steps.
  - `get_records` full: lost and won reasons equal the raw names, checked
    steps carry resolved stage names, standard omits the new keys, and the
    text channel contains no reason text.
  - `analyze pipeline_summary`: untruncated, one currency, zero missing
    values, sum equal to the raw `value` sum of open deals. The budget-line
    sandbox is unchanged by the new value rule.
- Not verified live: an account where `value_final` is non-zero (only the
  second account has that shape and it is production) and `outdated_reason_*`
  (no outdated deals on the sandbox).
- Independent review (one Opus reviewer, read-only) found no blocking bug.
  Applied: `checkedSteps` now shares `stepIds` and process ordering with the
  stage-move reader (two tools no longer disagree on one deal); tests with
  descending ids pin the order; new tests pin the month-13 NaN guard, the
  1900 lower bound and an accepted single-day range, each confirmed by
  mutating the code and watching the test fail; the `createdFrom` description
  and the tool description say to pass `status: "all"` for a creation cohort,
  because filter mode defaults to open deals.
- Kept on purpose: when both `value` and `value_final` are non-zero,
  `value_final` wins, as the maintainer's request specified. No probed deal
  has both, so this is a chosen precedence, not observed behaviour. The
  reviewer's alternative (non-zero `value` first) gives the same result on
  both probed accounts and would keep the budget write verifier exact on a
  mixed deal. Revisit if a mixed deal turns up.
- Kept on purpose: the BAD_PARAMS message stays "cannot be combined" for a
  bad date, matching `analyze`; the hint carries the specific fix.
- Follow-up candidate: `modifiedFrom` is still a free string; upstream
  probably ignores an unreadable date there too.
