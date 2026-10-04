# Dependency audit fix (October 2026)

## Failure and verified targets

On 2026-10-01 `bun audit` on Bun 1.3.14 reports 18 advisories (4 high,
11 moderate, 3 low) that were absent at the last green CI run on 2026-09-23.
`package.json` and `bun.lock` are identical on `main` and on the
`feat/read-tool-usability` branch, so every branch inherits the failure and
the next push fails the `Dependency audit` step of the test job.

| Package | Locked version | Target | Path | Direct dependency |
|---|---|---|---|---|
| hono | 4.13.5 | 4.13.7 | direct; also conformance > sdk > @hono/node-server | Yes, keep an exact pin |
| fast-uri | 3.1.6 | 3.1.8 | conformance > sdk > ajv | No |
| ip-address | 10.4.0 | 10.7.1 | conformance > sdk > express-rate-limit | No |
| undici | 7.29.0 | 7.29.1 | conformance | No |

The `bun audit` group headers (`fast-uri <3.1.7`, `ip-address <=10.5.0`)
show only the range of the first advisory in each group. The advisories
themselves need more:

- [GHSA-hrr3-gc8f-f4qj](https://github.com/fastify/fast-uri/security/advisories/GHSA-hrr3-gc8f-f4qj)
  affects fast-uri `>=3.0.0 <3.1.8`, so 3.1.7 is not enough.
- [GHSA-j6r3-76f7-8jcv](https://github.com/beaugunderson/ip-address/security/advisories/GHSA-j6r3-76f7-8jcv)
  and [GHSA-h3mg-xc3c-68pw](https://github.com/beaugunderson/ip-address/security/advisories/GHSA-h3mg-xc3c-68pw)
  affect ip-address `<=10.7.0`, so 10.5.1 is not enough.

Sources checked for all 18 IDs: the GitHub global advisory API, the
maintainers' repository advisories, and the npm bulk advisory endpoint that
`bun audit` queries. The GitHub API reports no advisory affecting any of the
four targets; the npm bulk endpoint returns `{}` for them. The ip-address
v10.7.0...v10.7.1 compare shows both security fixes (cross-family subnet
check, input length bound) merged from the advisory forks, although the
release notes list only a lockfile bump.

All four targets exist on npm, have no dependencies and declare no
preinstall, install or postinstall scripts. Each fits the declared parent
range: `hono` `^4` and `^4.11.4`, `fast-uri` `^3.0.1`, `ip-address`
`^10.2.0`, `undici` `^7.19.0`. The lockfile holds a single copy of each
package, so no nested resolutions are involved.

Maintainer advisories:
[Hono](https://github.com/honojs/hono/security/advisories/GHSA-hxh3-vqpv-xpqv),
[fast-uri](https://github.com/fastify/fast-uri/security/advisories/GHSA-qw65-cvwx-89v3)
(plus GHSA-58mr-gqgx-xq4g and GHSA-hrr3-gc8f-f4qj),
[ip-address](https://github.com/beaugunderson/ip-address/security/advisories/GHSA-rpw4-54j3-4h4q)
(plus GHSA-2vr4-cq9g-pvrc, GHSA-j6r3-76f7-8jcv, GHSA-h3mg-xc3c-68pw),
[undici](https://github.com/nodejs/undici/releases/tag/v7.29.1) (ten
advisories listed in the v7.29.1 release). The full audit, not this list, is
the pass gate.

Exposure note: the Hono advisory is an XSS in `hono/jsx` boundary
components. This server does not import `hono/jsx`, so the bump closes the
audit gate rather than a reachable bug. The other three packages are only in
the development-only MCP conformance tree and are not bundled into the
published binary.

## Implementation

1. Use the reproduced failing audit as the regression check. No application
   behavior changes and no new version-only unit tests.
2. Run the named update in a scratch copy of `package.json` and `bun.lock`,
   so the repository manifest is not rewritten:
   `bun update --ignore-scripts hono@4.13.7 fast-uri@3.1.8 ip-address@10.7.1 undici@7.29.1`.
   Take only the four package records Bun generates, with their registry
   integrity hashes, and apply them to the original lockfile together with
   the Hono pin in the workspace block. Cross-check every integrity hash
   against the npm registry metadata.
3. Bump the exact Hono pin in `package.json` to 4.13.7 and the existing
   package-contract expectation in `tests/package-contract.test.ts`. Keep
   exactly three runtime dependencies; transitive packages must not become
   direct dependencies.
4. Verify that only the four package resolutions changed. From a clean
   `node_modules`, run `bun install --frozen-lockfile --ignore-scripts`, then
   `bun audit`, and confirm runtime resolution from the parent packages
   (`ajv`, `express-rate-limit`, conformance, `@hono/node-server`).
5. Run `bun run typecheck`, `bun test`, `bun run test:security` and the
   read-only sandbox smoke (`bun run smoke`, Keychain service
   `livespace-api`, sandbox only). Keep credentials and record data out of
   logs.
6. The working tree already holds uncommitted work for
   `fix/deal-value-steps-created-filter`. This fix touches a disjoint set of
   files, so it can be committed on its own. Repeat install, audit, typecheck
   and tests on a clean export of `HEAD` plus only these files, to show the
   fix does not depend on the unrelated work.
7. No commit, push, version bump or release without the maintainer's
   request. Record results here and in the local `.ai` handoff.

## Execution notes

- Bun 1.3.14 repeated the September behavior. The named update in the
  scratch copy added `fast-uri`, `ip-address` and `undici` as direct
  dependencies and kept vulnerable nested copies
  (`@modelcontextprotocol/sdk/hono` 4.13.5, `ajv/fast-uri` 3.1.6,
  `express-rate-limit/ip-address` 10.4.0, `@modelcontextprotocol/conformance/undici`
  7.29.0). None of that reached the repository. A small script copied the
  four generated top-level records and the workspace Hono pin into the
  original lockfile, failing on anything other than exactly one match per
  replacement. The lockfile diff is five lines. All four integrity hashes
  match `dist.integrity` from the npm registry.
- `tests/package-contract.test.ts` pins the runtime dependencies exactly.
  Its Hono expectation was changed first and failed against the old
  manifest. Then the manifest was bumped. The manifest still lists exactly
  three runtime dependencies.
- Clean state: `node_modules` removed and `bun install --frozen-lockfile`
  (the CI command) run against an empty, session-local Bun cache, so every
  tarball was downloaded and checked against the lockfile. The install left
  the lockfile untouched. There are no nested copies of the four packages.
  Resolving through each parent package's own `require` gives the patched
  copies: `ajv` to fast-uri 3.1.8, `express-rate-limit` to ip-address 10.7.1,
  conformance to undici 7.29.1, `@hono/node-server`, the SDK and the app to
  hono 4.13.7.
- `bun audit`: "No vulnerabilities found", down from 18. `bun run typecheck`
  passed. `bun test` passed 1200 tests in 43 files with zero failures.
  `bun run test:security` passed 971 tests in 26 files. `git diff --check`
  passed. These counts include the uncommitted
  `fix/deal-value-steps-created-filter` work in the same tree.
- Isolation check (step 6): `git archive HEAD` plus only `package.json`,
  `bun.lock` and the contract test gave a frozen install, zero audit
  findings, a passing typecheck, 1168 tests and 943 security tests, all
  passing. 1168 matches the last recorded count for `22ccc0e`.
- The CI conformance job ran locally with the same synthetic credentials and
  limits: 5 scenarios passed and 25 failed, all listed in
  `conformance-baseline.yml` ("Baseline check passed"). This run used the
  updated development tree (undici, the SDK with ajv/fast-uri and
  express-rate-limit/ip-address) against a server on Hono 4.13.7.
- Sandbox, read only, Keychain service `livespace-api`, no `LIVESPACE_*`
  environment overrides: `bun run smoke` printed `ping: OK`,
  `identity: OK`, `smoke: OK`. The smoke script does not go through Hono,
  so a server on a separate loopback port was started with
  `LIVESPACE_MCP_READ_ONLY=true`. The SDK client called `health`,
  `search_crm` (3 deals, minimal) and `get_activity` (feed, 3 entries)
  through it. All three returned schema-validated `structuredContent` with
  no errors. Only status flags and counts were printed. No writes, and no
  credentials or record data in logs.
- The maintainer chose a separate pull request to `main`. The four files
  were applied to a worktree of `origin/main` (`877df79`) on the branch
  `fix/dependency-audit-2026-10`, leaving the deal-value work uncommitted in
  the original tree. On that base, a cold frozen install left the lockfile
  untouched. The audit found nothing, and typecheck passed. 1146 tests and
  925 security tests passed; 1146 matches the September count for `main`.
  Conformance matched the baseline. The sandbox smoke and the three
  read-only server calls passed again.
- No version bump or release.
