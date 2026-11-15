import * as z from "zod/v4";
import { cancelledError, LivespaceError } from "../../livespace/errors.js";
import { CALL_BUDGETS, CallBudget } from "../../livespace/v2/budget.js";
import type { LivespaceV2Client } from "../../livespace/v2/client.js";
import {
  actingUserHint,
  createV2MetadataFetchers,
  findActingUser,
  V2_METADATA_SECTIONS,
  type ActingUserLookup,
  type CurrentUserV2,
  type CustomFieldInfo,
  type CustomFieldKind,
  type Fetched,
  type UserInfo,
  type V2MetadataSection,
  type V2SectionDataMap,
} from "../../livespace/v2/metadata.js";
import { createTtlCache, type CacheHit, type TtlCacheOptions } from "../cache.js";
import { toolErrorSchema, toToolError, type ToolError, type ToolRunResult } from "./tool-error.js";

/**
 * Per-section item cap of the answer. The fetchers already bound what they
 * read upstream (explicit `perPage`, a page cap); this bounds what one tool
 * result puts into the context window (docs/security.md par. 3).
 */
const SECTION_ITEM_CAP = 500;

const CACHE_DEFAULTS: TtlCacheOptions = {
  ttlMs: 5 * 60_000,
  staleMaxMs: 30 * 60_000,
  failureCooldownMs: 30_000,
};

export interface SectionResult<S extends V2MetadataSection = V2MetadataSection> {
  data: V2SectionDataMap[S];
  asOf: number;
  stale: boolean;
  /** The upstream page cap cut the list short. */
  truncated: boolean;
  /** Fixed wording for the model, e.g. why there is no acting user. */
  hint?: string;
}

export interface MetadataCallOptions {
  signal?: AbortSignal;
  /** The tool call's request budget; a fetch this call starts spends it. */
  budget?: CallBudget;
}

export interface MetadataService {
  get<S extends V2MetadataSection>(
    section: S,
    opts?: MetadataCallOptions,
  ): Promise<SectionResult<S>>;
  /**
   * The user `LIVESPACE_ACTING_USER_EMAIL` names, matched in the cached user
   * dictionary. A failed lookup resolves to `unknown`; only a cancelled
   * caller rejects.
   */
  actingUser(opts?: MetadataCallOptions): Promise<ActingUserLookup>;
}

/**
 * Joins the TTL cache to the API v2 dictionary fetchers. One instance per
 * process: the cache state is what makes repeated dictionary reads cheap while
 * the MCP protocol layer stays stateless (docs/security.md par. 8).
 */
export function createMetadataService(
  client: Pick<LivespaceV2Client, "request">,
  config: { actingUserEmail: string | null },
  cacheOpts?: Partial<TtlCacheOptions>,
): MetadataService {
  const fetchers = createV2MetadataFetchers(client);
  const cache = createTtlCache({ ...CACHE_DEFAULTS, ...cacheOpts });

  // The shared fetch runs without the caller signal: the cache races the
  // caller against it, so one abandoned request cannot cancel the others. It
  // does carry a request budget, the one of the call that starts it; a call
  // that joins a fetch already in flight pays nothing.
  async function load<S extends V2MetadataSection>(
    section: S,
    opts: MetadataCallOptions | undefined,
  ): Promise<CacheHit<Fetched<V2SectionDataMap[S]>>> {
    const budget = opts?.budget ?? new CallBudget(CALL_BUDGETS.read);
    try {
      return await cache.get<Fetched<V2SectionDataMap[S]>>(
        section,
        () => fetchers[section]({ budget }),
        opts?.signal === undefined ? undefined : { signal: opts.signal },
      );
    } catch (error) {
      // A spent budget belongs to one tool call, not to the dictionary: the
      // failure cooldown must not hand it to the next caller. Nothing is lost
      // by dropping the key, since a cached value would have been served stale
      // instead of this error.
      if (error instanceof LivespaceError && error.code === "CALL_BUDGET_EXCEEDED") {
        cache.invalidate(section);
      }
      // The cache rejects an aborted caller with whatever the aborter passed
      // in - a DOMException, a plain Error, or a bare string. Only the signal
      // state is reliable, so that is what decides.
      if (opts?.signal?.aborted && !(error instanceof LivespaceError)) {
        throw cancelledError();
      }
      throw error;
    }
  }

  // The acting user lives in the user list, which the `users` section already
  // caches - reading it through the cache keeps `GET /users` at one read per
  // ttl. Losing it must not fail `currentUser` or `health`, so any failure
  // but the caller's own cancellation resolves to `unknown`.
  async function actingUser(opts?: MetadataCallOptions): Promise<ActingUserLookup> {
    const email = config.actingUserEmail;
    if (email === null) return { state: "not_configured", user: null };
    let users: CacheHit<Fetched<UserInfo[]>>;
    try {
      users = await load("users", opts);
    } catch (error) {
      if (opts?.signal?.aborted) {
        throw error instanceof LivespaceError ? error : cancelledError();
      }
      return { state: "unknown", user: null };
    }
    const user = findActingUser(users.value.data, email);
    if (user !== null) return { state: "resolved", user };
    // A user list cut at the page cap cannot prove anybody absent.
    return { state: users.value.truncated ? "unknown" : "not_found", user: null };
  }

  return {
    actingUser,
    async get<S extends V2MetadataSection>(
      section: S,
      opts?: MetadataCallOptions,
    ): Promise<SectionResult<S>> {
      const hit = await load(section, opts);
      const base = {
        data: hit.value.data,
        asOf: hit.asOf,
        stale: hit.stale,
        truncated: hit.value.truncated,
      };
      if (section !== "currentUser") return base;
      const acting = await actingUser(opts);
      const hint = actingUserHint(acting.state);
      // Cached values are frozen, so the acting user goes into a copy.
      const data = {
        ...(hit.value.data as CurrentUserV2),
        actingUser: acting.user,
      } as V2SectionDataMap[S];
      return { ...base, data, ...(hint === undefined ? {} : { hint }) };
    },
  };
}

const idName = z.object({ id: z.string(), name: z.string() });
// `selectable: false` marks a retired row; an assignable row omits the key.
const dictItem = idName.extend({ selectable: z.literal(false).optional() });
const treeItem = dictItem.extend({ parentId: z.string().nullable() });

// One envelope type per section. A union would let a section validate against
// the wrong member and silently strip fields it does not know, so each section
// names its own shape.
const envelopeOf = <T extends z.ZodType>(data: T) =>
  z.object({
    asOf: z.number(),
    ageMs: z.number(),
    stale: z.boolean(),
    truncated: z.boolean(),
    totalItems: z.number().optional(),
    hint: z.string().optional(),
    data,
  });

const stepData = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  weight: z.number(),
  required: z.boolean(),
  requiredItem: z.enum(["none", "note", "file"]),
  boundFields: z.number(),
});

const processData = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    selectable: z.boolean(),
    isDefault: z.boolean(),
    defaultLengthDays: z.number().nullable(),
    productRequired: z.boolean(),
    autoclose: z.boolean(),
    stages: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        description: z.string().nullable(),
        durationDays: z.number().nullable(),
        steps: z.array(stepData),
      }),
    ),
  }),
);

const userData = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    team: idName.nullable(),
  }),
);

const customFieldData = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    group: z.string().nullable(),
    required: z.boolean(),
    readOnly: z.boolean(),
    filterable: z.boolean(),
    selectable: z.literal(false).optional(),
    options: z.array(idName),
  }),
);

const currentUserData = z.object({
  integrationLogin: z.string(),
  timeZone: z.string(),
  actingUser: z.object({ id: z.string(), name: z.string(), email: z.string() }).nullable(),
});

const sectionsSchema = z.strictObject({
  processes: envelopeOf(processData).optional(),
  users: envelopeOf(userData).optional(),
  teams: envelopeOf(z.array(treeItem)).optional(),
  contactGroups: envelopeOf(z.array(dictItem)).optional(),
  dealGroups: envelopeOf(z.array(dictItem)).optional(),
  sources: envelopeOf(z.array(treeItem)).optional(),
  positions: envelopeOf(z.array(dictItem)).optional(),
  dealReasons: envelopeOf(
    z.array(dictItem.extend({ kind: z.enum(["won", "lost", "outdated"]) })),
  ).optional(),
  tags: envelopeOf(z.array(z.string())).optional(),
  currencies: envelopeOf(z.array(dictItem.extend({ isDefault: z.boolean() }))).optional(),
  taskTypes: envelopeOf(z.array(dictItem)).optional(),
  taskStatuses: envelopeOf(z.array(dictItem)).optional(),
  customFields: envelopeOf(
    z.object({
      person: customFieldData,
      company: customFieldData,
      deal: customFieldData,
      task: customFieldData,
    }),
  ).optional(),
  products: envelopeOf(
    z.array(z.object({ id: z.string(), name: z.string(), sku: z.string().nullable() })),
  ).optional(),
  currentUser: envelopeOf(currentUserData).optional(),
});

export const crmMetadataToolConfig = {
  title: "CRM Metadata",
  description: `Read CRM dictionaries. ALWAYS take ids from here instead of guessing.
Sections: processes (the full sales process config: stages in CRM order, each
with its steps, their weight, whether a step is required and what completing
it asks for), users (people who can own records, with e-mail and main team),
teams, contactGroups, dealGroups, sources, positions, dealReasons (reasons for
closing a deal as won, lost or outdated), tags (names only, tags have no ids),
currencies (the ones switched on for the account), taskTypes, taskStatuses,
customFields (per record kind: person, company, deal, task; a choice field
lists its options and takes the option id, not the name), products (id, name,
sku) and currentUser.
Notes: deal stage changes happen by completing steps, not by setting a stage
directly; a required step must be completed before a deal can be closed as
won. A row with selectable: false is retired or switched off: it explains old
records and cannot be assigned. currentUser is the integration user of the API
key (login, time zone) plus actingUser, the person this server works for;
actingUser is null when none is configured or matched, and hint says which.
truncated: true means more rows exist than the section returns. Results are
cached server-side for a few minutes (see asOf/ageMs/stale per section).
userQuery filters users by a case-insensitive name or email substring, without
accent folding or searching teams. With userQuery, omitted sections means
users only; explicit sections must include users. All matching users are
returned up to the cap; resolve multiple matches before choosing an owner or
notification recipient. For queried users, totalItems counts matches in the
cached dictionary before the cap, not all CRM users.`,
  inputSchema: z.strictObject({
    sections: z
      .array(z.enum(V2_METADATA_SECTIONS))
      .min(1)
      .max(V2_METADATA_SECTIONS.length)
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
  sections?: V2MetadataSection[];
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

type SectionError = ToolError & { section: string };

type SectionOutcome =
  | { section: V2MetadataSection; envelope: SectionEnvelope; shown?: number }
  | { section: V2MetadataSection; error: SectionError };

const CUSTOM_FIELD_KINDS: readonly CustomFieldKind[] = ["person", "company", "deal", "task"];

function canonicalSections(sections?: V2MetadataSection[]): V2MetadataSection[] {
  if (!sections) return [...V2_METADATA_SECTIONS];
  const wanted = new Set(sections);
  return V2_METADATA_SECTIONS.filter((section) => wanted.has(section));
}

function capped<T>(items: readonly T[]): readonly T[] {
  return items.length > SECTION_ITEM_CAP ? items.slice(0, SECTION_ITEM_CAP) : items;
}

/** The envelope plus how many rows it actually carries, for the text line. */
function buildEnvelope(
  section: V2MetadataSection,
  result: SectionResult,
  at: number,
): { envelope: SectionEnvelope; shown?: number } {
  const base = {
    asOf: result.asOf,
    ageMs: at - result.asOf,
    stale: result.stale,
    ...(result.hint === undefined ? {} : { hint: result.hint }),
  };
  if (Array.isArray(result.data)) {
    const data = capped(result.data as readonly unknown[]);
    return {
      envelope: {
        ...base,
        truncated: result.truncated || data.length < result.data.length,
        totalItems: result.data.length,
        data,
      },
      shown: data.length,
    };
  }
  if (section === "customFields") {
    // Four lists in one section: each is capped on its own, counted together.
    const fields = result.data as Record<CustomFieldKind, CustomFieldInfo[]>;
    const data = {} as Record<CustomFieldKind, readonly CustomFieldInfo[]>;
    let totalItems = 0;
    let shown = 0;
    for (const kind of CUSTOM_FIELD_KINDS) {
      data[kind] = capped(fields[kind]);
      totalItems += fields[kind].length;
      shown += data[kind].length;
    }
    return {
      envelope: { ...base, truncated: result.truncated || shown < totalItems, totalItems, data },
      shown,
    };
  }
  return { envelope: { ...base, truncated: false, data: result.data } };
}

// Only our own wording and the sanitized fields of a LivespaceError reach the
// caller - never the text of an unexpected error (security.md par. 6).
function toSectionError(section: V2MetadataSection, error: unknown): SectionError {
  if (error instanceof LivespaceError) return { section, ...toToolError(error) };
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
  const hint = envelope.hint ? `\n${envelope.hint}` : "";
  if (envelope.totalItems === undefined) {
    return `${outcome.section}: ok${staleMark}${hint}`;
  }
  const matching = outcome.section === "users" && queriedUsers ? " matching users" : "";
  const shown = outcome.shown ?? envelope.totalItems;
  const counts =
    shown < envelope.totalItems ? `${shown} of ${envelope.totalItems}` : `${envelope.totalItems}`;
  const truncatedMark = envelope.truncated ? " (truncated)" : "";
  return `${outcome.section}: ${counts}${matching}${truncatedMark}${staleMark}${hint}`;
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

  // One request budget for the whole tool call (docs/security.md par. 3):
  // every dictionary fetch this call starts spends from it.
  const callOpts: MetadataCallOptions = {
    budget: new CallBudget(CALL_BUDGETS.read),
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  };
  // Every section settles inside its own try/catch: one failing dictionary
  // must not take the whole result down.
  const outcomes = await Promise.all(
    requested.map(async (section): Promise<SectionOutcome> => {
      try {
        const result = await service.get(section, callOpts);
        // Filter a copy before the output cap; the shared cache must keep every
        // user for later queries and acting-user resolution.
        const selected = section === "users" && query !== undefined
          ? {
            ...result,
            data: (result.data as UserInfo[]).filter((user) =>
              user.name.toLowerCase().includes(query) || user.email.toLowerCase().includes(query)),
          }
          : result;
        const built = buildEnvelope(section, selected, now());
        if (section === "users" && query !== undefined && built.envelope.totalItems === 0) {
          built.envelope.hint = "No matching users in this dictionary snapshot. Check the name or email, " +
            "review asOf/ageMs/stale, and retry crm_metadata with userQuery if appropriate. " +
            "An empty result does not prove the user is absent from the CRM.";
        }
        return { section, ...built };
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
