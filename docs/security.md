# Security design

This document is the threat model and the binding security requirements for
`livespace-streamable-mcp-server`. Code that violates a MUST here does not ship.

## Principles

1. **Fail closed.** Missing or half-configured security settings stop the server
   at startup instead of degrading silently.
2. **Least privilege by construction.** The server holds exactly one credential
   (a per-user Livespace API key) and inherits that user's permissions - nothing
   more exists to leak.
3. **Secrets are radioactive.** API keys, secrets, tokens and session material
   MUST never appear in: the repository, git history, logs, error messages,
   tool responses, or anything else the model or a client can read.
4. **Guardrails live in deterministic code**, not in model goodwill. Anything
   the model must not do is enforced server-side.
5. **Minimal surface.** Few dependencies, few endpoints, few moving parts.

## 1. Credential handling

- Credentials come only from environment variables (`.env`, gitignored) or the
  OS keychain. There is no other input path - never CLI args, never tool args.
- Startup validates presence and shape of required config and exits with a
  clear message when incomplete. It MUST never echo values back.
- Livespace auth (`getToken` + `SHA1(key + token + secret)`) runs per request;
  tokens live only in memory for the duration of a call.
- Credentials are never placed in URLs (all Livespace calls are POST bodies).
- `.env.example` documents variable names only, never values.

## 2. Network exposure

- Default bind is `127.0.0.1`. The server MUST refuse to start on a
  non-loopback bind unless `MCP_AUTH_TOKEN` is set (fail-closed).
- When `MCP_AUTH_TOKEN` is set, every `/mcp` request MUST carry it as a Bearer
  token; comparison uses constant-time equality.
- Origin allowlist, deny-by-default, as DNS-rebinding protection.
- Request body size limits; `x-powered-by` disabled; no directory listings.
- TLS is terminated by the platform (Cloudflare Workers) or a reverse proxy -
  the Node/Bun process itself never listens publicly without one.
- v2 (multi-user) will implement OAuth 2.1 resource-server semantics per MCP
  spec 2026-07-28. Authorization is NEVER derived from `clientInfo`, server
  metadata, or tool annotations.

## 3. Livespace API compliance (load discipline)

Livespace's terms (§4 pt 14) permit API use at the operator's responsibility
and sanction only excessive server load. Therefore the client MUST implement:

- a global concurrency cap and conservative request throttle,
- exponential backoff with jitter on failures; no hot retry loops,
- explicit `limit` on every list call (the API defaults to returning ALL),
- batch caps (max 50 items per write batch),
- in-memory caching of dictionaries (processes, users, datasets) with TTL to
  avoid re-fetching static data.

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

## 5. Write safety

- v1 ships **no delete and no merge operations at all** - the worst mistakes
  are impossible, not just guarded.
- `LIVESPACE_MCP_READ_ONLY=true` disables every write tool (they are not even
  listed) - a global kill-switch for cautious operators.
- Batch writes support `dryRun` previews; destructive ambiguity resolves to
  "do nothing and explain".
- After every write the server re-reads the affected records and reports
  "before → after", so silent partial failures cannot hide.
- Contact creation uses Livespace's native dedupe check by default.
- Every tool carries accurate `readOnlyHint` / `destructiveHint` /
  `idempotentHint` annotations, enforced by tests.

## 6. Error and log hygiene

- Upstream errors are mapped to `{code, message, hint}`. Backend response
  bodies, stack traces, and auth material MUST never reach the model or client.
- Livespace app-level result codes are translated to actionable messages
  (e.g. 540 → "the API key's user lacks permission for this record").
- Logs go to stderr, contain no secrets, no full CRM payloads, and no
  personal data by default. Log level is configuration, not code edits.

## 7. Supply chain

- Runtime dependencies are minimal (MCP SDK, Hono, Zod) and pinned to exact
  versions; the lockfile is committed.
- No dependencies with install scripts; CI runs dependency audit and a secret
  scanner (gitleaks) on every push.

## 8. Data handling

- The server persists **no CRM data**. The only cache is in-memory dictionary
  data with TTL. Nothing is written to disk.
- No telemetry, no analytics, no outbound traffic except
  `https://<subdomain>.livespace.io`.

## 9. Repository hygiene

- The repo may start private and flip to public: the entire git history
  becomes public at that moment. Therefore: no secrets and no real CRM data in
  any commit, ever. Test fixtures are synthetic and anonymous.
- `.ai/` (agent working state) stays untracked.
- Documentation examples use placeholder values only.

## 10. Required security regression tests

The suite MUST cover at least:

1. startup refuses non-loopback bind without `MCP_AUTH_TOKEN`;
2. `/mcp` rejects missing/invalid bearer when auth is enabled (401 with
   correct `WWW-Authenticate`);
3. read-only mode hides and blocks all write tools;
4. upstream error bodies and tokens never appear in tool results or logs;
5. origin guard denies unknown origins;
6. user-supplied IDs are encoded, never interpolated into paths/queries;
7. every listed tool carries correct annotations (read-only enforcement test);
8. `analyze`/list tools always send an explicit `limit` upstream.

## Trust boundaries (out of scope)

- Livespace itself (TLS, storage, permissions model) is trusted.
- The MCP host/client applies its own tool-permission UX; this server reduces
  blast radius but cannot override host-side decisions.
- The operator's machine is trusted; protecting `.env` at rest is the
  operator's responsibility (documented in README).
