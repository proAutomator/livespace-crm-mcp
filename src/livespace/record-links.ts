/** The three kinds Livespace exposes a UI deep link for; tasks have none. */
export type LinkableKind = "person" | "company" | "deal";

const RECORD_URL_PATHS: Record<LinkableKind, string> = {
  person: "Contact/contact/details/api_id",
  company: "Contact/company/details/api_id",
  deal: "Deal/deal/details/api_id",
};

/**
 * The UI deep link for a record, built from the account subdomain. All three
 * patterns are read off live records' own `url` fields, so this is a FALLBACK:
 * a record that carries its own link is linked to by that, never by this.
 *
 * The id is percent-encoded. Ids are opaque upstream strings and the link
 * travels into a notification body, so none of one may add a path segment or a
 * query of its own (docs/security.md par. 1).
 */
export function recordUrl(subdomain: string, kind: LinkableKind, id: string): string {
  const path = RECORD_URL_PATHS[kind];
  return `https://${subdomain}.livespace.io/${path}/${encodeURIComponent(id)}`;
}

/** Search hits stay usable when an opaque ID cannot form a safe URL segment. */
export function searchHitUrl(subdomain: string, kind: LinkableKind, id: string): string {
  if (id === "" || id === "." || id === "..") return "";
  try {
    return recordUrl(subdomain, kind, id);
  } catch {
    // encodeURIComponent rejects an unpaired surrogate. Keep the hit, without a link.
    return "";
  }
}
