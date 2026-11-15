import type { LivespaceClient } from "../livespace/client.js";
import { cancelledError, LivespaceError } from "../livespace/errors.js";
import {
  createMetadataFetchers,
  type CurrentUser,
  type MetadataSection,
  type SectionDataMap,
  type UserInfo,
} from "../livespace/metadata.js";
import { createTtlCache, type TtlCacheOptions } from "./cache.js";

/**
 * The v1 dictionary service. `crm_metadata` reads API v2 now; this stays only
 * for the tools that still run on the signed-session API and validate against
 * its process and user dictionaries (`analyze`, `create_records`,
 * `move_deals_to_stage`, `notify_user`). It goes away with the last of them.
 */

const CACHE_DEFAULTS: TtlCacheOptions = {
  ttlMs: 5 * 60_000,
  staleMaxMs: 30 * 60_000,
  failureCooldownMs: 30_000,
};

export interface V1SectionResult<S extends MetadataSection = MetadataSection> {
  data: SectionDataMap[S];
  asOf: number;
  stale: boolean;
}

export interface V1MetadataService {
  get<S extends MetadataSection>(
    section: S,
    opts?: { signal?: AbortSignal },
  ): Promise<V1SectionResult<S>>;
}

/**
 * Joins the TTL cache to the upstream fetchers. One instance per process: the
 * cache state is what makes repeated dictionary reads cheap while the MCP
 * protocol layer stays stateless (docs/security.md par. 8).
 */
export function createV1MetadataService(
  client: Pick<LivespaceClient, "call">,
  cacheOpts?: Partial<TtlCacheOptions>,
): V1MetadataService {
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
    ): Promise<V1SectionResult<S>> {
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
