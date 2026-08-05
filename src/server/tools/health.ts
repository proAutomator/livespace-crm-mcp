import * as z from "zod/v4";

export const PROTOCOL_VERSION = "2026-07-28";

export interface HealthDeps {
  version: string;
  readOnly: boolean;
  livespacePing?: (opts?: {
    signal?: AbortSignal;
  }) => Promise<{ name?: string; login?: string }>;
}

export interface HealthArgs {
  checkLivespace?: boolean;
}

export interface HealthResult {
  text: string;
  structured: {
    ok: boolean;
    version: string;
    protocol: string;
    readOnly: boolean;
    livespace?: { reachable: boolean; user?: string };
  };
}

export const healthToolConfig = {
  title: "Server Health",
  description:
    "Check that this MCP server is up. Pass checkLivespace: true to also " +
    "verify the Livespace API connection (one lightweight call).",
  inputSchema: z.object({
    checkLivespace: z
      .boolean()
      .optional()
      .describe(
        "Also ping Livespace with the configured credentials (default false)",
      ),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    version: z.string(),
    protocol: z.string(),
    readOnly: z.boolean(),
    livespace: z
      .object({ reachable: z.boolean(), user: z.string().optional() })
      .optional(),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
} as const;

export async function runHealthCheck(
  deps: HealthDeps,
  args: HealthArgs,
  opts: { signal?: AbortSignal } = {},
): Promise<HealthResult> {
  const lines: string[] = [];
  let ok = true;
  let livespace: { reachable: boolean; user?: string } | undefined;

  if (args.checkLivespace === true && deps.livespacePing) {
    try {
      const me = await deps.livespacePing(
        opts.signal === undefined ? {} : { signal: opts.signal },
      );
      livespace =
        me.name === undefined
          ? { reachable: true }
          : { reachable: true, user: me.name };
      lines.push(`Livespace: reachable${me.name ? ` as ${me.name}` : ""}.`);
    } catch (error) {
      ok = false;
      livespace = { reachable: false };
      const hint =
        typeof error === "object" && error !== null && "hint" in error
          ? String((error as { hint: unknown }).hint)
          : "Check credentials and connectivity.";
      lines.push(`Livespace: NOT reachable. ${hint}`);
    }
  }

  lines.unshift(
    `Server ${ok ? "ok" : "degraded"} (v${deps.version}, protocol ${PROTOCOL_VERSION})` +
      (deps.readOnly ? ", read-only mode" : ""),
  );

  return {
    text: lines.join("\n"),
    structured: {
      ok,
      version: deps.version,
      protocol: PROTOCOL_VERSION,
      readOnly: deps.readOnly,
      ...(livespace === undefined ? {} : { livespace }),
    },
  };
}
