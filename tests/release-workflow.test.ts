import { describe, expect, test } from "bun:test";

/**
 * The release path runs on one human decision: the `npm-release` approval.
 * Everything after it (npm with provenance, then the MCP Registry through
 * GitHub OIDC) must stay automatic, keyless and pinned. Text checks keep this
 * free of a YAML dependency; each one names the line a change would break.
 */

const MCP_PUBLISHER_VERSION = "1.8.1";
/** From registry_1.8.1_checksums.txt, matched by the release asset digest. */
const MCP_PUBLISHER_SHA256 =
  "a06c9096dcb9727c13555b6be26c7effa707b01f06a4c561ba7a3635443cf2cc";

async function workflow(): Promise<string> {
  return Bun.file(new URL("../.github/workflows/publish.yml", import.meta.url)).text();
}

function job(text: string, name: string): string {
  const start = text.indexOf(`\n  ${name}:\n`);
  expect(start, `job ${name}`).toBeGreaterThan(-1);
  const rest = text.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/u);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe("release workflow", () => {
  test("npm publishing stays behind the protected npm-release approval", async () => {
    const publish = job(await workflow(), "publish");
    expect(publish).toContain("environment: npm-release");
    expect(publish).toContain("npm publish --access public --provenance");
  });

  test("the Registry entry follows npm automatically through GitHub OIDC", async () => {
    const registry = job(await workflow(), "registry");
    expect(registry).toContain("needs: publish");
    // Registry validation reads the npm package, so the version must resolve first.
    expect(registry).toContain('npm view "livespace-crm-mcp@${VERSION}" version');
    expect(registry).toContain("mcp-publisher login github-oidc");
    expect(registry).toContain("mcp-publisher publish");
  });

  test("mcp-publisher is a pinned, checksum-verified download", async () => {
    const registry = job(await workflow(), "registry");
    expect(registry).toContain(
      `releases/download/v${MCP_PUBLISHER_VERSION}/mcp-publisher_linux_amd64.tar.gz`,
    );
    expect(registry).toContain(MCP_PUBLISHER_SHA256);
    expect(registry).toContain("sha256sum -c -");
  });

  test("the release path reads no stored secret", async () => {
    expect(await workflow()).not.toContain("secrets.");
  });
});
