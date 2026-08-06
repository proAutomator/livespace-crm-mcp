import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  isInputRequiredResult,
  type InputRequiredResult,
  type RequestStateCodec,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { LivespaceError } from "../../src/livespace/errors.js";
import type { UserInfo } from "../../src/livespace/metadata.js";
import type { RecordFetchers, RecordKind } from "../../src/livespace/records.js";
import {
  createWriteFetchers,
  type NotificationWrite,
  type WriteFetchers,
} from "../../src/livespace/writes.js";
import type { MetadataService } from "../../src/server/tools/crm-metadata.js";
import {
  notifyUserToolConfig,
  runNotifyUser,
  type NotifyUserArgs,
  type NotifyUserDeps,
  type NotifyUserResult,
} from "../../src/server/tools/notify-user.js";
import type { ToolError, ToolRunResult } from "../../src/server/tools/tool-error.js";
import {
  NOTIFICATION_UNVERIFIABLE,
  type WriteState,
} from "../../src/server/tools/write-support.js";
import { company, deal, person } from "../support/records.js";

/**
 * `notify_user` against fakes. Every value below is invented: no CRM data, no
 * sandbox values, and no call leaves the process (AGENTS.md).
 *
 * The marker stands in for the message body - the one string this tool is asked
 * to carry. It may live in `structuredContent` and in the elicitation FORM,
 * where a human reads and edits it, and must never reach the text channel or
 * the fixed elicitation line (docs/security.md par. 4).
 */
const NAME_MARKER = "synthetic-name-marker";

/** The literal envelope key, spelled out so a rename upstream fails loudly. */
const CAPS_KEY = "io.modelcontextprotocol/clientCapabilities";

const SUBDOMAIN = "synthetic";

const USER_A = "user-synthetic-201";
const USER_B = "user-synthetic-202";
const USER_C = "user-synthetic-203";
const USER_D = "user-synthetic-204";
const USER_E = "user-synthetic-205";
const USER_F = "user-synthetic-206";

const DEAL_ID = "deal-synthetic-401";
const PERSON_ID = "person-synthetic-001";
const COMPANY_ID = "company-synthetic-101";

const BODY = `Synthetic notification body mentioning ${NAME_MARKER}`;

const USERS: UserInfo[] = [USER_A, USER_B, USER_C, USER_D, USER_E, USER_F].map(
  (id, index) => ({
    id,
    name: `Synthetic User ${index}`,
    email: `user.${index}@synthetic.example`,
    teams: [],
  }),
);

const RATE_LIMITED = new LivespaceError(
  "RATE_LIMITED",
  "Livespace rate-limited the request (HTTP 429).",
  "Wait before retrying; reduce request frequency if it persists.",
);

const OUTCOME_UNKNOWN = new LivespaceError(
  "WRITE_OUTCOME_UNKNOWN",
  "The write may or may not have been applied.",
  "Re-read before writing again; never retry the write itself.",
);

const VALIDATION_420 = new LivespaceError(
  "VALIDATION_ERROR",
  "Livespace rejected the request as invalid (420).",
  "One or more field values are invalid for this method. Fix them and retry.",
  420,
);

/**
 * A clock nobody shares. The send budget is module state measured in wall time,
 * so every test runs an hour later than the last one in FAKE time - far enough
 * that no earlier dispatch is still inside either window - and the base sits in
 * the past, so entries this file leaves behind are already stale for anything
 * that runs on the real clock afterwards.
 */
const CLOCK_BASE = Date.UTC(2020, 0, 1);
const REAL_NOW = Date.now;
let clock = CLOCK_BASE;

beforeEach(() => {
  clock += 3_600_000;
  Date.now = (): number => clock;
});

afterEach(() => {
  Date.now = REAL_NOW;
});

function advance(ms: number): void {
  clock += ms;
}

interface Recorded {
  method: string;
  input: unknown;
  opts: unknown;
}

/** The records every test can link to, unless it cans its own answer. */
const DEFAULT_RECORDS: Record<string, unknown> = {
  [`deal:${DEAL_ID}`]: deal(),
  [`person:${PERSON_ID}`]: person(),
  [`company:${COMPANY_ID}`]: company(),
};

interface Canning {
  /** The `users` dictionary, or an error the section read throws. */
  users?: unknown;
  /** Record answers keyed `<kind>:<id>`; an ARRAY answers one call each. */
  records?: Record<string, unknown>;
  sendNotification?: (call: number, input: NotificationWrite) => LivespaceError | undefined;
  /** Real write fetchers over a recording client, for the upstream wire pin. */
  writes?: WriteFetchers;
}

/**
 * The fakes implement exactly the fetchers `notify_user` may touch and RECORD
 * every call. Every other write fetcher throws: a notification that reaches for
 * one is a bug, not a passing test.
 */
function fakeWorld(canned: Canning = {}) {
  const calls: Recorded[] = [];
  const seen = new Map<string, number>();
  const push = (method: string, input: unknown, opts: unknown): number => {
    const call = calls.filter((entry) => entry.method === method).length;
    calls.push({ method, input, opts });
    return call;
  };
  const answerFor = (table: Record<string, unknown> | undefined, key: string): unknown => {
    const at = seen.get(key) ?? 0;
    seen.set(key, at + 1);
    const canning = table?.[key];
    const answer = Array.isArray(canning)
      ? canning[Math.min(at, canning.length - 1)]
      : canning;
    if (answer instanceof Error) throw answer;
    return answer ?? null;
  };
  const never =
    (method: string) =>
    async (): Promise<never> => {
      throw new Error(`notify_user must never call ${method}`);
    };

  const writes = (canned.writes ?? {
    sendNotification: async (input: NotificationWrite, opts?: unknown) => {
      const call = push("sendNotification", input, opts);
      const answer = canned.sendNotification?.(call, input);
      if (answer !== undefined) throw answer;
    },
    createPerson: never("createPerson"),
    createCompany: never("createCompany"),
    createDeal: never("createDeal"),
    createTask: never("createTask"),
    updatePerson: never("updatePerson"),
    updateCompany: never("updateCompany"),
    updateDeal: never("updateDeal"),
    updateTask: never("updateTask"),
    addNote: never("addNote"),
    addCall: never("addCall"),
    moveDealSteps: never("moveDealSteps"),
    findPersonByEmail: never("findPersonByEmail"),
    findCompanyByName: never("findCompanyByName"),
  }) as unknown as WriteFetchers;

  const table = { ...DEFAULT_RECORDS, ...(canned.records ?? {}) };
  const records = {
    getRecord: async (kind: RecordKind, id: string, opts?: unknown) => {
      const key = `${kind}:${id}`;
      push("getRecord", key, opts);
      return answerFor(table, key);
    },
  } as unknown as RecordFetchers;

  const metadata = {
    get: async (section: string, opts?: unknown) => {
      push("metadata", section, opts);
      const users = canned.users ?? USERS;
      if (users instanceof LivespaceError) throw users;
      return { data: users, asOf: 1000, stale: false };
    },
  } as unknown as MetadataService;

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

  const deps: NotifyUserDeps = { writes, records, metadata, codec, subdomain: SUBDOMAIN };
  const inputs = (method: string): unknown[] =>
    calls.filter((entry) => entry.method === method).map((entry) => entry.input);
  const count = (method: string): number => inputs(method).length;
  return { deps, calls, minted, inputs, count };
}

type World = ReturnType<typeof fakeWorld>;

interface CtxOptions {
  elicitation?: boolean;
  state?: WriteState;
  /** `true`/`false` are accepted answers; "decline"/"cancel" are dismissals. */
  confirm?: boolean | "decline" | "cancel";
  /** The edited message body, when the human sent one back. */
  text?: string;
}

function ctx(options: CtxOptions = {}): unknown {
  const content =
    options.text === undefined
      ? { confirm: options.confirm }
      : { confirm: options.confirm, text: options.text };
  const responses =
    options.confirm === undefined
      ? undefined
      : options.confirm === "decline" || options.confirm === "cancel"
        ? { confirm: { action: options.confirm } }
        : { confirm: { action: "accept", content } };
  return {
    mcpReq: {
      method: "tools/call",
      envelope: options.elicitation === true ? { [CAPS_KEY]: { elicitation: {} } } : {},
      ...(responses === undefined ? {} : { inputResponses: responses }),
      requestState: () => options.state,
    },
  };
}

function args(value: Record<string, unknown>): NotifyUserArgs {
  return value as unknown as NotifyUserArgs;
}

/** The plain call every test starts from: one recipient, one deal link. */
function dealCall(overrides: Record<string, unknown> = {}): NotifyUserArgs {
  return args({
    userId: USER_A,
    text: BODY,
    recordKind: "deal",
    recordId: DEAL_ID,
    ...overrides,
  });
}

function run(
  world: World,
  call: NotifyUserArgs,
  opts: { signal?: AbortSignal; ctx?: unknown } = {},
): Promise<NotifyUserResult> {
  return runNotifyUser(world.deps, call, opts);
}

function asRun(result: NotifyUserResult): ToolRunResult {
  if (isInputRequiredResult(result)) {
    throw new Error("expected a tool result, got an input-required result");
  }
  return result;
}

function asInputRequired(result: NotifyUserResult): InputRequiredResult {
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

function rowOf(result: ToolRunResult): Record<string, unknown> {
  const rows = resultsOf(result);
  expect(rows.length).toBe(1);
  return rows[0] as Record<string, unknown>;
}

function errorsOf(result: ToolRunResult): ToolError[] {
  return result.structured["errors"] as ToolError[];
}

/** Every answer the tool returns must validate against its own output schema. */
function expectPayload(result: ToolRunResult): void {
  const parsed = notifyUserToolConfig.outputSchema.safeParse(result.structured);
  expect(parsed.success).toBe(true);
  expect(parsed.data as Record<string, unknown>).toEqual(result.structured);
}

function elicitationMessageOf(result: InputRequiredResult): string {
  const requests = result.inputRequests as Record<string, { params: { message: string } }>;
  return requests["confirm"]?.params.message as string;
}

function requestedSchemaOf(result: InputRequiredResult): any {
  const requests = result.inputRequests as Record<
    string,
    { params: { requestedSchema: unknown } }
  >;
  return requests["confirm"]?.params.requestedSchema as any;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

/** Round one asks the human, round two carries the minted state back. */
async function twoRounds(
  world: World,
  call: NotifyUserArgs,
  answer: CtxOptions = { confirm: true },
): Promise<ToolRunResult> {
  const first = await run(world, call, { ctx: ctx({ elicitation: true }) });
  asInputRequired(first);
  const state = world.minted[0] as WriteState;
  return asRun(
    await run(world, call, { ctx: ctx({ elicitation: true, state, ...answer }) }),
  );
}

/** The non-elicitation execute path: preview once, then confirm. */
function confirmed(world: World, call: NotifyUserArgs): Promise<NotifyUserResult> {
  return run(world, args({ ...call, confirm: true }), { ctx: ctx() });
}

function sentInputs(world: World): NotificationWrite[] {
  return world.inputs("sendNotification") as NotificationWrite[];
}

describe("notifyUserToolConfig", () => {
  test("the annotations declare a non-destructive, non-idempotent write", () => {
    expect(notifyUserToolConfig.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  test("the input schema is a plain object at the JSON Schema root", () => {
    const json = z.toJSONSchema(notifyUserToolConfig.inputSchema) as Record<
      string,
      unknown
    >;
    expect(json["type"]).toBe("object");
    expect(json["oneOf"]).toBeUndefined();
  });

  test("the description is honest about delivery and about the cached user list", () => {
    const description = notifyUserToolConfig.description.replace(/\s+/gu, " ");
    expect(description).toContain(
      "Livespace exposes no read-back for notifications, so this tool reports a notification as dispatched, never as delivered",
    );
    expect(description).toContain("crm_metadata");
    expect(description).toContain("confirm: true");
    expect(description).toContain("500 characters");
    // The strongest claim it may make is "dispatched".
    expect(description).not.toContain("delivered to");
  });
});

describe("the input schema", () => {
  const parse = (value: unknown): boolean =>
    notifyUserToolConfig.inputSchema.safeParse(value).success;

  test("the root object is strict and names both required arguments", () => {
    expect(parse({ userId: USER_A, text: BODY })).toBe(true);
    expect(parse({ userId: USER_A })).toBe(false);
    expect(parse({ text: BODY })).toBe(false);
    expect(parse({ userId: USER_A, text: BODY, surprise: 1 })).toBe(false);
  });

  test("the recipient id and the body are bounded strings", () => {
    expect(parse({ userId: "", text: BODY })).toBe(false);
    expect(parse({ userId: "x".repeat(65), text: BODY })).toBe(false);
    expect(parse({ userId: USER_A, text: "" })).toBe(false);
    expect(parse({ userId: USER_A, text: "x".repeat(500) })).toBe(true);
    expect(parse({ userId: USER_A, text: "x".repeat(501) })).toBe(false);
  });

  test("the record link is an optional kind/id pair of the three linkable kinds", () => {
    for (const kind of ["person", "company", "deal"]) {
      expect(parse({ userId: USER_A, text: BODY, recordKind: kind, recordId: DEAL_ID })).toBe(
        true,
      );
    }
    expect(
      parse({ userId: USER_A, text: BODY, recordKind: "task", recordId: "task-synthetic-801" }),
    ).toBe(false);
    // The pairing itself is a runner rule: a schema refinement would answer with
    // a protocol validation error instead of a hint the model can act on.
    expect(parse({ userId: USER_A, text: BODY, recordKind: "deal" })).toBe(true);
    expect(parse({ userId: USER_A, text: BODY, recordId: DEAL_ID })).toBe(true);
  });
});

describe("arguments the runner refuses", () => {
  test("a record kind without an id is BAD_PARAMS before anything upstream", async () => {
    const world = fakeWorld();
    const result = asRun(
      await run(world, args({ userId: USER_A, text: BODY, recordKind: "deal" })),
    );
    expect(result.isError).toBe(true);
    expect(errorsOf(result)[0]?.code).toBe("BAD_PARAMS");
    expect(errorsOf(result)[0]?.hint).toContain("recordKind and recordId");
    expect(world.calls).toEqual([]);
    expectPayload(result);
  });

  test("a record id without a kind is BAD_PARAMS", async () => {
    const world = fakeWorld();
    const result = asRun(
      await run(world, args({ userId: USER_A, text: BODY, recordId: DEAL_ID })),
    );
    expect(errorsOf(result)[0]?.code).toBe("BAD_PARAMS");
    expect(world.calls).toEqual([]);
  });

  test("dryRun and confirm together are refused before anything upstream", async () => {
    const world = fakeWorld();
    const result = asRun(
      await run(world, dealCall({ dryRun: true, confirm: true }), { ctx: ctx() }),
    );
    expect(errorsOf(result)[0]?.code).toBe("BAD_PARAMS");
    expect(world.count("sendNotification")).toBe(0);
  });
});

describe("the recipient and the linked record", () => {
  test("a user id the cached dictionary does not list is NOT_FOUND, nothing is read or sent", async () => {
    const world = fakeWorld();
    const result = asRun(
      await confirmed(world, args({ userId: "user-synthetic-999", text: BODY })),
    );
    expect(result.isError).toBe(true);
    const error = errorsOf(result)[0] as ToolError;
    expect(error.code).toBe("NOT_FOUND");
    expect(error.hint).toContain("crm_metadata");
    // The staleness caveat: the list is cached, so a fresh user may be missing.
    expect(error.hint).toContain("cached");
    expect(world.count("getRecord")).toBe(0);
    expect(world.count("sendNotification")).toBe(0);
    expectPayload(result);
  });

  test("a record the CRM does not hold is NOT_FOUND and nothing is sent", async () => {
    const world = fakeWorld({ records: { [`deal:${DEAL_ID}`]: null } });
    const result = asRun(await confirmed(world, dealCall()));
    expect(errorsOf(result)[0]?.code).toBe("NOT_FOUND");
    expect(world.count("sendNotification")).toBe(0);
  });

  test("a rate-limited dictionary read is reported and nothing is sent", async () => {
    const world = fakeWorld({ users: RATE_LIMITED });
    const result = asRun(await confirmed(world, dealCall()));
    expect(errorsOf(result)[0]?.code).toBe("RATE_LIMITED");
    expect(world.count("sendNotification")).toBe(0);
  });

  test("the recipient is validated before the record is read", async () => {
    const world = fakeWorld();
    await confirmed(world, args({ userId: "user-synthetic-999", text: BODY, recordKind: "deal", recordId: DEAL_ID }));
    expect(world.calls.map((entry) => entry.method)).toEqual(["metadata"]);
  });
});

describe("the deep link", () => {
  test("the record's own url wins, verbatim", async () => {
    const own = `https://${SUBDOMAIN}.livespace.io/Deal/deal/details/api_id/${DEAL_ID}`;
    const world = fakeWorld({ records: { [`deal:${DEAL_ID}`]: deal({ url: own }) } });
    const result = asRun(await confirmed(world, dealCall()));
    expect(sentInputs(world)[0]?.url).toBe(own);
    expect(rowOf(result)["urlKind"]).toBe("record");
  });

  test("an empty url falls back to the constructed deep link, per kind", async () => {
    const cases: [RecordKind, string, string][] = [
      ["deal", DEAL_ID, `https://${SUBDOMAIN}.livespace.io/Deal/deal/details/api_id/${DEAL_ID}`],
      [
        "person",
        PERSON_ID,
        `https://${SUBDOMAIN}.livespace.io/Contact/contact/details/api_id/${PERSON_ID}`,
      ],
      [
        "company",
        COMPANY_ID,
        `https://${SUBDOMAIN}.livespace.io/Contact/company/details/api_id/${COMPANY_ID}`,
      ],
    ];
    const fixtures: Record<string, unknown> = {
      [`deal:${DEAL_ID}`]: deal({ url: "" }),
      [`person:${PERSON_ID}`]: person({ url: "" }),
      [`company:${COMPANY_ID}`]: company({ url: "" }),
    };
    for (const [kind, id, expected] of cases) {
      const world = fakeWorld({ records: fixtures });
      await confirmed(
        world,
        args({ userId: USER_A, text: BODY, recordKind: kind, recordId: id }),
      );
      expect(sentInputs(world)[0]?.url).toBe(expected);
      advance(61_000);
    }
  });

  test("a url pointing anywhere but this account falls back to the constructed one", async () => {
    const world = fakeWorld({
      records: { [`deal:${DEAL_ID}`]: deal({ url: "https://elsewhere.example/phish" }) },
    });
    await confirmed(world, dealCall());
    expect(sentInputs(world)[0]?.url).toBe(
      `https://${SUBDOMAIN}.livespace.io/Deal/deal/details/api_id/${DEAL_ID}`,
    );
  });

  test("without a record the link is the CRM root and the kind says so", async () => {
    const world = fakeWorld();
    const result = asRun(await confirmed(world, args({ userId: USER_A, text: BODY })));
    expect(sentInputs(world)[0]?.url).toBe(`https://${SUBDOMAIN}.livespace.io/`);
    expect(rowOf(result)["urlKind"]).toBe("root");
    expect(world.count("getRecord")).toBe(0);
  });
});

describe("the send budget", () => {
  const recipients = [USER_A, USER_B, USER_C, USER_D, USER_E];

  async function spendTheBudget(world: World): Promise<void> {
    for (const userId of recipients) {
      const result = asRun(await confirmed(world, args({ userId, text: BODY })));
      expect(rowOf(result)["dispatched"]).toBe(true);
    }
  }

  test("the sixth notification inside the window is refused before anything upstream", async () => {
    const world = fakeWorld();
    await spendTheBudget(world);
    const before = world.count("metadata");
    const result = asRun(await confirmed(world, args({ userId: USER_F, text: BODY })));
    expect(result.isError).toBe(true);
    const error = errorsOf(result)[0] as ToolError;
    expect(error.code).toBe("RATE_LIMITED");
    expect(error.message).toBe(
      "This server sends at most 5 notifications per 10 minutes, and that budget is spent.",
    );
    expect(world.count("metadata")).toBe(before);
    expect(world.count("sendNotification")).toBe(5);
    expectPayload(result);
  });

  test("the budget frees up once the window has passed", async () => {
    const world = fakeWorld();
    await spendTheBudget(world);
    advance(10 * 60_000 + 1);
    const result = asRun(await confirmed(world, args({ userId: USER_F, text: BODY })));
    expect(rowOf(result)["dispatched"]).toBe(true);
    expect(world.count("sendNotification")).toBe(6);
  });

  test("one recipient is notified at most once a minute, others are unaffected", async () => {
    const world = fakeWorld();
    asRun(await confirmed(world, args({ userId: USER_A, text: BODY })));
    advance(30_000);
    const refused = asRun(await confirmed(world, args({ userId: USER_A, text: BODY })));
    expect(errorsOf(refused)[0]?.message).toBe(
      "This recipient was notified less than a minute ago.",
    );
    expect(world.count("sendNotification")).toBe(1);

    const other = asRun(await confirmed(world, args({ userId: USER_B, text: BODY })));
    expect(rowOf(other)["dispatched"]).toBe(true);

    advance(31_000);
    const again = asRun(await confirmed(world, args({ userId: USER_A, text: BODY })));
    expect(rowOf(again)["dispatched"]).toBe(true);
    expect(world.count("sendNotification")).toBe(3);
  });

  test("a clock that jumped backwards does not wedge the budget", async () => {
    const world = fakeWorld();
    await spendTheBudget(world);
    // Every recorded dispatch now sits in the future. An entry nothing can drop
    // would refuse notifications for good, so those are dropped too.
    advance(-4 * 3_600_000);
    const result = asRun(await confirmed(world, args({ userId: USER_F, text: BODY })));
    expect(rowOf(result)["dispatched"]).toBe(true);
  });

  test("a preview costs nothing against the budget", async () => {
    const world = fakeWorld();
    for (let round = 0; round < 8; round += 1) {
      const preview = asRun(await run(world, dealCall({ dryRun: true }), { ctx: ctx() }));
      expect(preview.isError).toBe(false);
    }
    expect(world.count("sendNotification")).toBe(0);
  });
});

describe("the confirmation flow", () => {
  test("a plain call previews, asks for confirmation and sends nothing", async () => {
    const world = fakeWorld({ records: { [`deal:${DEAL_ID}`]: deal() } });
    const result = asRun(await run(world, dealCall(), { ctx: ctx() }));
    expect(result.isError).toBe(false);
    expect(result.structured["requiresConfirmation"]).toBe(true);
    const plan = planOf(result);
    expect(plan.length).toBe(1);
    expect(plan[0]?.["status"]).toBe("action");
    expect(plan[0]?.["summary"]).toStrictEqual({
      userId: USER_A,
      urlKind: "record",
      url: `https://${SUBDOMAIN}.livespace.io/Deal/deal/details/api_id/${DEAL_ID}`,
      textLength: BODY.length,
      textPreview: BODY,
    });
    expect(result.text).toBe(
      `notify_user preview: 1 notification for 1 recipient - ${BODY.length} character(s), ` +
        `linked to a record. Re-call with confirm: true to execute.`,
    );
    expect(world.count("sendNotification")).toBe(0);
    expectPayload(result);
  });

  test("dryRun previews without asking for a confirmation and sends nothing", async () => {
    const world = fakeWorld();
    const result = asRun(await run(world, dealCall({ dryRun: true }), { ctx: ctx() }));
    expect(result.structured["requiresConfirmation"]).toBeUndefined();
    expect(world.count("sendNotification")).toBe(0);
    expectPayload(result);
  });

  test("an elicitation-capable client is asked, with an editable body in the form", async () => {
    const world = fakeWorld();
    const request = asInputRequired(
      await run(world, dealCall(), { ctx: ctx({ elicitation: true }) }),
    );
    const schema = requestedSchemaOf(request);
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["confirm"]);
    expect(schema.properties.confirm.type).toBe("boolean");
    expect(schema.properties.text.type).toBe("string");
    // The human SEES the body and may edit it: that is what the field is for.
    expect(schema.properties.text.default).toBe(BODY);
    expect(schema.properties.text.minLength).toBe(1);
    expect(schema.properties.text.maxLength).toBe(500);

    expect(elicitationMessageOf(request)).toBe(
      `Send 1 in-app notification to 1 CRM user: ${BODY.length} character(s), ` +
        `linked to a record. The message below can be edited before it is sent. ` +
        `Livespace cannot confirm delivery. Approve?`,
    );
    expect(world.minted[0]?.tool).toBe("notify_user");
    expect(world.count("sendNotification")).toBe(0);
  });

  test("an accepted confirmation dispatches the planned body once", async () => {
    const world = fakeWorld();
    const result = await twoRounds(world, dealCall());
    expect(sentInputs(world)).toStrictEqual([
      {
        userId: USER_A,
        text: BODY,
        url: `https://${SUBDOMAIN}.livespace.io/Deal/deal/details/api_id/${DEAL_ID}`,
      },
    ]);
    expect(rowOf(result)["dispatched"]).toBe(true);
    expectPayload(result);
  });

  test("an edited body is what travels upstream and what the row counts", async () => {
    const world = fakeWorld();
    const edited = "Synthetic edited body, shorter";
    const result = await twoRounds(world, dealCall(), { confirm: true, text: edited });
    expect(sentInputs(world)[0]?.text).toBe(edited);
    const row = rowOf(result);
    expect(row["textLength"]).toBe(edited.length);
    expect(row["textPreview"]).toBe(edited);
  });

  test("an edited body outside 1..500 characters is declined and nothing is sent", async () => {
    for (const edited of ["", "x".repeat(501)]) {
      const world = fakeWorld();
      const result = await twoRounds(world, dealCall(), { confirm: true, text: edited });
      expect(result.structured["declined"]).toBe(true);
      expect(result.text).toContain(
        "The edited message is empty or longer than 500 characters; nothing was sent.",
      );
      expect(world.count("sendNotification")).toBe(0);
      expectPayload(result);
      advance(61_000);
    }
  });

  test("a declined or cancelled prompt sends nothing", async () => {
    for (const answer of ["decline", "cancel"] as const) {
      const world = fakeWorld();
      const result = await twoRounds(world, dealCall(), { confirm: answer });
      expect(result.structured["declined"]).toBe(true);
      expect(result.text).toContain("Confirmation was declined; nothing was sent.");
      expect(world.count("sendNotification")).toBe(0);
      expectPayload(result);
    }
  });

  test("an accepted confirmation carrying confirm false sends nothing", async () => {
    const world = fakeWorld();
    const result = await twoRounds(world, dealCall(), { confirm: false });
    expect(result.structured["declined"]).toBe(true);
    expect(world.count("sendNotification")).toBe(0);
  });

  test("a link that changed since the preview goes back for a fresh yes", async () => {
    const moved = `https://${SUBDOMAIN}.livespace.io/Deal/deal/details/api_id/deal-synthetic-499`;
    const world = fakeWorld({
      records: { [`deal:${DEAL_ID}`]: [deal(), deal({ url: moved })] },
    });
    const result = await twoRounds(world, dealCall());
    expect(result.structured["recordsChanged"]).toBe(true);
    expect(result.structured["requiresConfirmation"]).toBe(true);
    expect(result.text).toContain("Records changed since the preview; review and confirm again.");
    expect(world.count("sendNotification")).toBe(0);
    expectPayload(result);
  });
});

describe("the dispatch", () => {
  test("the upstream call is one notification_send with type 1 and the url verbatim", async () => {
    const upstream: {
      module: string;
      method: string;
      params: Record<string, unknown>;
      opts: Record<string, unknown>;
    }[] = [];
    const client = {
      call: (async (
        module: string,
        method: string,
        params?: Record<string, unknown>,
        opts?: unknown,
      ) => {
        upstream.push({
          module,
          method,
          params: params ?? {},
          opts: (opts ?? {}) as Record<string, unknown>,
        });
        return [];
      }) as never,
    };
    const world = fakeWorld({ writes: createWriteFetchers(client) });
    await confirmed(world, dealCall());
    expect(upstream.length).toBe(1);
    expect([upstream[0]?.module, upstream[0]?.method]).toEqual(["Crm", "notification_send"]);
    expect(upstream[0]?.params).toStrictEqual({
      user_id: USER_A,
      text: BODY,
      type: 1,
      url: `https://${SUBDOMAIN}.livespace.io/Deal/deal/details/api_id/${DEAL_ID}`,
    });
    expect(upstream[0]?.opts["write"]).toBe(true);
  });

  test("a dispatched notification claims nothing about delivery", async () => {
    const world = fakeWorld();
    const result = asRun(await confirmed(world, dealCall()));
    const row = rowOf(result);
    expect(row["status"]).toBe("ok");
    expect(row["dispatched"]).toBe(true);
    expect(row["verification"]).toBe("unavailable");
    expect(row["error"]).toStrictEqual(NOTIFICATION_UNVERIFIABLE);
    // "sent" is a claim nobody can back up; the row never carries one.
    expect(Object.keys(row)).not.toContain("sent");
    expect(result.text).toBe(
      "notify_user: dispatched 1 of 1 - errors 0, unknown 0. Livespace exposes no " +
        "read-back, so delivery is not confirmed; do not resend.",
    );
    expect(result.text).not.toContain("delivered");
    expect(result.isError).toBe(false);
    expectPayload(result);
  });

  test("an upstream rejection is an error row and the call fails", async () => {
    const world = fakeWorld({ sendNotification: () => VALIDATION_420 });
    const result = asRun(await confirmed(world, dealCall()));
    const row = rowOf(result);
    expect(row["status"]).toBe("error");
    expect(row["dispatched"]).toBe(false);
    expect((row["error"] as ToolError).code).toBe("VALIDATION_ERROR");
    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      "notify_user: dispatched 0 of 1 - errors 1, unknown 0. Livespace exposes no " +
        "read-back, so delivery is not confirmed; do not resend.",
    );
    expectPayload(result);
  });

  test("an unknown outcome claims nothing and is never retried", async () => {
    const world = fakeWorld({ sendNotification: () => OUTCOME_UNKNOWN });
    const result = asRun(await confirmed(world, dealCall()));
    const row = rowOf(result);
    expect(row["status"]).toBe("unknown_outcome");
    expect(Object.keys(row)).not.toContain("dispatched");
    expect(world.count("sendNotification")).toBe(1);
    expect(result.isError).toBe(true);
    expectPayload(result);
  });

  test("a call the caller abandoned rejects instead of answering", async () => {
    const world = fakeWorld();
    const controller = new AbortController();
    controller.abort();
    const error = await rejection(
      run(world, dealCall(), { signal: controller.signal, ctx: ctx() }),
    );
    expect(error).toBeInstanceOf(LivespaceError);
    expect((error as LivespaceError).code).toBe("CANCELLED");
    expect(world.count("sendNotification")).toBe(0);
  });
});

describe("what the text channel may carry", () => {
  test("the message body never reaches the text channel or the approval line", async () => {
    const world = fakeWorld();
    const preview = asRun(await run(world, dealCall(), { ctx: ctx() }));
    expect(preview.text).not.toContain(NAME_MARKER);

    const request = asInputRequired(
      await run(world, dealCall(), { ctx: ctx({ elicitation: true }) }),
    );
    expect(elicitationMessageOf(request)).not.toContain(NAME_MARKER);

    const executed = asRun(await confirmed(world, dealCall()));
    expect(executed.text).not.toContain(NAME_MARKER);
    // The structured channel is where the body is data, and there it is.
    expect(rowOf(executed)["textPreview"]).toContain(NAME_MARKER);
  });

  test("the structured preview of the body is capped at 100 characters", async () => {
    const long = `${NAME_MARKER} ${"x".repeat(400)}`;
    const world = fakeWorld();
    const result = asRun(await confirmed(world, args({ userId: USER_A, text: long })));
    const row = rowOf(result);
    expect(row["textLength"]).toBe(long.length);
    expect((row["textPreview"] as string).length).toBe(100);
    expect(row["textPreview"]).toBe(long.slice(0, 100));
    // The whole body still travels upstream - only the preview is cut.
    expect(sentInputs(world)[0]?.text).toBe(long);
  });
});
