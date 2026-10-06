# Releasing

A release needs one human decision: approving the `npm-release` environment.
Everything after that approval runs in `.github/workflows/publish.yml`.

## Steps

1. **Release PR.** Bump the version in `package.json`, both `version` fields
   of `server.json`, the README version links and `bunx` pin, the supported
   versions in `SECURITY.md`, and the version pins in
   `tests/release-metadata.test.ts` and `tests/package-contract.test.ts`.
   Merge with rebase once CI is green, so each commit stays on `main`:
   `gh pr merge --repo proAutomator/livespace-crm-mcp <number> --rebase --match-head-commit <sha>`.
   Both `gh` commands start with `--repo`, so a maintainer can allow exactly
   these two prefixes for an agent in Claude Code permission rules.
2. **GitHub Release.** Create `vX.Y.Z` on the merge commit with release
   notes. `v*` tags are protected against update and deletion.

   ```bash
   gh release create --repo proAutomator/livespace-crm-mcp vX.Y.Z --target <sha> --title "vX.Y.Z - <summary>" --notes-file <notes.md>
   ```

3. **Approve `npm-release`.** Open the workflow run and use "Review
   deployments", or approve from a terminal with the run id and environment
   id that `pending_deployments` reports.
4. **Automatic.** The `publish` job checks that the tag matches
   `package.json`, then runs typecheck, tests and the build, and publishes
   to npm with provenance. The `registry` job waits until npm serves the
   new version, installs a pinned and checksum-verified `mcp-publisher`, and
   publishes `server.json` to the MCP Registry through GitHub OIDC. Neither
   job reads a stored secret.
5. **Verify.**
   - `npm view livespace-crm-mcp dist-tags` shows the new `latest`.
   - `https://registry.modelcontextprotocol.io/v0.1/servers/io.github.proAutomator%2Flivespace-crm-mcp/versions/latest`
     returns the new version. The Registry search endpoint can lag behind.
   - `bunx livespace-crm-mcp@X.Y.Z` starts, and `initialize` reports the
     new version.

## When the Registry job fails

Use "Re-run failed jobs" on the workflow run. The `registry` job is
separate, so a re-run never tries to publish the same npm version again. As
a fallback, publish from a checkout of the tag:

```bash
mcp-publisher login github
mcp-publisher publish
```

## Updating mcp-publisher

Change the version in the download URL of the `registry` job and the
`MCP_PUBLISHER_SHA256` value. Take the hash from
`registry_<version>_checksums.txt` of that release and confirm it matches the
release asset digest. Update `tests/release-workflow.test.ts` to match.
