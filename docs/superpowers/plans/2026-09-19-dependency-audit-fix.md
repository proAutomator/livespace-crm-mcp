# Dependency audit fix

## Failure and verified targets

CI run 35438588391 passed type checking and tests, then failed `bun audit`.
The same audit reproduced locally on Bun 1.3.14: nine advisories across
Hono, qs and fast-uri. The latter two come from the development-only MCP
conformance dependency tree.

| Package | Locked version | Target | Direct dependency |
|---|---|---|---|
| hono | 4.13.0 | 4.13.5 | Yes, keep an exact pin |
| qs | 6.15.3 | 6.16.0 | No |
| fast-uri | 3.1.5 | 3.1.6 | No |

The target versions exist in npm and declare no preinstall, install or
postinstall scripts. Their dependency requirements fit the existing tree.
Maintainer advisories identify the fixes:
[Hono](https://github.com/honojs/hono/security/advisories/GHSA-g6gw-c38x-mqfc),
[qs](https://github.com/ljharb/qs/security/advisories/GHSA-x5fp-wj9c-mxmx),
[fast-uri](https://github.com/fastify/fast-uri/security/advisories/GHSA-5jgf-p345-68v8).
The full audit, rather than these three example advisories, is the pass gate.

## Implementation

1. Use the reproduced failing audit as the regression check. No application
   behavior changes or new version-only unit tests are needed.
2. Run `bun update --ignore-scripts hono@4.13.5 qs@6.16.0 fast-uri@3.1.6`.
   Inspect `package.json` and `bun.lock`. Keep only Hono as a direct
   dependency; if this Bun version adds the named transitive packages to
   the manifest, remove those entries and reconcile with `bun install`.
   Preserve all other direct pins, security controls and CI steps.
3. Verify that only the three selected package resolutions changed. Use
   `bun install --frozen-lockfile --ignore-scripts` and `bun audit` to verify
   the lockfile and the corrected dependency tree.
4. Run `bun run typecheck` and the full `bun test` suite, including packaged
   artifact tests. Run the existing read-only sandbox smoke using Keychain
   credentials in memory. Keep credentials and real record data out of logs.
5. Commit the dependency fix on the existing PR #2 branch, push, update the
   PR description for the final scope and wait for CI on the new commit.
   Gitleaks, tests with audit, conformance and CodeQL must pass. No merge,
   version bump, release or changes to protection rules.
6. Record results here and in the local `.ai` handoff outside the repository.

## Execution notes

- Bun 1.3.14 treated named transitive updates as new direct dependencies and
  retained the vulnerable versions in nested resolutions. Removed the two
  added manifest entries and kept only the three new package records generated
  by Bun, including their registry integrity hashes, in the original lockfile.
  No other package resolution changed. A forced frozen-lockfile installation
  succeeded. Runtime resolution from Express and Ajv confirmed the fixed qs
  and fast-uri versions.
- `bun audit` now reports no vulnerabilities, down from nine. The full test
  run found one expected stale value: the package-contract test pinned Hono
  to 4.13.0. Updated that existing expectation to 4.13.5, retaining its exact
  dependency allowlist. No application code or audit thresholds changed.
- Type checking passed. The bounded sandbox reads for search and activity
  passed with schema and hint validation; no CRM writes or payload logging.
- Final full run: 1146 tests passed, zero failures across 43 files. Typecheck
  and `git diff --check` also passed. The follow-up commit goes to PR #2;
  its GitHub checks and the local maintainer handoff record remote CI results.
