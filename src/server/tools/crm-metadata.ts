import * as z from "zod/v4";
import type { LivespaceClient } from "../../livespace/client.js";
import { LivespaceError } from "../../livespace/errors.js";
import {
  createMetadataFetchers,
  METADATA_SECTIONS,
  type MetadataSection,
  type SectionDataMap,
} from "../../livespace/metadata.js";
import { createTtlCache, type TtlCacheOptions } from "../cache.js";

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

  return {
    async get<S extends MetadataSection>(
      section: S,
      opts?: { signal?: AbortSignal },
    ): Promise<SectionResult<S>> {
      // The shared fetch runs without the caller signal; the cache races the
      // caller against it, so one abandoned request cannot cancel the others.
      const hit = await cache.get<SectionDataMap[S]>(
        section,
        () => fetchers[section](),
        opts?.signal ? { signal: opts.signal } : undefined,
      );
      return { data: hit.value, asOf: hit.asOf, stale: hit.stale };
    },
  };
}

const idName = z.object({ id: z.string(), name: z.string() });
const team = z.object({ id: z.string(), name: z.string(), roles: z.array(z.string()) });

const sectionData = z.union([
  z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      stages: z.array(
        z.object({ id: z.string(), name: z.string(), steps: z.array(idName) }),
      ),
    }),
  ),
  z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      email: z.string(),
      teams: z.array(team),
    }),
  ),
  z.array(idName),
  z.array(z.string()),
  z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      sku: z.string(),
      defaultPrice: z.string(),
    }),
  ),
  z.object({
    id: z.string().nullable(),
    name: z.string(),
    email: z.string(),
    position: z.string(),
    permissions: z.record(z.string(), z.boolean()),
    teams: z.array(team),
  }),
]);

const sectionEnvelope = z.object({
  asOf: z.number(),
  ageMs: z.number(),
  stale: z.boolean(),
  truncated: z.boolean(),
  totalItems: z.number().optional(),
  data: sectionData,
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
for a few minutes (see asOf/ageMs/stale per section).`,
  inputSchema: z.object({
    sections: z
      .array(z.enum(METADATA_SECTIONS))
      .min(1)
      .optional()
      .describe(
        "Dictionary sections to return (default: all). Fetch only what you need.",
      ),
  }),
  outputSchema: z.object({
    sections: z.partialRecord(z.enum(METADATA_SECTIONS), sectionEnvelope),
    errors: z.array(
      z.object({
        section: z.string(),
        code: z.string(),
        message: z.string(),
        hint: z.string(),
      }),
    ),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
} as const;

export interface CrmMetadataResult {
  text: string;
  structured: Record<string, unknown>;
  isError: boolean;
}

interface SectionEnvelope {
  asOf: number;
  ageMs: number;
  stale: boolean;
  truncated: boolean;
  totalItems?: number;
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
function sectionLine(outcome: SectionOutcome): string {
  if ("error" in outcome) {
    return `${outcome.section}: ERROR ${outcome.error.code} - ${outcome.error.hint}`;
  }
  const { envelope } = outcome;
  const staleMark = envelope.stale ? " (stale)" : "";
  if (envelope.totalItems === undefined) {
    return `${outcome.section}: ok${staleMark}`;
  }
  if (envelope.truncated) {
    const counts = `${SECTION_ITEM_CAP} of ${envelope.totalItems}`;
    return `${outcome.section}: ${counts} (truncated)${staleMark}`;
  }
  return `${outcome.section}: ${envelope.totalItems}${staleMark}`;
}

function cancelledError(): LivespaceError {
  return new LivespaceError(
    "CANCELLED",
    "The request was cancelled by the caller.",
    "Retry the call if the result is still needed.",
  );
}

export async function runCrmMetadata(
  service: MetadataService,
  args: { sections?: MetadataSection[] },
  opts: { signal?: AbortSignal; now?: () => number } = {},
): Promise<CrmMetadataResult> {
  const now = opts.now ?? (() => Date.now());
  const requested = canonicalSections(args.sections);
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
        return { section, envelope: buildEnvelope(result, now()) };
      } catch (error) {
        return { section, error: toSectionError(section, error) };
      }
    }),
  );

  const errors = outcomes.flatMap((outcome) =>
    "error" in outcome ? [outcome.error] : [],
  );
  if (errors.length === requested.length && errors.every((e) => e.code === "CANCELLED")) {
    throw cancelledError();
  }

  const sections: Record<string, SectionEnvelope> = {};
  for (const outcome of outcomes) {
    if ("envelope" in outcome) sections[outcome.section] = outcome.envelope;
  }

  const ok = outcomes.length - errors.length;
  const text = [
    `CRM metadata (${ok}/${requested.length} sections ok)`,
    ...outcomes.map(sectionLine),
  ].join("\n");

  return { text, structured: { sections, errors }, isError: ok === 0 };
}
