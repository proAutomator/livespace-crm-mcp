# Livespace CRM MCP Server

Unofficial [MCP](https://modelcontextprotocol.io) server for
[Livespace CRM](https://www.livespace.io). It exposes 11 intent-shaped tools
instead of mirroring the raw API and targets the stateless Streamable HTTP
transport in MCP spec 2026-07-28.

The v1 implementation is complete in this repository. It has six read tools
and five write tools, a global read-only switch, bounded API access, sanitized
errors and an elicitation-first confirmation flow. Use a test Livespace account
while evaluating it.

## Why this shape?

Livespace's RPC API has about 80 methods, but it does not provide sorting,
aggregation or a direct operation for setting a deal stage. The server groups
those lower-level calls into tasks an MCP client can use safely:

- discovery before IDs are used;
- bounded search, record reads and analysis;
- batch previews before writes;
- per-item outcomes and post-write checks;
- explicit handling of Livespace-specific stage moves and notifications.

## Tools

| Tool | Mode | Purpose and bound |
|---|---|---|
| `health` | Read | Checks the server; `checkLivespace: true` also makes one lightweight Livespace API call. |
| `crm_metadata` | Read | Returns nine dictionary sections, including processes, users, groups, sources, task dictionaries, products and the current user. |
| `search_crm` | Read | Finds persons, companies or deals. Sorted deal searches use one 200-record sort window and report truncation. |
| `get_records` | Read | Reads one record kind and up to 25 ids; walls for at most 5 persons, companies or deals. |
| `get_activity` | Read | Reads one record wall, one bounded CRM feed range or bounded task pages per call. |
| `analyze` | Read | Runs one named aggregation over bounded windows and reports whether its source window was truncated. |
| `create_records` | Write | Creates persons, companies, deals or tasks. Up to 10 items per call, with exact-match contact deduplication by default. |
| `update_records` | Write | Updates persons, companies, deals or tasks. Up to 10 items per call. |
| `log_activities` | Write | Adds public notes or phone calls. Up to 15 notes or calls per call. |
| `move_deals_to_stage` | Write | Moves deals by applying the minimal process-step diff. Up to 10 items per call; backward moves need an explicit allowlist. |
| `notify_user` | Write | Dispatches one in-app notification, limited to 5 per 10 minutes and 1 per recipient per minute. |

`move_deals_to_stage` works by checking and unchecking process steps because
Livespace has no "set stage" call. A deal stands at its furthest checked step.
A backward move therefore unchecks completed steps and can change the
historical meaning of those checkboxes.

`notify_user` validates the recipient and can add a deep link to a record.
Livespace provides no notification read-back, so the tool reports a successful
request as dispatched, never as delivered.

## Requirements

- A Livespace plan with API access, currently Automation or higher.
- One Livespace API key and secret from `Account settings -> API -> Users`.
  Every API operation uses that user's permissions.
- Bun 1.3.14 ([bun.sh](https://bun.sh)). The current server uses `Bun.serve`
  and has no Node.js or Cloudflare Workers adapter.

The v1 deployment model is single-user: one Livespace credential pair and, if
enabled, one MCP bearer token protect the server. There is no OAuth or
multi-user credential routing.

## Install and run

```bash
cp .env.example .env
bun install
bun run dev
```

Fill `.env` before starting the server. The default endpoint is
`http://127.0.0.1:3020/mcp`. Call `health` first, then use `crm_metadata` before
any operation that needs a user, process, stage, group or dictionary ID.

## Configuration

| Variable | Purpose |
|---|---|
| `LIVESPACE_SUBDOMAIN` | Account subdomain without protocol or `.livespace.io`. |
| `LIVESPACE_API_KEY` / `LIVESPACE_API_SECRET` | Credentials for one Livespace user. |
| `MCP_PORT` | Server port. Default: `3020`. |
| `MCP_BIND_HOST` | Bind address. Default: `127.0.0.1`. |
| `MCP_AUTH_TOKEN` | Bearer token for MCP requests. Required on a non-loopback bind. |
| `LIVESPACE_MCP_READ_ONLY` | Set to `true` to remove and block all write tools. |
| `MCP_REQUEST_STATE_KEY` | Secret of at least 32 bytes used to sign write confirmations. Required when authentication is enabled or the bind is not loopback. |
| `MCP_ALLOWED_HOSTS` | Host-header allowlist for DNS-rebinding protection. Required on a non-loopback bind. |
| `MCP_ALLOWED_ORIGIN_HOSTNAMES` | Optional additional browser-origin hostnames. On a non-loopback bind it defaults to `MCP_ALLOWED_HOSTS`. |
| `MCP_RATE_LIMIT_PER_MINUTE` / `MCP_RATE_LIMIT_BURST` | Per-principal request rate. Defaults: 120 per minute and burst 30. |
| `MCP_MAX_CONCURRENT_REQUESTS` / `MCP_MAX_QUEUED_REQUESTS` | Admission limits. Defaults: 8 in flight and 16 queued. |

The server refuses a non-loopback bind unless `MCP_AUTH_TOKEN` and
`MCP_ALLOWED_HOSTS` are set. Once `MCP_AUTH_TOKEN` is configured, every `/mcp`
request needs that Bearer token, including on loopback. Host and Origin checks
run before the MCP handler.

The Bun process does not terminate TLS. Put a TLS-capable reverse proxy in
front of every network-exposed deployment. The server reads credentials from
environment variables, commonly through Bun's `.env` loading; protecting
`.env` at rest is the operator's responsibility. Never commit it. The smoke
script can also read the sandbox credentials from the macOS Keychain.

## Write safety

The normal flow is elicitation-first:

1. A plain write-tool call or `dryRun: true` builds a plan and writes nothing.
2. On an elicitation-capable client, the server asks a human to approve the
   plan. A `confirm: true` argument cannot bypass this prompt.
3. The confirmation exchange uses a signed `requestState` that is valid for
   five minutes and consumed after an accepted or declined response. It is
   bound to the authenticated principal when present, the tool, arguments and
   preview.
4. If the relevant records changed before approval, the tool returns
   `recordsChanged: true`, writes nothing and presents a fresh plan.

Clients without elicitation use a less protected compatibility path:
`confirm: true executes immediately`. Preview first, obtain explicit human
approval, then repeat the same business arguments with `confirm: true`. This
path does not have the signed-state guarantees above.

Results distinguish these cases:

- `verification: verified` means the server re-read comparable fields after
  the write.
- A successful write can still report `verification: unavailable` when a
  follow-up read failed, no sent field had an independent comparator or the
  upstream API exposes no read-back. Inspect that item's error and re-read the
  record where possible; do not retry the write.
- `unknown_outcome` means the request may or may not have landed. Never retry
  it blindly.
- `not_attempted` means that item was not sent, usually because a time budget
  expired or an earlier item hit the upstream rate limit. Those unsent items
  can be submitted later; follow the error hint for the rate-limited item.

Notification success is reported as dispatched, never as delivered. If
delivery matters, confirm it by another channel instead of sending a duplicate
notification.

## v1 limits

- No delete or merge operations.
- No tag or custom-field writes.
- Tasks created here cannot be linked to records.
- Logged notes and calls cannot be edited or removed.
- Deal updates cover name and status; stage changes use
  `move_deals_to_stage`. Deal budget writes are not supported.
- `stage_conversion` is a point-in-time estimate because Livespace exposes no
  stage history.
- Reads and analyses use bounded windows. Inspect truncation fields before
  treating a result as complete.
- Missing values and mixed currencies can make monetary sums `null`; the
  result names the reason.
- API ids differ from the ids shown in the Livespace UI. Use IDs returned by
  `crm_metadata`, `search_crm` or another tool and never guess them.

## Development

```bash
bun test                 # complete offline suite
bun run test:security    # focused security contract from docs/security.md
bun run typecheck
bun run smoke            # live test-account check via .env or macOS Keychain
bun run dev
```

`bun run smoke` and `health` with `checkLivespace: true` make real API calls.
Use only a test Livespace account, never a production CRM.

The binding threat model and regression map are in
[docs/security.md](docs/security.md). Report vulnerabilities privately as
described in [SECURITY.md](SECURITY.md).

## Disclaimer

Community project. Not affiliated with, endorsed by or supported by Livespace
S.A. "Livespace" is a trademark of its owner and is used here only to describe
compatibility. Operations through the Livespace API run under your API key and,
under Livespace's terms of service, at your responsibility.

## Attribution

This server follows patterns from Adam Gospodarczyk's (overment) MCP servers,
especially
[iceener/streamable-mcp-server-template](https://github.com/iceener/streamable-mcp-server-template)
(MIT): a small intent-shaped tool surface, operating instructions, batch-first
writes with per-item results and errors with recovery hints. Thanks, Adam.

## Author

Built by [Kuba Masztalski](https://kubamasztalski.pl)

- LinkedIn: [linkedin.com/in/kuba-masztalski](https://www.linkedin.com/in/kuba-masztalski/)
- X: [@proAutomator](https://x.com/proAutomator)

Bugs and feature requests:
[GitHub Issues](https://github.com/proAutomator/livespace-crm-mcp/issues).
Security reports: see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
