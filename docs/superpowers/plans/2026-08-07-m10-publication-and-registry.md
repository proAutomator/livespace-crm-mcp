# M10 - Public Release and MCP Registry Plan (rev. 2 after package audit)

> **For agentic workers:** Kuba authorized the recommended M10 release sequence
> on 2026-08-07, including the public GitHub flip, npm publication, tag and
> release, Registry publication, final README update, commit and push. This does
> not authorize a message to Livespace. That still needs a reviewed recipient,
> timing and wording.

**Goal:** Turn the tested Bun project into a reproducible public package, then
publish its metadata to the official MCP Registry under the authorization
recorded above.

**Recommended distribution:** a public npm package named
`livespace-crm-mcp`, launched locally with `bunx` and reached over Streamable
HTTP on loopback. The official `server.json` schema allows Streamable HTTP as a
package transport. A Node adapter, stdio adapter, Workers deployment and shared
remote service are not Registry prerequisites.

**Why not a hosted remote:** v1 loads one Livespace credential pair and serves
one authenticated principal. A shared public deployment would expose one CRM
account or require a new multi-user credential architecture. Local execution
keeps each operator's CRM credentials on that operator's machine.

**Compatibility caveat:** schema support does not prove that every downstream
MCP host can launch `bunx` and then connect to a local HTTP port. The clean
package, direct URL flow and official conformance suite are tested. README does
not claim automatic launch support. A host that accepts only stdio is not
supported; a Bun stdio adapter remains a possible follow-up. Node is optional.

## Evidence collected on 2026-08-07

- GitHub repository `proAutomator/livespace-crm-mcp` is private. Its stable
  repository id is `1324035008`; serialize it as the JSON string
  `"1324035008"`. Description, homepage and topics are empty.
- GitHub owner `proAutomator` is a User, so the proposed Registry name is
  `io.github.proAutomator/livespace-crm-mcp`.
- npm returned 404 for `livespace-crm-mcp`; the name appears unclaimed but is
  not reserved until publication.
- The Registry returned no entry for the proposed name; it is likewise not
  reserved until publication.
- `package.json` now defines `livespace-crm-mcp@0.1.0`, the Registry ownership
  marker, one Bun bin and an exact six-file package allowlist.
- Two independent history reviews covered 101 reachable commits and five
  unreachable commits. Pinned gitleaks 8.18.4 found no leak in history or the
  worktree. The public-flip gate still fetches every ref and repeats the scan.
- M9 gates: 1102 full tests and 887 focused security tests pass, typecheck and
  audit pass, and the sandbox smoke passes.

## Current official requirements

- The Registry hosts metadata, not code. A server needs a public installation
  artifact or a public remote endpoint:
  [Registry overview](https://modelcontextprotocol.io/registry/about).
- npm packages must carry an `mcpName` exactly matching `server.json`:
  [package verification](https://modelcontextprotocol.io/registry/package-types).
- The current schema is
  [`2025-12-11/server.schema.json`](https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json).
  Recheck it immediately before publication because the Registry is still in
  preview.
- GitHub authentication permits `io.github.username/*` namespaces:
  [authentication](https://modelcontextprotocol.io/registry/authentication).
- Published metadata is immutable for a version, and the Registry currently
  has no normal unpublish operation:
  [versioning](https://modelcontextprotocol.io/registry/versioning) and
  [FAQ](https://modelcontextprotocol.io/registry/faq).

## Global constraints

- Default execution stays on `127.0.0.1`; do not make a package install bind
  publicly.
- Never put a credential value in package metadata, a package archive, GitHub,
  npm, Registry metadata, logs or release notes.
- Keep `MCP_AUTH_TOKEN` optional on loopback and preserve the fail-closed
  non-loopback rules.
- Release metadata and the package archive must contain no `.ai/`, tests,
  plans, `.env`, logs, real CRM data or development-only fixtures.
- Use exact versions. Keep `package.json`, `server.json`, the MCP initialize
  response, Git tag and release version synchronized.
- Use the existing Git identity if Kuba asks for a commit. Add no Codex author,
  signature, attribution or co-author trailer.
- No automatic publication trigger in the first release. Every external
  publication needs approval. Recheck current Actions health immediately before
  release rather than carrying an old billing assumption forward.

---

### Task 0: Integrate the moving remote safely

**Produces:** M10 starts from one known commit without losing the M9 worktree or
the user-authored README edits.

- [x] Inspect `HEAD`, `origin/main` and the worktree before touching Git.
- [x] Preserve the current remote title and author byline.
- [x] After Kuba asks for the M9 commit, integrate the current remote tip with a
  non-destructive rebase or merge, resolve README only from explicit evidence,
  then rerun all M9 gates.
- [x] Record the final base commit. Do not use `reset --hard` or discard a dirty
  file.

### Approval gate 1: Release identity and local packaging

Before any version-bearing file changes, Kuba chooses `0.1.0` or `1.0.0`,
confirms `io.github.proAutomator/livespace-crm-mcp`, and authorizes the local
package plus manifest work. Values written before this decision are only notes,
not release metadata.

**Recorded:** Kuba chose the recommended M10 path on 2026-08-07. The release is
`livespace-crm-mcp@0.1.0` with Registry name
`io.github.proAutomator/livespace-crm-mcp`.

### Task 1: Define and test the public package contract

**Files:**

- Modify: `package.json`
- Modify: `README.md`
- Create: a Bun executable entry point under `src/` or `bin/`
- Create: release-metadata and package-contract tests under `tests/`

**Recommended release identity:** `livespace-crm-mcp@0.1.0`, Registry name
`io.github.proAutomator/livespace-crm-mcp`. Version `0.1.0` matches the current
pre-1.0 security policy. Kuba can choose `1.0.0` only by explicitly declaring
the external contract stable.

- [x] Add failing tests for one exact version and Registry name across package
  metadata, server metadata and the MCP initialize response.
- [x] Make the npm package public-ready: remove `private: true`; add `mcpName`,
  `bin`, `files`, repository, homepage, bugs, keywords, description and Bun
  engine metadata.
- [x] Expose exactly one bin named `livespace-crm-mcp`. Test the literal public
  command `bunx livespace-crm-mcp`, not only a path under `node_modules/.bin`.
- [x] Add a build that produces a Bun executable without source-tree imports.
  Preserve exact dependency pins and fail the build if the bin lacks its Bun
  shebang.
- [x] Keep the executable behavior identical to `bun run dev`: read config from
  environment, bind loopback by default and expose `/mcp` plus `/health`.
- [x] Update README requirements, installation and configuration for the exact
  `bunx livespace-crm-mcp` package flow, local Streamable HTTP endpoint and
  release version. Add contract tests so README cannot drift from the package.
- [x] Do not add Node or Workers merely to satisfy Registry metadata.

### Task 2: Prove the package archive and clean install

**Produces:** the package is installable from its tarball and contains only the
public runtime and required docs.

- [x] Build, then inspect `npm pack --dry-run --json` against an exact allowlist.
- [x] Assert the archive excludes `.ai/`, `.git/`, `.github/`, tests, plan docs,
  `.env`, logs, local credentials and source fixtures.
- [x] Create the real tarball in a temporary directory and install it into a
  separate empty temporary project.
- [x] Launch the installed bin with synthetic config on a dedicated loopback
  port. Assert `/health`, modern `tools/list`, exact 11-tool order and read-only
  six-tool order.
- [x] Launch with sandbox credentials only for the final read-only ping. Never
  package or print those credentials.
- [x] No named host configuration was placed in scope. The packed artifact
  passed the official MCP conformance baseline and a clean `.env` plus `bunx`
  Streamable HTTP smoke. README states that clients may need the process
  started separately and that stdio-only clients are not supported. No real
  host configuration was touched.

### Task 3: Create and validate `server.json`

**Files:**

- Create: `server.json`
- Extend: release-metadata tests

- [x] Use the current official schema URL, proposed Registry name, title,
  description of at most 100 characters, version and repository id as the JSON
  string `"1324035008"`.
- [x] Point the package entry to the exact npm package and version, with package
  transport `streamable-http`. Omit `runtimeHint`: the current Registry schema
  accepts arbitrary strings, but official client code does not recognize
  `bunx` as a launch hint.
- [x] Make the transport URL loopback-only. If it uses `{MCP_PORT}`, declare
  `MCP_PORT` in `packages[].environmentVariables` with the JSON string default
  `"3020"`; package transports resolve those inputs and do not have their own
  `variables` map. Test the substitution.
- [x] Declare the three required Livespace inputs. Mark API key and secret as
  secrets. Offer read-only mode as an optional boolean. Do not solicit a public
  bind through Registry metadata.
- [x] Validate against the pinned JSON Schema without network access in the
  normal test suite. Re-download and compare the official schema immediately
  before publication.
- [x] Assert package `mcpName`, package version, Registry version and package
  entry version are character-for-character equal.

### Task 4: Public-history and GitHub readiness audit

**Produces:** a written go or no-go verdict before changing visibility.

- [x] Fetch every remote branch and tag. Compare GitHub's live remote tip with
  local refs.
- [x] Run the checksum-pinned gitleaks scan across every fetched ref and a
  separate no-git scan of the worktree.
- [x] Inspect unreachable objects if any credential or CRM data was ever
  removed locally. Review committed `.env*`, logs, generated artifacts and
  fixtures explicitly.
- [x] Verify every commit author e-mail is intended to become public.
- [x] Review issue, PR, discussion, Actions log and artifact visibility; repo
  variables, environments, deploy keys, webhooks and collaborators.
- [x] Confirm the public security contact in `SECURITY.md`.
- [x] Prepare, but do not apply, GitHub description, homepage and topics.
- [x] Prepare, but do not apply, branch protection, secret scanning, push
  protection and any production Environment. Query fresh Actions runs and
  record their real status immediately before release.

### Approval gate 2: GitHub public flip

Kuba explicitly authorizes changing the repository from private to public.
After the flip, verify anonymous clone, README, license, security contact,
history and GitHub security settings before publishing another artifact.

### Approval gate 3: GitHub metadata and security settings

Kuba separately authorizes changing description, homepage, topics, branch
protection, secret scanning, push protection and any GitHub Environment. Gate 2
does not imply this authority.

### Approval gate 4: Tag and GitHub Release

Kuba explicitly authorizes the version tag, push and GitHub Release. A tag is
not required by the Registry protocol but provides source provenance.

### Approval gate 5: npm authentication and publication

Kuba explicitly authorizes any required `npm login`, token or provenance setup,
2FA/OTP step and `npm publish --access public`. Never print or persist a token
or OTP in the repository, shell history, logs or plan. Verify the exact package
version, archive contents, ownership marker and clean installation from the
public registry before continuing.

### Approval gate 6: Registry authentication

Kuba explicitly authorizes GitHub OAuth or, if automated publication is later
chosen and a fresh Actions check is green, GitHub OIDC. A later workflow should
use only `contents: read` and `id-token: write` and a manually reviewed
production environment.

### Approval gate 7: Immutable Registry publication

Kuba explicitly authorizes `mcp-publisher publish`. Recheck the current schema,
publisher release and official terms first. After publication, query the exact
name and version, then test the installation data a downstream client receives.

### Task 5: Livespace heads-up

- [ ] Draft a short Polish note that links the public repository, states that
  the project is unofficial, names its security posture and asks Livespace for
  factual corrections rather than endorsement.
- [ ] Kuba reviews the recipient, timing and wording.
- [ ] Send nothing until Kuba explicitly authorizes the external message.

## Done gate

- Public source and package reproduce the same tested 11-tool server.
- Package archive and clean-install smoke are green.
- Full tests, focused security suite, typecheck, audit, conformance and sandbox
  read smoke are green on the release commit.
- Full fetched history and release worktree pass gitleaks.
- README, `package.json`, `server.json`, initialize response, tag and release
  agree on name and version.
- The Registry entry resolves and describes the exact package version.
- Every external action has Kuba's recorded approval.

## Execution notes

### Local release gate - 2026-08-07

- Release identity: npm `livespace-crm-mcp@0.1.0`; Registry
  `io.github.proAutomator/livespace-crm-mcp`; repository id `"1324035008"`.
- The package has one executable, `dist/livespace-crm-mcp`, built as a Bun ESM
  bundle with a Bun shebang and no source-tree imports.
- `mcp-publisher validate` passed against the live official Registry service.
  The normal test suite also validates against a pinned copy of schema
  `2025-12-11` with SHA-256
  `3fba09590c99f61735d234822279f4223fab9e300c0a81e81c91ab62a4114de0`.
- The final pre-publication tarball contains exactly `LICENSE`, `README.md`,
  `SECURITY.md`, `dist/livespace-crm-mcp`, `package.json` and `server.json`.
  No source, test, fixture, plan, `.env`, `.ai`, Git metadata or log is present.
  Its npm integrity is
  `sha512-i8QTjzUcWA0pHHY7wiNJBYcabtURhrOSRxB9ohVAsr2WjZV1lHd5Z6x24CT2vdB0jZ7Tmnu38LngFpc2PAlMjw==`.
- A checksum-verified gitleaks 8.18.4 scan of the extracted tarball passed with
  both the default rules and repository policy. Targeted secret-shape and local
  path scans also found no credential value or developer path.
- Clean tarball install passed. Literal `bunx livespace-crm-mcp` exposed all 11
  tools, read-only mode exposed six, and the README `.env` flow started on
  loopback with read-only enabled.
- Independent static review found two medium runtime issues before publication:
  a configured bearer token could be shorter than 32 bytes and authentication
  failures bypassed limiting; a replacement Request made after body buffering
  dropped client cancellation. Both findings were reproduced with failing
  tests, fixed at their narrow boundaries and re-reviewed without a bypass.
  Failed auth now uses one constant-cardinality bucket independent of valid
  traffic, and the forwarded request preserves the original signal.
- Gates: 1116 full tests, 890 focused security tests, typecheck, dependency
  audit, package dry-run, official conformance baseline and the sandbox
  read-only smoke all passed. Sandbox output was suppressed.
- npm authentication is active as `proautomator`. No token or OTP was read,
  printed or written to the repository.

### Publication status

The package and documentation are ready for the external release sequence.
GitHub visibility, public npm publication, tag and GitHub Release, and MCP
Registry publication are recorded below as they happen. The Livespace message
remains outside the authorized scope until Kuba reviews its recipient, timing
and wording.

Task 0 completed after Kuba explicitly requested the M9 commit. M9 was committed
as `593abae` with his configured Git identity, rebased onto `origin/main`
`0b74675`, and left unpushed. The 887-test security suite, 1102-test full suite,
typecheck and diff-check passed again after rebase. The pre-commit audit,
sandbox smoke and leak scans remain green evidence for the same M9 content.

No M10 package metadata, manifest, GitHub visibility, tag, release, npm
publication, Registry authentication/publication or Livespace message was
created in this turn.
