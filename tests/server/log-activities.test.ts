import { describe, expect, test } from "bun:test";
import {
  isInputRequiredResult,
  type InputRequiredResult,
  type RequestStateCodec,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { LivespaceClient } from "../../src/livespace/client.js";
import { errorFromEnvelope, LivespaceError } from "../../src/livespace/errors.js";
import type { RecordFetchers } from "../../src/livespace/records.js";
import {
  createWriteFetchers,
  type CallWrite,
  type NoteTargetKind,
  type WriteFetchers,
} from "../../src/livespace/writes.js";
import {
  logActivitiesToolConfig,
  runLogActivities,
  type LogActivitiesArgs,
  type LogActivitiesDeps,
  type LogActivitiesResult,
} from "../../src/server/tools/log-activities.js";
import type { ToolError, ToolRunResult } from "../../src/server/tools/tool-error.js";
import {
  hashArgs,
  WRITE_BUDGET_MS,
  type WriteState,
} from "../../src/server/tools/write-support.js";
import { wallEntry } from "../support/records.js";

/**
 * `log_activities` against fakes. Every value below is invented: no CRM data,
 * no sandbox values, and no call leaves the process (AGENTS.md).
 *
 * The marker stands in for a model- or CRM-authored string - a note body is
 * exactly that. It may live in `structuredContent`, where the schema types it
 * as data, and must never reach the text channel or an approval prompt
 * (docs/security.md par. 4).
 */
const NOTE_MARKER = "synthetic-note-marker";

/** The same idea for an upstream response body, which may never travel at all. */
const ENVELOPE_MARKER = "synthetic-envelope-marker";

/** The literal envelope key, spelled out so a rename upstream fails loudly. */
const CAPS_KEY = "io.modelcontextprotocol/clientCapabilities";

const PERSON_ID = "person-synthetic-001";
const COMPANY_ID = "company-synthetic-101";
const DEAL_ID = "deal-synthetic-401";

const VALIDATION_420: ToolError = {
  code: "VALIDATION_ERROR",
  message: "Livespace rejected the request as invalid (420).",
  hint: "One or more field values are invalid for this method. Fix them and retry.",
};

/** The fixed advisory an applied-but-unconfirmed write carries. */
const UNVERIFIED: ToolError = {
  code: "VERIFICATION_UNAVAILABLE",
  message: "The write was applied, but the follow-up read did not answer.",
  hint: "Re-read the record before writing to it again; never retry the write itself.",
};

const RATE_LIMITED = new LivespaceError(
  "RATE_LIMITED",
  "Livespace rate-limited the request (HTTP 429).",
  "Wait before retrying; reduce request frequency if it persists.",
);

type Answer<T> = T | LivespaceError;

interface NoteInput {
  kind: NoteTargetKind;
  id: string;
  note: string;
}

interface CallInput extends CallWrite {
  personId: string;
}

interface Canning {
  addNote?: (call: number, input: NoteInput) => Answer<string | null>;
  addCall?: (call: number, input: CallInput) => Answer<null>;
  /** Wall answers keyed `kind:id`. An Error value is thrown by the read. */
  walls?: Record<string, unknown>;
  /** Runs before every wall answer; throwing here is a read that failed. */
  onWall?: (call: number, key: string) => void;
}

interface Recorded {
  method: string;
  input: unknown;
  opts: unknown;
}

function unwrap<T>(value: Answer<T>): T {
  if (value instanceof LivespaceError) throw value;
  return value;
}

/**
 * The fakes implement exactly the fetchers `log_activities` may touch and
 * RECORD every call. The create and update fetchers throw: an activity tool
 * that reaches for them is a bug, not a passing test. `getRecord` is recorded
 * rather than thrown from - the executor swallows a failed re-read, so a silent
 * throw would hide the very call this tool must never make.
 */
function fakeWorld(canned: Canning = {}) {
  const calls: Recorded[] = [];
  const push = (method: string, input: unknown, opts: unknown): number => {
    const call = calls.filter((entry) => entry.method === method).length;
    calls.push({ method, input, opts });
    return call;
  };
  const never =
    (method: string) =>
    async (): Promise<never> => {
      throw new Error(`log_activities must never call ${method}`);
    };

  const writes = {
    addNote: async (kind: NoteTargetKind, id: string, note: string, opts?: unknown) => {
      const input: NoteInput = { kind, id, note };
      const call = push("addNote", input, opts);
      const answer =
        canned.addNote === undefined
          ? `wall-synthetic-${call + 1}`
          : canned.addNote(call, input);
      return { wallItemId: unwrap(answer) };
    },
    addCall: async (personId: string, input: CallWrite, opts?: unknown) => {
      const recorded: CallInput = { personId, ...input };
      const call = push("addCall", recorded, opts);
      if (canned.addCall !== undefined) unwrap(canned.addCall(call, recorded));
    },
    createPerson: never("createPerson"),
    createCompany: never("createCompany"),
    createDeal: never("createDeal"),
    createTask: never("createTask"),
    updatePerson: never("updatePerson"),
    updateCompany: never("updateCompany"),
    updateDeal: never("updateDeal"),
    updateTask: never("updateTask"),
    findPersonByEmail: never("findPersonByEmail"),
    findCompanyByName: never("findCompanyByName"),
  } as unknown as WriteFetchers;

  const records = {
    getRecord: async (kind: string, id: string, opts?: unknown) => {
      push("getRecord", `${kind}:${id}`, opts);
      return null;
    },
  } as unknown as RecordFetchers;

  const activity = {
    recordWall: async (opts: { kind: string; id: string; signal?: AbortSignal }) => {
      const call = push("recordWall", `${opts.kind}:${opts.id}`, opts);
      canned.onWall?.(call, `${opts.kind}:${opts.id}`);
      const answer = canned.walls?.[`${opts.kind}:${opts.id}`];
      if (answer instanceof Error) throw answer;
      return { entries: (answer ?? []) as [], truncated: false, totalEntries: 0 };
    },
  };

  const minted: WriteState[] = [];
  const codec = {
    mint: async (payload: WriteState) => {
      minted.push(payload);
      return `synthetic-wire-${minted.length}`;
    },
    verify: async () => {
      throw new Error("verify belongs to the SDK seam, not to the tool");
    },
  } as unknown as RequestStateCodec<WriteState>;

  const deps: LogActivitiesDeps = { writes, records, activity, codec };
  const inputs = (method: string): unknown[] =>
    calls.filter((entry) => entry.method === method).map((entry) => entry.input);
  const count = (method: string): number => inputs(method).length;
  const methods = (): string[] => calls.map((entry) => entry.method);
  return { deps, calls, minted, inputs, count, methods };
}

type World = ReturnType<typeof fakeWorld>;

interface CtxOptions {
  elicitation?: boolean;
  state?: WriteState;
  /** `true`/`false` are accepted answers; "decline" is a dismissed prompt. */
  confirm?: boolean | "decline";
}

function ctx(options: CtxOptions = {}): unknown {
  const responses =
    options.confirm === undefined
      ? undefined
      : options.confirm === "decline"
        ? { confirm: { action: "decline" } }
        : { confirm: { action: "accept", content: { confirm: options.confirm } } };
  return {
    mcpReq: {
      method: "tools/call",
      envelope: options.elicitation === true ? { [CAPS_KEY]: { elicitation: {} } } : {},
      ...(responses === undefined ? {} : { inputResponses: responses }),
      requestState: () => options.state,
    },
  };
}

function run(
  world: World,
  args: LogActivitiesArgs,
  opts: {
    signal?: AbortSignal;
    ctx?: unknown;
    allowUnboundWriteConfirmation?: boolean;
  } = {},
): Promise<LogActivitiesResult> {
  return runLogActivities(world.deps, args, {
    allowUnboundWriteConfirmation: true,
    ...opts,
  });
}

function asRun(result: LogActivitiesResult): ToolRunResult {
  if (isInputRequiredResult(result)) {
    throw new Error("expected a tool result, got an input-required result");
  }
  return result;
}

function asInputRequired(result: LogActivitiesResult): InputRequiredResult {
  if (!isInputRequiredResult(result)) {
    throw new Error("expected an input-required result");
  }
  return result;
}

function planOf(result: ToolRunResult): Record<string, unknown>[] {
  return result.structured["plan"] as Record<string, unknown>[];
}

function resultsOf(result: ToolRunResult): Record<string, unknown>[] {
  return result.structured["results"] as Record<string, unknown>[];
}

function errorsOf(result: ToolRunResult): ToolError[] {
  return result.structured["errors"] as ToolError[];
}

function statusesOf(result: ToolRunResult): unknown[] {
  return resultsOf(result).map((entry) => entry["status"]);
}

function verificationsOf(result: ToolRunResult): unknown[] {
  return resultsOf(result).map((entry) => entry["verification"]);
}

/** Every answer the tool returns must validate against its own output schema. */
function expectPayload(result: ToolRunResult): void {
  const parsed = logActivitiesToolConfig.outputSchema.safeParse(result.structured);
  expect(parsed.success).toBe(true);
  expect(parsed.data as Record<string, unknown>).toEqual(result.structured);
}

function elicitationMessageOf(result: InputRequiredResult): string {
  const requests = result.inputRequests as Record<string, { params: { message: string } }>;
  return requests["confirm"]?.params.message as string;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

/**
 * A clock whose write phase fits the budget and whose verification pass does
 * not: it jumps past the deadline the moment the first wall read starts. The
 * hook belongs in the world's `onWall`, the scenario runs inside `during`.
 */
function budgetSpentAtFirstWall(): {
  onWall: () => void;
  during: <T>(scenario: () => Promise<T>) => Promise<T>;
} {
  const realNow = Date.now;
  const base = realNow();
  let spent = false;
  return {
    onWall: (): void => {
      spent = true;
    },
    during: async <T>(scenario: () => Promise<T>): Promise<T> => {
      Date.now = (): number => (spent ? base + WRITE_BUDGET_MS + 1_000 : base);
      try {
        return await scenario();
      } finally {
        Date.now = realNow;
      }
    },
  };
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

function args(value: Record<string, unknown>): LogActivitiesArgs {
  return value as unknown as LogActivitiesArgs;
}

function note(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: "person", id: PERSON_ID, note: "Synthetic note one", ...overrides };
}

function callArg(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    personId: PERSON_ID,
    phone: "+00 000 000 001",
    direction: "outgoing",
    ...overrides,
  };
}

/** Round one asks the human, round two carries the minted state back. */
async function twoRounds(scenario: World, call: LogActivitiesArgs): Promise<ToolRunResult> {
  const first = await run(scenario, call, { ctx: ctx({ elicitation: true }) });
  asInputRequired(first);
  const state = scenario.minted[0] as WriteState;
  return asRun(
    await run(scenario, call, { ctx: ctx({ elicitation: true, state, confirm: true }) }),
  );
}

describe("logActivitiesToolConfig", () => {
  test("the annotations declare an honest, non-destructive write", () => {
    expect(logActivitiesToolConfig.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  test("the input schema is a plain object at the JSON Schema root", () => {
    const json = z.toJSONSchema(logActivitiesToolConfig.inputSchema) as Record<
      string,
      unknown
    >;
    expect(json["type"]).toBe("object");
    expect(json["oneOf"]).toBeUndefined();
  });

  test("the description names the cap, the confirmation flow and the public-only rule", () => {
    const description = logActivitiesToolConfig.description.replace(/\s+/gu, " ");
    expect(description).toContain("15 items per call");
    expect(description).toContain("confirm: true");
    // Note visibility is not controllable upstream: everything lands public.
    expect(description).toContain("PUBLIC");
  });
});

describe("the input schema", () => {
  const parse = (value: unknown): boolean =>
    logActivitiesToolConfig.inputSchema.safeParse(value).success;

  test("the root object is strict", () => {
    expect(parse({ notes: [note()] })).toBe(true);
    expect(parse({ notes: [note()], tasks: [] })).toBe(false);
  });

  test("a note names one of the three record kinds it can land on", () => {
    for (const kind of ["person", "company", "deal"]) {
      expect(parse({ notes: [note({ kind })] })).toBe(true);
    }
    expect(parse({ notes: [note({ kind: "task" })] })).toBe(false);
    expect(parse({ notes: [note({ kind: "Person" })] })).toBe(false);
  });

  test("note bounds are enforced and nothing undeclared is accepted", () => {
    expect(parse({ notes: [note({ id: "" })] })).toBe(false);
    expect(parse({ notes: [note({ id: "x".repeat(65) })] })).toBe(false);
    expect(parse({ notes: [note({ note: "" })] })).toBe(false);
    expect(parse({ notes: [note({ note: "x".repeat(5001) })] })).toBe(false);
    expect(parse({ notes: [note({ isPublic: false })] })).toBe(false);
  });

  test("call bounds and the direction enum are enforced", () => {
    for (const direction of ["incoming", "outgoing"]) {
      expect(parse({ calls: [callArg({ direction })] })).toBe(true);
    }
    expect(parse({ calls: [callArg({ direction: "missed" })] })).toBe(false);
    expect(parse({ calls: [callArg({ phone: "12" })] })).toBe(false);
    expect(parse({ calls: [callArg({ phone: "1".repeat(41) })] })).toBe(false);
    expect(parse({ calls: [callArg({ personId: "" })] })).toBe(false);
    expect(parse({ calls: [callArg({ note: "x".repeat(5001) })] })).toBe(false);
    expect(parse({ calls: [callArg({ duration: 60 })] })).toBe(false);
  });

  test("the call date takes a day or a timestamp and nothing else", () => {
    const accepted = ["2026-09-26", "2026-09-26 10:00", "2026-09-26 10:00:00"];
    for (const date of accepted) {
      expect(parse({ calls: [callArg({ date })] })).toBe(true);
    }
    const refused = ["2026-9-6", "2026-09-26T10:00:00", "26-09-2026", "2026-09-26 10"];
    for (const date of refused) {
      expect(parse({ calls: [callArg({ date })] })).toBe(false);
    }
  });

  test("fifteen items in one array are accepted and sixteen are not", () => {
    const fifteen = Array.from({ length: 15 }, (_, i) =>
      note({ note: `Synthetic note ${i}` }),
    );
    expect(parse({ notes: fifteen })).toBe(true);
    expect(parse({ notes: [...fifteen, note({ note: "One too many" })] })).toBe(false);
  });

  test("the per-array cap does not add up: the runner owns the total", () => {
    expect(
      parse({
        notes: Array.from({ length: 10 }, (_, i) => note({ note: `Synthetic note ${i}` })),
        calls: Array.from({ length: 10 }, () => callArg()),
      }),
    ).toBe(true);
  });
});

describe("argument rules", () => {
  test("a call with no items is refused", async () => {
    const scenario = fakeWorld();

    const result = asRun(await run(scenario, args({})));

    expect(result.isError).toBe(true);
    expect(result.text).toBe("log_activities failed: BAD_PARAMS.");
    expect(errorsOf(result)[0]?.code).toBe("BAD_PARAMS");
    expect(scenario.calls).toEqual([]);
    expectPayload(result);
  });

  test("more than fifteen activities across the two arrays is refused", async () => {
    const scenario = fakeWorld();

    const result = asRun(
      await run(
        scenario,
        args({
          notes: Array.from({ length: 10 }, (_, i) => note({ note: `Synthetic note ${i}` })),
          calls: Array.from({ length: 6 }, () => callArg()),
        }),
      ),
    );

    expect(errorsOf(result)[0]?.code).toBe("BAD_PARAMS");
    expect(errorsOf(result)[0]?.hint).toContain("15");
    expect(scenario.calls).toEqual([]);
  });

  test("a call date that is not a real day is refused", async () => {
    const scenario = fakeWorld();

    const result = asRun(
      await run(scenario, args({ calls: [callArg({ date: "2026-02-31" })] })),
    );

    expect(errorsOf(result)[0]?.code).toBe("BAD_PARAMS");
    expect(scenario.calls).toEqual([]);
  });

  test("a call date outside the supported years is refused", async () => {
    const scenario = fakeWorld();

    const result = asRun(
      await run(scenario, args({ calls: [callArg({ date: "1899-12-31" })] })),
    );

    expect(errorsOf(result)[0]?.code).toBe("BAD_PARAMS");
    expect(scenario.calls).toEqual([]);
  });
});

describe("routing and mapping", () => {
  test("each note kind reaches its own endpoint, dispatched once", async () => {
    // A company id sent to addContactNote answers 420 upstream (probe evidence
    // 15), so the endpoint strings are pinned verbatim through the real
    // fetchers rather than through a stub that could not tell them apart.
    const dispatched: { key: string; write: unknown }[] = [];
    const client = {
      call: (async (
        module: string,
        method: string,
        _params?: Record<string, unknown>,
        opts?: { write?: boolean },
      ) => {
        dispatched.push({ key: `${module}/${method}`, write: opts?.write });
        if (method === "addCompanyNote") {
          return { company: { id: COMPANY_ID, wall_item_id: "wall-synthetic-2" } };
        }
        if (method === "addDealNote") {
          return { deal: { id: DEAL_ID, wall_item_id: "wall-synthetic-3" } };
        }
        return { contact: { id: PERSON_ID, wall_item_id: "wall-synthetic-1" } };
      }) as never,
    };
    const scenario = fakeWorld();
    const deps: LogActivitiesDeps = {
      ...scenario.deps,
      writes: createWriteFetchers(client as unknown as Pick<LivespaceClient, "call">),
    };

    const result = await runLogActivities(
      deps,
      args({
        notes: [
          note({ kind: "person", id: PERSON_ID }),
          note({ kind: "company", id: COMPANY_ID }),
          note({ kind: "deal", id: DEAL_ID }),
        ],
        calls: [callArg()],
        confirm: true,
      }),
      { allowUnboundWriteConfirmation: true },
    );

    expect(dispatched.map((entry) => entry.key)).toEqual([
      "Contact/addContactNote",
      "Contact/addCompanyNote",
      "Deal/addDealNote",
      "Contact/addContactCall",
    ]);
    expect(dispatched.map((entry) => entry.write)).toEqual([true, true, true, true]);
    expect(statusesOf(asRun(result))).toEqual(["ok", "ok", "ok", "ok"]);
  });

  test("a call travels with its direction and a normalized timestamp", async () => {
    const scenario = fakeWorld();

    await run(
      scenario,
      args({
        calls: [
          callArg({
            direction: "incoming",
            note: "Synthetic call note",
            date: "2026-09-26 10:00",
          }),
        ],
        confirm: true,
      }),
    );

    expect(scenario.inputs("addCall")).toEqual([
      {
        personId: PERSON_ID,
        phone: "+00 000 000 001",
        direction: "incoming",
        note: "Synthetic call note",
        date: "2026-09-26 10:00:00",
      },
    ]);
  });

  test("the plan lists what each item will write, in declaration order", async () => {
    const scenario = fakeWorld();

    const result = asRun(
      await run(
        scenario,
        args({
          notes: [note({ kind: "deal", id: DEAL_ID })],
          calls: [callArg({ date: "2026-09-26" })],
        }),
      ),
    );

    expect(planOf(result)).toEqual([
      {
        index: 0,
        action: "log_note",
        kind: "deal",
        status: "note",
        summary: { id: DEAL_ID, note: "Synthetic note one" },
      },
      {
        index: 1,
        action: "log_call",
        kind: "person",
        status: "call",
        summary: {
          personId: PERSON_ID,
          phone: "+00 000 000 001",
          direction: "outgoing",
          date: "2026-09-26 00:00:00",
        },
      },
    ]);
    expect(scenario.count("addNote")).toBe(0);
    expect(scenario.count("addCall")).toBe(0);
    expectPayload(result);
  });
});

describe("the confirmation flow", () => {
  test("a plain call previews and writes nothing", async () => {
    const scenario = fakeWorld();

    const result = asRun(
      await run(
        scenario,
        args({
          notes: [note(), note({ kind: "deal", id: DEAL_ID })],
          calls: [callArg()],
        }),
      ),
    );

    expect(result.text).toBe(
      "log_activities preview: 3 item(s) (2 notes, 1 calls). Re-call with confirm: true to execute.",
    );
    expect(result.structured["requiresConfirmation"]).toBe(true);
    expect(result.structured["results"]).toBeUndefined();
    expect(scenario.calls).toEqual([]);
    expect(errorsOf(result)).toEqual([]);
    expectPayload(result);
  });

  test("dryRun previews without claiming a confirmation is pending", async () => {
    const scenario = fakeWorld();

    const result = asRun(await run(scenario, args({ notes: [note()], dryRun: true })));

    expect(result.structured["requiresConfirmation"]).toBeUndefined();
    expect(scenario.calls).toEqual([]);
    expectPayload(result);
  });

  test("dryRun and confirm together are refused", async () => {
    const scenario = fakeWorld();

    const result = asRun(
      await run(scenario, args({ notes: [note()], dryRun: true, confirm: true })),
    );

    expect(errorsOf(result)[0]?.code).toBe("BAD_PARAMS");
    expect(scenario.calls).toEqual([]);
  });

  test("an elicitation-capable client is asked with counts and no authored string", async () => {
    const scenario = fakeWorld();

    const result = asInputRequired(
      await run(
        scenario,
        args({
          notes: [note({ note: `Synthetic ${NOTE_MARKER}` }), note({ kind: "deal", id: DEAL_ID })],
          calls: [callArg()],
        }),
        { ctx: ctx({ elicitation: true }) },
      ),
    );

    expect(result.requestState).toBe("synthetic-wire-1");
    expect(elicitationMessageOf(result)).toBe(
      "Log 3 activit(y/ies) (2 notes, 1 calls). Approve?",
    );
    // The approval string a human reads is ours: counts and kinds only.
    expect(JSON.stringify(result)).not.toContain(NOTE_MARKER);
    expect(scenario.calls).toEqual([]);
    expect(scenario.minted[0]).toEqual({
      tool: "log_activities",
      argsHash: expect.stringMatching(/^[0-9a-f]{64}$/u) as unknown as string,
      previewDigest: expect.stringMatching(/^[0-9a-f]{64}$/u) as unknown as string,
      jti: expect.stringMatching(/^[0-9a-f]{32}$/u) as unknown as string,
    });
  });

  test("the model cannot self-confirm on an elicitation-capable client", async () => {
    const scenario = fakeWorld();

    const result = await run(scenario, args({ notes: [note()], confirm: true }), {
      ctx: ctx({ elicitation: true }),
    });

    asInputRequired(result);
    expect(scenario.count("addNote")).toBe(0);
  });

  test("a declined confirmation writes nothing and says so", async () => {
    const scenario = fakeWorld();
    const call = args({ notes: [note()] });
    asInputRequired(await run(scenario, call, { ctx: ctx({ elicitation: true }) }));
    const state = scenario.minted[0] as WriteState;

    const result = asRun(
      await run(scenario, call, {
        ctx: ctx({ elicitation: true, state, confirm: "decline" }),
      }),
    );

    expect(result.text).toBe(
      [
        "log_activities preview: 1 item(s) (1 notes, 0 calls). Re-call with confirm: true to execute.",
        "Confirmation was declined; nothing was written.",
      ].join("\n"),
    );
    expect(result.structured["declined"]).toBe(true);
    expect(scenario.count("addNote")).toBe(0);
    expectPayload(result);
  });

  test("an accepted confirmation executes the plan exactly once", async () => {
    const scenario = fakeWorld();

    const result = await twoRounds(scenario, args({ notes: [note()] }));

    expect(scenario.count("addNote")).toBe(1);
    expect(statusesOf(result)).toEqual(["ok"]);
    expectPayload(result);
  });

  test("a replayed confirmation is refused and writes nothing", async () => {
    const scenario = fakeWorld();
    const call = args({ notes: [note()] });
    await twoRounds(scenario, call);
    const state = scenario.minted[0] as WriteState;

    const replay = asRun(
      await run(scenario, call, { ctx: ctx({ elicitation: true, state, confirm: true }) }),
    );

    expect(errorsOf(replay)[0]?.code).toBe("BAD_PARAMS");
    expect(scenario.count("addNote")).toBe(1);
  });

  test("a confirmation minted for another tool is refused", async () => {
    const scenario = fakeWorld();
    const state: WriteState = {
      tool: "create_records",
      argsHash: "hash-synthetic-a",
      previewDigest: "digest-synthetic-a",
      jti: "jti-synthetic-other-tool-activities",
    };

    const result = asRun(
      await run(scenario, args({ notes: [note()] }), {
        ctx: ctx({ elicitation: true, state, confirm: true }),
      }),
    );

    expect(errorsOf(result)[0]?.code).toBe("BAD_PARAMS");
    expect(scenario.calls).toEqual([]);
  });

  test("a stale preview digest sends the batch back for a fresh yes", async () => {
    const scenario = fakeWorld();
    const call = { notes: [note()], calls: undefined };
    const state: WriteState = {
      tool: "log_activities",
      argsHash: await hashArgs(call),
      previewDigest: "digest-synthetic-stale",
      jti: "jti-synthetic-stale-digest",
    };

    const result = asRun(
      await run(scenario, args(call), {
        ctx: ctx({ elicitation: true, state, confirm: true }),
      }),
    );

    expect(scenario.count("addNote")).toBe(0);
    expect(result.text).toBe(
      [
        "log_activities preview: 1 item(s) (1 notes, 0 calls). Re-call with confirm: true to execute.",
        "Records changed since the preview; review and confirm again.",
      ].join("\n"),
    );
    expect(result.structured["recordsChanged"]).toBe(true);
    expect(result.structured["requiresConfirmation"]).toBe(true);
    expectPayload(result);
  });

  test("without elicitation the confirm argument is the execute trigger", async () => {
    const scenario = fakeWorld();

    const result = asRun(
      await run(scenario, args({ notes: [note()], confirm: true }), { ctx: ctx() }),
    );

    expect(scenario.count("addNote")).toBe(1);
    expect(statusesOf(result)).toEqual(["ok"]);
  });
});

describe("wall verification", () => {
  test("two notes on one record read that record's wall once", async () => {
    const scenario = fakeWorld({
      walls: {
        [`deal:${DEAL_ID}`]: [
          wallEntry({ type: "notatka", text: "Synthetic note one" }),
          wallEntry({ type: "notatka", text: "Synthetic note two" }),
        ],
      },
    });

    const result = asRun(
      await run(
        scenario,
        args({
          notes: [
            note({ kind: "deal", id: DEAL_ID, note: "Synthetic note one" }),
            note({ kind: "deal", id: DEAL_ID, note: "Synthetic note two" }),
          ],
          confirm: true,
        }),
      ),
    );

    expect(scenario.inputs("recordWall")).toEqual([`deal:${DEAL_ID}`]);
    expect(verificationsOf(result)).toEqual(["verified", "verified"]);
    // The wall answers for activities; a record read never does.
    expect(scenario.count("getRecord")).toBe(0);
    expect(result.text).toBe(
      "log_activities: attempted 2 of 2 - ok 2, errors 0, unknown 0, not attempted 0.",
    );
    expectPayload(result);
  });

  test("a note is verified by the wall item id the write reported", async () => {
    const scenario = fakeWorld({
      walls: {
        [`person:${PERSON_ID}`]: [
          {
            ...wallEntry({ type: "notatka", text: "Synthetic unrelated wall text" }),
            id: "wall-synthetic-1",
          },
        ],
      },
    });

    const result = asRun(
      await run(scenario, args({ notes: [note()], confirm: true })),
    );

    expect(resultsOf(result)[0]).toEqual({
      index: 0,
      action: "log_note",
      kind: "person",
      status: "ok",
      id: "wall-synthetic-1",
      verification: "verified",
    });
    expectPayload(result);
  });

  test("a note whose id the endpoint withheld is matched by its text", async () => {
    const scenario = fakeWorld({
      addNote: () => null,
      walls: {
        [`company:${COMPANY_ID}`]: [
          wallEntry({ type: "aktywnosc", text: "Synthetic unrelated wall text" }),
          wallEntry({ type: "notatka", text: "Synthetic note one" }),
        ],
      },
    });

    const result = asRun(
      await run(
        scenario,
        args({ notes: [note({ kind: "company", id: COMPANY_ID })], confirm: true }),
      ),
    );

    expect(resultsOf(result)[0]).toEqual({
      index: 0,
      action: "log_note",
      kind: "company",
      status: "ok",
      verification: "verified",
    });
  });

  test("a long note is matched by the head a truncated wall entry keeps", async () => {
    const long = "Synthetic note body ".repeat(40);
    const scenario = fakeWorld({
      walls: {
        [`person:${PERSON_ID}`]: [
          wallEntry({ type: "notatka", text: long.slice(0, 500), textTruncated: true }),
        ],
      },
    });

    const result = asRun(
      await run(scenario, args({ notes: [note({ note: long })], confirm: true })),
    );

    expect(verificationsOf(result)).toEqual(["verified"]);
  });

  test("a note the wall does not show stays ok and unverified", async () => {
    const scenario = fakeWorld({
      walls: {
        [`person:${PERSON_ID}`]: [
          wallEntry({ type: "notatka", text: "Synthetic someone else's note" }),
        ],
      },
    });

    const result = asRun(await run(scenario, args({ notes: [note()], confirm: true })));

    expect(resultsOf(result)[0]).toEqual({
      index: 0,
      action: "log_note",
      kind: "person",
      status: "ok",
      id: "wall-synthetic-1",
      verification: "unavailable",
      error: UNVERIFIED,
    });
    // A write that landed is never turned into an error by the check that follows.
    expect(result.isError).toBe(false);
    expectPayload(result);
  });

  test("a call is verified by a phone entry carrying the timestamp that was sent", async () => {
    const scenario = fakeWorld({
      walls: {
        [`person:${PERSON_ID}`]: [
          wallEntry({ type: "notatka", text: "Synthetic note one" }),
          wallEntry({ type: "telefon", date: "2026-09-26 10:00:00+02" }),
        ],
      },
    });

    const result = asRun(
      await run(
        scenario,
        args({ calls: [callArg({ date: "2026-09-26 10:00" })], confirm: true }),
      ),
    );

    expect(resultsOf(result)[0]).toEqual({
      index: 0,
      action: "log_call",
      kind: "person",
      status: "ok",
      verification: "verified",
    });
    expectPayload(result);
  });

  test("a call logged without a date has no timestamp to match and says so", async () => {
    const scenario = fakeWorld({
      walls: {
        [`person:${PERSON_ID}`]: [wallEntry({ type: "telefon", date: "2026-09-26 10:00:00" })],
      },
    });

    const result = asRun(await run(scenario, args({ calls: [callArg()], confirm: true })));

    expect(statusesOf(result)).toEqual(["ok"]);
    expect(verificationsOf(result)).toEqual(["unavailable"]);
    expect(resultsOf(result)[0]?.["error"]).toEqual(UNVERIFIED);
  });

  test("a wall read that fails leaves the applied write ok and unverified", async () => {
    const scenario = fakeWorld({
      walls: { [`person:${PERSON_ID}`]: new Error("synthetic wall failure") },
    });

    const result = asRun(await run(scenario, args({ notes: [note()], confirm: true })));

    expect(scenario.count("addNote")).toBe(1);
    expect(statusesOf(result)).toEqual(["ok"]);
    expect(verificationsOf(result)).toEqual(["unavailable"]);
    expect(result.isError).toBe(false);
    expectPayload(result);
  });

  test("nothing applied means no wall is read at all", async () => {
    const scenario = fakeWorld({ addNote: () => errorFromEnvelope(420) });

    const result = asRun(await run(scenario, args({ notes: [note()], confirm: true })));

    expect(scenario.count("recordWall")).toBe(0);
    expect(statusesOf(result)).toEqual(["error"]);
    expect(result.isError).toBe(true);
  });
});

describe("execution", () => {
  test("one rejected item does not stop its siblings, and the 420 body never travels", async () => {
    // The envelope a 420 arrives in carries upstream text. The client maps the
    // RESULT CODE and nothing else, so the body cannot reach the model
    // (docs/security.md par. 6) - this pins that it does not.
    const envelope = {
      status: false,
      result: 420,
      error: `invalid value for 'note': ${ENVELOPE_MARKER}`,
    };
    const scenario = fakeWorld({
      addNote: (call) => (call === 0 ? errorFromEnvelope(envelope.result) : "wall-synthetic-2"),
      walls: {
        [`deal:${DEAL_ID}`]: [wallEntry({ type: "notatka", text: "Synthetic note one" })],
      },
    });

    const result = asRun(
      await run(
        scenario,
        args({
          notes: [note(), note({ kind: "deal", id: DEAL_ID })],
          confirm: true,
        }),
      ),
    );

    expect(statusesOf(result)).toEqual(["error", "ok"]);
    expect(resultsOf(result)[0]?.["error"]).toEqual(VALIDATION_420);
    // Only the record that was actually written is verified.
    expect(scenario.inputs("recordWall")).toEqual([`deal:${DEAL_ID}`]);
    const wire = `${result.text}\n${JSON.stringify(result.structured)}`;
    expect(envelope.error).toContain(ENVELOPE_MARKER);
    expect(wire).not.toContain(ENVELOPE_MARKER);
    expect(result.isError).toBe(false);
    expectPayload(result);
  });

  test("a rate-limited item leaves the rest not attempted", async () => {
    const scenario = fakeWorld({
      addNote: (call) => (call === 1 ? RATE_LIMITED : `wall-synthetic-${call + 1}`),
      walls: {
        [`person:${PERSON_ID}`]: [wallEntry({ type: "notatka", text: "Synthetic note one" })],
      },
    });

    const result = asRun(
      await run(
        scenario,
        args({
          notes: [
            note({ note: "Synthetic note one" }),
            note({ note: "Synthetic note two" }),
            note({ note: "Synthetic note three" }),
          ],
          confirm: true,
        }),
      ),
    );

    expect(scenario.count("addNote")).toBe(2);
    expect(statusesOf(result)).toEqual(["ok", "error", "not_attempted"]);
    expect(result.text).toBe(
      "log_activities: attempted 2 of 3 - ok 1, errors 1, unknown 0, not attempted 1.",
    );
    expect(result.structured["counts"]).toEqual({
      ok: 1,
      skippedDuplicate: 0,
      error: 1,
      unknownOutcome: 0,
      notAttempted: 1,
    });
    expectPayload(result);
  });

  test("a batch whose every attempt failed is an error", async () => {
    const scenario = fakeWorld({ addCall: () => errorFromEnvelope(420) });

    const result = asRun(await run(scenario, args({ calls: [callArg()], confirm: true })));

    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      "log_activities: attempted 1 of 1 - ok 0, errors 1, unknown 0, not attempted 0.",
    );
    expectPayload(result);
  });

  test("a caller who walked away before the first write gets no work and no result", async () => {
    const scenario = fakeWorld();
    const controller = new AbortController();
    controller.abort();

    const error = await rejection(
      run(scenario, args({ notes: [note()], confirm: true }), {
        signal: controller.signal,
      }),
    );

    expect((error as LivespaceError).code).toBe("CANCELLED");
    expect(scenario.calls).toEqual([]);
  });

  test("an abort mid-batch is audited by counts and ids, then rejects", async () => {
    const controller = new AbortController();
    const scenario = fakeWorld({
      addNote: (call) => {
        if (call === 0) return "wall-synthetic-1";
        controller.abort();
        throw new LivespaceError(
          "CANCELLED",
          "The request was cancelled.",
          "Re-run the call if you still need the answer.",
        );
      },
    });

    const { value, lines } = await onStderr(async () =>
      rejection(
        run(
          scenario,
          args({
            notes: [
              note({ note: "Synthetic note one" }),
              note({ note: "Synthetic note two" }),
              note({ note: "Synthetic note three" }),
            ],
            confirm: true,
          }),
          { signal: controller.signal },
        ),
      ),
    );

    expect((value as LivespaceError).code).toBe("CANCELLED");
    expect(scenario.count("addNote")).toBe(2);
    expect(scenario.count("recordWall")).toBe(0);
    expect(lines).toEqual([
      "write batch cancelled after 1 applied item(s): ids=[wall-synthetic-1]",
    ]);
  });

  test("an abort inside the wall pass is audited by the same one line", async () => {
    // The writes have already landed and cannot be taken back. A cancel here
    // must still leave the operator a record of what was written - the write
    // phase's audit line ends the call before this point can be reached, so
    // exactly one line is ever emitted.
    const controller = new AbortController();
    const scenario = fakeWorld({
      onWall: () => {
        controller.abort();
        throw new Error("synthetic wall failure");
      },
    });

    const { value, lines } = await onStderr(async () =>
      rejection(
        run(
          scenario,
          args({
            notes: [
              note({ kind: "deal", id: DEAL_ID }),
              note({ kind: "deal", id: DEAL_ID, note: "Synthetic note two" }),
            ],
            confirm: true,
          }),
          { signal: controller.signal },
        ),
      ),
    );

    expect((value as LivespaceError).code).toBe("CANCELLED");
    expect(scenario.count("addNote")).toBe(2);
    // One read per DISTINCT target: two notes on one deal is one wall read.
    expect(scenario.count("recordWall")).toBe(1);
    expect(lines).toEqual([
      "write batch cancelled after 2 applied item(s): ids=[wall-synthetic-1, wall-synthetic-2]",
    ]);
  });

  test("an abort between wall reads issues no further read", async () => {
    const controller = new AbortController();
    const scenario = fakeWorld({
      onWall: (call) => {
        if (call === 0) controller.abort();
      },
    });

    const { value, lines } = await onStderr(async () =>
      rejection(
        run(
          scenario,
          args({
            notes: [note(), note({ kind: "deal", id: DEAL_ID, note: "Synthetic note two" })],
            confirm: true,
          }),
          { signal: controller.signal },
        ),
      ),
    );

    expect((value as LivespaceError).code).toBe("CANCELLED");
    expect(scenario.inputs("recordWall")).toEqual([`person:${PERSON_ID}`]);
    expect(lines).toEqual([
      "write batch cancelled after 2 applied item(s): ids=[wall-synthetic-1, wall-synthetic-2]",
    ]);
  });

  test("the wall pass stops at the budget and the unread items stay ok", async () => {
    // The budget spans BOTH phases: a write phase that ran long leaves no
    // room for the reads that follow it. A check that could not run reports
    // itself as unavailable - it never un-applies a write, and never errors.
    const clock = budgetSpentAtFirstWall();
    const scenario = fakeWorld({
      onWall: clock.onWall,
      walls: {
        [`person:${PERSON_ID}`]: [wallEntry({ type: "notatka", text: "Synthetic note one" })],
        [`deal:${DEAL_ID}`]: [wallEntry({ type: "notatka", text: "Synthetic note two" })],
      },
    });

    const result = asRun(
      await clock.during(() =>
        run(
          scenario,
          args({
            notes: [note(), note({ kind: "deal", id: DEAL_ID, note: "Synthetic note two" })],
            confirm: true,
          }),
        ),
      ),
    );

    expect(scenario.inputs("recordWall")).toEqual([`person:${PERSON_ID}`]);
    expect(statusesOf(result)).toEqual(["ok", "ok"]);
    // The second deal's wall WOULD have carried its note; it was never read.
    expect(verificationsOf(result)).toEqual(["verified", "unavailable"]);
    expect(resultsOf(result)[1]?.["error"]).toEqual(UNVERIFIED);
    expect(result.isError).toBe(false);
    expectPayload(result);
  });
});

describe("the text channel and the output schema", () => {
  test("no authored note text reaches the text channel", async () => {
    const scenario = fakeWorld();
    const call = (extra: Record<string, unknown>): LogActivitiesArgs =>
      args({ notes: [note({ note: `Synthetic ${NOTE_MARKER}` })], ...extra });

    const preview = asRun(await run(scenario, call({})));
    const executed = asRun(await run(scenario, call({ confirm: true })));

    expect(preview.text).not.toContain(NOTE_MARKER);
    expect(executed.text).not.toContain(NOTE_MARKER);
    // The note body is data, so it does travel in the structured channel.
    expect(JSON.stringify(preview.structured)).toContain(NOTE_MARKER);
  });

  test("the output schema rejects a key nobody declared", () => {
    expect(logActivitiesToolConfig.outputSchema.safeParse({ errors: [] }).success).toBe(true);
    expect(
      logActivitiesToolConfig.outputSchema.safeParse({ errors: [], surprise: 1 }).success,
    ).toBe(false);
  });
});
