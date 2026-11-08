import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MAP_FILES = [
  "tests/config/server-env.test.ts",
  "tests/server/http.test.ts",
  "tests/server/idle-timeout.test.ts",
  "tests/server/body-limit.test.ts",
  "tests/server/limits.test.ts",
  "tests/server/write-registration.test.ts",
  "tests/livespace/client.test.ts",
  "tests/livespace/writes.test.ts",
  "tests/server/modern-wire.test.ts",
  "tests/livespace/metadata.test.ts",
  "tests/server/tools/crm-metadata.test.ts",
  "tests/livespace/records.test.ts",
  "tests/livespace/activity.test.ts",
  "tests/livespace/aggregate-windows.test.ts",
  "tests/server/tools/search-crm.test.ts",
  "tests/server/tools/get-activity.test.ts",
  "tests/server/analyze.test.ts",
  "tests/config/env.test.ts",
  "tests/livespace/v2/client.test.ts",
  "tests/livespace/v2/problems.test.ts",
  "tests/livespace/v2/budget.test.ts",
  "tests/server/tools/tool-error.test.ts",
] as const;

const SECURITY_GATE_FILES = [
  "tests/security-contract.test.ts",
  ...MAP_FILES,
  "tests/server/auth.test.ts",
  "tests/server/write-support.test.ts",
  "tests/server/create-records.test.ts",
  "tests/server/update-records.test.ts",
  "tests/server/log-activities.test.ts",
  "tests/server/move-deals-to-stage.test.ts",
  "tests/server/notify-user.test.ts",
] as const;

async function repoFile(path: string): Promise<string> {
  return Bun.file(new URL(`../${path}`, import.meta.url)).text();
}

describe("docs/security.md section 10 contract", () => {
  test("maps all twenty-two numbered requirements to their regression proofs", async () => {
    const security = await repoFile("docs/security.md");
    const rows = [...security.matchAll(/^\|\s*(\d+)\s*\|/gmu)].map(
      (match) => Number(match[1]),
    );
    expect(rows).toEqual(Array.from({ length: 22 }, (_, index) => index + 1));
    for (const path of MAP_FILES) expect(security).toContain(`\`${path}\``);
    expect(security).toContain("`bun run test:security`");
  });

  test("states the bounded exception for endpoints without a usable limit", async () => {
    const [security, agents] = await Promise.all([
      repoFile("docs/security.md"),
      repoFile("AGENTS.md"),
    ]);
    for (const text of [security, agents]) {
      const prose = text.replace(/\s+/gu, " ");
      expect(prose).toContain("where the endpoint supports it");
      expect(prose).toContain("`Todo/getTodoObjects`");
      expect(prose).toContain("fixed 50-row pages");
    }
    expect(security).not.toContain(
      "explicit `limit` on every list call (the API defaults",
    );
    expect(agents).not.toContain("always send an explicit `limit`");
  });

  test("states the API v2 key model, load discipline and error hygiene", async () => {
    const security = (await repoFile("docs/security.md")).replace(/\s+/gu, " ");
    // Requirement 6 and 8 name the v2 path builder and page size.
    expect(security).toMatch(/6\. user-supplied IDs[^|]*`v2Path`/u);
    expect(security).toMatch(/8\. `analyze` and list-style calls[^|]*`perPage`/u);
    for (const phrase of [
      "integration user",
      "`LIVESPACE_V2_SHARED_ACCESS=acknowledged`",
      "`LIVESPACE_V2_DAILY_RESERVE`",
      "`Authorization` header",
      "`crm:sales-process:write`",
      "`Idempotency-Key`",
    ]) {
      expect(security).toContain(phrase);
    }
  });

  test("no source file sends a DELETE request", async () => {
    const glob = new Bun.Glob("src/**/*.ts");
    const root = fileURLToPath(new URL("../", import.meta.url));
    let scanned = 0;
    for await (const path of glob.scan({ cwd: root })) {
      scanned += 1;
      const source = await Bun.file(join(root, path)).text();
      expect(source, path).not.toMatch(/["']delete["']/iu);
    }
    expect(scanned).toBeGreaterThan(20);
  });

  test("the focused security command includes every contract file", async () => {
    const pkg = JSON.parse(await repoFile("package.json")) as {
      scripts?: Record<string, string>;
    };
    const command = pkg.scripts?.["test:security"];
    expect(command).toBeDefined();
    for (const path of SECURITY_GATE_FILES) expect(command).toContain(path);
  });
});
