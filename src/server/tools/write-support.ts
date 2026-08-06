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
 * The machinery the three write tools share: batch caps, the confirmation
 * state machine, the signed single-use `requestState`, and the executor that
 * writes items one at a time and verifies each one.
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
 * to spare; an activity item costs one write, so fifteen fit.
 */
export const WRITE_BATCH_CAP = 10;
export const ACTIVITY_BATCH_CAP = 15;

/** Wall clock for ONE write call, checked between items. */
export const WRITE_BUDGET_MS = 45_000;

/** How long a minted confirmation stays valid. */
export const CONFIRMATION_TTL_SECONDS = 300;

/** The `inputRequests` key every write tool elicits its confirmation under. */
export const CONFIRM_INPUT_KEY = "confirm";

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
 * Spent confirmations, bounded. 512 entries is sound under the single-process
 * deployment the codec key already assumes; past that the oldest is evicted
 * and becomes replayable, which is the documented bound of an in-memory set.
 */
const CONSUMED_JTI_LIMIT = 512;
const consumedJtis = new Set<string>();

export function consumeJti(jti: string): boolean {
  if (consumedJtis.has(jti)) return false;
  consumedJtis.add(jti);
  if (consumedJtis.size > CONSUMED_JTI_LIMIT) {
    const oldest = consumedJtis.values().next().value;
    if (oldest !== undefined) consumedJtis.delete(oldest);
  }
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
      "Send dryRun: true for a preview, or confirm: true to execute - not both.",
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
  if (opts.confirm === true) return { mode: "execute" };
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
  status: "create" | "update" | "note" | "call" | "skipped_duplicate" | "blocked";
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

function sentKeyCount(sent: Record<string, unknown>): number {
  return Object.values(sent).filter((value) => value !== undefined).length;
}

/** The successful path: the write landed, now say how much of it stuck. */
async function verifiedResult(
  deps: ExecuteDeps,
  item: RecordWriteItem,
  id: string,
  opts: WriteCallOptions,
): Promise<ItemResult> {
  const reread = await safeReread(deps, item.kind, id, opts);
  const verdict = verifyApplied(item.kind, item.sent, reread);
  const after = projected(item, reread);
  return {
    ...base(item),
    status: "ok",
    id,
    ...(item.before === undefined ? {} : { before: item.before }),
    ...(after === undefined ? {} : { after }),
    verification: verdict.verified ? "verified" : "unavailable",
    ...(verdict.unappliedFields.length > 0
      ? { unappliedFields: verdict.unappliedFields }
      : {}),
    ...(verdict.verified ? {} : { error: VERIFICATION_UNAVAILABLE }),
  };
}

/**
 * An item whose write landed. A record is re-read and compared; an activity is
 * not - `log_activities` verifies those through the wall, in one read per
 * target record rather than one per item.
 */
async function appliedResult(
  deps: ExecuteDeps,
  item: RecordWriteItem | ActivityWriteItem,
  id: string | null,
  opts: WriteCallOptions,
): Promise<ItemResult> {
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
  // Every sent field came back missing: nothing landed. Fields the verifier
  // has no counterpart for - a person's firstname, which upstream folds into
  // `name` - never appear here, so an update built only from those reads as
  // applied rather than as a false alarm.
  if (verdict.unappliedFields.length >= sentKeyCount(item.sent)) {
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
    if (item.status === "blocked") {
      results.push({ ...base(item), status: "error", error: item.error });
      continue;
    }

    let id: string | null = null;
    let failure: ToolError | undefined;
    try {
      id = await item.perform(callOpts);
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
