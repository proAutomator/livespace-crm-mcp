import {
  acceptedContent,
  inputRequired,
  type InputRequiredResult,
  type RequestStateCodec,
  type ServerContext,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  cancelledError,
  LivespaceError,
  type LivespaceErrorCode,
} from "../../livespace/errors.js";
import type { UserInfo } from "../../livespace/metadata.js";
import type { RecordFetchers } from "../../livespace/records.js";
import {
  recordUrl,
  type LinkableKind,
  type WriteCallOptions,
  type WriteFetchers,
} from "../../livespace/writes.js";
import { readWriteState, type WriteToolOptions } from "./create-records.js";
import type { MetadataService } from "./crm-metadata.js";
import {
  toolErrorSchema,
  toToolError,
  type ToolError,
  type ToolRunResult,
} from "./tool-error.js";
import {
  clientSupportsElicitation,
  countResults,
  decideConfirm,
  executePlan,
  hashArgs,
  isBatchError,
  newJti,
  CONFIRM_INPUT_KEY,
  NOTIFICATION_UNVERIFIABLE,
  WRITE_BUDGET_MS,
  WRITE_CONFIRMATION_DESCRIPTION,
  WRITE_CONFIRM_PARAMETER_DESCRIPTION,
  WRITE_PREVIEW_HINT,
  type ActionWriteItem,
  type ItemResult,
  type WriteItemPlan,
  type WriteState,
} from "./write-support.js";

/**
 * `notify_user` - one in-app Livespace notification, to one validated
 * recipient, sent only after a human said yes.
 *
 * It shares the confirmation machinery of the other write tools. What is its
 * own comes from the probe evidence behind the endpoint (M8, recorded in the
 * plan doc) and from the critique panel:
 *
 * 1. **Nobody can confirm delivery.** `Crm/notification_send` answers 200 with
 *    an empty body and exposes NO read-back - three candidate endpoints all
 *    refused - so the strongest honest word is "dispatched". Every result says
 *    that and carries the NOTIFICATION_UNVERIFIABLE advisory; a resend would be
 *    a second bell entry, not a fix (docs/security.md par. 5).
 * 2. **A bogus recipient answers 200 silently.** The id is therefore validated
 *    against the cached `users` dictionary BEFORE anything is dispatched, and
 *    the description says that list may be minutes stale.
 * 3. **The human reads the message and may edit it.** The elicitation form
 *    carries two fields: the approval boolean and the message body, defaulted
 *    to what was planned. The accepted text is what travels upstream, bounded
 *    exactly as the argument is; anything outside the bound is a decline.
 * 4. **A notification is a nudge, not a channel.** The module-scope budget - 5
 *    per 10 minutes, 1 per recipient per minute - is checked before any
 *    dictionary read, so a model in a loop costs the CRM nothing, and checked
 *    again together with the booking, synchronously, right before the dispatch:
 *    calls that overlap are ordinary, and a check-then-act guard bounds nothing
 *    across an await.
 *
 * The text channel and the approval line carry counts and fixed wording only:
 * the message body is model- or CRM-authored text, and it belongs in the form
 * the human reads, in `structuredContent` (capped) and upstream - nowhere else
 * (par. 4).
 *
 * Nothing here is cached: record data never is (par. 8), so this module must
 * never import the server cache.
 */

export const NOTIFY_USER_TOOL = "notify_user";

/** The one item this tool ever plans. */
const NOTIFY_ACTION = "send_notification";
const NOTIFY_KIND = "notification";

/** The upstream body bound, and the cut a structured preview of it gets. */
const TEXT_MAX = 500;
const PREVIEW_MAX = 100;

/** The send budget: a nudge tool, not a mailing list. */
const WINDOW_MS = 10 * 60_000;
const WINDOW_CAP = 5;
const RECIPIENT_COOLDOWN_MS = 60_000;

const idSchema = z.string().min(1).max(64);

const inputSchema = z.strictObject({
  userId: idSchema.describe(
    'The CRM user to notify, from crm_metadata (sections: ["users"]).',
  ),
  text: z
    .string()
    .min(1)
    .max(TEXT_MAX)
    .describe("The message body; a human reads it and may edit it before it is sent."),
  recordKind: z
    .enum(["person", "company", "deal"])
    .optional()
    .describe("What the notification links to. Send it together with recordId."),
  recordId: idSchema
    .optional()
    .describe("The linked record's id, from search_crm or get_records."),
  dryRun: z
    .boolean()
    .optional()
    .describe("Return the plan and send nothing; cannot be combined with confirm."),
  confirm: z
    .boolean()
    .optional()
    .describe(WRITE_CONFIRM_PARAMETER_DESCRIPTION),
});

/**
 * What the plan shows, and what the confirmation digest is taken over: the
 * recipient, the link the bell entry points at, and the size and head of the
 * body. Two notifications that would carry different links can never hash
 * alike.
 */
const summarySchema = z.strictObject({
  userId: z.string(),
  urlKind: z.enum(["record", "root"]),
  url: z.string(),
  textLength: z.number(),
  textPreview: z.string(),
});

const planItemSchema = z.strictObject({
  index: z.number(),
  action: z.string(),
  kind: z.string(),
  // One shape only: a notification is planned, or the call was refused before
  // there was anything to plan.
  status: z.literal("action"),
  summary: summarySchema,
});

const resultItemSchema = z.strictObject({
  index: z.number(),
  action: z.string(),
  kind: z.string(),
  status: z.enum(["ok", "error", "unknown_outcome", "not_attempted"]),
  /** Whether the dispatch left this server. Never a claim about delivery. */
  dispatched: z.boolean().optional(),
  urlKind: z.enum(["record", "root"]).optional(),
  textLength: z.number().optional(),
  textPreview: z.string().optional(),
  verification: z.enum(["verified", "unavailable"]).optional(),
  error: toolErrorSchema.optional(),
});

const countsSchema = z.strictObject({
  ok: z.number(),
  skippedDuplicate: z.number(),
  error: z.number(),
  unknownOutcome: z.number(),
  notAttempted: z.number(),
});

// Optional keys on one root, never a union: a preview carries `plan`, a sent
// notification carries `results` and `counts`, and a refused call carries
// neither. `errors` is always present.
const outputSchema = z.strictObject({
  plan: z.array(planItemSchema).optional(),
  requiresConfirmation: z.literal(true).optional(),
  declined: z.literal(true).optional(),
  recordsChanged: z.literal(true).optional(),
  results: z.array(resultItemSchema).optional(),
  counts: countsSchema.optional(),
  errors: z.array(toolErrorSchema),
});

export type NotifyUserArgs = z.output<typeof inputSchema>;

/** A write tool returns a normal result, or asks the client for a human's yes. */
export type NotifyUserResult = ToolRunResult | InputRequiredResult;

export interface NotifyUserDeps {
  writes: WriteFetchers;
  /** The linked record is read once, to prove it exists and to take its link. */
  records: Pick<RecordFetchers, "getRecord">;
  /** The dictionary the recipient id is validated against. */
  metadata: MetadataService;
  codec: RequestStateCodec<WriteState>;
  /** The account subdomain every deep link is built from. */
  subdomain: string;
}

export const notifyUserToolConfig = {
  title: "Notify a CRM User",
  description: `Send ONE in-app Livespace notification to one CRM user - a short message and a
link, shown in that user's notification bell. ${WRITE_CONFIRMATION_DESCRIPTION}
The human may edit the notification message in the approval form.
Livespace exposes no read-back for notifications, so this tool reports a notification as dispatched, never as
delivered - do not resend one, confirm with the recipient another way instead.
userId comes from crm_metadata (sections: ["users"]) and is checked against it
before anything is sent; that list is cached for a few minutes, so a user
created just now may not be in it yet. The message is at most 500 characters.
Link the notification to a person, company or deal by sending recordKind and
recordId together - both or neither - otherwise it points at the CRM home
page. This server sends at most 5 notifications per 10 minutes, and at most
one per recipient per minute.`,
  inputSchema,
  outputSchema,
  annotations: {
    readOnlyHint: false,
    // A notification adds a bell entry; nothing in the CRM is overwritten.
    destructiveHint: false,
    // Sending the same message twice is two notifications, not one.
    idempotentHint: false,
    openWorldHint: false,
  },
} as const;

const DECLINED_LINE = "Confirmation was declined; nothing was sent.";

const CHANGED_LINE = "Records changed since the preview; review and confirm again.";

const EDITED_TEXT_LINE =
  `The edited message is empty or longer than ${TEXT_MAX} characters; nothing was sent.`;

/**
 * The elicitation form. Two fields: the approval, and the body itself - the one
 * place the message is shown, because a human approving a message they cannot
 * read is not approving anything. The wording around it is ours and fixed.
 */
function confirmForm(planned: string) {
  return {
    type: "object" as const,
    properties: {
      confirm: {
        type: "boolean" as const,
        title: "Send this notification",
        description: "Approve the send. Anything else leaves the CRM untouched.",
      },
      text: {
        type: "string" as const,
        title: "Message",
        description: "What the recipient will read. Edit it to change what is sent.",
        default: planned,
        minLength: 1,
        maxLength: TEXT_MAX,
      },
    },
    required: ["confirm"],
  };
}

/**
 * The human's answer to THIS tool's form. The shared reader knows `{confirm}`
 * alone and would refuse a form carrying an edited body, so the accepted
 * content is read here, against this form's own schema. Unknown keys are
 * dropped rather than refused: the answer comes from a client we do not own.
 */
const acceptedForm = z.object({
  confirm: z.boolean(),
  text: z.string().optional(),
});

interface AcceptedAnswer {
  confirm: boolean;
  text?: string | undefined;
}

function readAccepted(ctx: unknown): AcceptedAnswer | undefined {
  const responses = (
    ctx as { mcpReq?: { inputResponses?: Record<string, unknown> } } | null
  )?.mcpReq?.inputResponses;
  return acceptedContent(responses, CONFIRM_INPUT_KEY, acceptedForm);
}

/**
 * The send ledger: one entry per dispatch, oldest first, kept for the length of
 * the window and no longer. Module scope on purpose - the budget is about this
 * server, not about one request - and plain wall time, so a clock stub is the
 * whole test seam.
 */
interface DispatchEntry {
  userId: string;
  at: number;
}

const dispatches: DispatchEntry[] = [];

/**
 * Only entries inside the window survive. The list is rebuilt rather than
 * shifted from the front: a clock that jumped - backwards, or forward past the
 * window - would otherwise leave an entry nothing could ever drop, and a wedged
 * budget refuses every notification from then on.
 */
function prune(now: number): void {
  const kept = dispatches.filter(
    (entry) => entry.at <= now && now - entry.at < WINDOW_MS,
  );
  dispatches.length = 0;
  dispatches.push(...kept);
}

/**
 * A refusal the executor can also throw, so its code is the transport's own
 * union: `toToolError` preserves `{code, message, hint}` for a `LivespaceError`
 * and collapses everything else into a generic UPSTREAM_ERROR, which would lose
 * this wording exactly where the human needs it.
 */
interface BudgetRefusal extends ToolError {
  code: LivespaceErrorCode;
}

const BUDGET_SPENT: BudgetRefusal = {
  code: "RATE_LIMITED",
  message: `This server sends at most ${WINDOW_CAP} notifications per 10 minutes, and that budget is spent.`,
  hint: "Nothing was sent. Wait for the window to pass, or tell the person another way.",
};

const RECIPIENT_COOLDOWN: BudgetRefusal = {
  code: "RATE_LIMITED",
  message: "This recipient was notified less than a minute ago.",
  hint: "Nothing was sent. Wait a minute before notifying the same person again.",
};

function checkBudget(userId: string, now: number): BudgetRefusal | null {
  prune(now);
  if (dispatches.length >= WINDOW_CAP) return BUDGET_SPENT;
  const recent = dispatches.some(
    (entry) => entry.userId === userId && now - entry.at < RECIPIENT_COOLDOWN_MS,
  );
  return recent ? RECIPIENT_COOLDOWN : null;
}

function noteDispatch(userId: string, now: number): void {
  dispatches.push({ userId, at: now });
}

function badParams(hint: string): ToolError {
  return {
    code: "BAD_PARAMS",
    message: "These notify_user arguments cannot be combined.",
    hint,
  };
}

function recipientNotFound(): ToolError {
  return {
    code: "NOT_FOUND",
    message: "Recipient not found.",
    hint: 'Call crm_metadata (sections: ["users"]) for valid user ids. That list is cached for a few minutes, so a user created just now may not be in it yet.',
  };
}

function recordNotFound(): ToolError {
  return {
    code: "NOT_FOUND",
    message: "Record not found.",
    hint: "The id does not exist or the API key's user cannot see it - take ids from search_crm or get_records.",
  };
}

/**
 * A refused call carries no plan and no results - there is nothing to qualify.
 * The text names the code; the hint travels in the structured channel.
 */
function failed(error: ToolError): ToolRunResult {
  return {
    text: `${NOTIFY_USER_TOOL} failed: ${error.code}.`,
    structured: { errors: [error] },
    isError: true,
  };
}

/**
 * The CANCELLED contract at every catch site: only the caller's signal STATE is
 * reliable (an abort surfaces as a DOMException, a plain Error or a bare string
 * reason), and a cancelled call NEVER returns a tool result - it rejects.
 */
function toEntry(error: unknown, signal: AbortSignal | undefined): ToolError {
  if (signal?.aborted) throw cancelledError();
  const entry = toToolError(error);
  if (entry.code === "CANCELLED") throw cancelledError();
  return entry;
}

/**
 * Cross-field rules live here rather than in the schema: a zod refinement would
 * turn every combination mistake into a protocol-level validation error, while a
 * returned `{code, message, hint}` tells the model how to fix the call.
 */
function argumentHint(args: NotifyUserArgs): string | null {
  if ((args.recordKind === undefined) !== (args.recordId === undefined)) {
    return "A link needs both recordKind and recordId, or neither. Send the pair, or drop both and the notification points at the CRM home page.";
  }
  return null;
}

type UrlKind = "record" | "root";

interface Link {
  urlKind: UrlKind;
  url: string;
}

function crmRoot(subdomain: string): string {
  return `https://${subdomain}.livespace.io/`;
}

/**
 * The record's own link, but only when it points at THIS account. A record
 * field is CRM-authored text (par. 4) and this one travels into a bell entry a
 * human will click, so a link anywhere else is not used - the deep link is
 * rebuilt from the id instead.
 */
function ownLink(subdomain: string, value: string | undefined): string | null {
  const url = value === undefined ? "" : value.trim();
  return url.startsWith(crmRoot(subdomain)) ? url : null;
}

async function resolveLink(
  deps: NotifyUserDeps,
  args: NotifyUserArgs,
  signal: AbortSignal | undefined,
): Promise<Link | ToolError> {
  const kind: LinkableKind | undefined = args.recordKind;
  const id = args.recordId;
  if (kind === undefined || id === undefined) {
    return { urlKind: "root", url: crmRoot(deps.subdomain) };
  }
  let record: { url?: string } | null;
  try {
    record = await deps.records.getRecord(
      kind,
      id,
      signal === undefined ? undefined : { signal },
    );
  } catch (error) {
    return toEntry(error, signal);
  }
  if (record === null) return recordNotFound();
  const own = ownLink(deps.subdomain, record.url);
  return { urlKind: "record", url: own ?? recordUrl(deps.subdomain, kind, id) };
}

async function validateRecipient(
  metadata: MetadataService,
  userId: string,
  signal: AbortSignal | undefined,
): Promise<ToolError | null> {
  let users: readonly UserInfo[];
  try {
    const dictionary = await metadata.get(
      "users",
      signal === undefined ? undefined : { signal },
    );
    users = dictionary.data;
  } catch (error) {
    return toEntry(error, signal);
  }
  // Upstream accepts a bogus recipient with a 200 and drops it (probe evidence
  // 6), so this check is the only thing standing between a typo and a
  // notification nobody ever sees.
  return users.some((user) => user.id === userId) ? null : recipientNotFound();
}

/** What the plan shows and what the result row repeats, for one body. */
interface NotifyDetail {
  urlKind: UrlKind;
  url: string;
  textLength: number;
  textPreview: string;
}

function detailFor(text: string, link: Link): NotifyDetail {
  return {
    urlKind: link.urlKind,
    url: link.url,
    textLength: text.length,
    // The body is data and belongs in the structured channel - a head of it is
    // enough to recognise the message without carrying the whole thing twice.
    textPreview: text.slice(0, PREVIEW_MAX),
  };
}

function planItems(args: NotifyUserArgs, detail: NotifyDetail): WriteItemPlan[] {
  return [
    {
      index: 0,
      action: NOTIFY_ACTION,
      kind: NOTIFY_KIND,
      status: "action",
      summary: {
        userId: args.userId,
        urlKind: detail.urlKind,
        url: detail.url,
        textLength: detail.textLength,
        textPreview: detail.textPreview,
      },
    },
  ];
}

function linkPhrase(urlKind: UrlKind): string {
  return urlKind === "record" ? "linked to a record" : "linked to the CRM home page";
}

/** Counts and fixed wording only - never the body, never a CRM name (par. 4). */
function previewLine(detail: NotifyDetail): string {
  return (
    `${NOTIFY_USER_TOOL} preview: 1 notification for 1 recipient - ` +
    `${detail.textLength} character(s), ${linkPhrase(detail.urlKind)}. ` +
    `${WRITE_PREVIEW_HINT}`
  );
}

/**
 * The line a HUMAN approves. Same rule: the message itself is in the form field
 * below it, where it can be read and edited - never in this sentence.
 */
function approvalMessage(detail: NotifyDetail): string {
  return (
    `Send 1 in-app notification to 1 CRM user: ${detail.textLength} character(s), ` +
    `${linkPhrase(detail.urlKind)}. The message below can be edited before it is sent. ` +
    `Livespace cannot confirm delivery. Approve?`
  );
}

interface PreviewFlags {
  requiresConfirmation?: boolean;
  declined?: boolean;
  recordsChanged?: boolean;
  editedTextRefused?: boolean;
}

function previewResult(
  items: readonly WriteItemPlan[],
  detail: NotifyDetail,
  flags: PreviewFlags,
): ToolRunResult {
  const lines = [previewLine(detail)];
  if (flags.declined === true) lines.push(DECLINED_LINE);
  if (flags.editedTextRefused === true) lines.push(EDITED_TEXT_LINE);
  if (flags.recordsChanged === true) lines.push(CHANGED_LINE);
  return {
    text: lines.join("\n"),
    structured: {
      plan: items,
      ...(flags.requiresConfirmation === true ? { requiresConfirmation: true } : {}),
      ...(flags.declined === true ? { declined: true } : {}),
      ...(flags.recordsChanged === true ? { recordsChanged: true } : {}),
      errors: [],
    },
    isError: false,
  };
}

/**
 * The executor reports what the dispatch did; the plan knows what it WAS.
 * `ItemResult` is not widened for that - each tool merges its own detail into
 * its own rows, exactly as `create_records` fills in duplicate ids.
 */
interface NotifyResultRow extends ItemResult {
  dispatched?: boolean;
  urlKind?: UrlKind;
  textLength?: number;
  textPreview?: string;
}

function mergeDetail(result: ItemResult, detail: NotifyDetail): NotifyResultRow {
  return {
    ...result,
    // An outcome the transport could not tell us about is exactly that: the
    // notification may have gone out, so neither true nor false is honest.
    ...(result.status === "unknown_outcome" ? {} : { dispatched: result.status === "ok" }),
    urlKind: detail.urlKind,
    textLength: detail.textLength,
    textPreview: detail.textPreview,
  };
}

/**
 * The executed line. "Dispatched" is the strongest word available: Livespace
 * exposes no read-back, so nothing here may sound like a delivery receipt.
 */
function executedText(rows: readonly NotifyResultRow[]): string {
  const counts = countResults(rows);
  return (
    `${NOTIFY_USER_TOOL}: dispatched ${counts.ok} of 1 - ` +
    `errors ${counts.error}, unknown ${counts.unknownOutcome}. ` +
    `Livespace exposes no read-back, so delivery is not confirmed; do not resend.`
  );
}

/** The notification itself: flipping `confirm` or `dryRun` is not a new one. */
function itemArgs(args: NotifyUserArgs): Record<string, unknown> {
  return {
    userId: args.userId,
    text: args.text,
    recordKind: args.recordKind,
    recordId: args.recordId,
  };
}

export async function runNotifyUser(
  deps: NotifyUserDeps,
  args: NotifyUserArgs,
  opts: WriteToolOptions = {},
): Promise<NotifyUserResult> {
  // One wall clock for the whole call, the dictionary and record reads
  // included - the client's request timeout does not stop counting while the
  // recipient is being validated.
  const deadlineAt = Date.now() + WRITE_BUDGET_MS;
  const hint = argumentHint(args);
  if (hint !== null) return failed(badParams(hint));
  const signal = opts.signal;
  // A caller who walked away before the first call gets no work and no result.
  if (signal?.aborted) throw cancelledError();

  // The budget is checked FIRST, before a single upstream read: a refusal must
  // cost the CRM nothing, and a preview of a notification that cannot be sent
  // would only invite a retry.
  const refusal = checkBudget(args.userId, Date.now());
  if (refusal !== null) return failed(refusal);

  const argsHash = await hashArgs(itemArgs(args));
  const state = readWriteState(opts.ctx);
  const accepted = readAccepted(opts.ctx);
  const decision = decideConfirm({
    tool: NOTIFY_USER_TOOL,
    argsHash,
    confirm: args.confirm,
    dryRun: args.dryRun,
    state,
    elicitedConfirm: accepted?.confirm,
    clientSupportsElicitation: clientSupportsElicitation(opts.ctx),
    allowUnboundWriteConfirmation: opts.allowUnboundWriteConfirmation,
  });
  // A refused confirmation costs nothing upstream: it is decided before the
  // dictionary is even read.
  if (!("mode" in decision)) return failed(decision);

  const recipientError = await validateRecipient(deps.metadata, args.userId, signal);
  if (recipientError !== null) return failed(recipientError);

  const link = await resolveLink(deps, args, signal);
  if ("code" in link) return failed(link);

  const planned = detailFor(args.text, link);
  const items = planItems(args, planned);
  const digest = await hashArgs(items);

  if (decision.mode === "input-required") {
    const wire = await deps.codec.mint(
      { tool: NOTIFY_USER_TOOL, argsHash, previewDigest: digest, jti: newJti() },
      opts.ctx as ServerContext,
    );
    return inputRequired({
      inputRequests: {
        [CONFIRM_INPUT_KEY]: inputRequired.elicit({
          message: approvalMessage(planned),
          requestedSchema: confirmForm(args.text),
        }),
      },
      requestState: wire,
    });
  }
  if (decision.mode === "declined") {
    return previewResult(items, planned, { declined: true });
  }
  if (decision.mode === "preview") {
    return previewResult(items, planned, { requiresConfirmation: args.dryRun !== true });
  }
  // The preview is a promise about a record that may have moved since. When the
  // rebuilt plan no longer matches the one that was approved - a changed deep
  // link is enough - nothing is sent and the fresh plan goes back for a fresh
  // confirmation.
  if (state !== undefined && digest !== state.previewDigest) {
    return previewResult(items, planned, {
      requiresConfirmation: true,
      recordsChanged: true,
    });
  }

  // The human's own words win over the planned ones, and they answer to the
  // same bound the argument does: an edit outside it is not a smaller send, it
  // is no send at all.
  const body = accepted?.text ?? args.text;
  if (body.length < 1 || body.length > TEXT_MAX) {
    return previewResult(items, planned, { declined: true, editedTextRefused: true });
  }

  const executed = detailFor(body, link);
  const item: ActionWriteItem = {
    index: 0,
    action: NOTIFY_ACTION,
    kind: NOTIFY_KIND,
    status: "action",
    advisory: NOTIFICATION_UNVERIFIABLE,
    perform: async (callOpts: WriteCallOptions) => {
      // Checked and booked in one synchronous step, with no await between the
      // two: the early refusal above is a cheap pre-filter that costs the CRM
      // nothing, but every await between it and the dispatch is a window a
      // concurrent call walks through, and only this block holds the bound.
      // Booked BEFORE the dispatch on purpose: a call whose outcome we never
      // learn still spent a notification, and the budget has to assume it did.
      const at = Date.now();
      const late = checkBudget(args.userId, at);
      if (late !== null) throw new LivespaceError(late.code, late.message, late.hint);
      noteDispatch(args.userId, at);
      await deps.writes.sendNotification(
        { userId: args.userId, text: body, url: executed.url },
        callOpts,
      );
    },
  };

  const results = (
    await executePlan({ records: deps.records }, [item], {
      ...(signal === undefined ? {} : { signal }),
      deadlineAt,
    })
  ).map((result) => mergeDetail(result, executed));

  return {
    text: executedText(results),
    structured: { results, counts: countResults(results), errors: [] },
    isError: isBatchError(results),
  };
}
