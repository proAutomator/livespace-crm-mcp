import { describe, expect, test } from "bun:test";
import type { ServerContext } from "@modelcontextprotocol/server";
import { LivespaceError } from "../../src/livespace/errors.js";
import type { RecordFetchers, RecordKind } from "../../src/livespace/records.js";
import type { RecordPointer } from "../../src/livespace/writes.js";
import {
  ACTIVITY_BATCH_CAP,
  CONFIRMATION_TTL_SECONDS,
  NOTIFICATION_UNVERIFIABLE,
  VERIFICATION_UNAVAILABLE,
  VERIFICATION_UNCHECKED,
  WRITE_BATCH_CAP,
  WRITE_BUDGET_MS,
  buildWriteCodec,
  clientSupportsElicitation,
  consumeJti,
  countResults,
  decideConfirm,
  executePlan,
  hashArgs,
  isBatchError,
  newJti,
  readElicitedConfirm,
  type ActionWriteItem,
  type ConfirmDecision,
  type CreateResolution,
  type ExecutableItem,
  type ExecuteDeps,
  type ItemResult,
  type NoWriteItem,
  type RecordWriteItem,
  type WriteItemPlan,
  type WriteState,
} from "../../src/server/tools/write-support.js";
import { person, task } from "../support/records.js";

/**
 * The shared write machinery, pinned against fakes. Every value here is
 * invented (AGENTS.md): no CRM data, no sandbox values, and nothing in this
 * file ever leaves the process.
 */

const KEY = "synthetic-request-state-key-0123456789";
const OTHER_KEY = "synthetic-request-state-key-9876543210";

/** The literal envelope key, spelled out so a rename upstream fails loudly. */
const CAPS_KEY = "io.modelcontextprotocol/clientCapabilities";

function ctxWithCaps(caps: unknown): unknown {
  return { mcpReq: { method: "tools/call", envelope: { [CAPS_KEY]: caps } } };
}

function ctxWithResponses(responses: Record<string, unknown>): unknown {
  return { mcpReq: { method: "tools/call", inputResponses: responses } };
}

function serverContext(principal = "synthetic-principal"): ServerContext {
  return {
    mcpReq: { method: "tools/call" },
    http: { authInfo: { clientId: principal } },
  } as unknown as ServerContext;
}

function state(overrides: Partial<WriteState> = {}): WriteState {
  return {
    tool: "create_records",
    argsHash: "hash-synthetic-a",
    previewDigest: "digest-synthetic-a",
    jti: newJti(),
    ...overrides,
  };
}

function mode(decision: ConfirmDecision): string {
  return "mode" in decision ? decision.mode : `error:${decision.code}`;
}

describe("decideConfirm", () => {
  test("dryRun with confirm is a contradiction", () => {
    const decision = decideConfirm({
      tool: "create_records",
      argsHash: "hash-synthetic-a",
      dryRun: true,
      confirm: true,
      clientSupportsElicitation: false,
    });
    expect(decision).toEqual({
      code: "BAD_PARAMS",
      message: "dryRun and confirm cannot be combined.",
      hint: "Send dryRun: true for a preview, or confirm: true to execute - not both.",
    });
  });

  test("dryRun previews and ignores any confirmation state", () => {
    const carried = state();
    const decision = decideConfirm({
      tool: "create_records",
      argsHash: "hash-synthetic-a",
      dryRun: true,
      state: carried,
      elicitedConfirm: true,
      clientSupportsElicitation: true,
    });
    expect(mode(decision)).toBe("preview");
    // The state was ignored, so its jti is still unspent.
    expect(consumeJti(carried.jti)).toBe(true);
  });

  test("a confirmation minted for another tool is refused", () => {
    const decision = decideConfirm({
      tool: "update_records",
      argsHash: "hash-synthetic-a",
      state: state({ tool: "create_records" }),
      elicitedConfirm: true,
      clientSupportsElicitation: true,
    });
    expect(decision).toEqual({
      code: "BAD_PARAMS",
      message: "This confirmation belongs to another tool.",
      hint: "Call the tool again without a confirmation to get a fresh preview.",
    });
  });

  test("a confirmation whose arguments changed is refused", () => {
    const decision = decideConfirm({
      tool: "create_records",
      argsHash: "hash-synthetic-b",
      state: state({ argsHash: "hash-synthetic-a" }),
      elicitedConfirm: true,
      clientSupportsElicitation: true,
    });
    expect(decision).toEqual({
      code: "BAD_PARAMS",
      message: "The arguments changed since the preview.",
      hint: "Call the tool again to preview the new arguments, then confirm those.",
    });
  });

  test("a confirmation is single use", () => {
    const carried = state();
    const first = decideConfirm({
      tool: "create_records",
      argsHash: carried.argsHash,
      state: carried,
      elicitedConfirm: true,
      clientSupportsElicitation: true,
    });
    expect(mode(first)).toBe("execute");

    const replay = decideConfirm({
      tool: "create_records",
      argsHash: carried.argsHash,
      state: carried,
      elicitedConfirm: true,
      clientSupportsElicitation: true,
    });
    expect(replay).toEqual({
      code: "BAD_PARAMS",
      message: "This confirmation was already used.",
      hint: "Call the tool again to get a fresh preview, then confirm that one.",
    });
  });

  test("state without an accepted elicitation is a declined preview", () => {
    const decision = decideConfirm({
      tool: "create_records",
      argsHash: "hash-synthetic-a",
      state: state(),
      clientSupportsElicitation: true,
    });
    expect(mode(decision)).toBe("declined");
  });

  test("an explicitly refused elicitation is a declined preview, never an execute", () => {
    const decision = decideConfirm({
      tool: "create_records",
      argsHash: "hash-synthetic-a",
      state: state(),
      elicitedConfirm: false,
      // Even a confirm argument cannot rescue a refused prompt.
      confirm: true,
      clientSupportsElicitation: true,
    });
    expect(mode(decision)).toBe("declined");
  });

  test("state plus an accepted elicitation executes", () => {
    const decision = decideConfirm({
      tool: "create_records",
      argsHash: "hash-synthetic-a",
      state: state(),
      elicitedConfirm: true,
      clientSupportsElicitation: true,
    });
    expect(mode(decision)).toBe("execute");
  });

  test("the model cannot self-confirm on an elicitation-capable client", () => {
    const decision = decideConfirm({
      tool: "create_records",
      argsHash: "hash-synthetic-a",
      confirm: true,
      clientSupportsElicitation: true,
    });
    expect(mode(decision)).toBe("input-required");
  });

  test("an elicitation-capable client is asked before anything is written", () => {
    const decision = decideConfirm({
      tool: "create_records",
      argsHash: "hash-synthetic-a",
      clientSupportsElicitation: true,
    });
    expect(mode(decision)).toBe("input-required");
  });

  test("without elicitation the confirm argument is the execute trigger", () => {
    const decision = decideConfirm({
      tool: "create_records",
      argsHash: "hash-synthetic-a",
      confirm: true,
      clientSupportsElicitation: false,
    });
    expect(mode(decision)).toBe("execute");
  });

  test("a plain call previews", () => {
    const decision = decideConfirm({
      tool: "create_records",
      argsHash: "hash-synthetic-a",
      clientSupportsElicitation: false,
    });
    expect(mode(decision)).toBe("preview");
  });
});

describe("hashArgs", () => {
  test("key order does not change the hash", async () => {
    const first = await hashArgs({ persons: [{ firstname: "A", lastname: "B" }] });
    const second = await hashArgs({ persons: [{ lastname: "B", firstname: "A" }] });
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("array order does change the hash", async () => {
    const first = await hashArgs({ companies: [{ name: "A" }, { name: "B" }] });
    const second = await hashArgs({ companies: [{ name: "B" }, { name: "A" }] });
    expect(first).not.toBe(second);
  });

  test("nothing is stripped: an added key changes the hash", async () => {
    const bare = await hashArgs({ persons: [] });
    const withConfirm = await hashArgs({ persons: [], confirm: true });
    expect(bare).not.toBe(withConfirm);
  });
});

describe("clientSupportsElicitation", () => {
  test("form-capable clients are accepted", () => {
    expect(clientSupportsElicitation(ctxWithCaps({ elicitation: {} }))).toBe(true);
    expect(clientSupportsElicitation(ctxWithCaps({ elicitation: { form: {} } }))).toBe(
      true,
    );
  });

  test("url-only elicitation is not form elicitation", () => {
    expect(clientSupportsElicitation(ctxWithCaps({ elicitation: { url: {} } }))).toBe(
      false,
    );
  });

  test("anything else falls back to the universal preview", () => {
    expect(clientSupportsElicitation(ctxWithCaps({}))).toBe(false);
    expect(clientSupportsElicitation(ctxWithCaps({ elicitation: true }))).toBe(false);
    expect(clientSupportsElicitation(ctxWithCaps({ elicitation: null }))).toBe(false);
    expect(clientSupportsElicitation({ mcpReq: { method: "tools/call" } })).toBe(false);
    expect(clientSupportsElicitation(undefined)).toBe(false);
    expect(clientSupportsElicitation(null)).toBe(false);
  });
});

describe("readElicitedConfirm", () => {
  test("an accepted confirm is read back", () => {
    const ctx = ctxWithResponses({
      confirm: { action: "accept", content: { confirm: true } },
    });
    expect(readElicitedConfirm(ctx)).toBe(true);
  });

  test("declined, cancelled, off-schema and missing responses read as undefined", () => {
    expect(
      readElicitedConfirm(ctxWithResponses({ confirm: { action: "decline" } })),
    ).toBeUndefined();
    expect(
      readElicitedConfirm(ctxWithResponses({ confirm: { action: "cancel" } })),
    ).toBeUndefined();
    expect(
      readElicitedConfirm(
        ctxWithResponses({
          confirm: { action: "accept", content: { confirm: "yes" } },
        }),
      ),
    ).toBeUndefined();
    expect(readElicitedConfirm(ctxWithResponses({}))).toBeUndefined();
    expect(readElicitedConfirm(undefined)).toBeUndefined();
  });

  test("an accepted refusal reads as false", () => {
    const ctx = ctxWithResponses({
      confirm: { action: "accept", content: { confirm: false } },
    });
    expect(readElicitedConfirm(ctx)).toBe(false);
  });
});

describe("consumeJti", () => {
  test("a jti burns on first use", () => {
    const jti = "jti-synthetic-burn";
    expect(consumeJti(jti)).toBe(true);
    expect(consumeJti(jti)).toBe(false);
  });

  test("more than 512 later entries never unburn an unexpired jti", () => {
    const oldest = "jti-synthetic-stays-burned";
    expect(consumeJti(oldest)).toBe(true);
    for (let i = 0; i < 600; i += 1) {
      expect(consumeJti(`jti-synthetic-filler-${i}`)).toBe(true);
    }
    expect(consumeJti(oldest)).toBe(false);
  });

  test("expired entries are purged without unburning a live sibling", () => {
    const realNow = Date.now;
    const base = realNow();
    try {
      Date.now = () => base;
      expect(consumeJti("jti-synthetic-expires")).toBe(true);

      Date.now = () => base + CONFIRMATION_TTL_SECONDS * 1000 - 1;
      expect(consumeJti("jti-synthetic-still-live")).toBe(true);

      Date.now = () => base + CONFIRMATION_TTL_SECONDS * 1000 + 1;
      expect(consumeJti("jti-synthetic-expires")).toBe(true);
      expect(consumeJti("jti-synthetic-still-live")).toBe(false);
    } finally {
      Date.now = realNow;
    }
  });
});

describe("caps and budget", () => {
  test("the batch caps and the wall clock are the timeout arithmetic", () => {
    expect(WRITE_BATCH_CAP).toBe(10);
    expect(ACTIVITY_BATCH_CAP).toBe(15);
    expect(WRITE_BUDGET_MS).toBe(45_000);
    expect(CONFIRMATION_TTL_SECONDS).toBe(300);
  });
});

/** A recording `getRecord`, keyed `kind:id`; an Error value is thrown. */
function fakeRecords(answers: Record<string, unknown> = {}): {
  deps: ExecuteDeps;
  calls: string[];
} {
  const calls: string[] = [];
  const getRecord = (async (kind: RecordKind, id: string) => {
    calls.push(`${kind}:${id}`);
    const answer = answers[`${kind}:${id}`];
    if (answer instanceof Error) throw answer;
    return answer ?? null;
  }) as RecordFetchers["getRecord"];
  return { deps: { records: { getRecord } }, calls };
}

interface ItemOptions {
  sent?: Record<string, unknown>;
  id?: string;
  fail?: unknown;
  resolve?: CreateResolution;
  before?: Record<string, unknown>;
}

function createPerson(
  index: number,
  writes: string[],
  opts: ItemOptions = {},
): RecordWriteItem {
  const id = opts.id ?? "person-synthetic-001";
  return {
    index,
    action: "create_person",
    kind: "person",
    status: "create",
    sent: opts.sent ?? { emails: ["person.one@synthetic.example"] },
    perform: async () => {
      writes.push(`create_person#${index}`);
      if (opts.fail !== undefined) throw opts.fail;
      return id;
    },
    view: (record) => ({ emails: record["emails"] }),
    ...(opts.resolve === undefined ? {} : { resolve: opts.resolve }),
    ...(opts.before === undefined ? {} : { before: opts.before }),
  };
}

function updateTask(
  index: number,
  writes: string[],
  opts: ItemOptions = {},
): RecordWriteItem {
  const id = opts.id ?? "task-synthetic-801";
  return {
    index,
    action: "update_task",
    kind: "task",
    status: "update",
    id,
    sent: opts.sent ?? { title: "Synthetic Task One" },
    perform: async () => {
      writes.push(`update_task#${index}`);
      if (opts.fail !== undefined) throw opts.fail;
      return id;
    },
    view: (record) => ({ title: record["title"] }),
    ...(opts.before === undefined ? {} : { before: opts.before }),
  };
}

/**
 * A person update, which is the kind whose sent fields may have no comparator
 * at all: `firstname` and `lastname` are composed into `name` upstream.
 */
function updatePerson(
  index: number,
  writes: string[],
  opts: ItemOptions = {},
): RecordWriteItem {
  const id = opts.id ?? "person-synthetic-001";
  return {
    index,
    action: "update_person",
    kind: "person",
    status: "update",
    id,
    sent: opts.sent ?? { firstname: "Anna" },
    perform: async () => {
      writes.push(`update_person#${index}`);
      if (opts.fail !== undefined) throw opts.fail;
      return id;
    },
    view: (record) => ({ name: record["name"] }),
    ...(opts.before === undefined ? {} : { before: opts.before }),
  };
}

function noteItem(index: number, writes: string[], wallItemId: string | null): ExecutableItem {
  return {
    index,
    action: "note",
    kind: "deal",
    status: "note",
    perform: async () => {
      writes.push(`note#${index}`);
      return wallItemId;
    },
  };
}

/** A deal the move tool found already standing where it was asked to stand. */
function unchangedDeal(index: number, view?: Record<string, unknown>): NoWriteItem {
  return {
    index,
    action: "move_deal",
    kind: "deal",
    status: "unchanged",
    ...(view === undefined ? {} : { view }),
  };
}

/** A dispatch-only item: one notification, nothing upstream to read it back. */
function notifyItem(
  index: number,
  writes: string[],
  opts: { fail?: unknown } = {},
): ActionWriteItem {
  return {
    index,
    action: "notify_user",
    kind: "notification",
    status: "action",
    advisory: NOTIFICATION_UNVERIFIABLE,
    perform: async () => {
      writes.push(`notify#${index}`);
      if (opts.fail !== undefined) throw opts.fail;
    },
  };
}

function run(
  deps: ExecuteDeps,
  items: readonly ExecutableItem[],
  opts: { signal?: AbortSignal; deadlineAt?: number } = {},
): Promise<ItemResult[]> {
  return executePlan(deps, items, {
    deadlineAt: opts.deadlineAt ?? Date.now() + WRITE_BUDGET_MS,
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  });
}

const RATE_LIMITED = new LivespaceError(
  "RATE_LIMITED",
  "Livespace rate-limited the request (HTTP 429).",
  "Wait before retrying; reduce request frequency if it persists.",
);

const UNKNOWN_OUTCOME = new LivespaceError(
  "WRITE_OUTCOME_UNKNOWN",
  "The write request failed mid-flight; Livespace may or may not have applied it.",
  "Re-read the affected records to verify the outcome before retrying.",
);

const UNKNOWN_ENTRY = {
  code: "WRITE_OUTCOME_UNKNOWN",
  message: "The write request failed mid-flight; Livespace may or may not have applied it.",
  hint: "Re-read the affected records to verify the outcome before retrying.",
};

describe("executePlan", () => {
  test("a create is written, re-read and verified", async () => {
    const writes: string[] = [];
    const { deps, calls } = fakeRecords({ "person:person-synthetic-001": person() });

    const results = await run(deps, [createPerson(0, writes)]);

    expect(writes).toEqual(["create_person#0"]);
    expect(calls).toEqual(["person:person-synthetic-001"]);
    expect(results).toEqual([
      {
        index: 0,
        action: "create_person",
        kind: "person",
        status: "ok",
        id: "person-synthetic-001",
        after: { emails: ["person.one@synthetic.example"] },
        verification: "verified",
      },
    ]);
  });

  test("a dropped field is reported, and the item stays ok", async () => {
    const writes: string[] = [];
    const { deps } = fakeRecords({ "person:person-synthetic-001": person({ emails: [] }) });

    const results = await run(deps, [createPerson(0, writes)]);

    expect(results[0]?.status).toBe("ok");
    expect(results[0]?.unappliedFields).toEqual(["emails"]);
    expect(results[0]?.verification).toBe("verified");
  });

  test("a failed re-read never un-applies the write", async () => {
    const writes: string[] = [];
    const { deps } = fakeRecords({
      "person:person-synthetic-001": new LivespaceError(
        "UPSTREAM_ERROR",
        "Livespace reported a general API error (500).",
        "Retry once; if it persists, reduce the request size.",
      ),
    });

    const results = await run(deps, [createPerson(0, writes)]);

    expect(results).toEqual([
      {
        index: 0,
        action: "create_person",
        kind: "person",
        status: "ok",
        id: "person-synthetic-001",
        verification: "unavailable",
        error: VERIFICATION_UNAVAILABLE,
      },
    ]);
  });

  test("a re-read that finds nothing reports the same unavailable verdict", async () => {
    const writes: string[] = [];
    const { deps } = fakeRecords();

    const results = await run(deps, [createPerson(0, writes)]);

    expect(results[0]?.status).toBe("ok");
    expect(results[0]?.verification).toBe("unavailable");
    expect(results[0]?.unappliedFields).toBeUndefined();
  });

  test("a write whose fields have no re-read check is applied but never verified", async () => {
    // The write landed - the upstream said so - but the re-read compared
    // nothing, so the item may not claim to be verified. It says the check did
    // not run, and says why in wording of its own.
    const writes: string[] = [];
    const { deps } = fakeRecords({ "person:person-synthetic-001": person() });

    const results = await run(deps, [
      createPerson(0, writes, { sent: { firstname: "Synthetic", lastname: "Person" } }),
    ]);

    expect(results).toEqual([
      {
        index: 0,
        action: "create_person",
        kind: "person",
        status: "ok",
        id: "person-synthetic-001",
        after: { emails: ["person.one@synthetic.example"] },
        verification: "unavailable",
        error: VERIFICATION_UNCHECKED,
      },
    ]);
    expect(VERIFICATION_UNCHECKED).not.toEqual(VERIFICATION_UNAVAILABLE);
  });

  test("an update carries its before-values through", async () => {
    const writes: string[] = [];
    const { deps } = fakeRecords({ "task:task-synthetic-801": task() });

    const results = await run(deps, [
      updateTask(0, writes, { before: { title: "Synthetic Task Zero" } }),
    ]);

    expect(results).toEqual([
      {
        index: 0,
        action: "update_task",
        kind: "task",
        status: "ok",
        id: "task-synthetic-801",
        before: { title: "Synthetic Task Zero" },
        after: { title: "Synthetic Task One" },
        verification: "verified",
      },
    ]);
  });

  test("a note reports the wall item it created and is never re-read here", async () => {
    const writes: string[] = [];
    const { deps, calls } = fakeRecords();

    const results = await run(deps, [noteItem(0, writes, "wall-synthetic-901")]);

    expect(calls).toEqual([]);
    expect(results).toEqual([
      {
        index: 0,
        action: "note",
        kind: "deal",
        status: "ok",
        id: "wall-synthetic-901",
      },
    ]);
  });

  test("duplicates and blocked targets never write, and order is preserved", async () => {
    const writes: string[] = [];
    const { deps } = fakeRecords({ "person:person-synthetic-001": person() });
    const blocked = {
      code: "NOT_FOUND",
      message: "Record not found.",
      hint: "Check the id with search_crm.",
    };

    const results = await run(deps, [
      {
        index: 0,
        action: "create_person",
        kind: "person",
        status: "skipped_duplicate",
        existingId: "person-synthetic-777",
      },
      createPerson(1, writes),
      {
        index: 2,
        action: "update_task",
        kind: "task",
        status: "blocked",
        error: blocked,
      },
    ]);

    expect(writes).toEqual(["create_person#1"]);
    expect(results.map((entry) => entry.status)).toEqual([
      "skipped_duplicate",
      "ok",
      "error",
    ]);
    expect(results[0]).toEqual({
      index: 0,
      action: "create_person",
      kind: "person",
      status: "skipped_duplicate",
      existingId: "person-synthetic-777",
    });
    expect(results[2]).toEqual({
      index: 2,
      action: "update_task",
      kind: "task",
      status: "error",
      error: blocked,
    });
  });

  test("one failing item does not stop its siblings", async () => {
    const writes: string[] = [];
    const { deps } = fakeRecords({ "person:person-synthetic-002": person() });
    const rejected = new LivespaceError(
      "VALIDATION_ERROR",
      "Livespace rejected the request as invalid (420).",
      "One or more field values are invalid for this method. Fix them and retry.",
    );

    const results = await run(deps, [
      createPerson(0, writes, { fail: rejected }),
      createPerson(1, writes, { id: "person-synthetic-002" }),
    ]);

    expect(writes).toEqual(["create_person#0", "create_person#1"]);
    expect(results[0]).toEqual({
      index: 0,
      action: "create_person",
      kind: "person",
      status: "error",
      error: {
        code: "VALIDATION_ERROR",
        message: "Livespace rejected the request as invalid (420).",
        hint: "One or more field values are invalid for this method. Fix them and retry.",
      },
    });
    expect(results[1]?.status).toBe("ok");
  });

  test("a rate-limited item stops the batch", async () => {
    const writes: string[] = [];
    const { deps } = fakeRecords({ "person:person-synthetic-001": person() });

    const results = await run(deps, [
      createPerson(0, writes),
      createPerson(1, writes, { fail: RATE_LIMITED }),
      createPerson(2, writes),
    ]);

    expect(writes).toEqual(["create_person#0", "create_person#1"]);
    expect(results.map((entry) => entry.status)).toEqual([
      "ok",
      "error",
      "not_attempted",
    ]);
    expect(results[1]?.error?.code).toBe("RATE_LIMITED");
    expect(results[2]).toEqual({
      index: 2,
      action: "create_person",
      kind: "person",
      status: "not_attempted",
    });
  });

  test("items past the budget are not attempted", async () => {
    const writes: string[] = [];
    const { deps } = fakeRecords({ "person:person-synthetic-001": person() });
    // Fixed outside the stubbed clock: the runner's own deadline, unaffected.
    const deadlineAt = Date.now() + WRITE_BUDGET_MS;

    const results = await pastTheBudget(() =>
      run(deps, [createPerson(0, writes), createPerson(1, writes)], { deadlineAt }),
    );

    expect(writes).toEqual(["create_person#0"]);
    expect(results.map((entry) => entry.status)).toEqual(["ok", "not_attempted"]);
  });

  test("a halted batch still reports why a blocked item was blocked", async () => {
    // The plan phase is what blocks an item, and it is also what can burn the
    // budget. Swallowing the reason into a bare not_attempted would hide the
    // halt from the only reader who can act on it.
    const writes: string[] = [];
    const { deps } = fakeRecords({ "person:person-synthetic-001": person() });
    const deadlineAt = Date.now() + WRITE_BUDGET_MS;
    const blocked = {
      code: "RATE_LIMITED",
      message: "Livespace rate-limited the request (HTTP 429).",
      hint: "Wait before retrying; reduce request frequency if it persists.",
    };

    const results = await pastTheBudget(() =>
      run(
        deps,
        [
          createPerson(0, writes),
          {
            index: 1,
            action: "create_person",
            kind: "person",
            status: "blocked",
            error: blocked,
          },
        ],
        { deadlineAt },
      ),
    );

    expect(writes).toEqual(["create_person#0"]);
    expect(results.map((entry) => entry.status)).toEqual(["ok", "error"]);
    expect(results[1]?.error).toEqual(blocked);
  });

  test("an abort between items is audited on stderr and then rejects", async () => {
    const writes: string[] = [];
    const { deps } = fakeRecords({
      "person:person-synthetic-001": person(),
      "person:person-synthetic-002": person({ id: "person-synthetic-002" }),
    });
    const controller = new AbortController();
    const items = [
      createPerson(0, writes),
      {
        ...createPerson(1, writes, { id: "person-synthetic-002" }),
        perform: async (): Promise<string> => {
          writes.push("create_person#1");
          controller.abort();
          return "person-synthetic-002";
        },
      },
      createPerson(2, writes),
    ];

    const { value: error, lines } = await onStderr(() =>
      rejection(run(deps, items, { signal: controller.signal })),
    );

    expect(writes).toEqual(["create_person#0", "create_person#1"]);
    expect((error as LivespaceError).code).toBe("CANCELLED");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^write batch cancelled after 2 applied item\(s\): ids=\[/u);
    expect(lines[0]).toContain("person-synthetic-001");
    expect(lines[0]).toContain("person-synthetic-002");
  });

  test("a pre-aborted call writes nothing", async () => {
    const writes: string[] = [];
    const { deps } = fakeRecords();
    const controller = new AbortController();
    controller.abort();

    const { value: error, lines } = await onStderr(() =>
      rejection(run(deps, [createPerson(0, writes)], { signal: controller.signal })),
    );

    expect(writes).toEqual([]);
    expect((error as LivespaceError).code).toBe("CANCELLED");
    expect(lines).toEqual(["write batch cancelled after 0 applied item(s): ids=[]"]);
  });
});

describe("items that write nothing and items that only dispatch", () => {
  test("an unchanged item is ok without a dispatch, a re-read or an advisory", async () => {
    const { deps, calls } = fakeRecords({ "person:person-synthetic-001": person() });

    const results = await run(deps, [
      unchangedDeal(0, { stageId: "stage-synthetic-2", stageName: "Synthetic Stage 2" }),
    ]);

    // Nothing was written and nothing was read: there is no outcome to verify,
    // so the item claims none.
    expect(calls).toEqual([]);
    expect(results).toEqual([
      {
        index: 0,
        action: "move_deal",
        kind: "deal",
        status: "ok",
        after: { stageId: "stage-synthetic-2", stageName: "Synthetic Stage 2" },
      },
    ]);
  });

  test("an unchanged item without a view carries no display bag", async () => {
    const { deps } = fakeRecords();

    const results = await run(deps, [unchangedDeal(0)]);

    expect(results).toEqual([
      { index: 0, action: "move_deal", kind: "deal", status: "ok" },
    ]);
  });

  test("an unchanged item counts as an applied item and never fails the batch", async () => {
    const { deps } = fakeRecords();

    const results = await run(deps, [unchangedDeal(0)]);

    expect(countResults(results).ok).toBe(1);
    expect(isBatchError(results)).toBe(false);
  });

  test("an action item dispatches once and reports the advisory it was given", async () => {
    const writes: string[] = [];
    const { deps, calls } = fakeRecords();

    const results = await run(deps, [notifyItem(0, writes)]);

    expect(writes).toEqual(["notify#0"]);
    // Dispatch only: an action has no record to re-read.
    expect(calls).toEqual([]);
    expect(results).toEqual([
      {
        index: 0,
        action: "notify_user",
        kind: "notification",
        status: "ok",
        verification: "unavailable",
        error: NOTIFICATION_UNVERIFIABLE,
      },
    ]);
  });

  test("the advisory an action reports is the caller's, not a shared default", async () => {
    const writes: string[] = [];
    const { deps } = fakeRecords();
    const advisory = {
      code: "SYNTHETIC_ADVISORY",
      message: "Synthetic advisory message.",
      hint: "Synthetic advisory hint.",
    };

    const results = await run(deps, [{ ...notifyItem(0, writes), advisory }]);

    expect(results[0]?.error).toEqual(advisory);
    expect(results[0]?.error).not.toEqual(NOTIFICATION_UNVERIFIABLE);
  });

  test("a failing action is an error, and it never becomes an id-less ok", async () => {
    const writes: string[] = [];
    const { deps } = fakeRecords();
    const rejected = new LivespaceError(
      "VALIDATION_ERROR",
      "Livespace rejected the request as invalid (420).",
      "One or more field values are invalid for this method. Fix them and retry.",
    );

    const results = await run(deps, [notifyItem(0, writes, { fail: rejected })]);

    expect(results[0]?.status).toBe("error");
    expect(results[0]?.error?.code).toBe("VALIDATION_ERROR");
  });

  test("an action whose outcome is unknown is never resolved into a success", async () => {
    // There is nothing to read back, so a mid-flight failure stays unknown -
    // the caller is told to confirm another way, never to dispatch again.
    const writes: string[] = [];
    const { deps, calls } = fakeRecords();

    const results = await run(deps, [notifyItem(0, writes, { fail: UNKNOWN_OUTCOME })]);

    expect(calls).toEqual([]);
    expect(results[0]).toEqual({
      index: 0,
      action: "notify_user",
      kind: "notification",
      status: "unknown_outcome",
      error: UNKNOWN_ENTRY,
    });
  });

  test("the notification advisory says delivery cannot be confirmed", () => {
    expect(NOTIFICATION_UNVERIFIABLE).toEqual({
      code: "NOTIFICATION_UNVERIFIABLE",
      message:
        "Livespace exposes no read-back for notifications; delivery cannot be confirmed.",
      hint: "Do not resend; confirm with the recipient another way.",
    });
  });

  test("a planned item may be a move, an unchanged deal or an action", () => {
    const items: WriteItemPlan[] = [
      { index: 0, action: "move_deal", kind: "deal", status: "move", summary: {} },
      { index: 1, action: "move_deal", kind: "deal", status: "unchanged", summary: {} },
      {
        index: 2,
        action: "notify_user",
        kind: "notification",
        status: "action",
        summary: {},
      },
    ];

    expect(items.map((item) => item.status)).toEqual(["move", "unchanged", "action"]);
  });
});

describe("unknown write outcomes", () => {
  function resolution(
    overrides: Partial<CreateResolution>,
    hit: RecordPointer | null,
    lookups: string[],
  ): CreateResolution {
    return {
      lookup: "missed",
      uniqueInBatch: true,
      knownIds: [],
      find: async () => {
        lookups.push("find");
        return hit;
      },
      ...overrides,
    };
  }

  test("a create is resolved when the plan-time lookup found nothing", async () => {
    const writes: string[] = [];
    const lookups: string[] = [];
    const { deps } = fakeRecords();

    const results = await run(deps, [
      createPerson(0, writes, {
        fail: UNKNOWN_OUTCOME,
        resolve: resolution({}, { id: "person-synthetic-003", name: "" }, lookups),
      }),
    ]);

    expect(lookups).toEqual(["find"]);
    expect(results).toEqual([
      {
        index: 0,
        action: "create_person",
        kind: "person",
        status: "ok",
        id: "person-synthetic-003",
        resolvedByReread: true,
        verification: "unavailable",
        error: VERIFICATION_UNAVAILABLE,
      },
    ]);
  });

  test("a create whose lookup never ran stays unknown", async () => {
    const writes: string[] = [];
    const lookups: string[] = [];
    const { deps } = fakeRecords();

    const results = await run(deps, [
      createPerson(0, writes, {
        fail: UNKNOWN_OUTCOME,
        resolve: resolution(
          { lookup: "not-run" },
          { id: "person-synthetic-003", name: "" },
          lookups,
        ),
      }),
    ]);

    expect(lookups).toEqual([]);
    expect(results[0]).toEqual({
      index: 0,
      action: "create_person",
      kind: "person",
      status: "unknown_outcome",
      error: UNKNOWN_ENTRY,
    });
  });

  test("a create whose lookup already had a hit stays unknown", async () => {
    const writes: string[] = [];
    const lookups: string[] = [];
    const { deps } = fakeRecords();

    const results = await run(deps, [
      createPerson(0, writes, {
        fail: UNKNOWN_OUTCOME,
        resolve: resolution(
          { lookup: "hit" },
          { id: "person-synthetic-003", name: "" },
          lookups,
        ),
      }),
    ]);

    expect(lookups).toEqual([]);
    expect(results[0]?.status).toBe("unknown_outcome");
  });

  test("a create sharing its identity with another item stays unknown", async () => {
    const writes: string[] = [];
    const lookups: string[] = [];
    const { deps } = fakeRecords();

    const results = await run(deps, [
      createPerson(0, writes, {
        fail: UNKNOWN_OUTCOME,
        resolve: resolution(
          { uniqueInBatch: false },
          { id: "person-synthetic-003", name: "" },
          lookups,
        ),
      }),
    ]);

    expect(lookups).toEqual([]);
    expect(results[0]?.status).toBe("unknown_outcome");
  });

  test("a resolution landing on a pre-existing record proves nothing", async () => {
    const writes: string[] = [];
    const lookups: string[] = [];
    const { deps } = fakeRecords();

    const results = await run(deps, [
      createPerson(0, writes, {
        fail: UNKNOWN_OUTCOME,
        resolve: resolution(
          { knownIds: ["person-synthetic-003"] },
          { id: "person-synthetic-003", name: "" },
          lookups,
        ),
      }),
    ]);

    expect(lookups).toEqual(["find"]);
    expect(results[0]?.status).toBe("unknown_outcome");
  });

  test("a resolution lookup that fails leaves the outcome unknown", async () => {
    const writes: string[] = [];
    const { deps } = fakeRecords();

    const results = await run(deps, [
      createPerson(0, writes, {
        fail: UNKNOWN_OUTCOME,
        resolve: {
          lookup: "missed",
          uniqueInBatch: true,
          knownIds: [],
          find: async () => {
            throw new LivespaceError("NETWORK_ERROR", "Network error.", "Retry.");
          },
        },
      }),
    ]);

    expect(results[0]?.status).toBe("unknown_outcome");
  });

  test("an update whose fields all landed is resolved by the re-read", async () => {
    const writes: string[] = [];
    const { deps, calls } = fakeRecords({ "task:task-synthetic-801": task() });

    const results = await run(deps, [
      updateTask(0, writes, {
        fail: UNKNOWN_OUTCOME,
        sent: { title: "Synthetic Task One", description: "Synthetic task description" },
      }),
    ]);

    expect(calls).toEqual(["task:task-synthetic-801"]);
    expect(results).toEqual([
      {
        index: 0,
        action: "update_task",
        kind: "task",
        status: "ok",
        id: "task-synthetic-801",
        after: { title: "Synthetic Task One" },
        resolvedByReread: true,
        verification: "verified",
      },
    ]);
  });

  test("an update that landed partially is ok and names what did not", async () => {
    const writes: string[] = [];
    const { deps } = fakeRecords({ "task:task-synthetic-801": task() });

    const results = await run(deps, [
      updateTask(0, writes, {
        fail: UNKNOWN_OUTCOME,
        sent: { title: "Synthetic Task One", description: "Synthetic other description" },
      }),
    ]);

    expect(results[0]?.status).toBe("ok");
    expect(results[0]?.resolvedByReread).toBe(true);
    expect(results[0]?.unappliedFields).toEqual(["description"]);
  });

  test("an update whose fields all missed stays unknown", async () => {
    const writes: string[] = [];
    const { deps } = fakeRecords({ "task:task-synthetic-801": task() });

    const results = await run(deps, [
      updateTask(0, writes, {
        fail: UNKNOWN_OUTCOME,
        sent: { title: "Synthetic other title", description: "Synthetic other text" },
      }),
    ]);

    expect(results[0]).toEqual({
      index: 0,
      action: "update_task",
      kind: "task",
      status: "unknown_outcome",
      error: UNKNOWN_ENTRY,
    });
  });

  test("an update with nothing comparable stays unknown, however the re-read went", async () => {
    // A person's firstname has no counterpart on the mapped record, so the
    // re-read compared NOTHING. Zero compared fields is zero evidence, and an
    // unknown outcome resolved from zero evidence is a guess.
    const writes: string[] = [];
    const { deps, calls } = fakeRecords({ "person:person-synthetic-001": person() });

    const results = await run(deps, [
      updatePerson(0, writes, { fail: UNKNOWN_OUTCOME, sent: { firstname: "Anna" } }),
    ]);

    expect(calls).toEqual(["person:person-synthetic-001"]);
    expect(results[0]).toEqual({
      index: 0,
      action: "update_person",
      kind: "person",
      status: "unknown_outcome",
      error: UNKNOWN_ENTRY,
    });
  });

  test("an unknown outcome is decided by the compared fields alone", async () => {
    // firstname cannot be checked and emails did not land: every field that
    // COULD be compared came back missing, so nothing is claimed - the
    // uncheckable field must not pad the count into a success.
    const writes: string[] = [];
    const { deps } = fakeRecords({ "person:person-synthetic-001": person() });

    const results = await run(deps, [
      updatePerson(0, writes, {
        fail: UNKNOWN_OUTCOME,
        sent: { firstname: "Anna", emails: ["anna@synthetic.example"] },
      }),
    ]);

    expect(results[0]?.status).toBe("unknown_outcome");
  });

  test("an unknown outcome with one compared field that landed is resolved", async () => {
    const writes: string[] = [];
    const { deps } = fakeRecords({ "person:person-synthetic-001": person() });

    const results = await run(deps, [
      updatePerson(0, writes, {
        fail: UNKNOWN_OUTCOME,
        sent: { firstname: "Anna", note: "Synthetic note text" },
      }),
    ]);

    expect(results[0]?.status).toBe("ok");
    expect(results[0]?.resolvedByReread).toBe(true);
    expect(results[0]?.verification).toBe("verified");
  });

  test("an update whose re-read fails stays unknown", async () => {
    const writes: string[] = [];
    const { deps } = fakeRecords({
      "task:task-synthetic-801": new LivespaceError(
        "TIMEOUT",
        "Livespace did not respond within 30000 ms.",
        "Retry; if it persists, reduce the request size.",
      ),
    });

    const results = await run(deps, [updateTask(0, writes, { fail: UNKNOWN_OUTCOME })]);

    expect(results[0]?.status).toBe("unknown_outcome");
  });

  test("a note with an unknown outcome is never resolved", async () => {
    const writes: string[] = [];
    const { deps, calls } = fakeRecords();

    const results = await run(deps, [
      {
        index: 0,
        action: "note",
        kind: "deal",
        status: "note",
        perform: async () => {
          writes.push("note#0");
          throw UNKNOWN_OUTCOME;
        },
      },
    ]);

    expect(calls).toEqual([]);
    expect(results[0]).toEqual({
      index: 0,
      action: "note",
      kind: "deal",
      status: "unknown_outcome",
      error: UNKNOWN_ENTRY,
    });
  });
});

describe("result counts", () => {
  const results: ItemResult[] = [
    { index: 0, action: "a", kind: "person", status: "ok" },
    { index: 1, action: "a", kind: "person", status: "skipped_duplicate" },
    { index: 2, action: "a", kind: "person", status: "error" },
    { index: 3, action: "a", kind: "person", status: "unknown_outcome" },
    { index: 4, action: "a", kind: "person", status: "not_attempted" },
  ];

  test("counts cover every status", () => {
    expect(countResults(results)).toEqual({
      ok: 1,
      skippedDuplicate: 1,
      error: 1,
      unknownOutcome: 1,
      notAttempted: 1,
    });
  });

  test("a batch is an error only when every attempted item failed", () => {
    expect(isBatchError(results)).toBe(false);
    expect(isBatchError([results[2] as ItemResult, results[3] as ItemResult])).toBe(true);
    // Nothing attempted: skipping every duplicate is a success.
    expect(isBatchError([results[1] as ItemResult, results[4] as ItemResult])).toBe(false);
    expect(isBatchError([])).toBe(false);
  });
});

describe("the write request-state codec", () => {
  test("a minted state round-trips", async () => {
    const codec = buildWriteCodec({ requestStateKey: KEY });
    const ctx = serverContext();
    const payload = state();

    const wire = await codec.mint(payload, ctx);
    expect(await codec.verify(wire, ctx)).toEqual(payload);
  });

  test("a tampered state is refused", async () => {
    const codec = buildWriteCodec({ requestStateKey: KEY });
    const ctx = serverContext();
    const wire = await codec.mint(state(), ctx);

    await expect(codec.verify(`${wire}x`, ctx)).rejects.toThrow();
  });

  test("another key cannot verify", async () => {
    const ctx = serverContext();
    const wire = await buildWriteCodec({ requestStateKey: KEY }).mint(state(), ctx);

    await expect(
      buildWriteCodec({ requestStateKey: OTHER_KEY }).verify(wire, ctx),
    ).rejects.toThrow();
  });

  test("another principal cannot replay a state", async () => {
    const codec = buildWriteCodec({ requestStateKey: KEY });
    const wire = await codec.mint(state(), serverContext("synthetic-principal-a"));

    await expect(
      codec.verify(wire, serverContext("synthetic-principal-b")),
    ).rejects.toThrow();
  });

  test("a state expires after the confirmation window", async () => {
    const codec = buildWriteCodec({ requestStateKey: KEY });
    const ctx = serverContext();
    const realNow = Date.now;
    let wire: string;
    try {
      Date.now = (): number => realNow() - (CONFIRMATION_TTL_SECONDS + 60) * 1000;
      wire = await codec.mint(state(), ctx);
    } finally {
      Date.now = realNow;
    }

    await expect(codec.verify(wire, ctx)).rejects.toThrow();
  });

  test("a missing key falls back to a per-process key with one stderr note", async () => {
    const { value: codecs, lines } = await onStderr(async () => [
      buildWriteCodec({}),
      buildWriteCodec({}),
    ]);
    const ctx = serverContext();

    // Same process, same key: a confirmation minted by one round verifies in
    // the next, which is what MRTR needs.
    const wire = await (codecs[0] as ReturnType<typeof buildWriteCodec>).mint(
      state(),
      ctx,
    );
    expect(
      await (codecs[1] as ReturnType<typeof buildWriteCodec>).verify(wire, ctx),
    ).toBeDefined();
    expect(lines.length).toBeLessThanOrEqual(1);
  });
});

/**
 * Runs a scenario under a clock that sits past the budget from its SECOND read
 * on: read #1 is the first item's own deadline check, every later read is the
 * check between items.
 */
async function pastTheBudget<T>(scenario: () => Promise<T>): Promise<T> {
  const realNow = Date.now;
  const base = realNow();
  let reads = 0;
  Date.now = (): number => {
    reads += 1;
    return reads <= 1 ? base : base + WRITE_BUDGET_MS + 1_000;
  };
  try {
    return await scenario();
  } finally {
    Date.now = realNow;
  }
}

/** Captures the stderr audit channel for one scenario. */
async function onStderr<T>(
  scenario: () => Promise<T>,
): Promise<{ value: T; lines: string[] }> {
  const real = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]): void => {
    lines.push(args.map(String).join(" "));
  };
  try {
    return { value: await scenario(), lines };
  } finally {
    console.error = real;
  }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}
