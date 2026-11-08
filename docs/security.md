# Security design

This document is the threat model and the binding security requirements for
`livespace-crm-mcp`. Code that violates a MUST here does not ship.

## Principles

1. **Fail closed.** Missing or half-configured security settings stop the server
   at startup instead of degrading silently.
2. **Least privilege by construction.** The server holds one required
   credential, a Livespace API v2 service key, and an optional v1 key pair -
   nothing more exists to leak. The v2 key belongs to an integration user, not
   to a person: it sees every active record of the account, is not bound by
   Livespace roles, and authors everything it writes. The server has exactly
   that visibility, and the README says so plainly. Operators MUST give the key
   only the scopes the enabled tools need (table below): a read-only server
   gets `read` scopes only, a write server adds `write` scopes, and no install
   grants a `delete` scope or `crm:sales-process:write`. The optional v1 pair
   inherits its Livespace user's permissions; that user SHOULD be a dedicated
   API user with the smallest useful permissions, never an administrator.
3. **Secrets are radioactive.** API keys, secrets, tokens and session material
   MUST never appear in: the repository, git history, logs, error messages,
   tool responses, or anything else the model or a client can read.
4. **Guardrails live in deterministic code**, not in model goodwill. Anything
   the model must not do is enforced server-side.
5. **Minimal surface.** Few dependencies, few endpoints, few moving parts.

### API v2 scopes per tool

Tools move from the v1 pair to API v2 one area at a time; this is the scope
set each one needs once it runs on API v2.

| Tool | Scopes |
|---|---|
| `health` | none (`GET /users/me`) |
| `crm_metadata` | `crm:person:read`, `crm:company:read`, `crm:deal:read`, `crm:task:read`, `crm:sales-process:read` |
| `search_crm`, `get_records` | `crm:person:read`, `crm:company:read`, `crm:deal:read`, `crm:task:read`; included notes, calls and e-mails add `crm:note:read`, `crm:call:read`, `crm:email:read` |
| `get_activity` | `crm:note:read`, `crm:call:read`, `crm:email:read`, `crm:task:read` |
| `analyze` | `crm:deal:read`, `crm:sales-process:read` |
| `create_records`, `update_records` | `crm:person:write`, `crm:company:write`, `crm:deal:write`, `crm:task:write` |
| `move_deals_to_stage` | `crm:deal:write` |
| `log_activities` | `crm:note:write`, `crm:call:write` |
| `notify_user` | `crm:notification:write` |

## 1. Credential handling

- Credentials come only from environment variables (`.env`, gitignored) or the
  OS keychain. There is no other input path - never CLI args, never tool args.
- Startup validates presence and shape of required config and exits with a
  clear message when incomplete. It MUST never echo values back. The v2 key
  must match `^ls_[A-Za-z0-9_-]{43}$`; the v1 key and secret are optional and
  come as a pair or not at all.
- The v2 key is a static Bearer credential. It travels only in the
  `Authorization` header of requests to `https://<subdomain>.livespace.io/api/v2`,
  and the client does not follow redirects, so the header never reaches
  another host.
- The v1 auth (`getToken` + `SHA1(key + token + secret)`) runs per request;
  tokens live only in memory for the duration of a call.
- Credentials are never placed in URLs (v1 calls are POST bodies, the v2 key
  is a header).
- `.env.example` documents variable names only, never values.

## 2. Network exposure

- Default bind is `127.0.0.1`. Every configured `MCP_AUTH_TOKEN` MUST contain
  at least 32 bytes of cryptographically random material. The server MUST
  refuse to start on a non-loopback bind unless that token is set
  (fail-closed).
- A non-loopback bind MUST also carry `LIVESPACE_V2_SHARED_ACCESS=acknowledged`.
  Every client of a shared endpoint sees what the API v2 integration user
  sees, so the operator has to opt in to that explicitly. Any other value
  refuses to start, on loopback too.
- When `MCP_AUTH_TOKEN` is set, every `/mcp` request MUST carry it as a Bearer
  token; comparison uses constant-time equality.
- Write tools MUST NOT be enabled without `MCP_AUTH_TOKEN`, including on
  loopback. Read-only remains the startup default.
- Authentication failures MUST pass through one bounded, constant-cardinality
  rate-limit bucket. They never reach request-body buffering, and exhausting
  their bucket does not consume the valid principal's allowance.
- Origin allowlist, deny-by-default, as DNS-rebinding protection.
- Each HTTP request MUST contain one top-level JSON-RPC message. Batch arrays
  MUST be rejected before MCP dispatch so one admission cannot fan out into
  unbounded tool work.
- Tool arguments MUST be bounded before schema validation, because
  validation cost grows with every element. Every input array declares a
  maximum length, and one call's arguments hold at most
  `MAX_TOOL_INPUT_ELEMENTS` array elements and object members, counted at
  every level before any schema runs. A call over the cap gets an error
  result and no tool work. The cap stays above the largest valid input.
- Request body size limits; a buffered body MUST preserve the original request
  cancellation signal; `x-powered-by` disabled; no directory listings. The
  admission queue and body upload MUST share one absolute deadline, defaulting
  to 10 seconds and capped at 60 seconds. Timed-out or disconnected waiters
  MUST leave the queue immediately.
- Tool execution after body upload MUST receive a separate absolute deadline,
  defaulting to 90 seconds and capped at 180 seconds. The deadline signal MUST
  remain live until the response body finishes, including streamed responses.
  The admission slot MUST remain held for the same lifetime, then release on
  completion, cancellation or deadline. A timed-out write keeps the existing
  unknown-outcome semantics and MUST NOT be presented as safely retryable.
- The HTTP runtime's idle-connection timeout MUST outlast the ingress and
  execution deadlines together, so a slow call ends with this server's own
  result, never with a dropped connection. Bun defaults to 10 seconds and
  accepts at most 255, which is why execution is capped at 180 seconds. The
  same timeout keeps idle keep-alive connections open between requests;
  network-exposed deployments sit behind the required reverse proxy.
- `/mcp` responses MUST send `Cache-Control: no-store` and vary by
  `Authorization`. The unauthenticated `/health` liveness endpoint exposes
  status only.
- TLS is terminated by the platform (Cloudflare Workers) or a reverse proxy -
  the Node/Bun process itself never listens publicly without one.
- A future multi-user mode will implement OAuth 2.1 resource-server semantics
  per MCP spec 2026-07-28. Authorization is NEVER derived from `clientInfo`, server
  metadata, or tool annotations.

## 3. Livespace API compliance (load discipline)

Livespace's terms (§4 pt 14) permit API use at the operator's responsibility
and sanction only excessive server load. Therefore the client MUST implement:

- a global concurrency cap and conservative request throttle,
- exponential backoff with jitter on failures; no hot retry loops,
- an explicit `limit` on every list call where the endpoint supports it;
  `Todo/getTodoObjects` uses fixed 50-row pages, while dictionary endpoints
  that ignore `limit` are bounded by local caps,
- batch caps (max 50 items per write batch),
- in-memory caching of dictionaries (processes, users, datasets) with TTL to
  avoid re-fetching static data.

API v2 counts every request twice: against a burst window per key and
against a daily budget per account, reset at 00:00 UTC (provisional limits:
100 requests per 10 seconds, 25 000 to 100 000 a day by tier). The daily budget is shared by every key
and integration of the customer, and refused requests count too. The v2
client therefore MUST also implement:

- at most 2 requests in flight and 150 ms between starts, applied to every
  attempt, retries included,
- an explicit `perPage` on every list and search, within the contract caps
  (500; 50 for the extended deal search and `GET /search`), and a bounded page
  count per call,
- a request budget per tool call (read tools 60, `analyze` 150, write tools
  80), spent by every HTTP attempt and refusing before the request that would
  exceed it,
- the burst window from `X-RateLimit-Remaining` and `X-RateLimit-Reset`: a
  spent window is waited out up to 10 seconds, a longer one refuses,
- a daily reserve: once `X-RateLimit-Daily-Remaining` is at or below
  `LIVESPACE_V2_DAILY_RESERVE` (default 5000, 0 turns the guard off), new work
  is refused, `health` excepted, instead of spending the budget the customer's
  other integrations depend on,
- reads retry transport failures (429, 5xx, timeout, network) at most three
  attempts; `Retry-After` is honored up to 10 seconds and a longer one is not
  retried.

## 4. Prompt-injection posture

CRM records contain text written by third parties (notes, imported e-mails,
names). That content is **untrusted data**:

- Tool responses return record content clearly delimited as data; server
  `instructions` direct the model to treat record content as data, never as
  instructions to follow.
- The server never interprets, evaluates, or acts on record content itself -
  no code execution, no dynamic dispatch from data.
- Write operations act only on explicit, schema-validated tool arguments.
- Structured output schemas keep data in typed fields instead of free text
  where possible.
- These controls do not stop a host or model from being influenced by data it
  receives. Operators MUST choose a host whose storage and retention policy is
  appropriate for CRM data and SHOULD keep write sessions separate from broad
  exploratory reads.

## 5. Write safety

- The server ships **no delete and no merge operations at all** - the worst
  mistakes are impossible, not just guarded. The API v2 client cannot send a
  `DELETE` request.
- API v2 writes without an `Idempotency-Key` (people, companies, deals, notes,
  notifications) are never resent once dispatched: a timeout, 5xx, network
  error or abort reports an unknown outcome. Only a 429 retries, because it
  was refused before processing. A write that carries a key is retried at
  most once, with the same key.
- Write tools are absent by default. `LIVESPACE_MCP_ENABLE_WRITES=true` is the
  explicit opt-in, while `LIVESPACE_MCP_READ_ONLY=true` remains a global
  kill-switch and wins over that opt-in.
- On clients with form elicitation, execution requires the signed, single-use
  confirmation state bound to the principal, tool, arguments and preview.
  Clients without form elicitation can preview but MUST NOT execute through
  `confirm: true` by default. The operator-only
  `MCP_ALLOW_UNBOUND_WRITE_CONFIRMATION=true` escape hatch may restore that
  compatibility path, and documentation MUST label it unsafe.
- Batch writes support `dryRun` previews; destructive ambiguity resolves to
  "do nothing and explain".
- After a write with a read-back the server re-reads the affected record and
  reports before -> after, naming the fields that did not stick. A read never
  turns an applied write into an error: when the follow-up read itself fails,
  the item stays successful and reports `verification: unavailable` instead of
  masking a write that landed.
- A write whose upstream exposes NO read-back is unverifiable by construction
  and says so. An in-app notification is the one such write in v1 - three
  candidate read endpoints were probed and all refused - so it reports
  `verification: unavailable` with a fixed advisory, is reported as
  dispatched, never as delivered, and is never retried on an unknown outcome:
  a resend would be a second entry in the recipient's bell, not a fix.
- Contact creation dedupes by default, and the check is OURS: Livespace's
  `__check_if_exists` parameter was probed on a sandbox and does NOT dedupe,
  so a person is looked up by exact e-mail (case-insensitive) and a company by
  exact name before anything is created.
- Every tool carries accurate `readOnlyHint` / `destructiveHint` /
  `idempotentHint` annotations, enforced by tests.

## 6. Error and log hygiene

- Upstream errors are mapped to `{code, message, hint}`. Backend response
  bodies, stack traces, and auth material MUST never reach the model or client.
- Livespace app-level result codes are translated to actionable messages
  (e.g. 540 → "the API key's user lacks permission for this record").
- API v2 failures arrive as `application/problem+json`. Their `title`,
  `detail`, violation messages, `conflicts` and `supported` are dropped. Only
  fixed wording chosen by status and problem type passes, plus the JSON
  Pointer paths of rejected inputs (sanitized, at most 20), a request id in
  its 32-hex shape and a missing scope in the documented `crm:<area>:<level>`
  shape.
- Logs go to stderr, contain no secrets, no full CRM payloads, and no
  personal data by default. Log level is configuration, not code edits.

## 7. Supply chain

- Runtime dependencies are minimal (MCP SDK, Hono, Zod) and pinned to exact
  versions; the lockfile is committed.
- No dependencies with install scripts; CI runs a dependency audit
  (`bun audit`) and a checksum-pinned secret scanner (gitleaks) on every
  push; GitHub Actions are pinned to commit SHAs.
- npm releases MUST run from the protected `npm-release` GitHub environment
  through npm trusted publishing. The workflow has only `contents: read` and
  `id-token: write`; public releases publish a provenance attestation.

## 8. Data handling

- The server persists **no CRM data**. The only cache is in-memory dictionary
  data with TTL. Nothing is written to disk.
- No telemetry, no analytics, no outbound traffic except
  `https://<subdomain>.livespace.io` (API v2 and, when configured, the v1
  fallback).
- Once a result reaches an MCP host, its persistence, model-provider retention
  and training policy are outside this process. User documentation MUST state
  that boundary plainly.

## 9. Repository hygiene

- The repo may start private and flip to public: the entire git history
  becomes public at that moment. Therefore: no secrets and no real CRM data in
  any commit, ever. Test fixtures are synthetic and anonymous.
- `.ai/` (agent working state) stays untracked.
- Documentation examples use placeholder values only.

## 10. Required security regression tests

The suite MUST cover at least:

1. startup refuses non-loopback bind without `MCP_AUTH_TOKEN` and refuses any
   configured auth token shorter than 32 bytes;
2. `/mcp` rejects missing/invalid bearer when auth is enabled (401 with
   correct `WWW-Authenticate`), bounds repeated failures, and keeps the valid
   principal's allowance independent;
3. read-only mode hides and blocks all write tools;
4. upstream error bodies and tokens never appear in tool results or logs;
5. origin guard denies unknown origins;
6. user-supplied IDs are encoded, never interpolated into paths/queries;
   API v2 paths are built only by `v2Path`, which percent-encodes each id and
   refuses dot segments;
7. every listed tool carries correct annotations (read-only enforcement test);
8. `analyze` and list-style calls send an explicit `limit` where the endpoint
   supports it, and on API v2 an explicit `perPage` within the contract caps
   with a bounded page count; `Todo/getTodoObjects` uses fixed 50-row pages
   with bounded page counts, and limit-ignoring dictionary endpoints use
   bounded local caps.
9. buffered `/mcp` requests preserve client cancellation through the SDK and
   into tool work.
10. top-level JSON-RPC batch arrays are rejected before any tool or upstream
    work while single-message legacy and modern requests remain supported.
11. one absolute ingress deadline covers admission queueing and body upload;
    stalled bodies receive 408, body readers are cancelled, and aborted queue
    waiters release capacity immediately.
12. startup defaults to read-only, write opt-in requires authentication and a
    stable request-state key, and the read-only kill-switch takes precedence;
13. a non-elicitation client cannot execute with `confirm: true` unless the
    operator explicitly enables the unsafe compatibility flag;
14. the post-upload execution deadline aborts real tool work and remains live
    through streamed response consumption;
15. `/mcp` responses are non-cacheable and `/health` exposes status only;
16. the runtime idle timeout outlasts ingress plus execution, so a handler
    still working past Bun's 10-second default answers normally.
17. every tool input has a finite largest valid size under the input element
    cap, and a call over the cap is refused before validation and tool work.
18. the API v2 key appears only in the `Authorization` header: never in a
    URL, an error, a tool result or a log line, and never behind a redirect;
19. API v2 problem bodies never reach the model: only fixed wording,
    sanitized pointers, a validated request id and a well-formed scope pass;
20. API v2 load discipline: explicit `perPage` and bounded pages, a request
    budget per tool call, the burst window and the daily reserve refusal;
21. API v2 writes without an idempotency key never retry after dispatch, and
    keyed writes retry only once, with the same key;
22. a non-loopback bind refuses to start without
    `LIVESPACE_V2_SHARED_ACCESS=acknowledged`.

### Regression map

Run `bun run test:security` for the focused contract below. `bun test` remains
the complete gate and MUST also pass before release.

| Requirement | Regression proof |
|---|---|
| 1 | `tests/config/server-env.test.ts` - non-loopback startup and minimum auth-token checks |
| 2 | `tests/server/http.test.ts` - bearer rejection, failure limiting and valid-principal isolation |
| 3 | `tests/server/write-registration.test.ts` - `read-only mode lists the six read tools and none of the write tools`; `read-only refuses a direct call to every write tool, fetchers untouched` |
| 4 | `tests/server/http.test.ts` - `upstream bodies and bearer tokens reach neither results nor stderr`; `tests/livespace/client.test.ts` - envelope and auth-echo redaction; `tests/server/tools/tool-error.test.ts` - fixed generic mapping |
| 5 | `tests/server/http.test.ts` - `unknown Origin is rejected` and the localhost control |
| 6 | `tests/livespace/client.test.ts` - `keeps an opaque user id in POST data and out of the request URL`; `tests/livespace/writes.test.ts` - `recordUrl percent-encodes the id it is given`; `tests/livespace/v2/client.test.ts` - `encodes path ids`, `refuses ids that are empty or dot segments`, `refuses a path that did not come from v2Path` |
| 7 | `tests/server/modern-wire.test.ts` - `every listed tool carries its exact security annotations`; `tests/server/write-registration.test.ts` - read-only enforcement |
| 8 | `tests/livespace/metadata.test.ts`, `tests/server/tools/crm-metadata.test.ts`, `tests/livespace/records.test.ts`, `tests/livespace/activity.test.ts`, `tests/livespace/aggregate-windows.test.ts`, `tests/server/tools/search-crm.test.ts`, `tests/server/tools/get-activity.test.ts`, and `tests/server/analyze.test.ts` pin upstream limits, dictionary caps, fixed pages and bounded windows; each API v2 list and search call adds its `perPage` and page-cap test here as its tool moves to API v2 |
| 9 | `tests/server/http.test.ts` - `buffering a normal MCP body preserves client cancellation` |
| 10 | `tests/server/http.test.ts` - `rejects a JSON-RPC batch before any tool work` plus the existing legacy and modern single-message controls |
| 11 | `tests/config/server-env.test.ts` - bounded ingress configuration; `tests/server/http.test.ts` - stalled-body 408 and slot handoff; `tests/server/body-limit.test.ts` - reader cancellation; `tests/server/limits.test.ts` - aborted queue removal |
| 12 | `tests/config/server-env.test.ts` - safe defaults, write authentication, state key and kill-switch precedence |
| 13 | `tests/server/write-support.test.ts` and write-tool wire tests - refusal by default and explicit compatibility control |
| 14 | `tests/config/server-env.test.ts` and `tests/server/http.test.ts` - bounded execution setting, live abort signal and streamed-response admission lifetime |
| 15 | `tests/server/http.test.ts` - `no-store`, `Vary: Authorization` and minimal liveness response |
| 16 | `tests/config/server-env.test.ts` - idle timeout derived from both deadlines and within Bun's maximum; `tests/server/idle-timeout.test.ts` - a 15-second handler answers through the real listener |
| 17 | `tests/server/modern-wire.test.ts` - `every tool input is bounded and fits under the input element cap`; `a call over the input element cap is refused before validation and tool work` |
| 18 | `tests/livespace/v2/client.test.ts` - `sends the key only as a Bearer header`, `does not follow redirects, so the key never leaves for another host`, `the key never appears in errors or stderr`; `tests/config/env.test.ts` - `rejects a malformed v2 key without echoing it` |
| 19 | `tests/livespace/v2/problems.test.ts` - `violation messages and detail never reach the error`, pointer, request id and scope checks; `tests/server/tools/tool-error.test.ts` - `toToolError copies fields and requestId from LivespaceError details` |
| 20 | `tests/livespace/v2/budget.test.ts` - `a call over its request budget stops before the next request`, burst and daily tracking; `tests/livespace/v2/client.test.ts` - `refuses when the daily budget is at the reserve`, `spends the call budget per attempt, retries included`, `consecutive requests start at least 150 ms apart` and the burst window tests; `perPage` and page caps as under requirement 8 |
| 21 | `tests/livespace/v2/client.test.ts` - `a timed-out create without a key is unknown and never resent`, `a keyed write retries once with the same key`, `cancellation before dispatch is CANCELLED, after dispatch of a write is unknown`; `tests/security-contract.test.ts` - `no source file sends a DELETE request` |
| 22 | `tests/config/server-env.test.ts` - `non-loopback bind with a v2 key needs the shared access acknowledgement` |

## Trust boundaries (out of scope)

- Livespace itself (TLS, storage, permissions model) is trusted.
- The MCP host/client applies its own tool-permission UX; this server reduces
  blast radius but cannot override host-side decisions.
- The operator's machine is trusted; protecting `.env` at rest is the
  operator's responsibility (documented in README).
