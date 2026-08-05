export function buildInstructions(options: { readOnly: boolean }): string {
  const readOnlyNote = options.readOnly
    ? "\nNOTE: read-only mode is ON. Write tools are disabled and not listed.\n"
    : "";

  return `Unofficial MCP server for Livespace CRM. It exposes intent-shaped tools
instead of mirroring the raw API, adds server-side sorting and aggregation the
API lacks, and returns errors with recovery hints.
${readOnlyNote}
Quick start:
- Call the "health" tool first to confirm the server and (optionally, with
  checkLivespace: true) the Livespace connection are working.
- More tools (metadata, search, records, activity, analyze, writes) arrive in
  later milestones; each describes its own inputs.

CRITICAL - Livespace facts this server enforces for you:
- Deal status (open/won/lost) is NOT the same as the process stage. Stage
  changes happen by completing process steps; dedicated tools handle that.
- Record IDs from this API differ from the IDs visible in the Livespace UI.
  Never guess IDs; always take them from tool results.
- All operations run with the permissions of the API key's user. A
  "permission denied" error is a Livespace permission issue, not a bug.

Error handling: every error carries {code, message, hint}. Follow the hint -
it names the fix or the tool to call next.`;
}
