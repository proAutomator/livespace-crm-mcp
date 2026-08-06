import { McpServer } from "@modelcontextprotocol/server";
import type { ServerConfig } from "../config/server-env.js";
import type { ActivityFetchers } from "../livespace/activity.js";
import type { RecordFetchers } from "../livespace/records.js";
import { buildInstructions } from "./instructions.js";
import {
  crmMetadataToolConfig,
  runCrmMetadata,
  type MetadataService,
} from "./tools/crm-metadata.js";
import { getActivityToolConfig, runGetActivity } from "./tools/get-activity.js";
import { getRecordsToolConfig, runGetRecords } from "./tools/get-records.js";
import { healthToolConfig, runHealthCheck } from "./tools/health.js";
import { searchCrmToolConfig, runSearchCrm } from "./tools/search-crm.js";

export interface AppDeps {
  config: ServerConfig;
  version: string;
  livespacePing?:
    | ((opts?: {
        signal?: AbortSignal;
      }) => Promise<{ name?: string; login?: string }>)
    | undefined;
  metadata?: MetadataService | undefined;
  records?: RecordFetchers | undefined;
  activity?: ActivityFetchers | undefined;
}

// The SDK surfaces the per-request context as the second callback argument;
// its exact shape is SDK-internal, so probe defensively for an AbortSignal.
function requestSignal(ctx: unknown): AbortSignal | undefined {
  if (ctx === null || typeof ctx !== "object") return undefined;
  const direct = (ctx as { signal?: unknown }).signal;
  if (direct instanceof AbortSignal) return direct;
  const mcpReq = (ctx as { mcpReq?: { signal?: unknown } }).mcpReq;
  if (mcpReq && mcpReq.signal instanceof AbortSignal) return mcpReq.signal;
  return undefined;
}

// Fresh server per request (SDK requirement for stateless HTTP). Tool
// registration happens here and nowhere else.
export function createServerFactory(deps: AppDeps): () => McpServer {
  return () => {
    const server = new McpServer(
      {
        name: "livespace-crm-mcp",
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

    server.registerTool("health", healthToolConfig, async (args, ctx) => {
      const result = await runHealthCheck(
        {
          version: deps.version,
          readOnly: deps.config.readOnly,
          ...(deps.livespacePing ? { livespacePing: deps.livespacePing } : {}),
        },
        args,
        { signal: requestSignal(ctx) },
      );
      return {
        content: [{ type: "text" as const, text: result.text }],
        structuredContent: result.structured,
        ...(result.structured.ok ? {} : { isError: true }),
      };
    });

    if (deps.metadata) {
      const metadata = deps.metadata;
      server.registerTool(
        "crm_metadata",
        crmMetadataToolConfig,
        async (args, ctx) => {
          const result = await runCrmMetadata(metadata, args, {
            signal: requestSignal(ctx),
          });
          return {
            content: [{ type: "text" as const, text: result.text }],
            structuredContent: result.structured,
            ...(result.isError ? { isError: true } : {}),
          };
        },
      );
    }

    // The read tools need the record fetchers; get_activity additionally needs
    // the activity ones. Each tool is only listed when it can actually answer.
    if (deps.records) {
      const records = deps.records;

      server.registerTool("search_crm", searchCrmToolConfig, async (args, ctx) => {
        const result = await runSearchCrm(records, args, {
          signal: requestSignal(ctx),
        });
        return {
          content: [{ type: "text" as const, text: result.text }],
          structuredContent: result.structured,
          ...(result.isError ? { isError: true } : {}),
        };
      });

      server.registerTool(
        "get_records",
        getRecordsToolConfig,
        async (args, ctx) => {
          // `activity` may be absent; the runner turns an includeWall request
          // into a BAD_PARAMS answer instead of failing the whole tool.
          const result = await runGetRecords(records, deps.activity, args, {
            signal: requestSignal(ctx),
          });
          return {
            content: [{ type: "text" as const, text: result.text }],
            structuredContent: result.structured,
            ...(result.isError ? { isError: true } : {}),
          };
        },
      );

      if (deps.activity) {
        const activity = deps.activity;
        server.registerTool(
          "get_activity",
          getActivityToolConfig,
          async (args, ctx) => {
            const result = await runGetActivity(records, activity, args, {
              signal: requestSignal(ctx),
            });
            return {
              content: [{ type: "text" as const, text: result.text }],
              structuredContent: result.structured,
              ...(result.isError ? { isError: true } : {}),
            };
          },
        );
      }
    }

    return server;
  };
}
