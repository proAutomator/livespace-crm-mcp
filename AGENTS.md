# livespace-streamable-mcp-server - Agent Instructions

Unofficial MCP server for Livespace CRM. ~10 intent-shaped tools instead of a
1:1 mirror of the ~80-method RPC API. Target protocol: MCP 2026-07-28
(stateless Streamable HTTP). Stack: TypeScript (strict) + Hono, Bun/Node with
a planned Cloudflare Workers dual runtime, `@modelcontextprotocol/server` v2
pinned to an exact version.

## Hard rules

1. **Read `docs/security.md` before touching auth, the Livespace client,
   transport, or error handling.** Its MUSTs are binding; code violating them
   does not ship.
2. **No secrets, no real CRM data - anywhere.** Not in code, tests, fixtures,
   docs, commit messages, or `.ai/` files. Fixtures are synthetic and every
   fake credential value MUST contain the word "synthetic" (e.g.
   `synthetic-key-123`) - `.gitleaks.toml` allowlists that marker and nothing
   else, so CI stays green without weakening the scanner. This repo's full
   history is expected to become public.
3. **Never log tokens or full CRM payloads.** Errors surfaced to the model
   must never contain upstream response bodies or stack traces.
4. **TDD.** Write the failing test first. Every tool ships with contract tests;
   security regressions from `docs/security.md` §10 stay green.
5. **English** for code, comments, commits, and docs.
6. Do not change the default bind (`127.0.0.1`) or weaken fail-closed startup
   checks without an explicit maintainer decision.
7. Do not commit or push unless Kuba asks.

## Livespace API - facts that will bite you

- Success is `status: true && result: 200` in the response envelope; HTTP is
  200 even on errors. Always check the envelope.
- The official Postman docs contain errors (e.g. "delete deal" shown as
  `Contact/deleteDeal`; PDF v1.13 says `Deal/deleteDeal`). Trust the API PDF
  over the Postman portal and confirm every method with a live smoke test on a
  sandbox account before release.
- `Deal/getAll` requires at least one condition. List endpoints default to
  returning ALL records - always send an explicit `limit`.
- There is no "set stage" call: stage changes = marking process steps via
  `editDeal stages{step_id: 0|1}` mapped from `Deal/process_getList`.
- Every logical call costs 2 HTTP requests (auth token + call): batch
  aggressively, cache dictionaries in memory with TTL.
- Select-type custom fields (datasets) take answer IDs, not display text.

## Design canon

- Tools (5 read / 5 write): `crm_metadata`, `search_crm`, `get_records`,
  `get_activity`, `analyze`, `create_records`, `update_records`,
  `move_deals_to_stage`, `log_activities`, `notify_user`. No delete, no merge
  in v1.
- Responses are dual-channel: short markdown summary + schema-validated
  `structuredContent`; slim shapes; `detail: minimal|standard|full`.
- Errors are `{code, message, hint}` where the hint names the recovery tool.
- Server `instructions` are an operating manual: quick start, per-tool cheat
  sheet, CRITICAL warnings ("deal status ≠ process stage", "never guess IDs -
  take them from crm_metadata").
- Writes: batch arrays with per-item results, `dryRun` previews, post-write
  verification ("before → after"), honest tool annotations.

## Agent Session Files

Use `.ai/PLAN.md`, `.ai/TODO.md`, `.ai/HANDOFF.md`, and `.ai/NOTIFY.md` as the
shared working state for AI agents. These files are **untracked** (see
`.gitignore`) - they stay local and may reference private context.

- `.ai/PLAN.md` - current plan for substantial multi-step work.
- `.ai/TODO.md` - current checklist, decisions, and open points.
- `.ai/HANDOFF.md` - status for the next agent or post-compaction continuation.
- `.ai/NOTIFY.md` - only items that require Kuba's attention or manual action.

Update these files during larger changes, before stopping work, before handing
work to another agent, and when a blocker appears. Do not store secrets, API
keys, or full environment variable values in them.
