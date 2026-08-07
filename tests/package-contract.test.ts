import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(ROOT, "dist/livespace-crm-mcp");
const EXPECTED_FILES = [
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "dist/livespace-crm-mcp",
  "package.json",
  "server.json",
] as const;
const ALL_TOOLS = [
  "health",
  "crm_metadata",
  "search_crm",
  "get_records",
  "get_activity",
  "analyze",
  "create_records",
  "update_records",
  "log_activities",
  "move_deals_to_stage",
  "notify_user",
] as const;
const READ_TOOLS = ALL_TOOLS.slice(0, 6);
const PROTOCOL = "2026-07-28";

let scratch = "";
let project = "";

interface CommandResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

function run(
  command: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): CommandResult {
  const spawnOptions = {
    cwd: options.cwd ?? ROOT,
    stdout: "pipe",
    stderr: "pipe",
    ...(options.env === undefined ? {} : { env: options.env }),
  } as const;
  return Bun.spawnSync(command, spawnOptions) as CommandResult;
}

function output(result: CommandResult): string {
  const decoder = new TextDecoder();
  return `${decoder.decode(result.stdout)}\n${decoder.decode(result.stderr)}`;
}

async function unusedPort(): Promise<number> {
  const reservation = Bun.serve({ port: 0, fetch: () => new Response("reserved") });
  const port = reservation.port;
  await reservation.stop(true);
  if (port === undefined) throw new Error("Bun did not assign a test port");
  return port;
}

async function waitForHealth(port: number, child: Bun.Subprocess): Promise<Response> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      const stderr = await new Response(
        child.stderr as ReadableStream<Uint8Array>,
      ).text();
      throw new Error(`packaged server exited before readiness: ${stderr}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return response;
    } catch {
      // The next bounded attempt handles normal startup latency.
    }
    await Bun.sleep(25);
  }
  throw new Error("packaged server did not become healthy");
}

function modernMeta(): Record<string, unknown> {
  return {
    "io.modelcontextprotocol/protocolVersion": PROTOCOL,
    "io.modelcontextprotocol/clientInfo": {
      name: "packed-artifact-test",
      version: "0.0.0-test",
    },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
}

async function modernCall(
  port: number,
  method: "tools/list",
  id: number,
): Promise<any> {
  const params = { _meta: modernMeta() };
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      host: `127.0.0.1:${port}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL,
      "mcp-method": method,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  expect(response.status).toBe(200);
  const text = await response.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  return JSON.parse(dataLine?.slice(6) ?? text);
}

async function initializeVersion(port: number): Promise<string | undefined> {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      host: `127.0.0.1:${port}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "packed-artifact-test", version: "0.0.0-test" },
      },
    }),
  });
  expect(response.status).toBe(200);
  const text = await response.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  const payload = JSON.parse(dataLine?.slice(6) ?? text);
  return payload.result?.serverInfo?.version;
}

function packagedEnvironment(port: number, readOnly: boolean): Record<string, string> {
  const required = ["PATH", "HOME", "TMPDIR"] as const;
  const inherited = Object.fromEntries(
    required.flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
  return {
    ...inherited,
    NO_COLOR: "1",
    MCP_PORT: String(port),
    LIVESPACE_SUBDOMAIN: "synthetic-workspace",
    LIVESPACE_API_KEY: "synthetic-key-package-test",
    LIVESPACE_API_SECRET: "synthetic-secret-package-test",
    LIVESPACE_MCP_READ_ONLY: String(readOnly),
  };
}

async function assertPackagedServer(readOnly: boolean): Promise<void> {
  const port = await unusedPort();
  const child = Bun.spawn(["bunx", "livespace-crm-mcp"], {
    cwd: project,
    env: packagedEnvironment(port, readOnly),
    stdout: "ignore",
    stderr: "pipe",
  });
  try {
    const health = await waitForHealth(port, child);
    expect(await health.json()).toMatchObject({ status: "ok", version: "0.1.0" });
    expect(await initializeVersion(port)).toBe("0.1.0");
    const listed = await modernCall(port, "tools/list", 2);
    expect(listed.result?.tools?.map((tool: any) => tool.name)).toEqual(
      readOnly ? READ_TOOLS : ALL_TOOLS,
    );
  } finally {
    child.kill("SIGTERM");
    await child.exited;
  }
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "livespace-crm-mcp-package-"));
  project = join(scratch, "consumer");
  await mkdir(project, { recursive: true });

  const built = run(["bun", "run", "build"]);
  expect(built.exitCode, output(built)).toBe(0);

  const packed = run([
    "npm",
    "pack",
    "--ignore-scripts",
    "--json",
    "--pack-destination",
    scratch,
    "--cache",
    join(scratch, "npm-cache"),
  ]);
  expect(packed.exitCode, output(packed)).toBe(0);
  const packResult = JSON.parse(new TextDecoder().decode(packed.stdout));
  const tarball = join(scratch, packResult[0].filename);

  await Bun.write(
    join(project, "package.json"),
    JSON.stringify({ name: "synthetic-package-consumer", private: true }),
  );
  const installed = run(["bun", "add", "--offline", tarball], {
    cwd: project,
    env: { ...process.env, TMPDIR: scratch },
  });
  expect(installed.exitCode, output(installed)).toBe(0);
});

afterAll(async () => {
  if (scratch !== "") await rm(scratch, { recursive: true, force: true });
});

describe("public npm package contract", () => {
  test("is public-ready with one Bun executable and exact runtime pins", async () => {
    const packageJson = await Bun.file(join(ROOT, "package.json")).json();
    expect(packageJson.private).toBeUndefined();
    expect(packageJson.description).toBe(
      "Unofficial local MCP server for Livespace CRM with read tools and guarded writes.",
    );
    expect(packageJson.mcpName).toBe("io.github.proAutomator/livespace-crm-mcp");
    expect(packageJson.bin).toEqual({ "livespace-crm-mcp": "dist/livespace-crm-mcp" });
    expect(packageJson.files).toEqual([
      "dist/livespace-crm-mcp",
      "README.md",
      "LICENSE",
      "SECURITY.md",
      "server.json",
    ]);
    expect(packageJson.engines).toEqual({ bun: ">=1.3.14" });
    expect(packageJson.repository).toEqual({
      type: "git",
      url: "git+https://github.com/proAutomator/livespace-crm-mcp.git",
    });
    expect(packageJson.homepage).toBe(
      "https://github.com/proAutomator/livespace-crm-mcp#readme",
    );
    expect(packageJson.bugs).toEqual({
      url: "https://github.com/proAutomator/livespace-crm-mcp/issues",
    });
    expect(packageJson.keywords).toEqual([
      "bun",
      "crm",
      "livespace",
      "mcp",
      "model-context-protocol",
    ]);
    expect(packageJson.scripts.build).toBe("bun run scripts/build-package.ts");
    expect(packageJson.scripts.prepack).toBe("bun run build");
    expect(packageJson.dependencies).toEqual({
      "@modelcontextprotocol/server": "2.0.0",
      hono: "4.13.0",
      zod: "4.4.3",
    });
    expect(packageJson.devDependencies).toEqual({
      "@types/bun": "1.3.14",
      typescript: "7.0.2",
    });
  });

  test("builds one executable Bun bundle with no source-tree imports", async () => {
    await chmod(BIN, 0o755);
    const text = await Bun.file(BIN).text();
    expect(text.startsWith("#!/usr/bin/env bun\n")).toBe(true);
    expect(text).not.toMatch(/(?:from|import\()\s*["'][^"']*src\//u);
    expect(text).not.toContain("../package.json");
  });

  test("packs the exact public runtime allowlist", () => {
    const result = run([
      "npm",
      "pack",
      "--ignore-scripts",
      "--dry-run",
      "--json",
      "--cache",
      join(scratch, "npm-cache"),
    ]);
    expect(result.exitCode, output(result)).toBe(0);
    const details = JSON.parse(new TextDecoder().decode(result.stdout))[0];
    const paths: string[] = details.files.map((file: any) => file.path as string);
    expect(paths.sort()).toEqual([...EXPECTED_FILES].sort());

    const forbidden = [
      /(^|\/)\.ai(\/|$)/u,
      /(^|\/)\.env(?:\.|\/|$)/u,
      /(^|\/)\.git(?:hub)?(\/|$)/u,
      /(^|\/)tests?(\/|$)/u,
      /(^|\/)docs?(\/|$)/u,
      /(^|\/)src(\/|$)/u,
      /(^|\/)scripts?(\/|$)/u,
      /(^|\/)(?:fixtures?|plans?)(\/|$)/u,
      /(?:^|\/)[^/]*\.log$/u,
      /(?:credential|secret|token)/iu,
    ];
    for (const pattern of forbidden) {
      expect(paths.some((path) => pattern.test(path)), String(pattern)).toBe(false);
    }
  });

  test("puts no credential values or secret defaults in public metadata", async () => {
    const serverJson = await Bun.file(join(ROOT, "server.json")).json();
    const inputs = serverJson.packages[0].environmentVariables;
    const secrets = inputs.filter((input: any) => input.isSecret === true);
    expect(secrets.map((input: any) => input.name)).toEqual([
      "LIVESPACE_API_KEY",
      "LIVESPACE_API_SECRET",
    ]);
    for (const input of secrets) {
      expect(input.value).toBeUndefined();
      expect(input.default).toBeUndefined();
      expect(input.placeholder).toBeUndefined();
    }

    const metadata = `${await Bun.file(join(ROOT, "package.json")).text()}\n${JSON.stringify(serverJson)}`;
    expect(metadata).not.toContain("synthetic-key");
    expect(metadata).not.toContain("synthetic-secret");
  });

  test("documents the public Bun package flow and local MCP endpoint", async () => {
    const readme = await Bun.file(join(ROOT, "README.md")).text();
    expect(readme).toContain("bunx livespace-crm-mcp");
    expect(readme).toContain("http://127.0.0.1:3020/mcp");
    expect(readme).toContain("Bun 1.3.14 or newer");
    expect(readme).toContain("LIVESPACE_SUBDOMAIN");
    expect(readme).toContain("LIVESPACE_API_KEY");
    expect(readme).toContain("LIVESPACE_API_SECRET");
    expect(readme).toContain("Streamable HTTP");
    expect(readme).toContain(
      "https://www.npmjs.com/package/livespace-crm-mcp/v/0.1.0",
    );
    expect(readme).toContain(
      "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.proAutomator%2Flivespace-crm-mcp/versions/0.1.0",
    );
  });

  test(
    "runs the installed artifact through the literal bunx command with all tools",
    async () => {
      await assertPackagedServer(false);
    },
    30_000,
  );

  test(
    "runs the installed artifact through bunx in read-only mode",
    async () => {
      await assertPackagedServer(true);
    },
    30_000,
  );
});
