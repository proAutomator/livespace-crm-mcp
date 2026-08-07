import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ServerConfig } from "../src/config/server-env.js";
import { buildApp } from "../src/server/app.js";

const VERSION = "0.1.1";
const PACKAGE_NAME = "livespace-crm-mcp";
const MCP_NAME = "io.github.proAutomator/livespace-crm-mcp";
const SCHEMA_URL =
  "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json";
const SCHEMA_SHA256 =
  "3fba09590c99f61735d234822279f4223fab9e300c0a81e81c91ab62a4114de0";

const CONFIG: ServerConfig = {
  port: 3020,
  bindHost: "127.0.0.1",
  readOnly: true,
  allowUnboundWriteConfirmation: false,
  allowedHostnames: ["localhost", "127.0.0.1", "[::1]"],
  allowedOriginHostnames: ["localhost", "127.0.0.1", "[::1]"],
  rateLimitPerMinute: 6000,
  rateLimitBurst: 1000,
  maxConcurrentRequests: 16,
  maxQueuedRequests: 32,
  requestIngressTimeoutMs: 10_000,
  requestExecutionTimeoutMs: 90_000,
};

async function jsonFile(path: string): Promise<any> {
  return Bun.file(new URL(path, import.meta.url)).json();
}

function resolveRef(schema: any, root: any): any {
  if (typeof schema?.$ref !== "string") return schema;
  if (!schema.$ref.startsWith("#/")) {
    throw new Error(`unsupported schema ref: ${schema.$ref}`);
  }
  return schema.$ref
    .slice(2)
    .split("/")
    .reduce((value: any, segment: string) => value?.[segment], root);
}

function schemaErrors(
  value: unknown,
  rawSchema: any,
  root: any,
  path = "$",
): string[] {
  const schema = resolveRef(rawSchema, root);
  if (!schema || typeof schema !== "object") return [`${path}: invalid schema node`];

  const errors: string[] = [];
  if (Array.isArray(schema.allOf)) {
    for (const child of schema.allOf) {
      errors.push(...schemaErrors(value, child, root, path));
    }
  }
  if (Array.isArray(schema.anyOf)) {
    const alternatives = schema.anyOf.map((child: any) =>
      schemaErrors(value, child, root, path),
    );
    if (!alternatives.some((alternative: string[]) => alternative.length === 0)) {
      errors.push(`${path}: did not match anyOf`);
    }
  }
  if (schema.not && schemaErrors(value, schema.not, root, path).length === 0) {
    errors.push(`${path}: matched forbidden schema`);
  }
  if (Object.hasOwn(schema, "const") && value !== schema.const) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path}: expected one of ${schema.enum.join(", ")}`);
  }

  if (schema.type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${path}: expected object`);
      return errors;
    }
    const object = value as Record<string, unknown>;
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(object, required)) errors.push(`${path}.${required}: required`);
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(object, key)) {
        errors.push(...schemaErrors(object[key], child, root, `${path}.${key}`));
      }
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) {
      errors.push(`${path}: expected array`);
      return errors;
    }
    if (schema.items) {
      value.forEach((item, index) => {
        errors.push(...schemaErrors(item, schema.items, root, `${path}[${index}]`));
      });
    }
  } else if (schema.type === "string") {
    if (typeof value !== "string") {
      errors.push(`${path}: expected string`);
      return errors;
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: shorter than ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${path}: longer than ${schema.maxLength}`);
    }
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) {
      errors.push(`${path}: did not match ${schema.pattern}`);
    }
    if (schema.format === "uri") {
      try {
        new URL(value);
      } catch {
        errors.push(`${path}: invalid URI`);
      }
    }
  } else if (schema.type === "boolean" && typeof value !== "boolean") {
    errors.push(`${path}: expected boolean`);
  } else if (schema.type === "number" && typeof value !== "number") {
    errors.push(`${path}: expected number`);
  }
  return errors;
}

async function initializeVersion(): Promise<string | undefined> {
  const app = buildApp({ config: CONFIG, version: VERSION });
  const response = await app.fetch(new Request("http://127.0.0.1:3020/mcp", {
    method: "POST",
    headers: {
      host: "127.0.0.1:3020",
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
        clientInfo: { name: "release-metadata-test", version: "0.0.0-test" },
      },
    }),
  }));
  expect(response.status).toBe(200);
  const body = await response.text();
  const dataLine = body.split("\n").find((line) => line.startsWith("data: "));
  const payload = JSON.parse(dataLine?.slice(6) ?? body);
  return payload.result?.serverInfo?.version;
}

describe("public release metadata", () => {
  test("keeps one exact public identity across package, Registry and MCP initialize", async () => {
    const packageJson = await jsonFile("../package.json");
    const serverJson = await jsonFile("../server.json");

    expect(packageJson.name).toBe(PACKAGE_NAME);
    expect(packageJson.version).toBe(VERSION);
    expect(packageJson.mcpName).toBe(MCP_NAME);
    expect(serverJson.name).toBe(MCP_NAME);
    expect(serverJson.version).toBe(VERSION);
    expect(serverJson.packages).toHaveLength(1);
    expect(serverJson.packages[0].identifier).toBe(PACKAGE_NAME);
    expect(serverJson.packages[0].version).toBe(VERSION);
    expect(await initializeVersion()).toBe(VERSION);
  });

  test("is valid against the pinned official Registry schema", async () => {
    const schemaFile = Bun.file(
      new URL("./fixtures/mcp-server-schema-2025-12-11.json", import.meta.url),
    );
    const schemaText = await schemaFile.text();
    expect(createHash("sha256").update(schemaText).digest("hex")).toBe(SCHEMA_SHA256);

    const schema = JSON.parse(schemaText);
    const serverJson = await jsonFile("../server.json");
    expect(schema.$id).toBe(SCHEMA_URL);
    expect(serverJson.$schema).toBe(SCHEMA_URL);
    expect(schemaErrors(serverJson, schema, schema)).toEqual([]);
  });

  test("declares a loopback Streamable HTTP package and only safe inputs", async () => {
    const serverJson = await jsonFile("../server.json");
    const entry = serverJson.packages[0];
    expect(entry.registryType).toBe("npm");
    expect(entry.registryBaseUrl).toBe("https://registry.npmjs.org");
    expect(entry.runtimeHint).toBeUndefined();
    expect(entry.transport).toEqual({
      type: "streamable-http",
      url: "http://127.0.0.1:{MCP_PORT}/mcp",
      headers: [
        {
          name: "Authorization",
          value: "Bearer {MCP_AUTH_TOKEN}",
        },
      ],
    });
    expect(entry.transport.url.replace("{MCP_PORT}", "41230")).toBe(
      "http://127.0.0.1:41230/mcp",
    );

    const inputs = Object.fromEntries(
      entry.environmentVariables.map((input: any) => [input.name, input]),
    );
    expect(Object.keys(inputs)).toEqual([
      "MCP_PORT",
      "LIVESPACE_SUBDOMAIN",
      "LIVESPACE_API_KEY",
      "LIVESPACE_API_SECRET",
      "MCP_AUTH_TOKEN",
      "LIVESPACE_MCP_ENABLE_WRITES",
      "MCP_REQUEST_STATE_KEY",
    ]);
    expect(inputs.MCP_PORT.default).toBe("3020");
    expect(inputs.LIVESPACE_SUBDOMAIN).toMatchObject({
      isRequired: true,
      isSecret: false,
    });
    expect(inputs.LIVESPACE_API_KEY).toMatchObject({
      isRequired: true,
      isSecret: true,
    });
    expect(inputs.LIVESPACE_API_SECRET).toMatchObject({
      isRequired: true,
      isSecret: true,
    });
    expect(inputs.MCP_AUTH_TOKEN).toMatchObject({
      isRequired: true,
      isSecret: true,
    });
    expect(inputs.LIVESPACE_MCP_ENABLE_WRITES).toMatchObject({
      format: "boolean",
      default: "false",
      isRequired: false,
    });
    expect(inputs.MCP_REQUEST_STATE_KEY).toMatchObject({
      isRequired: false,
      isSecret: true,
    });
    expect(inputs.MCP_BIND_HOST).toBeUndefined();
  });

  test("uses the stable public repository identity and a concise description", async () => {
    const serverJson = await jsonFile("../server.json");
    expect(serverJson.repository).toEqual({
      url: "https://github.com/proAutomator/livespace-crm-mcp",
      source: "github",
      id: "1324035008",
    });
    expect(serverJson.description.length).toBeGreaterThan(0);
    expect(serverJson.description.length).toBeLessThanOrEqual(100);
  });
});
