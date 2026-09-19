# Agent guidance and host compatibility

## Problem and scope

The five write descriptions and their preview results still suggest that a
client without form elicitation can execute with `confirm: true`. Since
0.1.1 the default runtime refuses that path. Empty searches also lack the
recovery guidance promised in the original design. Finally, wire tests alone
cannot prove that a real host passes structured results to its model or
handles human confirmation.

Keep the existing read-only default, signed approval state, compatibility
flag and separation of CRM data from text summaries. No API, dependency,
version, release or credential changes.

## Implementation

1. Test the five public descriptions and preview messages against the safe
   confirmation contract before changing them. Keep the existing runtime
   tests for signed approval, rejection, replay and compatibility mode.
2. Add shared fixed wording in `src/server/tools/write-support.ts` and use
   it from `create-records.ts`, `update-records.ts`, `log-activities.ts`,
   `move-deals-to-stage.ts` and `notify-user.ts`:
   - `dryRun: true` always previews;
   - form-capable clients request human approval on a non-dry-run call;
   - other clients preview, and `confirm: true` is refused by default;
   - only an operator-enabled unsafe compatibility mode permits unbound
     confirmation. The tool must not recommend turning it on.
3. Add an optional `hint: string` to each successful `search_crm` kind
   envelope and the `get_activity` output. Include the same fixed wording
   in the text summary. Do not echo search text, IDs or CRM strings.
   - Prefer a returned cursor when an empty page has another page.
   - A phrase search suggests a word prefix of at least two characters.
   - A filtered search suggests checking IDs through `crm_metadata` and
     changing filters only when appropriate to the user's request.
   - An activity type filter applies to one page, not the whole source.
   - Failed calls stay errors; nonempty calls do not get empty-result hints.
   - Do not broaden filters or make additional upstream calls automatically.
4. Update `src/server/instructions.ts` with the hint contract. Add focused
   tests in `tests/server/tools/search-crm.test.ts`, `get-activity.test.ts`
   and the write registration/runner suites, including schema validation.
5. Add `scripts/host-check.ts`: an explicitly synthetic loopback instance of
   the real app with an in-memory record backend and no Livespace client.
   A random per-run value appears only in structured record data. Use a
   real CLI host to retrieve it, preview a synthetic write, and attempt the
   normal confirmation flow. Record protocol/capability observations and
   in-memory write counts only. Never treat an automated SDK acceptance as
   proof of real human approval in a host.
6. Document the tested host/version, results and reproducible steps in
   `docs/host-compatibility.md`, linked from README. Unsupported or
   noninteractive confirmation must remain safely blocked and be reported
   as a limitation. Do not weaken confirmation to make a host test pass.

## Validation

- Run the focused tests first and observe the new failures.
- Run focused tests after implementation, then `bun test` and
  `bun run typecheck`; inspect `git diff --check`.
- Run the real-host synthetic check without changing persistent host config.
- Run a bounded read-only smoke on the configured Livespace sandbox; keep
  credentials in memory and print only check results. No live CRM writes.
- Record evidence and limits below. Do not commit or publish.

## Execution notes

- Updated all five write descriptions, their `confirm` parameter descriptions,
  previews and the contradictory `dryRun`/`confirm` recovery hint. The runtime
  authorization rules are unchanged. Tests first failed on the stale wording.
- Added optional, fixed-wording empty-result hints to both read tools and
  their text summaries. Paging takes priority over changing filters; no extra
  upstream calls or CRM-string echoes were introduced.
- Added the synthetic host fixture and two contract tests proving that its
  random marker stays out of text results and that previews/unbound attempts
  leave its write count at zero.
- `bun test`: 1146 pass, 0 fail across 43 files. `bun run typecheck` and
  `git diff --check` pass. The first full run hit the sandbox's temporary-file
  restriction in the offline package installation; the package tests and
  final full suite passed with that filesystem restriction lifted.
- Real Codex CLI 0.154.0 read the structured-only marker in both its default
  2025-06-18 protocol path and the process-local `mcp_2026_07_28` feature path.
  Default mode refused unbound confirmation. The newer path completed signed
  confirmation with a decline in noninteractive mode. Both left zero
  in-memory writes. Interactive human acceptance remains unverified; the
  exact scope and repeatable procedure are in `docs/host-compatibility.md`.
- Live sandbox smoke passed for empty `search_crm` and `get_activity` output,
  including schema validation and hints. Reads were bounded to one record per
  request. The temporary smoke harness initially checked the wrong envelope
  path; it was corrected before the successful run. No CRM writes or real
  payloads were persisted. Credentials stayed in memory from macOS Keychain.
- The fixture was stopped. The implementation did not change persistent host
  configuration, dependencies or package version. No release was created.
