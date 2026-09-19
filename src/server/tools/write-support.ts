import {
  CLIENT_CAPABILITIES_META_KEY,
  acceptedContent,
  createRequestStateCodec,
  type RequestStateCodec,
  type ServerContext,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { ServerConfig } from "../../config/server-env.js";
import { cancelledError } from "../../livespace/errors.js";
import type {
  RecordDataMap,
  RecordFetchers,
  RecordKind,
} from "../../livespace/records.js";
import {
  verifyApplied,
  type RecordPointer,
  type WriteCallOptions,
} from "../../livespace/writes.js";
import { toToolError, type ToolError } from "./tool-error.js";

/**
 * The machinery the write tools share: batch caps, the confirmation state
 * machine, the signed single-use `requestState`, and the executor that writes
 * items one at a time and verifies each one.
 *
 * Five rules shape it, all of them from docs/security.md par. 5 and the M6
 * critique panel:
 *
 * 1. **A human approves, not the model.** On a client that can elicit, a write
 *    executes only after an accepted confirmation whose signed state matches
 *    this tool, these arguments and an unspent `jti`. A `confirm: true`
 *    argument cannot stand in for that prompt - it is ignored there.
 * 2. **What the human reads is ours.** Every approval string is counts and
 *    fixed wording; no CRM name, id or field value ever reaches it (par. 4).
 *    That is the tools' job, and this module never builds one from data.
 * 3. **The write outcome decides the item status.** A re-read that fails or
 *    finds nothing NEVER turns an applied write into an error: the item stays
 *    `ok` and reports `verification: "unavailable"`. `unappliedFields` is only
 *    ever spoken from a successful comparison.
 * 4. **An upstream that said stop is not hammered.** A rate-limited item ends
 *    the batch; the rest report `not_attempted`. The same for the wall clock:
 *    the budget is checked BETWEEN items, never mid-dispatch.
 * 5. **A cancelled batch is accounted for.** The abort signal is checked
 *    between items; before the CANCELLED rejection, one stderr line records
 *    how many items were applied and their ids - counts and ids only (par. 6).
 *
 * Nothing here is cached: record data never is (par. 8), so this module must
 * never import the server cache.
 */

/**
 * Batch caps, from timeout arithmetic rather than taste. One logical call is
 * two HTTP round-trips (token + signed dispatch) at 0.5-2 s through the
 * throttle, and a create/update item costs up to three of them (plan lookup,
 * write, re-read): 1.5-6 s. Ten of those fit a 60 s client timeout with room
 * to spare; an activity item costs one write plus, when its target is a
 * distinct record, one wall read - up to two - so fifteen fit. The budget
 * below spans BOTH phases, which is what keeps that arithmetic honest.
 */
export const WRITE_BATCH_CAP = 10;
export const ACTIVITY_BATCH_CAP = 15;

/** Wall clock for ONE write call, checked between items. */
export const WRITE_BUDGET_MS = 45_000;

/** How long a minted confirmation stays valid. */
export const CONFIRMATION_TTL_SECONDS = 300;

/** The `inputRequests` key every write tool elicits its confirmation under. */
export const CONFIRM_INPUT_KEY = "confirm";

// Keep discovery and previews aligned with decideConfirm's safe default.
export const WRITE_CONFIRMATION_DESCRIPTION = `dryRun: true previews without writing or asking for approval.
On clients with form elicitation, a non-dry-run call requests human approval;
confirm: true cannot bypass it. Other clients can preview, but execution with
confirm: true is refused by default. Only an operator-enabled unsafe compatibility
mode permits execution without signed human approval; see server instructions.`;

export const WRITE_CONFIRM_PARAMETER_DESCRIPTION =
  "True is refused by default without form elicitation; only operator-enabled " +
  "unsafe compatibility mode permits unbound execution. With form elicitation, " +
  "human approval is still required.";

export const WRITE_PREVIEW_HINT =
  "Use a client with form elicitation for approval. Without it, confirm: true " +
  "is refused unless the operator enabled unsafe compatibility mode.";

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Canonical JSON: object keys sorted, array order kept (an array's order is
 * data - the items are written in it), `undefined` dropped the way
 * `JSON.stringify` would drop it anyway.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return Object.fromEntries(entries.map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}

/**
 * The fingerprint a confirmation is bound to. It hashes exactly what it is
 * given - the tools hand it the item arrays alone, so that flipping `confirm`
 * or `dryRun` does not invalidate a confirmation minted for the same records.
 */
export async function hashArgs(value: unknown): Promise<string> {
  const json = JSON.stringify(canonical(value) ?? null);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json));
  return hex(new Uint8Array(digest));
}

/**
 * The confirmation payload. It is SIGNED, not encrypted: the client can read
 * it, so it carries fingerprints and a nonce - never argument values.
 */
export interface WriteState {
  tool: string;
  argsHash: string;
  previewDigest: string;
  jti: string;
}

/** 16 random bytes: the nonce that makes a confirmation single-use. */
export function newJti(): string {
  return hex(crypto.getRandomValues(new Uint8Array(16)));
}

let processKey: string | undefined;

/**
 * The loopback development fallback: one random key per PROCESS, not per call.
 * A fresh key per codec would break the flow it exists for - round two would
 * never verify round one's state.
 */
function fallbackKey(): string {
  if (processKey === undefined) {
    processKey = hex(crypto.getRandomValues(new Uint8Array(32)));
    console.error(
      "MCP_REQUEST_STATE_KEY is not set: write confirmations are signed with a " +
        "per-process random key and stop verifying after a restart. Set the " +
        "variable for anything but loopback development.",
    );
  }
  return processKey;
}

export function buildWriteCodec(
  config: Pick<ServerConfig, "requestStateKey">,
): RequestStateCodec<WriteState> {
  return createRequestStateCodec<WriteState>({
    key: config.requestStateKey ?? fallbackKey(),
    ttlSeconds: CONFIRMATION_TTL_SECONDS,
    // The spec's user-binding MUST: a confirmation minted for one principal
    // and one method is refused when echoed under another.
    bind: (ctx: ServerContext) =>
      `${ctx.mcpReq.method}\0${ctx.http?.authInfo?.clientId ?? ""}`,
  });
}

/**
 * Whether this client can be asked. Returning an input-required result to a
 * client that cannot elicit is a hard protocol error, so the probe is narrow
 * on purpose: anything it does not recognise falls back to the universal
 * preview, which works everywhere.
 */
export function clientSupportsElicitation(ctx: unknown): boolean {
  const envelope = (ctx as { mcpReq?: { envelope?: Record<string, unknown> } } | null)
    ?.mcpReq?.envelope;
  if (envelope === undefined || envelope === null) return false;
  const caps = envelope[CLIENT_CAPABILITIES_META_KEY];
  if (caps === null || typeof caps !== "object") return false;
  const elicitation = (caps as Record<string, unknown>)["elicitation"];
  if (elicitation === null || typeof elicitation !== "object") return false;
  if (Array.isArray(elicitation)) return false;
  // An empty capability object is the era's "all modes"; a populated one must
  // name form mode. URL-only elicitation cannot carry a confirmation form.
  const keys = Object.keys(elicitation as Record<string, unknown>);
  return keys.length === 0 || keys.includes("form");
}

const confirmSchema = z.strictObject({ confirm: z.boolean() });

/**
 * The human's answer, validated. `undefined` covers every non-answer - key
 * missing, prompt declined or cancelled, content off-schema - and all of them
 * mean the same thing here: nothing was approved.
 */
export function readElicitedConfirm(ctx: unknown): boolean | undefined {
  const responses = (
    ctx as { mcpReq?: { inputResponses?: Record<string, unknown> } } | null
  )?.mcpReq?.inputResponses;
  return acceptedContent(responses, CONFIRM_INPUT_KEY, confirmSchema)?.confirm;
}

/**
 * Spent confirmations live for a full codec TTL after they are consumed.
 * Never evict an unexpired entry: a count-bound set made an old but still
 * valid signed state replayable once enough later confirmations were used.
 * Expiry bounds this process-local store by the valid-time window instead.
 */
const consumedJtis = new Map<string, number>();

function purgeExpiredJtis(now: number): void {
  for (const [jti, expiresAt] of consumedJtis) {
    if (expiresAt < now) consumedJtis.delete(jti);
  }
}

export function consumeJti(jti: string): boolean {
  const now = Date.now();
  purgeExpiredJtis(now);
  if (consumedJtis.has(jti)) return false;
  consumedJtis.set(jti, now + CONFIRMATION_TTL_SECONDS * 1000);
  return true;
}

export type ConfirmMode = "preview" | "input-required" | "execute" | "declined";

export interface ConfirmOptions {
  tool: string;
  argsHash: string;
  confirm?: boolean | undefined;
  dryRun?: boolean | undefined;
  /** The VERIFIED codec payload, or undefined when the round carried none. */
  state?: WriteState | undefined;
  elicitedConfirm?: boolean | undefined;
  clientSupportsElicitation: boolean;
  /** Explicit operator opt-in for the compatibility path without signed state. */
  allowUnboundWriteConfirmation?: boolean | undefined;
}

export type ConfirmDecision = { mode: ConfirmMode } | ToolError;

function confirmRefused(message: string, hint: string): ToolError {
  return { code: "BAD_PARAMS", message, hint };
}

/**
 * The whole confirmation flow in one pure function, so every path is a test
 * row rather than a branch buried in three tools.
 *
 * The two rules worth stating out loud:
 *
 * - On an elicitation-capable client the model CANNOT self-confirm. A
 *   `confirm: true` argument there still ends in the human prompt (rule 4).
 * - A state that arrives without an accepted answer is a DECLINE, never a
 *   retry: re-eliciting a prompt the human just dismissed is nagging, and
 *   executing it is a write nobody approved.
 */
export function decideConfirm(opts: ConfirmOptions): ConfirmDecision {
  if (opts.dryRun === true && opts.confirm === true) {
    return confirmRefused(
      "dryRun and confirm cannot be combined.",
      "Send dryRun: true without confirm for a preview. For approval, omit both on a client with form elicitation.",
    );
  }
  if (opts.dryRun === true) return { mode: "preview" };

  const state = opts.state;
  if (state !== undefined) {
    if (state.tool !== opts.tool) {
      return confirmRefused(
        "This confirmation belongs to another tool.",
        "Call the tool again without a confirmation to get a fresh preview.",
      );
    }
    if (state.argsHash !== opts.argsHash) {
      return confirmRefused(
        "The arguments changed since the preview.",
        "Call the tool again to preview the new arguments, then confirm those.",
      );
    }
    // Burned here, on the round that could execute - a declined answer spends
    // it too, so a dismissed prompt cannot be replayed into a write.
    if (!consumeJti(state.jti)) {
      return confirmRefused(
        "This confirmation was already used.",
        "Call the tool again to get a fresh preview, then confirm that one.",
      );
    }
    if (opts.elicitedConfirm !== true) return { mode: "declined" };
    return { mode: "execute" };
  }

  if (opts.clientSupportsElicitation) return { mode: "input-required" };
  if (opts.confirm === true) {
    if (opts.allowUnboundWriteConfirmation === true) return { mode: "execute" };
    return confirmRefused(
      "This client cannot bind confirmation to a human approval.",
      "Use a client with form elicitation, or let the operator explicitly " +
        "enable the unsafe compatibility mode.",
    );
  }
  return { mode: "preview" };
}

/**
 * One planned item, as the preview shows it. `blocked` carries the reason it
 * cannot run (a missing target, say) and is skipped at execute.
 */
export interface WriteItemPlan {
  index: number;
  action: string;
  kind: string;
  status:
    | "create"
    | "update"
    | "move"
    | "unchanged"
    | "action"
    | "note"
    | "call"
    | "skipped_duplicate"
    | "blocked";
  summary: Record<string, unknown>;
  dedupe?: { existingId: string };
  before?: Record<string, unknown>;
  error?: ToolError;
}

/** One executed item. `status` is decided by the WRITE, never by the re-read. */
export interface ItemResult {
  index: number;
  action: string;
  kind: string;
  status: "ok" | "skipped_duplicate" | "error" | "unknown_outcome" | "not_attempted";
  id?: string;
  existingId?: string;
  resolvedByReread?: boolean;
  verification?: "verified" | "unavailable";
  unappliedFields?: string[];
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  error?: ToolError;
}

/**
 * The re-read record, handed to the tool's own projector as a plain bag. The
 * projection is display material for `after`; the typed comparison that
 * decides `unappliedFields` is `verifyApplied`'s job.
 */
export type RecordView = (record: Record<string, unknown>) => Record<string, unknown>;

/**
 * What a create may be resolved against when its outcome is unknown. The guard
 * is deliberately narrow: a resolution is only believed when the plan-time
 * lookup RAN, found nothing, and no sibling item claims the same identity -
 * otherwise the row found could be someone else's record entirely.
 */
export interface CreateResolution {
  lookup: "not-run" | "hit" | "missed";
  uniqueInBatch: boolean;
  /** Ids that existed before this batch: landing on one proves nothing. */
  knownIds: readonly string[];
  find(opts: WriteCallOptions): Promise<RecordPointer | null>;
}

export interface RecordWriteItem {
  index: number;
  action: string;
  kind: RecordKind;
  status: "create" | "update";
  /** Field values under the TOOL's names - what `verifyApplied` compares. */
  sent: Record<string, unknown>;
  /** Updates own their target id; a create learns it from the echo. */
  id?: string;
  /** ONE dispatch, resolving with the record id. */
  perform(opts: WriteCallOptions): Promise<string>;
  view?: RecordView;
  before?: Record<string, unknown>;
  resolve?: CreateResolution;
}

export interface ActivityWriteItem {
  index: number;
  action: string;
  kind: string;
  status: "note" | "call";
  /** Resolves with the wall item id when the endpoint reports one. */
  perform(opts: WriteCallOptions): Promise<string | null>;
}

/**
 * An item the plan resolved to nothing to do - a deal already standing where it
 * was asked to stand. It is `ok` because the CRM already holds what the caller
 * asked for, and it dispatches nothing, reads nothing back and claims no
 * verification: there is no outcome to verify.
 */
export interface NoWriteItem {
  index: number;
  action: string;
  kind: string;
  status: "unchanged";
  /** The display bag, reported as `after`: what a re-read would have shown. */
  view?: Record<string, unknown>;
}

/**
 * A write with no record behind it - a notification. It dispatches once and
 * stops there: the endpoint exposes no read-back at all, so the item reports
 * `verification: "unavailable"` with the advisory its caller supplies, and a
 * mid-flight failure stays `unknown_outcome` rather than being resolved.
 */
export interface ActionWriteItem {
  index: number;
  action: string;
  kind: string;
  status: "action";
  /** Why the outcome cannot be checked; shown with the applied item. */
  advisory: ToolError;
  perform(opts: WriteCallOptions): Promise<void>;
}

export interface SkippedItem {
  index: number;
  action: string;
  kind: string;
  status: "skipped_duplicate";
  existingId: string;
}

export interface BlockedItem {
  index: number;
  action: string;
  kind: string;
  status: "blocked";
  error: ToolError;
}

export type ExecutableItem =
  | RecordWriteItem
  | ActivityWriteItem
  | ActionWriteItem
  | NoWriteItem
  | SkippedItem
  | BlockedItem;

export interface ExecuteDeps {
  records: Pick<RecordFetchers, "getRecord">;
}

/**
 * The advisory an applied-but-unverified write carries. It says the one thing
 * that matters: read before writing again, and never retry the write itself.
 */
export const VERIFICATION_UNAVAILABLE: ToolError = {
  code: "VERIFICATION_UNAVAILABLE",
  message: "The write was applied, but the follow-up read did not answer.",
  hint: "Re-read the record before writing to it again; never retry the write itself.",
};

/**
 * The other reason a check could not run: the read ANSWERED, and not one sent
 * field has a counterpart to compare it against - a person's firstname, which
 * upstream folds into a composed `name`. Saying "the read did not answer" there
 * would be false, and saying "verified" would be a claim about a comparison
 * that never happened.
 */
export const VERIFICATION_UNCHECKED: ToolError = {
  code: "VERIFICATION_UNCHECKED",
  message: "The write was applied; the sent fields have no independent re-read check.",
  hint: "Re-read the record if you need proof; do not retry the write.",
};

/**
 * The advisory a notification carries. Livespace has no read-back for one -
 * three candidate endpoints all answered 540 - so "dispatched" is the strongest
 * thing anyone can say, and a resend would be a second bell entry, not a fix.
 */
export const NOTIFICATION_UNVERIFIABLE: ToolError = {
  code: "NOTIFICATION_UNVERIFIABLE",
  message:
    "Livespace exposes no read-back for notifications; delivery cannot be confirmed.",
  hint: "Do not resend; confirm with the recipient another way.",
};

/**
 * The reason an item never made it into the plan: the call's budget ran out
 * while the earlier items were being looked up. It is a BLOCK, not a silent
 * skip - the plan phase costs upstream reads, so the caller has to know which
 * items were never considered and why.
 */
export const PLAN_BUDGET_EXPIRED: ToolError = {
  code: "BUDGET_EXPIRED",
  message: "The call ran out of time before this item was planned.",
  hint: "Nothing was written for it. Re-send this item in a smaller batch.",
};

function base(item: ExecutableItem): { index: number; action: string; kind: string } {
  return { index: item.index, action: item.action, kind: item.kind };
}

function isRecordItem(item: ExecutableItem): item is RecordWriteItem {
  return item.status === "create" || item.status === "update";
}

/**
 * The CANCELLED contract at every catch site: only the caller's signal STATE is
 * reliable (an abort surfaces as a DOMException, a plain Error or a bare string
 * reason), and a cancelled call NEVER returns a tool result - it rejects.
 */
function classify(
  error: unknown,
  signal: AbortSignal | undefined,
): ToolError | "cancelled" {
  if (signal?.aborted) return "cancelled";
  const entry = toToolError(error);
  return entry.code === "CANCELLED" ? "cancelled" : entry;
}

/** A re-read is never allowed to fail an applied write, so it fails quietly. */
async function safeReread(
  deps: ExecuteDeps,
  kind: RecordKind,
  id: string,
  opts: WriteCallOptions,
): Promise<RecordDataMap[RecordKind] | null> {
  try {
    return await deps.records.getRecord(kind, id, opts);
  } catch {
    return null;
  }
}

function projected(
  item: RecordWriteItem,
  reread: RecordDataMap[RecordKind] | null,
): Record<string, unknown> | undefined {
  if (reread === null || item.view === undefined) return undefined;
  return item.view(reread as unknown as Record<string, unknown>);
}

/**
 * The successful path: the write landed, now say how much of it stuck.
 *
 * "Verified" is only ever spoken about fields a comparator actually ran on. A
 * read that answered but had nothing to compare is `unavailable` too - with its
 * own advisory, because the reason differs and the recovery does not.
 */
async function verifiedResult(
  deps: ExecuteDeps,
  item: RecordWriteItem,
  id: string,
  opts: WriteCallOptions,
): Promise<ItemResult> {
  const reread = await safeReread(deps, item.kind, id, opts);
  const verdict = verifyApplied(item.kind, item.sent, reread);
  const after = projected(item, reread);
  const compared = verdict.verified && verdict.comparedFields.length > 0;
  const advisory = verdict.verified ? VERIFICATION_UNCHECKED : VERIFICATION_UNAVAILABLE;
  return {
    ...base(item),
    status: "ok",
    id,
    ...(item.before === undefined ? {} : { before: item.before }),
    ...(after === undefined ? {} : { after }),
    verification: compared ? "verified" : "unavailable",
    ...(verdict.unappliedFields.length > 0
      ? { unappliedFields: verdict.unappliedFields }
      : {}),
    ...(compared ? {} : { error: advisory }),
  };
}

/**
 * An item whose write landed. A record is re-read and compared; an activity is
 * not - `log_activities` verifies those through the wall, in one read per
 * target record rather than one per item.
 */
async function appliedResult(
  deps: ExecuteDeps,
  item: RecordWriteItem | ActivityWriteItem | ActionWriteItem,
  id: string | null,
  opts: WriteCallOptions,
): Promise<ItemResult> {
  // An action has nothing to read back, and says so with the caller's own
  // wording rather than pretending a check was attempted.
  if (item.status === "action") {
    return {
      ...base(item),
      status: "ok",
      verification: "unavailable",
      error: item.advisory,
    };
  }
  if (!isRecordItem(item)) {
    return { ...base(item), status: "ok", ...(id === null ? {} : { id }) };
  }
  // A record write always answers with an id; the guard keeps the shared
  // dispatch signature total instead of casting the type away.
  if (id === null) {
    return {
      ...base(item),
      status: "ok",
      verification: "unavailable",
      error: VERIFICATION_UNAVAILABLE,
    };
  }
  return verifiedResult(deps, item, id, opts);
}

function unknownResult(item: ExecutableItem, entry: ToolError): ItemResult {
  return { ...base(item), status: "unknown_outcome", error: entry };
}

/**
 * A write whose outcome the transport could not tell us. Guessing wrong in
 * either direction is expensive, so resolution is conservative: a create is
 * only claimed when a uniquely-identified lookup that came up empty at plan
 * time now finds a record nobody knew about, and an update - whose id we own
 * anyway - is decided by re-reading it.
 */
async function resolveUnknown(
  deps: ExecuteDeps,
  item: RecordWriteItem,
  entry: ToolError,
  opts: WriteCallOptions,
): Promise<ItemResult> {
  if (item.status === "create") {
    const resolve = item.resolve;
    if (resolve === undefined || resolve.lookup !== "missed" || !resolve.uniqueInBatch) {
      return unknownResult(item, entry);
    }
    let hit: RecordPointer | null = null;
    try {
      hit = await resolve.find(opts);
    } catch {
      hit = null;
    }
    if (hit === null || resolve.knownIds.includes(hit.id)) {
      return unknownResult(item, entry);
    }
    return {
      ...base(item),
      status: "ok",
      id: hit.id,
      resolvedByReread: true,
      // The record was found, but its fields were never compared.
      verification: "unavailable",
      error: VERIFICATION_UNAVAILABLE,
    };
  }

  const id = item.id;
  if (id === undefined) return unknownResult(item, entry);
  const reread = await safeReread(deps, item.kind, id, opts);
  const verdict = verifyApplied(item.kind, item.sent, reread);
  // No comparison, no claim: the outcome stays unknown.
  if (!verdict.verified) return unknownResult(item, entry);
  // The resolution is decided by the fields a comparator RAN on, and by
  // nothing else. Zero of them is zero evidence - an update naming only a
  // person's firstname, which upstream folds into `name`, can never be
  // resolved this way. And when every compared field came back missing,
  // nothing landed: an uncheckable field sent beside them must not pad the
  // count into a success.
  if (verdict.unappliedFields.length >= verdict.comparedFields.length) {
    return unknownResult(item, entry);
  }
  const after = projected(item, reread);
  return {
    ...base(item),
    status: "ok",
    id,
    ...(item.before === undefined ? {} : { before: item.before }),
    ...(after === undefined ? {} : { after }),
    resolvedByReread: true,
    verification: "verified",
    ...(verdict.unappliedFields.length > 0
      ? { unappliedFields: verdict.unappliedFields }
      : {}),
  };
}

/** Counts and written ids only - no names, no payloads (par. 6). */
function auditCancelled(applied: number, ids: readonly string[]): void {
  console.error(
    `write batch cancelled after ${applied} applied item(s): ids=[${ids.join(", ")}]`,
  );
}

/**
 * The same accounting for a phase that runs AFTER `executePlan` - a post-write
 * verification pass, say, whose writes have already landed and cannot be taken
 * back. The counts are derived exactly as `executePlan` derives them: applied
 * items are the ones the write made `ok`, and the ids are the ones they
 * reported. A logged call reports none, so an ids list shorter than the count
 * is correct, not a bug.
 *
 * Exactly one line is ever emitted per call: `executePlan`'s own cancel ends
 * the call before any later phase can start.
 */
export async function withCancelAudit<T>(
  written: readonly ItemResult[],
  phase: () => Promise<T>,
): Promise<T> {
  try {
    return await phase();
  } catch (error) {
    if (toToolError(error).code === "CANCELLED") {
      const applied = written.filter((result) => result.status === "ok");
      auditCancelled(
        applied.length,
        applied.flatMap((result) => (result.id === undefined ? [] : [result.id])),
      );
    }
    throw error;
  }
}

/**
 * Writes the plan, one item at a time, in declaration order.
 *
 * Sequential on purpose: a batch that fires concurrently cannot honour "stop
 * when the upstream said stop", and its partial results would be unordered
 * against the items the caller sent.
 */
export async function executePlan(
  deps: ExecuteDeps,
  items: readonly ExecutableItem[],
  opts: { signal?: AbortSignal; deadlineAt: number },
): Promise<ItemResult[]> {
  const results: ItemResult[] = [];
  const appliedIds: string[] = [];
  const callOpts: WriteCallOptions =
    opts.signal === undefined ? {} : { signal: opts.signal };
  let applied = 0;
  let halted = false;

  // Annotated on the binding, not the arrow: that is what lets the compiler
  // treat a `cancel()` call as unreachable code after it.
  const cancel: () => never = () => {
    auditCancelled(applied, appliedIds);
    throw cancelledError();
  };

  for (const item of items) {
    // Between items, in this order - never mid-dispatch.
    if (opts.signal?.aborted) cancel();
    if (!halted && Date.now() >= opts.deadlineAt) halted = true;

    // Before the halt guard: a blocked item already carries the reason it
    // cannot run - often the very reason the batch halted - and a bare
    // `not_attempted` would swallow it.
    if (item.status === "blocked") {
      results.push({ ...base(item), status: "error", error: item.error });
      continue;
    }
    if (halted) {
      results.push({ ...base(item), status: "not_attempted" });
      continue;
    }
    if (item.status === "skipped_duplicate") {
      results.push({
        ...base(item),
        status: "skipped_duplicate",
        existingId: item.existingId,
      });
      continue;
    }
    // Nothing to do, so nothing is dispatched and nothing is read back: the
    // CRM already holds what the caller asked for. It is not counted as an
    // applied item either - the audit line speaks about writes.
    if (item.status === "unchanged") {
      results.push({
        ...base(item),
        status: "ok",
        ...(item.view === undefined ? {} : { after: item.view }),
      });
      continue;
    }

    let id: string | null = null;
    let failure: ToolError | undefined;
    try {
      // A record write answers with an id, an activity with a wall item id or
      // nothing, an action with nothing at all.
      const dispatched: unknown = await item.perform(callOpts);
      id = typeof dispatched === "string" ? dispatched : null;
    } catch (error) {
      const classified = classify(error, opts.signal);
      if (classified === "cancelled") cancel();
      failure = classified;
    }

    let result: ItemResult;
    if (failure === undefined) {
      result = await appliedResult(deps, item, id, callOpts);
    } else if (failure.code === "WRITE_OUTCOME_UNKNOWN") {
      // A record item can be looked for; a note or a call cannot.
      result = isRecordItem(item)
        ? await resolveUnknown(deps, item, failure, callOpts)
        : unknownResult(item, failure);
    } else {
      result = { ...base(item), status: "error", error: failure };
      // An upstream that rejected the call before processing it is telling
      // the batch to stop, not to try the next item faster.
      if (failure.code === "RATE_LIMITED") halted = true;
    }

    if (result.status === "ok") {
      applied += 1;
      if (result.id !== undefined) appliedIds.push(result.id);
    }
    results.push(result);
  }

  // A caller who walked away mid-batch gets the audit line, not a result.
  if (opts.signal?.aborted) cancel();
  return results;
}

export interface WriteCounts {
  ok: number;
  skippedDuplicate: number;
  error: number;
  unknownOutcome: number;
  notAttempted: number;
}

export function countResults(results: readonly ItemResult[]): WriteCounts {
  const counts: WriteCounts = {
    ok: 0,
    skippedDuplicate: 0,
    error: 0,
    unknownOutcome: 0,
    notAttempted: 0,
  };
  for (const result of results) {
    if (result.status === "ok") counts.ok += 1;
    else if (result.status === "skipped_duplicate") counts.skippedDuplicate += 1;
    else if (result.status === "error") counts.error += 1;
    else if (result.status === "unknown_outcome") counts.unknownOutcome += 1;
    else counts.notAttempted += 1;
  }
  return counts;
}

/**
 * A call failed only when it tried something and every attempt failed. A batch
 * that skipped every duplicate did exactly what it was asked to do.
 */
export function isBatchError(results: readonly ItemResult[]): boolean {
  const counts = countResults(results);
  const attempted = counts.ok + counts.error + counts.unknownOutcome;
  return attempted > 0 && counts.ok === 0;
}
