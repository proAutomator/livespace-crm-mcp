# livespace-streamable-mcp-server

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
- [Bun](https://bun.sh) or Node.js 20+ (Cloudflare Workers deploy planned)

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

## Development

```bash
bun install
bun test            # offline unit tests
bun run typecheck
bun run smoke       # LIVE call against your Livespace account (uses .env or macOS Keychain)
```

`bun run smoke` performs real API calls (ping + current user) with your
credentials. Point it at a test instance, never at a production CRM.

## Disclaimer

Community project. Not affiliated with, endorsed by, or supported by
Livespace S.A. "Livespace" is a trademark of its owner; it is used here only
to describe compatibility. Operations performed through the Livespace API are
executed under your API key and, per Livespace's terms of service, at your own
responsibility.

## License

[MIT](LICENSE)
