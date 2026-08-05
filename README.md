# livespace-mcp

Unofficial [MCP](https://modelcontextprotocol.io) server for
[Livespace CRM](https://www.livespace.io) - designed for the model, not as a
1:1 API mirror. Built for MCP spec **2026-07-28** (stateless Streamable HTTP).

> **Status: early development.** The tool surface below is the design target;
> implementation is in progress. Do not point this at a production CRM yet.

## Why not just wrap the API?

Livespace's RPC API has ~80 methods but no sorting, no aggregations and no
direct "set stage" operation. This server exposes ~10 intent-shaped tools
instead, adds the missing capabilities server-side, and teaches the model how
to use them (operating-manual `instructions`, errors with recovery hints,
discovery-first dictionaries, batch-first writes with dry-run previews).

Planned tools (5 read / 5 write): `crm_metadata`, `search_crm`, `get_records`,
`get_activity`, `analyze`, `create_records`, `update_records`,
`move_deals_to_stage`, `log_activities`, `notify_user`.

## Security

The binding security rules live in [docs/security.md](docs/security.md):
per-user API key with that user's permissions, localhost by default with
fail-closed auth on public binds, no delete or merge operations in v1, a
global read-only mode, dry-run plus post-write verification, sanitized
errors, and no storage of CRM data.

Report vulnerabilities per [SECURITY.md](SECURITY.md).

## Requirements

- Livespace account on a plan with API access (Automation or higher)
- API key + secret for your Livespace user
  (Account settings → API → Users) - all calls run with that user's permissions
- [Bun](https://bun.sh) 1.2+ (the current entrypoint uses `Bun.serve`;
  Node.js and Cloudflare Workers adapters are planned)

## Configuration

Copy `.env.example` to `.env` and fill in your values. Never commit `.env`.

| Variable | Purpose |
|---|---|
| `LIVESPACE_SUBDOMAIN` | Your account subdomain (`<subdomain>.livespace.io`) |
| `LIVESPACE_API_KEY` / `LIVESPACE_API_SECRET` | Per-user API credentials |
| `MCP_PORT` | Server port (default `3020`) |
| `MCP_BIND_HOST` | Default `127.0.0.1`; non-loopback requires `MCP_AUTH_TOKEN` |
| `MCP_AUTH_TOKEN` | Bearer token for `/mcp`; mandatory on public binds |
| `LIVESPACE_MCP_READ_ONLY` | `true` disables all write tools |
| `MCP_RATE_LIMIT_PER_MINUTE` / `MCP_RATE_LIMIT_BURST` | Per-principal request budget (default 120/min, burst 30) |
| `MCP_MAX_CONCURRENT_REQUESTS` / `MCP_MAX_QUEUED_REQUESTS` | Overload protection (default 8 in flight, 16 queued; excess gets 429 + `Retry-After`) |

## Development

```bash
bun install
bun test            # offline unit tests
bun run typecheck
bun run smoke       # LIVE Livespace API check (uses .env or macOS Keychain)
bun run dev         # start the MCP server on http://127.0.0.1:3020/mcp
```

Quick manual check once `bun run dev` is running (set `MCP_PORT` if 3020 is
taken on your machine). Modern client (MCP 2026-07-28):

```bash
curl -s -X POST http://127.0.0.1:3020/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: tools/list' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"curl-smoke","version":"0.0.0"},"io.modelcontextprotocol/clientCapabilities":{}}}}'
```

Legacy-era client (2025-03-26 fallback, no MCP headers):

```bash
curl -s -X POST http://127.0.0.1:3020/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

`bun run smoke` and the health tool's `checkLivespace` perform real API calls
with your credentials. Point them at a test instance, never at a production CRM.

## Disclaimer

Community project. Not affiliated with, endorsed by, or supported by
Livespace S.A. "Livespace" is a trademark of its owner; it is used here only
to describe compatibility. Operations performed through the Livespace API are
executed under your API key and, per Livespace's terms of service, at your own
responsibility.

## Attribution

This server follows the design patterns of Adam Gospodarczyk's (overment)
MCP servers, in particular
[iceener/streamable-mcp-server-template](https://github.com/iceener/streamable-mcp-server-template)
(MIT): a few intent-shaped tools instead of endpoint mirrors, operating-manual
`instructions`, batch-first writes with per-item results, and errors that
carry recovery hints. Thanks, Adam.

## License

[MIT](LICENSE)
