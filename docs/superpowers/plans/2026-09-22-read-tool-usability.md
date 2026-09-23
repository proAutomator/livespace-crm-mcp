# Read-tool usability from the official MCP comparison

Status: implemented and verified locally after Fable 5.1 max plan review.
Base: `877df79ceca0ffc48419df39544ca629ea8121b6`.

## Goal and boundaries

Make record links available in lightweight results, reject unsupported tool
arguments, resolve CRM users without returning the whole dictionary, and stop
describing every absent upstream value as an empty CRM field.

Keep the existing tools, authentication, write controls, API endpoints, cache
lifetime, pagination and dependency versions. OAuth and global note search
need separate design and API work. The initial implementation excluded commit,
push and release; a separate maintainer request on September 23 authorizes
commit and push of these changes.
All tests use synthetic records; live validation is read-only on the existing
test account. A second account with a restricted role is not available, so
field-level permission semantics remain unverified.

## Verified inputs

- `Search/getResult` supports persons, companies and deals. The M4 execution
  notes record successful phrase-hit ID -> get-record checks for all three.
- The existing `recordUrl` uses `/details/api_id/<encoded API ID>` routes,
  observed in real record URL fields. It does not use the numeric UI ID route.
- `createRecordFetchers` has three call sites: production `src/index.ts`,
  `tests/livespace/records.test.ts`, and the real-fetcher search tool tests.
- `SearchHit` has no URL; standard/full records already have one. Minimal
  projections omit it. Tasks have no verified URL and stay unchanged.
- The local Zod schemas for health and crm_metadata accept and strip unknown
  keys. The other nine tool input roots use `z.strictObject`.
- Metadata users are fetched through the existing TTL cache. The tool caps
  returned dictionary rows at 500; it can filter the cached list before that
  cap without a new endpoint or per-user request.
- `asName` maps non-strings, including null and undefined, to an empty string.
  Some descriptions currently claim such values prove the CRM field is empty.
  Official MCP's null semantics do not establish old API's semantics.

## 1. Record links

Files:
- Add `src/livespace/record-links.ts`.
- Edit `src/livespace/writes.ts`, `src/livespace/records.ts`, `src/index.ts`,
  `src/server/tools/search-crm.ts`.
- Test `tests/livespace/records.test.ts`, `tests/livespace/writes.test.ts`,
  `tests/server/tools/search-crm.test.ts`, `tests/server/tools/get-records.test.ts`
  and the hardcoded search-hit fixture in `tests/server/modern-wire.test.ts`.

Move the existing pure helper and type into a module that imports neither
records nor writes. Re-export them from writes so existing users and tests
retain the same import. Keep the verified routes and ID encoding:

```ts
export type LinkableKind = "person" | "company" | "deal";
const RECORD_URL_PATHS: Record<LinkableKind, string> = {
  person: "Contact/contact/details/api_id",
  company: "Contact/company/details/api_id",
  deal: "Deal/deal/details/api_id",
};
export function recordUrl(subdomain: string, kind: LinkableKind, id: string): string {
  return `https://${subdomain}.livespace.io/${RECORD_URL_PATHS[kind]}/${encodeURIComponent(id)}`;
}
```

Require the configured subdomain as the second `createRecordFetchers` argument.
Production supplies `livespaceConfig.subdomain`, already validated at startup;
unit tests supply `synthetic-demo`. Add `url: string` to SearchHit and its output
schema. Build it for mapped phrase hits from the requested kind and returned
API ID. Do not fetch a record to obtain its URL and do not guess numeric UI IDs.
The hit count, cap and hasMore/cursor behavior remain unchanged.

Keep recordUrl behavior for existing write callers. Add a separate safe wrapper
for search-hit URLs: empty ID, exact dot/dot-dot, or failed encodeURIComponent
produce an empty URL, never a thrown URIError or an unsafe path. Valid IDs keep
the existing path. Do not encode dots as a workaround: URL parsers normalize
encoded dot segments too. The required string field can be empty, consistent
with record URLs. Test these edge cases and describe generated links as built
from the API ID, not individually verified.

Add `url` to MINIMAL_FIELDS for person, company and deal. Existing record URLs
are preserved; there is no new fallback for full-record URLs or tasks.

TDD cases: URL for every supported kind; reserved ID characters stay in one
encoded segment; synthetic subdomain only; exactly the existing upstream call
per phrase search; valid output schema; minimal keeps the original record URL;
task projection unchanged. Update exact-result expectations to include URLs.

## 2. Strict tool inputs

Change only input roots in `src/server/tools/health.ts` and
`src/server/tools/crm-metadata.ts` from `z.object` to `z.strictObject`.
Do not alter output objects or implement a second schema validator.

Add failing schema tests in `tests/server/tools/health.test.ts` and
`tests/server/tools/crm-metadata.test.ts`. Add real tools/call regressions in
`tests/server/modern-wire.test.ts`: unexpected top-level keys must be rejected
before health ping or metadata get executes. Assert the advertised input
schemas have `additionalProperties: false`; valid calls still work. Cover
legacy transport in `tests/server/http.test.ts`. SDK 2.0.0 rejects invalid
input with result.isError=true and text containing Input validation error,
without structuredContent or a JSON-RPC payload.error. Assert this behavior
and zero dependency calls; do not replace SDK error handling.

## 3. User lookup in crm_metadata

Files: `src/server/tools/crm-metadata.ts`,
`tests/server/tools/crm-metadata.test.ts`, `tests/server/modern-wire.test.ts`.

Add optional `userQuery` to the strict input schema:

```ts
userQuery: z.string().trim().min(2).max(100).optional().describe(
  "Case-insensitive substring of a user's name or email. Filters users only; " +
  "when sections is omitted, returns only users. Returns all matches up to " +
  "the section cap; do not choose a recipient when several users match."
),
```

Use an exported `CrmMetadataArgs` interface with optional sections/userQuery
for the runner. With no query preserve today's default of all sections. With
a query and omitted sections request only users. With explicit sections that
exclude users return isError and `{section: "users", code: "BAD_PARAMS",
message: "userQuery requires the users section.", hint: "Include users in
sections, or omit sections to search users only."}` without upstream calls.
Explicit mixed sections are allowed; only users are filtered.

Trim and lowercase the query; match with `name.toLowerCase().includes(query)`
or `email.toLowerCase().includes(query)`. No regex or automatic exact-match
selection. Preserve original order and all matching identities. Do not modify
the cached array or objects. Pass a new filtered section result to the existing
buildEnvelope so the 500-row cap follows filtering. totalItems counts matches
in the cached dictionary, not all users and not an upstream global count.
Keep asOf/ageMs/stale. A subsequent query must not require another fetch while
the dictionary is fresh, and must not reuse a prior filtered result.

For zero matches add the same fixed hint in an optional users-envelope hint
and in the text channel, advising a name/email and dictionary-age check.
The envelope schema may carry optional hint; populate it only for an empty
user query. Queried users' text counts say matching users, including truncation.
Do not echo the supplied query, user names or emails in text.
For several matches state in the description/instructions that the caller
must resolve ambiguity before a write; do not auto-select anyone.

TDD cases: name and email, mixed case and outer whitespace, trim/min/max
validation, multiple matches, empty matches, default users-only query,
explicit invalid sections with zero calls, mixed sections, a hit beyond the
first 500 original users, more than 500 matches, unchanged cached data across
queries, cache call count, stale metadata and cancellation. Validate outputs
and one full tools/call round trip.

## 4. Missing-data guidance

Edit wording in `src/server/tools/search-crm.ts`,
`src/server/tools/get-records.ts`, `src/server/tools/record-schemas.ts`,
`src/livespace/records.ts`, `src/server/instructions.ts`, and relevant README
read-tool examples. Search for other current tool descriptions or comments
making the same unconditional claim and align those without changing runtime.

The contract becomes:

"Fields excluded by detail are omitted. An empty or null returned value means
this response supplies no value; it does not establish why the field is empty
or absent. Do not infer access restrictions or an empty CRM field from it.
For deal value/probability, preserve returned numeric zero and distinguish it
from null; this does not establish whether a zero budget was intentionally set.
Some counters and flags normalize missing data to zero or false, so they do
not prove an explicitly stored value."

Retain numeric types, normalization, projections, sort order, sums and missing
counts. No field-level permission flags, new null model, or claim that old API
implements the official MCP's null behavior. Correct the instruction that
currently tells the agent to treat zero as missing. Existing zero-vs-null
numeric tests remain the behavioral check; do not add brittle prose snapshots.
Update the existing obsolete instructions.test.ts assertion for not filled in.
Also align the current comment in src/livespace/aggregate.ts. Historical plans
remain historical evidence rather than being rewritten.

## 5. Documentation and validation

Update README's tool table and Read results section and server instructions for
userQuery, match ambiguity, URL availability and missing-value limits. English
documentation follows no-ai-slop and uses ASCII hyphens. Tool names/counts stay
unchanged. Keep local review material and results outside the repository.

Before implementation: run Fable 5.1 max through Claude Code CLI with read-only
Read/Glob/Grep tools, no MCP/hooks, no session persistence. Supply this plan,
the original concept and API gap mail, the official MCP test report, the
corrected Fable synthesis, and relevant source/test files. Record actual model,
result, source hashes, and findings. Revise the plan for confirmed issues.

During implementation, each behavioral change follows red -> green TDD. Run
focused tests for each workstream, then the full test suite and typecheck once
after integration. Run git diff --check and review the complete patch. Existing
security tests run within the full suite. No dependency changes or new audit
gate are needed.

Live validation: read credentials from macOS Keychain into memory, assert the
known test subdomain, and print only check booleans/counts. For each of three
record kinds read at most one list record, derive a phrase in memory, search a
bounded page, and compare one hit URL to a fresh record URL. Query metadata by
a fragment from a visible user and verify the expected ID is among results;
run one guaranteed-empty query. No CRM values, IDs or credential material in
logs or saved files. Do not modify permissions or create users. Record that
restricted-role behavior was not tested.

## Execution notes

- Fable 5.1 max completed a read-only CLI review successfully, 96 turns.
  Verdict: ready after corrections. Accepted the scoped zero semantics,
  search-only safe URL wrapper, SDK validation result shape, missing wire
  fixture and obsolete instruction assertion, and dual-channel empty hints.
- The review's claim that a host reads only structuredContent is stronger than
  our evidence: the prior test proved it reads that channel, not that it ignores
  text. Dual-channel hints are useful regardless.
- Baseline: 1146 tests passed; typecheck passed. Package installation tests need
  execution outside the filesystem sandbox for Bun's temporary directory.
- Links TDD: 242 passing / 15 failing tests before implementation; final
  focused suite 258 passing. Metadata/validation regressions failed before
  implementation; integrated metadata/health/HTTP suite now passes 90 tests.
- Final full suite: 1168 tests, 5080 assertions, zero failures. Typecheck and
  git diff --check passed. Existing package, security and protocol tests ran
  within the full suite. No dependencies or configuration changed.
- Live test account reads confirmed phrase-hit URLs match fresh record URLs
  for persons, companies and deals, and minimal records retain those URLs.
  User lookup and an empty query result passed schema validation. Credentials
  and records stayed in memory; output contained only checks and zero writes.
- A final independent code review found no actionable issues. Restricted-role
  semantics remain untested; guidance states the uncertainty rather than
  assigning a cause. At the September 22 implementation checkpoint, no commit,
  push, release or CRM write had been performed.
