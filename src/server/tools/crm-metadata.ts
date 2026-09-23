import * as z from "zod/v4";
import type { LivespaceClient } from "../../livespace/client.js";
import { cancelledError, LivespaceError } from "../../livespace/errors.js";
import {
  createMetadataFetchers,
  METADATA_SECTIONS,
  type CurrentUser,
  type MetadataSection,
  type SectionDataMap,
  type UserInfo,
} from "../../livespace/metadata.js";
import { createTtlCache, type TtlCacheOptions } from "../cache.js";
import { toolErrorSchema, type ToolRunResult } from "./tool-error.js";

/**
 * Per-section item cap. The dictionary endpoints ignore `limit` upstream (probe
 * evidence in metadata.ts), so this is where the context window and the load
 * discipline of docs/security.md par. 3 are protected.
 */
const SECTION_ITEM_CAP = 500;

const CACHE_DEFAULTS: TtlCacheOptions = {
  ttlMs: 5 * 60_000,
  staleMaxMs: 30 * 60_000,
  failureCooldownMs: 30_000,
};

export interface SectionResult<S extends MetadataSection = MetadataSection> {
  data: SectionDataMap[S];
  asOf: number;
  stale: boolean;
}

export interface MetadataService {
  get<S extends MetadataSection>(
    section: S,
    opts?: { signal?: AbortSignal },
  ): Promise<SectionResult<S>>;
}

/**
 * Joins the TTL cache to the upstream fetchers. One instance per process: the
 * cache state is what makes repeated dictionary reads cheap while the MCP
 * protocol layer stays stateless (docs/security.md par. 8).
 */
export function createMetadataService(
  client: Pick<LivespaceClient, "call">,
  cacheOpts?: Partial<TtlCacheOptions>,
): MetadataService {
  const fetchers = createMetadataFetchers(client);
  const cache = createTtlCache({ ...CACHE_DEFAULTS, ...cacheOpts });

  // The current user's id lives in the user list, which the `users` section
  // already caches - reading it through the cache keeps User_getAll at one
  // call per ttl (docs/security.md par. 3). Losing the id must not fail the
  // section, so any failure here resolves to null.
  async function resolveCurrentUserId(
    email: string,
    callerOpts?: { signal?: AbortSignal },
  ): Promise<string | null> {
    if (!email) return null;
    try {
      const users = await cache.get<UserInfo[]>(
        "users",
        () => fetchers.users(),
        callerOpts,
      );
      return users.value.find((user) => user.email === email)?.id ?? null;
    } catch {
      return null;
    }
  }

  return {
    async get<S extends MetadataSection>(
      section: S,
      opts?: { signal?: AbortSignal },
    ): Promise<SectionResult<S>> {
      const callerOpts = opts?.signal ? { signal: opts.signal } : undefined;
      try {
        // The shared fetch runs without the caller signal; the cache races the
        // caller against it, so one abandoned request cannot cancel the others.
        const hit = await cache.get<SectionDataMap[S]>(
          section,
          () => fetchers[section](),
          callerOpts,
        );
        if (section !== "currentUser") {
          return { data: hit.value, asOf: hit.asOf, stale: hit.stale };
        }
        const current = hit.value as CurrentUser;
        // Cached values are frozen, so the resolved id goes into a copy.
        const data = {
          ...current,
          id: await resolveCurrentUserId(current.email, callerOpts),
        } as SectionDataMap[S];
        return { data, asOf: hit.asOf, stale: hit.stale };
      } catch (error) {
        // The cache rejects an aborted caller with whatever the aborter passed
        // in - a DOMException, a plain Error, or a bare string. Only the signal
        // state is reliable, so that is what decides.
        if (opts?.signal?.aborted && !(error instanceof LivespaceError)) {
          throw cancelledError();
        }
        throw error;
      }
    },
  };
}

const idName = z.object({ id: z.string(), name: z.string() });
const team = z.object({ id: z.string(), name: z.string(), roles: z.array(z.string()) });

// One envelope type per section. A union would let a section validate against
// the wrong member and silently strip fields it does not know (products losing
// sku/defaultPrice, for one), so each section names its own shape.
const envelopeOf = <T extends z.ZodType>(data: T) =>
  z.object({
    asOf: z.number(),
    ageMs: z.number(),
    stale: z.boolean(),
    truncated: z.boolean(),
    totalItems: z.number().optional(),
    data,
  });

const processData = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    stages: z.array(
      z.object({ id: z.string(), name: z.string(), steps: z.array(idName) }),
    ),
  }),
);

const userData = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    teams: z.array(team),
  }),
);

const productData = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    sku: z.string(),
    defaultPrice: z.string(),
  }),
);

const currentUserData = z.object({
  id: z.string().nullable(),
  name: z.string(),
  email: z.string(),
  position: z.string(),
  permissions: z.record(z.string(), z.boolean()),
  teams: z.array(team),
});

const sectionsSchema = z.strictObject({
  processes: envelopeOf(processData).optional(),
  users: envelopeOf(userData).extend({ hint: z.string().optional() }).optional(),
  contactGroups: envelopeOf(z.array(idName)).optional(),
  dealGroups: envelopeOf(z.array(idName)).optional(),
  sources: envelopeOf(z.array(z.string())).optional(),
  taskTypes: envelopeOf(z.array(idName)).optional(),
  taskStatuses: envelopeOf(z.array(idName)).optional(),
  products: envelopeOf(productData).optional(),
  currentUser: envelopeOf(currentUserData).optional(),
});

export const crmMetadataToolConfig = {
  title: "CRM Metadata",
  description: `Read CRM dictionaries: processes (with stages and their checkbox steps),
users and teams, contact/deal groups, sources, task types and statuses,
products, and the current user. ALWAYS take ids from here instead of
guessing. Notes: deal stage changes happen by completing steps, not by
setting a stage directly; stages, steps and statuses are listed in their
CRM order; sources have no ids (names only); currentUser.id is null when it
cannot be resolved - then match currentUser.email in the users section.
Custom-field datasets are not available yet. Results are cached server-side
for a few minutes (see asOf/ageMs/stale per section). userQuery filters users
by a case-insensitive name or email substring, without accent folding or
searching teams. With userQuery, omitted sections means users only; explicit
sections must include users. All matching users are returned up to the cap;
resolve multiple matches before choosing an owner or notification recipient.
For queried users, totalItems counts matches in the cached dictionary before
the cap, not all CRM users.`,
  inputSchema: z.strictObject({
    sections: z
      .array(z.enum(METADATA_SECTIONS))
      .min(1)
      .optional()
      .describe(
        "Dictionary sections to return (default: users with userQuery, otherwise all). Fetch only what you need.",
      ),
    userQuery: z
      .string()
      .trim()
      .min(2)
      .max(100)
      .optional()
      .describe(
        "Name or email substring (2-100 characters after trimming), case-insensitive. " +
        "Filters users only; when sections is omitted, returns only users. " +
        "Resolve multiple matches before choosing a user.",
      ),
  }),
  outputSchema: z.object({
    sections: sectionsSchema,
    // One extra key on the shared shape: which section the failure belongs to.
    errors: z.array(toolErrorSchema.extend({ section: z.string() })),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
} as const;

export type CrmMetadataResult = ToolRunResult;

export interface CrmMetadataArgs {
  sections?: MetadataSection[];
  userQuery?: string;
}

interface SectionEnvelope {
  asOf: number;
  ageMs: number;
  stale: boolean;
  truncated: boolean;
  totalItems?: number;
  hint?: string;
  data: unknown;
}

interface SectionError {
  section: string;
  code: string;
  message: string;
  hint: string;
}

type SectionOutcome =
  | { section: MetadataSection; envelope: SectionEnvelope }
  | { section: MetadataSection; error: SectionError };

function canonicalSections(sections?: MetadataSection[]): MetadataSection[] {
  if (!sections) return [...METADATA_SECTIONS];
  const wanted = new Set(sections);
  return METADATA_SECTIONS.filter((section) => wanted.has(section));
}

function buildEnvelope(result: SectionResult, at: number): SectionEnvelope {
  const base = { asOf: result.asOf, ageMs: at - result.asOf, stale: result.stale };
  if (!Array.isArray(result.data)) {
    return { ...base, truncated: false, data: result.data };
  }
  const totalItems = result.data.length;
  const truncated = totalItems > SECTION_ITEM_CAP;
  return {
    ...base,
    truncated,
    totalItems,
    data: truncated ? result.data.slice(0, SECTION_ITEM_CAP) : result.data,
  };
}

// Only our own wording and the mapped {code, message, hint} of a LivespaceError
// reach the caller - never the text of an unexpected error (security.md par. 6).
function toSectionError(section: MetadataSection, error: unknown): SectionError {
  if (error instanceof LivespaceError) {
    return { section, code: error.code, message: error.message, hint: error.hint };
  }
  return {
    section,
    code: "UPSTREAM_ERROR",
    message: "Unexpected server error while loading this section.",
    hint: "Retry; report it on the issue tracker if it persists.",
  };
}

// Counts and fixed wording only: CRM-authored strings stay in structuredContent
// where the schema types them as data (security.md par. 4).
function sectionLine(outcome: SectionOutcome, queriedUsers: boolean): string {
  if ("error" in outcome) {
    return `${outcome.section}: ERROR ${outcome.error.code} - ${outcome.error.hint}`;
  }
  const { envelope } = outcome;
  const staleMark = envelope.stale ? " (stale)" : "";
  if (envelope.totalItems === undefined) {
    return `${outcome.section}: ok${staleMark}`;
  }
  const matching = outcome.section === "users" && queriedUsers ? " matching users" : "";
  const hint = envelope.hint ? `\n${envelope.hint}` : "";
  if (envelope.truncated) {
    const counts = `${SECTION_ITEM_CAP} of ${envelope.totalItems}`;
    return `${outcome.section}: ${counts}${matching} (truncated)${staleMark}${hint}`;
  }
  return `${outcome.section}: ${envelope.totalItems}${matching}${staleMark}${hint}`;
}

export async function runCrmMetadata(
  service: MetadataService,
  args: CrmMetadataArgs,
  opts: { signal?: AbortSignal; now?: () => number } = {},
): Promise<CrmMetadataResult> {
  const now = opts.now ?? (() => Date.now());
  const query = args.userQuery?.trim().toLowerCase();
  if (query !== undefined && args.sections !== undefined && !args.sections.includes("users")) {
    return {
      text: "CRM metadata: userQuery requires the users section. Include users in sections, or omit sections to search users only.",
      structured: {
        sections: {},
        errors: [{
          section: "users",
          code: "BAD_PARAMS",
          message: "userQuery requires the users section.",
          hint: "Include users in sections, or omit sections to search users only.",
        }],
      },
      isError: true,
    };
  }
  const requested = canonicalSections(args.sections ?? (query === undefined ? undefined : ["users"]));
  if (requested.length === 0) {
    return {
      text: "CRM metadata (0/0 sections ok)",
      structured: { sections: {}, errors: [] },
      isError: false,
    };
  }

  const callerOpts = opts.signal ? { signal: opts.signal } : undefined;
  // Every section settles inside its own try/catch: one failing dictionary
  // must not take the whole result down.
  const outcomes = await Promise.all(
    requested.map(async (section): Promise<SectionOutcome> => {
      try {
        const result = await service.get(section, callerOpts);
        // Filter a copy before the output cap; the shared cache must keep every
        // user for later queries and currentUser ID resolution.
        const selected = section === "users" && query !== undefined
          ? {
            ...result,
            data: (result.data as UserInfo[]).filter((user) =>
              user.name.toLowerCase().includes(query) || user.email.toLowerCase().includes(query)),
          }
          : result;
        const envelope = buildEnvelope(selected, now());
        if (section === "users" && query !== undefined && envelope.totalItems === 0) {
          envelope.hint = "No matching users in this dictionary snapshot. Check the name or email, " +
            "review asOf/ageMs/stale, and retry crm_metadata with userQuery if appropriate. " +
            "An empty result does not prove the user is absent from the CRM.";
        }
        return { section, envelope };
      } catch (error) {
        return { section, error: toSectionError(section, error) };
      }
    }),
  );

  const errors = outcomes.flatMap((outcome) =>
    "error" in outcome ? [outcome.error] : [],
  );
  if (
    errors.length > 0 &&
    errors.length === requested.length &&
    errors.every((e) => e.code === "CANCELLED")
  ) {
    throw cancelledError();
  }

  const sections: Record<string, SectionEnvelope> = {};
  for (const outcome of outcomes) {
    if ("envelope" in outcome) sections[outcome.section] = outcome.envelope;
  }

  const ok = outcomes.length - errors.length;
  const text = [
    `CRM metadata (${ok}/${requested.length} sections ok)`,
    ...outcomes.map((outcome) => sectionLine(outcome, query !== undefined)),
  ].join("\n");

  return { text, structured: { sections, errors }, isError: ok === 0 };
}
