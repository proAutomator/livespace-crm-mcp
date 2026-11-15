/** Media types of the Livespace public API v2 (`Accept` and `Content-Type`). */

export const MEDIA_JSON = "application/json";
/** Compact rows for get and search of people, companies, deals and tasks. */
export const MEDIA_MINIMAL = "application/vnd.ls-api.minimal.v2+json";
/** Deal search only; caps `perPage` at 50. */
export const MEDIA_EXTENDED = "application/vnd.ls-api.extended.v2+json";

/** Actions are chosen by the request `Content-Type` of a `PATCH`. */
export const CONTENT_DEAL_STATUS = "application/vnd.ls-api.deal-status.v2+json";
export const CONTENT_TASK_COMPLETE = "application/vnd.ls-api.task-complete.v2+json";
export const CONTENT_TASK_REOPEN = "application/vnd.ls-api.task-reopen.v2+json";

export type V2MediaType = typeof MEDIA_JSON | typeof MEDIA_MINIMAL | typeof MEDIA_EXTENDED;
export type V2ContentType =
  | typeof MEDIA_JSON
  | typeof CONTENT_DEAL_STATUS
  | typeof CONTENT_TASK_COMPLETE
  | typeof CONTENT_TASK_REOPEN;
