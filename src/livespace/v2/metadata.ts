import { LivespaceError } from "../errors.js";
import type { CallBudget } from "./budget.js";
import type { LivespaceV2Client } from "./client.js";

/**
 * CRM dictionaries of API v2 behind `health` and `crm_metadata`.
 *
 * The shapes below were read live on a demo account (2026-11-15) and compared
 * with the vendor's draft contract. The API changed once without a
 * `meta.version` bump, so every mapper reads only the fields it needs, takes
 * a row without a string id as an unknown shape, and fails with fixed wording
 * instead of guessing (docs/security.md par. 6).
 */

type V2Requester = Pick<LivespaceV2Client, "request">;

export interface V2FetchOptions {
  signal?: AbortSignal;
  /** The tool call's request budget; every page spends from it. */
  budget?: CallBudget;
}

/** The integration user the API v2 key belongs to: never a person. */
export interface IntegrationUser {
  login: string;
  timeZone: string;
}

/** The human this server works for, from `LIVESPACE_ACTING_USER_EMAIL`. */
export interface ActingUser {
  id: string;
  name: string;
  email: string;
}

/**
 * `not_configured`: no e-mail is set. `not_found`: it matches no user the API
 * lists. `unknown`: the user list itself did not load, so nothing is known.
 */
export type ActingUserState = "resolved" | "not_configured" | "not_found" | "unknown";

export interface ActingUserLookup {
  state: ActingUserState;
  user: ActingUser | null;
}

// Fixed wording only: upstream content must never reach an error message
// (docs/security.md par. 6).
function unexpectedShape(): LivespaceError {
  return new LivespaceError(
    "UPSTREAM_ERROR",
    "Livespace API v2 returned an unexpected shape for this dictionary.",
    "Report it on the issue tracker; the API may have changed.",
  );
}

function asObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw unexpectedShape();
  }
  return value as Record<string, unknown>;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * `GET /users/me`. The live API answers camelCase (`timeZone`); the draft
 * contract says snake_case (`time_zone`). Both are read, so neither spelling
 * breaks the caller. `essential` is for `health` alone: it lets this one
 * request through when the daily reserve refuses everything else.
 */
export async function readIntegrationUser(
  client: V2Requester,
  opts: V2FetchOptions & { essential?: boolean } = {},
): Promise<IntegrationUser> {
  const response = await client.request<unknown>(
    { method: "GET", path: "/users/me" },
    {
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      ...(opts.budget === undefined ? {} : { budget: opts.budget }),
      ...(opts.essential === true ? { essential: true } : {}),
    },
  );
  const me = asObject(response.data);
  return {
    login: asText(me["login"]),
    timeZone: asText(me["timeZone"]) || asText(me["time_zone"]),
  };
}

/**
 * What to tell the model when no acting user is known. Fixed wording: it
 * names a variable and a tool, never a value (docs/security.md par. 1).
 */
export function actingUserHint(state: ActingUserState): string | undefined {
  switch (state) {
    case "resolved":
      return undefined;
    case "not_configured":
      return (
        "No acting user is configured. The API v2 key belongs to an integration " +
        "user, not a person: set LIVESPACE_ACTING_USER_EMAIL to the e-mail of the " +
        "Livespace user this server works for."
      );
    case "not_found":
      return (
        "LIVESPACE_ACTING_USER_EMAIL matches no user Livespace lists as a possible " +
        "record owner. Compare it with the users section of crm_metadata."
      );
    case "unknown":
      return (
        "The acting user could not be checked because the user list did not load. " +
        "Retry later."
      );
  }
}
