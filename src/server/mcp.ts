import { McpServer } from "@modelcontextprotocol/server";
import type { ServerConfig } from "../config/server-env.js";
import { buildInstructions } from "./instructions.js";
import { healthToolConfig, runHealthCheck } from "./tools/health.js";

export interface AppDeps {
  config: ServerConfig;
  version: string;
  livespacePing?: (() => Promise<{ name?: string; login?: string }>) | undefined;
}

// Fresh server per request (SDK requirement for stateless HTTP). Tool
// registration happens here and nowhere else.
export function createServerFactory(deps: AppDeps): () => McpServer {
  return () => {
    const server = new McpServer(
      {
        name: "livespace-streamable-mcp-server",
        title: "Livespace CRM (unofficial)",
        version: deps.version,
        description:
          "Unofficial MCP server for Livespace CRM: intent-shaped tools, " +
          "server-side aggregation, errors with recovery hints.",
      },
      {
        instructions: buildInstructions({ readOnly: deps.config.readOnly }),
        cacheHints: {
          "server/discover": { ttlMs: 60_000, cacheScope: "private" },
          "tools/list": { ttlMs: 60_000, cacheScope: "private" },
        },
      },
    );

    server.registerTool("health", healthToolConfig, async (args) => {
      const result = await runHealthCheck(
        {
          version: deps.version,
          readOnly: deps.config.readOnly,
          ...(deps.livespacePing ? { livespacePing: deps.livespacePing } : {}),
        },
        args,
      );
      return {
        content: [{ type: "text" as const, text: result.text }],
        structuredContent: result.structured,
        ...(result.structured.ok ? {} : { isError: true }),
      };
    });

    return server;
  };
}
