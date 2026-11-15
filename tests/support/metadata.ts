import type {
  MetadataService,
  SectionResult,
} from "../../src/server/tools/crm-metadata.js";

/** An empty but well-shaped answer for every API v2 dictionary section. */
function emptySection(section: string): unknown {
  if (section === "customFields") return { person: [], company: [], deal: [], task: [] };
  if (section === "currentUser") {
    return { integrationLogin: "synthetic-integration", timeZone: "Europe/Warsaw", actingUser: null };
  }
  return [];
}

/**
 * A synthetic API v2 dictionary service for wire tests. `read` may return the
 * data of a section, `undefined` for the empty default, or throw to simulate
 * a failing section.
 */
export function fakeV2Metadata(
  read: (section: string) => unknown = () => undefined,
): MetadataService {
  return {
    get: (async (section: string) => ({
      data: read(section) ?? emptySection(section),
      asOf: 1_000,
      stale: false,
      truncated: false,
    })) as unknown as MetadataService["get"],
    actingUser: async () => ({ state: "not_configured", user: null }),
  };
}

export type { SectionResult };
