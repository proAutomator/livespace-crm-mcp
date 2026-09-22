# Host compatibility

Record data lives in `structuredContent`; `content` contains a short summary.
A useful host must pass the structured data to its model. Write execution
also needs form elicitation and a signed confirmation round trip. A host
that lists the tools has not necessarily passed either check.

## Tested on 2026-09-19

These checks used Codex CLI 0.154.0, Bun 1.3.14 and the working tree based on
server 0.1.1 with the guidance fixes. The fixture ran the production MCP app
with an in-memory backend. It had no Livespace client or credentials.

| Host mode | Observed protocol | Structured data | Write behavior |
|---|---|---|---|
| `codex exec`, default protocol setting | 2025-06-18 | Model reproduced the random note that appeared only in `structuredContent`. | Dry run and plain call returned previews. `confirm: true` failed with `BAD_PARAMS`; zero writes. |
| `codex exec --enable mcp_2026_07_28` | 2026-07-28 | Model reproduced the same structured-only note. | Dry run returned a preview. Plain call and `confirm: true` both completed with `declined: true`; zero writes. |

The second mode completed the confirmation round trip with a refusal in a
noninteractive process. It does **not** prove that a human saw a form or
could accept it. The CLI marks `mcp_2026_07_28` as an under-development
feature; it was enabled only for that test process.

The default mode used the SDK's older protocol path successfully for reads.
Do not infer that other legacy clients support writes from that result.
Codex Desktop, Claude and other interactive hosts remain unverified here.
Server contract tests separately cover signed acceptance, decline, changed
arguments, tampering and replay. Those tests do not certify a host's UI.

## Repeat with synthetic data

From a source checkout with dependencies installed, start:

```sh
bun run scripts/host-check.ts
```

The script ignores Livespace environment configuration. It binds to a free
loopback port, prints its URL and an expected random marker, then logs only
request transport metadata and in-memory write counts. Only person creation
is implemented; other write operations fail. Stop it with Ctrl+C after the
check. The fixture's public synthetic token must never protect a real CRM.

Run a separate CLI session. Replace `PORT` with the printed port and use an
empty working directory. Do not put the expected marker in the prompt.

```sh
codex exec --ignore-user-config --ignore-rules --ephemeral \
  --skip-git-repo-check --sandbox read-only \
  --disable apps --disable plugins --disable multi_agent \
  --disable shell_tool --disable browser_use --disable computer_use \
  -c 'web_search="disabled"' \
  -c 'mcp_servers.host_check.url="http://127.0.0.1:PORT/mcp"' \
  -c 'mcp_servers.host_check.http_headers={Authorization="Bearer synthetic-host-check-token-0123456789-abcd"}' \
  'Use only host_check for this synthetic compatibility test. Call get_records with kind person, ids ["person-synthetic-001"], detail full, and report the exact note. Call create_records with persons [{"firstname":"Synthetic Host Check"}] and dryRun true. Then call it without dryRun or confirm. If it returns a preview without an approval request, call it once with confirm true. Never approve a form yourself, invent requestState or enable unsafe compatibility. Report observed results and stop.'
```

Repeat with `--enable mcp_2026_07_28` to exercise the newer protocol path in
that CLI version. Compare the model's answer with the marker printed by the
fixture. A transcript containing structured data is insufficient on its own:
the answer must show that the model received it. Check the server's write
counter as well as the host's claimed outcome.

## Before enabling writes in an interactive host

Use the same synthetic fixture in the intended host and record its exact
version and protocol settings. Check the following with a human present:

1. A dry run shows the structured plan and does not open an approval form.
2. A plain write call shows a human approval form. Before accepting, the
   user can inspect the structured plan that the confirmation refers to.
   If the host hides that plan, the workflow is unsuitable for informed
   approval even if it can display a yes/no prompt.
3. Declining or dismissing the form leaves the counter at zero.
4. Accepting one new synthetic person produces exactly one in-memory write
   and a post-write result. The model cannot replace this step by supplying
   `confirm: true`.

Record these as separate outcomes. Do not mark interactive approval as
passed based on a noninteractive refusal or a simulated SDK acceptance.
Keep `MCP_ALLOW_UNBOUND_WRITE_CONFIRMATION` off during compatibility checks.
