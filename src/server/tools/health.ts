import * as z from "zod/v4";
import { LivespaceError } from "../../livespace/errors.js";
import type { RateLimitSnapshot } from "../../livespace/v2/budget.js";
import {
  actingUserHint,
  type ActingUserLookup,
  type IntegrationUser,
} from "../../livespace/v2/metadata.js";

export const PROTOCOL_VERSION = "2026-07-28";

/** What `checkLivespace` needs; absent when no API v2 client is wired. */
export interface HealthLivespaceDeps {
  /** `GET /users/me`, exempt from the daily reserve. */
  v2Ping: (opts?: { signal?: AbortSignal }) => Promise<IntegrationUser>;
  rateLimit: () => RateLimitSnapshot;
  dailyReserve: number;
  /** Matches the configured e-mail against the cached user dictionary. */
  actingUser: (opts?: { signal?: AbortSignal }) => Promise<ActingUserLookup>;
}

export interface HealthDeps {
  version: string;
  readOnly: boolean;
  /** True when the optional v1 key pair is configured. */
  v1Fallback: boolean;
  livespace?: HealthLivespaceDeps;
}

export interface HealthArgs {
  checkLivespace?: boolean;
}

interface LivespaceHealth {
  reachable: boolean;
  integrationUser?: string;
  timeZone?: string;
  actingUser?: string | null;
  dailyRemaining?: number | null;
  dailyReserve: number;
  hint?: string;
}

export interface HealthResult {
  text: string;
  structured: {
    ok: boolean;
    version: string;
    protocol: string;
    readOnly: boolean;
    backend: { api: "v2"; v1Fallback: boolean };
    livespace?: LivespaceHealth;
  };
}

export const healthToolConfig = {
  title: "Server Health",
  description:
    "Check that this MCP server is up. Pass checkLivespace: true to also " +
    "verify the Livespace API v2 connection (one lightweight call): it reports " +
    "the integration user of the key and its time zone, the user this server " +
    "acts for (null when none is configured or matched), and how many requests " +
    "are left in the account's daily API budget next to the configured reserve.",
  inputSchema: z.strictObject({
    checkLivespace: z
      .boolean()
      .optional()
      .describe(
        "Also call Livespace API v2 with the configured key (default false)",
      ),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    version: z.string(),
    protocol: z.string(),
    readOnly: z.boolean(),
    backend: z.object({ api: z.literal("v2"), v1Fallback: z.boolean() }),
    livespace: z
      .object({
        reachable: z.boolean(),
        integrationUser: z.string().optional(),
        timeZone: z.string().optional(),
        actingUser: z.string().nullable().optional(),
        dailyRemaining: z.number().nullable().optional(),
        dailyReserve: z.number(),
        hint: z.string().optional(),
      })
      .optional(),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
} as const;

const UNREACHABLE_HINT = "Check LIVESPACE_API_V2_KEY, LIVESPACE_SUBDOMAIN and connectivity.";

function budgetLine(dailyRemaining: number | null, reserve: number): string {
  const left = dailyRemaining === null ? "unknown" : String(dailyRemaining);
  return `Daily API budget: ${left} requests left (reserve ${reserve}).`;
}

async function checkLivespace(
  deps: HealthLivespaceDeps,
  signal: AbortSignal | undefined,
): Promise<{ health: LivespaceHealth; lines: string[] }> {
  const callOpts = signal === undefined ? {} : { signal };
  const { dailyReserve } = deps;

  let me: IntegrationUser;
  try {
    me = await deps.v2Ping(callOpts);
  } catch (error) {
    // Only a LivespaceError carries our own fixed wording; the text of
    // anything else may echo an upstream body (docs/security.md par. 6).
    const hint = error instanceof LivespaceError ? error.hint : UNREACHABLE_HINT;
    return {
      health: {
        reachable: false,
        dailyRemaining: deps.rateLimit().dailyRemaining,
        dailyReserve,
        hint,
      },
      lines: [`Livespace API v2: NOT reachable. ${hint}`],
    };
  }

  // Read after the ping, so the count is the one that response carried.
  const dailyRemaining = deps.rateLimit().dailyRemaining;
  const hints: string[] = [];
  // The login, the time zone and the user's name are CRM-authored text: they
  // stay in structuredContent, where the schema types them as data
  // (docs/security.md par. 4). The lines below are fixed wording and numbers.
  const lines = ["Livespace API v2: reachable.", budgetLine(dailyRemaining, dailyReserve)];
  if (dailyReserve > 0 && dailyRemaining !== null && dailyRemaining <= dailyReserve) {
    hints.push(
      "The daily API budget is at or below the reserve: the other tools refuse " +
        "new Livespace requests until the reset at 00:00 UTC.",
    );
  }

  let acting: ActingUserLookup;
  try {
    acting = await deps.actingUser(callOpts);
  } catch {
    acting = { state: "unknown", user: null };
  }
  const actingHint = actingUserHint(acting.state);
  if (actingHint === undefined) lines.push("Acting user: resolved.");
  else hints.push(actingHint);

  lines.push(...hints);
  return {
    health: {
      reachable: true,
      ...(me.login === "" ? {} : { integrationUser: me.login }),
      ...(me.timeZone === "" ? {} : { timeZone: me.timeZone }),
      // Absent when the lookup failed: "no such user" would be a guess.
      ...(acting.state === "unknown" ? {} : { actingUser: acting.user?.name ?? null }),
      dailyRemaining,
      dailyReserve,
      ...(hints.length === 0 ? {} : { hint: hints.join(" ") }),
    },
    lines,
  };
}

export async function runHealthCheck(
  deps: HealthDeps,
  args: HealthArgs,
  opts: { signal?: AbortSignal } = {},
): Promise<HealthResult> {
  const lines: string[] = [];
  let ok = true;
  let livespace: LivespaceHealth | undefined;

  if (args.checkLivespace === true && deps.livespace !== undefined) {
    const checked = await checkLivespace(deps.livespace, opts.signal);
    livespace = checked.health;
    ok = checked.health.reachable;
    lines.push(...checked.lines);
  }

  lines.unshift(
    `Server ${ok ? "ok" : "degraded"} (v${deps.version}, protocol ${PROTOCOL_VERSION}, ` +
      `Livespace API v2${deps.v1Fallback ? " with the v1 fallback" : ""})` +
      (deps.readOnly ? ", read-only mode" : ""),
  );

  return {
    text: lines.join("\n"),
    structured: {
      ok,
      version: deps.version,
      protocol: PROTOCOL_VERSION,
      readOnly: deps.readOnly,
      backend: { api: "v2", v1Fallback: deps.v1Fallback },
      ...(livespace === undefined ? {} : { livespace }),
    },
  };
}
