import {
  McpServer,
  isInputRequiredResult,
  type CallToolResult,
  type InputRequiredResult,
  type RequestStateCodec,
  type StandardSchemaWithJSON,
  type ToolCallback,
} from "@modelcontextprotocol/server";
import type * as z from "zod/v4";
import type { ServerConfig } from "../config/server-env.js";
import type { ActivityFetchers } from "../livespace/activity.js";
import type { RecordFetchers } from "../livespace/records.js";
import type { WriteFetchers } from "../livespace/writes.js";
import { buildInstructions } from "./instructions.js";
import { analyzeToolConfig, runAnalyze } from "./tools/analyze.js";
import {
  createRecordsToolConfig,
  runCreateRecords,
  type WriteToolOptions,
} from "./tools/create-records.js";
import {
  crmMetadataToolConfig,
  runCrmMetadata,
  type MetadataService,
} from "./tools/crm-metadata.js";
import { getActivityToolConfig, runGetActivity } from "./tools/get-activity.js";
import { getRecordsToolConfig, runGetRecords } from "./tools/get-records.js";
import { healthToolConfig, runHealthCheck } from "./tools/health.js";
import { logActivitiesToolConfig, runLogActivities } from "./tools/log-activities.js";
import { searchCrmToolConfig, runSearchCrm } from "./tools/search-crm.js";
import type { ToolRunResult } from "./tools/tool-error.js";
import { updateRecordsToolConfig, runUpdateRecords } from "./tools/update-records.js";
import { buildWriteCodec, type WriteState } from "./tools/write-support.js";

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
  /** Absent in read-only mode: `index.ts` does not even build them there. */
  writes?: WriteFetchers | undefined;
}

/**
 * Everything the write tools need, resolved ONCE per process.
 *
 * The codec is the reason this is not decided per request: round two of a
 * confirmation must verify what round one minted, and a codec built per
 * request would fall back to a fresh random key and refuse every confirmation
 * (docs/security.md par. 5).
 */
interface WriteSetup {
  writes: WriteFetchers;
  records: RecordFetchers;
  metadata: MetadataService;
  activity?: ActivityFetchers;
  codec: RequestStateCodec<WriteState>;
}

/**
 * The write surface exists only when the kill-switch is off AND every
 * dependency it needs is present: the write fetchers, the record fetchers a
 * post-write re-read goes through, and the metadata service a deal's process id
 * is validated against. Anything missing leaves the three tools unregistered -
 * absent from `tools/list` and refused on a direct call.
 */
function resolveWriteSetup(deps: AppDeps): WriteSetup | undefined {
  if (deps.config.readOnly) return undefined;
  const { writes, records, metadata } = deps;
  if (writes === undefined || records === undefined || metadata === undefined) {
    return undefined;
  }
  return {
    writes,
    records,
    metadata,
    ...(deps.activity === undefined ? {} : { activity: deps.activity }),
    codec: buildWriteCodec(deps.config),
  };
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
  const writing = resolveWriteSetup(deps);
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
        // A confirmation the client echoes back is attacker-controlled input:
        // the seam verifies its signature before the handler runs and answers
        // the frozen -32602 when it fails. Configured only where write tools
        // exist - no write surface, no state to verify.
        ...(writing === undefined
          ? {}
          : { requestState: { verify: writing.codec.verify } }),
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

    // Every read tool is registered the same way: run it, then wrap the
    // dual-channel result. Only the runner differs, so the wrapping lives once.
    // `health` stays hand-written - it reports failure from its own payload.
    //
    // `run` takes the input schema's OWN output type, so a tool whose schema
    // and Args interface drift apart is a compile error at the call site below.
    // The SDK types its callback through a conditional on the schema type,
    // which stays unresolved while `S` is generic - hence the one cast here,
    // and nowhere else.
    const register = <S extends z.ZodType & StandardSchemaWithJSON>(
      name: string,
      config: { inputSchema: S; outputSchema: StandardSchemaWithJSON },
      run: (args: z.output<S>, signal: AbortSignal | undefined) => Promise<ToolRunResult>,
    ): void => {
      const handler = async (args: z.output<S>, ctx: unknown): Promise<CallToolResult> => {
        const result = await run(args, requestSignal(ctx));
        return {
          content: [{ type: "text" as const, text: result.text }],
          structuredContent: result.structured,
          ...(result.isError ? { isError: true } : {}),
        };
      };
      server.registerTool<StandardSchemaWithJSON, S>(
        name,
        config,
        handler as ToolCallback<S>,
      );
    };

    /**
     * The same wrapping for a write tool, plus the one difference that matters:
     * a write may answer with an input-required result instead of a tool
     * result. That is the SDK's own vocabulary - it travels untouched, and only
     * a tool result gets the dual-channel treatment. The handler also receives
     * the request context, which carries the client's capabilities, the human's
     * answer and the verified confirmation state.
     */
    const registerWrite = <S extends z.ZodType & StandardSchemaWithJSON>(
      name: string,
      config: { inputSchema: S; outputSchema: StandardSchemaWithJSON },
      run: (
        args: z.output<S>,
        opts: WriteToolOptions,
      ) => Promise<ToolRunResult | InputRequiredResult>,
    ): void => {
      const handler = async (
        args: z.output<S>,
        ctx: unknown,
      ): Promise<CallToolResult | InputRequiredResult> => {
        const signal = requestSignal(ctx);
        const result = await run(args, { ...(signal === undefined ? {} : { signal }), ctx });
        if (isInputRequiredResult(result)) return result;
        return {
          content: [{ type: "text" as const, text: result.text }],
          structuredContent: result.structured,
          ...(result.isError ? { isError: true } : {}),
        };
      };
      server.registerTool<StandardSchemaWithJSON, S>(
        name,
        config,
        handler as ToolCallback<S>,
      );
    };

    if (deps.metadata) {
      const metadata = deps.metadata;
      register("crm_metadata", crmMetadataToolConfig, (args, signal) =>
        runCrmMetadata(metadata, args, { signal }),
      );
    }

    // The read tools need the record fetchers; get_activity additionally needs
    // the activity ones. Each tool is only listed when it can actually answer.
    if (deps.records) {
      const records = deps.records;

      register("search_crm", searchCrmToolConfig, (args, signal) =>
        runSearchCrm(records, args, { signal }),
      );

      // `activity` may be absent; the runner turns an includeWall request into a
      // BAD_PARAMS answer instead of failing the whole tool.
      register("get_records", getRecordsToolConfig, (args, signal) =>
        runGetRecords(records, deps.activity, args, { signal }),
      );

      if (deps.activity) {
        const activity = deps.activity;
        register("get_activity", getActivityToolConfig, (args, signal) =>
          runGetActivity(records, activity, args, { signal }),
        );
      }

      // `analyze` sweeps deals, the feed and tasks, and reads the processes
      // dictionary for stage names and order - so it needs all three deps.
      if (deps.activity && deps.metadata) {
        const activity = deps.activity;
        const metadata = deps.metadata;
        register("analyze", analyzeToolConfig, (args, signal) =>
          runAnalyze(records, activity, metadata, args, { signal }),
        );
      }
    }

    // The write tools come last, and only when `resolveWriteSetup` said so.
    if (writing !== undefined) {
      const { writes, records, metadata, codec } = writing;

      registerWrite("create_records", createRecordsToolConfig, (args, opts) =>
        runCreateRecords({ writes, records, metadata, codec }, args, opts),
      );

      registerWrite("update_records", updateRecordsToolConfig, (args, opts) =>
        runUpdateRecords({ writes, records, codec }, args, opts),
      );

      // A logged note or call is verified through the target record's wall, so
      // this one needs the activity fetchers the same way `get_activity` does.
      if (writing.activity !== undefined) {
        const activity = writing.activity;
        registerWrite("log_activities", logActivitiesToolConfig, (args, opts) =>
          runLogActivities({ writes, records, activity, codec }, args, opts),
        );
      }
    }

    return server;
  };
}
