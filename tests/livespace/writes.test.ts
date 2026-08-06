import { describe, expect, test } from "bun:test";
import { LivespaceError } from "../../src/livespace/errors.js";
import { mapTask } from "../../src/livespace/records.js";
import {
  createWriteFetchers,
  verifyApplied,
  type WriteFetchers,
} from "../../src/livespace/writes.js";
import { company, deal, person, task } from "../support/records.js";

/**
 * Write fetchers, pinned against recording fakes. Every value here is invented
 * (AGENTS.md): no CRM data, no sandbox values, and no call ever leaves the
 * process.
 *
 * The payload assertions are `toStrictEqual` on the WHOLE params object on
 * purpose. Upstream accepts unknown keys silently (probe evidence 11), so a key
 * that should not be there - `_wall` above all - would never be caught by a
 * subset assertion.
 */

const UNEXPECTED_SHAPE = "Livespace returned an unexpected shape for this write.";

interface FakeCall {
  module: string;
  method: string;
  params: Record<string, unknown>;
  opts: { write?: boolean; signal?: AbortSignal };
}

function fakeWriteClient(responses: Record<string, unknown>) {
  const calls: FakeCall[] = [];
  return {
    calls,
    client: {
      call: (async (
        module: string,
        method: string,
        params?: Record<string, unknown>,
        opts?: unknown,
      ) => {
        calls.push({
          module,
          method,
          params: params ?? {},
          opts: (opts ?? {}) as FakeCall["opts"],
        });
        const key = `${module}/${method}`;
        if (!(key in responses)) {
          throw new LivespaceError(
            "UPSTREAM_ERROR",
            `no synthetic response for ${key}`,
            "fixture gap",
          );
        }
        const canned = responses[key];
        if (canned instanceof LivespaceError) throw canned;
        return canned;
      }) as never,
    },
  };
}

function writeFetchersFor(responses: Record<string, unknown>) {
  const { client, calls } = fakeWriteClient(responses);
  return { writes: createWriteFetchers(client), calls };
}

/** Every key name in a payload, at any depth - the `_wall` sweep runs on this. */
function keyNames(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) keyNames(entry, found);
    return found;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      found.push(key);
      keyNames(inner, found);
    }
  }
  return found;
}

function onlyCall(calls: FakeCall[]): FakeCall {
  expect(calls).toHaveLength(1);
  return calls[0] as FakeCall;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

const CREATE_ECHOES: Record<string, unknown> = {
  "Contact/addContact": { contact: { id: "person-synthetic-001" } },
  "Contact/addCompany": { company: { id: "company-synthetic-101" } },
  "Deal/addDeal": { deal: { id: "deal-synthetic-401" } },
  "Todo/addTodo": { todo: { id: "task-synthetic-801" } },
};

describe("create payloads", () => {
  test("createPerson wraps the contact, sends string arrays and links the company", async () => {
    const { writes, calls } = writeFetchersFor(CREATE_ECHOES);

    const created = await writes.createPerson({
      firstname: "Synthetic",
      lastname: "Person",
      emails: ["person.one@synthetic.example", "second@synthetic.example"],
      phones: ["+00 000 000 001"],
      note: "Synthetic note text",
      companyId: "company-synthetic-101",
    });

    expect(created).toEqual({ id: "person-synthetic-001" });
    const call = onlyCall(calls);
    expect([call.module, call.method]).toEqual(["Contact", "addContact"]);
    expect(call.params).toStrictEqual({
      contact: {
        firstname: "Synthetic",
        lastname: "Person",
        // String arrays, never the scalar email/phone: those echo back and
        // store NOTHING (probe evidence 2).
        emails: ["person.one@synthetic.example", "second@synthetic.example"],
        phones: ["+00 000 000 001"],
        note: "Synthetic note text",
        company: { id: "company-synthetic-101" },
      },
    });
    expect(call.opts.write).toBe(true);
    // The CRM feed entry is the operator's audit trail of agent activity, so
    // nothing here may suppress it (rev. 2 decision).
    expect(keyNames(call.params)).not.toContain("_wall");
  });

  test("createPerson omits every field it was not given", async () => {
    const { writes, calls } = writeFetchersFor(CREATE_ECHOES);

    await writes.createPerson({ firstname: "Synthetic" });

    expect(onlyCall(calls).params).toStrictEqual({ contact: { firstname: "Synthetic" } });
  });

  test("createCompany wraps the company and keeps nip optional", async () => {
    const withNip = writeFetchersFor(CREATE_ECHOES);
    const created = await withNip.writes.createCompany({
      name: "Synthetic Company Alpha",
      nip: "0000000000",
    });
    expect(created).toEqual({ id: "company-synthetic-101" });
    const call = onlyCall(withNip.calls);
    expect([call.module, call.method]).toEqual(["Contact", "addCompany"]);
    expect(call.params).toStrictEqual({
      company: { name: "Synthetic Company Alpha", nip: "0000000000" },
    });

    const bare = writeFetchersFor(CREATE_ECHOES);
    await bare.writes.createCompany({ name: "Synthetic Company Beta" });
    expect(onlyCall(bare.calls).params).toStrictEqual({
      company: { name: "Synthetic Company Beta" },
    });
  });

  test("createDeal links a company as a nested object", async () => {
    const { writes, calls } = writeFetchersFor(CREATE_ECHOES);

    const created = await writes.createDeal({
      name: "Synthetic Deal One",
      companyId: "company-synthetic-101",
    });

    expect(created).toEqual({ id: "deal-synthetic-401" });
    const call = onlyCall(calls);
    expect([call.module, call.method]).toEqual(["Deal", "addDeal"]);
    // A scalar company_id answers 420 upstream (probe evidence 6).
    expect(call.params).toStrictEqual({
      deal: { name: "Synthetic Deal One", company: { id: "company-synthetic-101" } },
    });
    expect(keyNames(call.params)).not.toContain("company_id");
  });

  test("createDeal links a contact as a nested object", async () => {
    const { writes, calls } = writeFetchersFor(CREATE_ECHOES);

    await writes.createDeal({
      name: "Synthetic Deal Two",
      contactId: "person-synthetic-001",
    });

    expect(onlyCall(calls).params).toStrictEqual({
      deal: { name: "Synthetic Deal Two", contact: { id: "person-synthetic-001" } },
    });
  });

  test("createDeal sends process_id as a scalar and maps both budget line forms", async () => {
    const { writes, calls } = writeFetchersFor(CREATE_ECHOES);

    await writes.createDeal({
      name: "Synthetic Deal Three",
      companyId: "company-synthetic-101",
      processId: "process-synthetic-501",
      budget: [
        { productId: "product-synthetic-701", price: 111, amount: 3 },
        { productName: "Synthetic custom line", price: 200, amount: 2 },
      ],
    });

    const call = onlyCall(calls);
    expect(call.params).toStrictEqual({
      deal: {
        name: "Synthetic Deal Three",
        company: { id: "company-synthetic-101" },
        // `process: {id}` is ignored upstream; only the scalar selects the
        // pipeline process (probe evidence 6).
        process_id: "process-synthetic-501",
        budget: [
          { product_id: "product-synthetic-701", price: 111, amount: 3 },
          { product_name: "Synthetic custom line", price: 200, amount: 2 },
        ],
      },
    });
    expect(keyNames(call.params)).not.toContain("process");
    expect(keyNames(call.params)).not.toContain("value");
  });

  test("createTask passes both date forms through the scalar date key", async () => {
    const timed = writeFetchersFor(CREATE_ECHOES);
    const created = await timed.writes.createTask({
      title: "Synthetic Task One",
      date: "2026-09-20 10:00:00",
      description: "Synthetic task description",
    });
    expect(created).toEqual({ id: "task-synthetic-801" });
    const call = onlyCall(timed.calls);
    expect([call.module, call.method]).toEqual(["Todo", "addTodo"]);
    expect(call.params).toStrictEqual({
      todo: {
        title: "Synthetic Task One",
        date: "2026-09-20 10:00:00",
        description: "Synthetic task description",
      },
    });

    const allDay = writeFetchersFor(CREATE_ECHOES);
    await allDay.writes.createTask({ title: "Synthetic Task Two", date: "2026-09-26" });
    const dayCall = onlyCall(allDay.calls);
    expect(dayCall.params).toStrictEqual({
      todo: { title: "Synthetic Task Two", date: "2026-09-26" },
    });
    // date_from/date_to/datesPeriod/date_type are echoed and dropped on write
    // (probe evidence 8), so they are never sent.
    for (const key of ["date_from", "date_to", "datesPeriod", "date_type"]) {
      expect(keyNames(dayCall.params)).not.toContain(key);
    }
  });

  test("task links are not sent at all - `objects` does not persist", async () => {
    const { writes, calls } = writeFetchersFor(CREATE_ECHOES);

    await writes.createTask({ title: "Synthetic Task Three" });

    expect(keyNames(onlyCall(calls).params)).not.toContain("objects");
  });
});

describe("update payloads", () => {
  const UPDATE_ECHOES: Record<string, unknown> = {
    "Contact/editContact": { contact: { id: "person-synthetic-001" } },
    "Contact/editCompany": { company: { id: "company-synthetic-101" } },
    "Deal/editDeal": { deal: { id: "deal-synthetic-401" } },
    "Todo/editTodo": { todo: { id: "task-synthetic-801" } },
  };

  test("updatePerson sends the id and only the provided fields", async () => {
    const { writes, calls } = writeFetchersFor(UPDATE_ECHOES);

    await writes.updatePerson({ id: "person-synthetic-001", firstname: "Synthetic" });

    const call = onlyCall(calls);
    expect([call.module, call.method]).toEqual(["Contact", "editContact"]);
    // Edits MERGE upstream (probe evidence 4), so an unsent field is left alone
    // rather than blanked.
    expect(call.params).toStrictEqual({
      contact: { id: "person-synthetic-001", firstname: "Synthetic" },
    });
  });

  test("updatePerson keeps the arrays and the nested company link", async () => {
    const { writes, calls } = writeFetchersFor(UPDATE_ECHOES);

    await writes.updatePerson({
      id: "person-synthetic-001",
      emails: ["person.one@synthetic.example"],
      phones: ["+00 000 000 001"],
      note: "Synthetic note text",
      companyId: "company-synthetic-102",
    });

    expect(onlyCall(calls).params).toStrictEqual({
      contact: {
        id: "person-synthetic-001",
        emails: ["person.one@synthetic.example"],
        phones: ["+00 000 000 001"],
        note: "Synthetic note text",
        company: { id: "company-synthetic-102" },
      },
    });
  });

  test("updateCompany sends the id and only the provided fields", async () => {
    const { writes, calls } = writeFetchersFor(UPDATE_ECHOES);

    await writes.updateCompany({ id: "company-synthetic-101", nip: "0000000001" });

    const call = onlyCall(calls);
    expect([call.module, call.method]).toEqual(["Contact", "editCompany"]);
    expect(call.params).toStrictEqual({
      company: { id: "company-synthetic-101", nip: "0000000001" },
    });
  });

  test("updateDeal carries name and status only", async () => {
    const { writes, calls } = writeFetchersFor(UPDATE_ECHOES);

    await writes.updateDeal({ id: "deal-synthetic-401", status: "won" });

    const call = onlyCall(calls);
    expect([call.module, call.method]).toEqual(["Deal", "editDeal"]);
    expect(call.params).toStrictEqual({
      deal: { id: "deal-synthetic-401", status: "won" },
    });
  });

  test("updateTask maps isCompleted to the stringly-typed upstream flag", async () => {
    const done = writeFetchersFor(UPDATE_ECHOES);
    await done.writes.updateTask({ id: "task-synthetic-801", isCompleted: true });
    expect(onlyCall(done.calls).params).toStrictEqual({
      todo: { id: "task-synthetic-801", is_completed: "1" },
    });

    const open = writeFetchersFor(UPDATE_ECHOES);
    await open.writes.updateTask({ id: "task-synthetic-801", isCompleted: false });
    const call = onlyCall(open.calls);
    expect([call.module, call.method]).toEqual(["Todo", "editTodo"]);
    expect(call.params).toStrictEqual({
      todo: { id: "task-synthetic-801", is_completed: "0" },
    });
  });

  test("updateTask sends title, date and description untouched", async () => {
    const { writes, calls } = writeFetchersFor(UPDATE_ECHOES);

    await writes.updateTask({
      id: "task-synthetic-801",
      title: "Synthetic Task One",
      date: "2026-09-26",
      description: "Synthetic task description",
    });

    expect(onlyCall(calls).params).toStrictEqual({
      todo: {
        id: "task-synthetic-801",
        title: "Synthetic Task One",
        date: "2026-09-26",
        description: "Synthetic task description",
      },
    });
  });
});

describe("notes and calls", () => {
  interface NoteCase {
    kind: "person" | "company" | "deal";
    id: string;
    module: string;
    method: string;
    params: Record<string, unknown>;
  }

  const noteCases: NoteCase[] = [
    {
      kind: "person",
      id: "person-synthetic-001",
      module: "Contact",
      method: "addContactNote",
      params: { contact: { id: "person-synthetic-001", note: "Synthetic note text" } },
    },
    {
      // A company id sent to addContactNote answers 420 (probe evidence 15).
      kind: "company",
      id: "company-synthetic-101",
      module: "Contact",
      method: "addCompanyNote",
      params: { company: { id: "company-synthetic-101", note: "Synthetic note text" } },
    },
    {
      kind: "deal",
      id: "deal-synthetic-401",
      module: "Deal",
      method: "addDealNote",
      params: { deal: { id: "deal-synthetic-401", note: "Synthetic note text" } },
    },
  ];

  for (const noteCase of noteCases) {
    test(`addNote routes ${noteCase.kind} notes to ${noteCase.module}/${noteCase.method}`, async () => {
      const { writes, calls } = writeFetchersFor({
        [`${noteCase.module}/${noteCase.method}`]: {
          wall_item_id: "wallitem-synthetic-011",
        },
      });

      const result = await writes.addNote(
        noteCase.kind,
        noteCase.id,
        "Synthetic note text",
      );

      expect(result).toEqual({ wallItemId: "wallitem-synthetic-011" });
      const call = onlyCall(calls);
      expect([call.module, call.method]).toEqual([noteCase.module, noteCase.method]);
      expect(call.params).toStrictEqual(noteCase.params);
      expect(call.opts.write).toBe(true);
      // Note visibility is not controllable upstream (probe evidence 9), so no
      // access flag is invented here.
      for (const key of ["access", "is_public", "visibility", "_wall"]) {
        expect(keyNames(call.params)).not.toContain(key);
      }
    });
  }

  test("an echo without a wall item id reports null instead of failing", async () => {
    const { writes } = writeFetchersFor({ "Deal/addDealNote": { deal: { id: "x" } } });

    expect(await writes.addNote("deal", "deal-synthetic-401", "Synthetic")).toEqual({
      wallItemId: null,
    });
  });

  test("addCall maps the full call payload for both directions", async () => {
    const outgoing = writeFetchersFor({ "Contact/addContactCall": {} });
    await outgoing.writes.addCall("person-synthetic-001", {
      phone: "+00 000 000 001",
      direction: "outgoing",
      note: "Synthetic call note",
      date: "2026-09-20 10:00:00",
    });
    const call = onlyCall(outgoing.calls);
    expect([call.module, call.method]).toEqual(["Contact", "addContactCall"]);
    expect(call.params).toStrictEqual({
      contact: {
        id: "person-synthetic-001",
        phone: "+00 000 000 001",
        direction: "outgoing",
        note: "Synthetic call note",
        // The date PERSISTS on calls (probe evidence 1, probe 12e).
        date: "2026-09-20 10:00:00",
      },
    });

    const incoming = writeFetchersFor({ "Contact/addContactCall": {} });
    await incoming.writes.addCall("person-synthetic-002", {
      phone: "+00 000 000 002",
      direction: "incoming",
    });
    expect(onlyCall(incoming.calls).params).toStrictEqual({
      contact: {
        id: "person-synthetic-002",
        phone: "+00 000 000 002",
        direction: "incoming",
      },
    });
  });
});

describe("write flag, signal and endpoint table", () => {
  interface MethodCase {
    method: keyof WriteFetchers;
    responses: Record<string, unknown>;
    run: (writes: WriteFetchers, signal: AbortSignal) => Promise<unknown>;
    module: string;
    upstream: string;
    write: boolean;
  }

  const cases: MethodCase[] = [
    {
      method: "createPerson",
      responses: CREATE_ECHOES,
      run: (writes, signal) => writes.createPerson({ firstname: "Synthetic" }, { signal }),
      module: "Contact",
      upstream: "addContact",
      write: true,
    },
    {
      method: "createCompany",
      responses: CREATE_ECHOES,
      run: (writes, signal) =>
        writes.createCompany({ name: "Synthetic Company Alpha" }, { signal }),
      module: "Contact",
      upstream: "addCompany",
      write: true,
    },
    {
      method: "createDeal",
      responses: CREATE_ECHOES,
      run: (writes, signal) =>
        writes.createDeal(
          { name: "Synthetic Deal One", companyId: "company-synthetic-101" },
          { signal },
        ),
      module: "Deal",
      upstream: "addDeal",
      write: true,
    },
    {
      method: "createTask",
      responses: CREATE_ECHOES,
      run: (writes, signal) =>
        writes.createTask({ title: "Synthetic Task One" }, { signal }),
      module: "Todo",
      upstream: "addTodo",
      write: true,
    },
    {
      method: "updatePerson",
      responses: { "Contact/editContact": { contact: { id: "person-synthetic-001" } } },
      run: (writes, signal) =>
        writes.updatePerson(
          { id: "person-synthetic-001", firstname: "Synthetic" },
          { signal },
        ),
      module: "Contact",
      upstream: "editContact",
      write: true,
    },
    {
      method: "updateCompany",
      responses: { "Contact/editCompany": {} },
      run: (writes, signal) =>
        writes.updateCompany({ id: "company-synthetic-101", nip: "0000000001" }, { signal }),
      module: "Contact",
      upstream: "editCompany",
      write: true,
    },
    {
      method: "updateDeal",
      responses: { "Deal/editDeal": {} },
      run: (writes, signal) =>
        writes.updateDeal({ id: "deal-synthetic-401", status: "lost" }, { signal }),
      module: "Deal",
      upstream: "editDeal",
      write: true,
    },
    {
      method: "updateTask",
      responses: { "Todo/editTodo": {} },
      run: (writes, signal) =>
        writes.updateTask({ id: "task-synthetic-801", isCompleted: true }, { signal }),
      module: "Todo",
      upstream: "editTodo",
      write: true,
    },
    {
      method: "addNote",
      responses: { "Contact/addContactNote": { wall_item_id: "wallitem-synthetic-011" } },
      run: (writes, signal) =>
        writes.addNote("person", "person-synthetic-001", "Synthetic note text", {
          signal,
        }),
      module: "Contact",
      upstream: "addContactNote",
      write: true,
    },
    {
      method: "addCall",
      responses: { "Contact/addContactCall": {} },
      run: (writes, signal) =>
        writes.addCall(
          "person-synthetic-001",
          { phone: "+00 000 000 001", direction: "outgoing" },
          { signal },
        ),
      module: "Contact",
      upstream: "addContactCall",
      write: true,
    },
    {
      method: "findPersonByEmail",
      responses: { "Contact/getAll": { contact: [] } },
      run: (writes, signal) =>
        writes.findPersonByEmail("person.one@synthetic.example", { signal }),
      module: "Contact",
      upstream: "getAll",
      write: false,
    },
    {
      method: "findCompanyByName",
      responses: { "Contact/getAll": { company: [] } },
      run: (writes, signal) =>
        writes.findCompanyByName("Synthetic Company Alpha", { signal }),
      module: "Contact",
      upstream: "getAll",
      write: false,
    },
  ];

  for (const methodCase of cases) {
    test(`${methodCase.method} calls ${methodCase.module}/${methodCase.upstream} with write ${String(methodCase.write)} and the signal`, async () => {
      const { writes, calls } = writeFetchersFor(methodCase.responses);
      const signal = new AbortController().signal;

      await methodCase.run(writes, signal);

      const call = onlyCall(calls);
      expect([call.module, call.method]).toEqual([
        methodCase.module,
        methodCase.upstream,
      ]);
      // A write is dispatched exactly once and never auto-retried; a lookup is
      // an ordinary read (docs/security.md par. 5).
      if (methodCase.write) expect(call.opts.write).toBe(true);
      else expect(call.opts.write).not.toBe(true);
      expect(call.opts.signal).toBe(signal);
      expect(keyNames(call.params)).not.toContain("_wall");
    });
  }

  test("the table covers every fetcher method", () => {
    const { writes } = writeFetchersFor({});
    expect(new Set(cases.map((entry) => entry.method))).toEqual(
      new Set(Object.keys(writes) as Array<keyof WriteFetchers>),
    );
  });
});

describe("dedupe lookups", () => {
  test("findPersonByEmail normalizes the address before the exact filter", async () => {
    const { writes, calls } = writeFetchersFor({
      "Contact/getAll": {
        contact: [{ id: "person-synthetic-001", name: "Synthetic Person One" }],
      },
    });

    const hit = await writes.findPersonByEmail("  Person.One@Synthetic.Example  ");

    expect(hit).toEqual({ id: "person-synthetic-001", name: "Synthetic Person One" });
    const call = onlyCall(calls);
    expect([call.module, call.method]).toEqual(["Contact", "getAll"]);
    // The filter is exact and case-insensitive upstream (probe evidence 10);
    // trimming and lowercasing here keeps the batch-local compare aligned.
    expect(call.params).toStrictEqual({
      type: "contact",
      emails: "person.one@synthetic.example",
      limit: 2,
    });
  });

  test("findPersonByEmail reports null on an empty page", async () => {
    const { writes } = writeFetchersFor({ "Contact/getAll": { contact: [] } });

    expect(await writes.findPersonByEmail("nobody@synthetic.example")).toBeNull();
  });

  test("findPersonByEmail skips idless rows", async () => {
    const { writes } = writeFetchersFor({
      "Contact/getAll": {
        contact: [{ name: "row without an id" }, { id: "person-synthetic-002", name: "Two" }],
      },
    });

    expect(await writes.findPersonByEmail("person.two@synthetic.example")).toEqual({
      id: "person-synthetic-002",
      name: "Two",
    });
  });

  test("findCompanyByName finds the exact name anywhere on the like page", async () => {
    // Row 12 of 25: like-page ordering is UNVERIFIED, so the compare must not
    // depend on the hit being first.
    const rows = Array.from({ length: 25 }, (_, index) => ({
      id: `company-synthetic-${String(index).padStart(3, "0")}`,
      name: `Synthetic Company Alpha ${index}`,
    }));
    rows[11] = { id: "company-synthetic-101", name: "Synthetic Company Alpha" };
    const { writes, calls } = writeFetchersFor({ "Contact/getAll": { company: rows } });

    const hit = await writes.findCompanyByName("  synthetic company alpha ");

    expect(hit).toEqual({ id: "company-synthetic-101", name: "Synthetic Company Alpha" });
    expect(onlyCall(calls).params).toStrictEqual({
      type: "company",
      names: "synthetic company alpha",
      condition: "like",
      limit: 25,
    });
  });

  test("findCompanyByName rejects a like hit that is not the same name", async () => {
    const { writes } = writeFetchersFor({
      "Contact/getAll": {
        company: [
          { id: "company-synthetic-102", name: "Synthetic Company Alpha Holding" },
        ],
      },
    });

    expect(await writes.findCompanyByName("Synthetic Company Alpha")).toBeNull();
  });
});

describe("echo parsing", () => {
  const idless: Array<[string, string, (writes: WriteFetchers) => Promise<unknown>]> = [
    ["createPerson", "Contact/addContact", (writes) => writes.createPerson({ firstname: "S" })],
    ["createCompany", "Contact/addCompany", (writes) => writes.createCompany({ name: "S" })],
    [
      "createDeal",
      "Deal/addDeal",
      (writes) => writes.createDeal({ name: "S", companyId: "company-synthetic-101" }),
    ],
    ["createTask", "Todo/addTodo", (writes) => writes.createTask({ title: "S" })],
  ];

  for (const [name, endpoint, run] of idless) {
    test(`${name} fails loudly when the echo carries no id`, async () => {
      const { writes } = writeFetchersFor({ [endpoint]: { ok: true } });

      const error = await rejection(run(writes));

      expect(error).toBeInstanceOf(LivespaceError);
      expect((error as LivespaceError).code).toBe("UPSTREAM_ERROR");
      expect((error as LivespaceError).message).toBe(UNEXPECTED_SHAPE);
    });
  }

  test("an unwrapped echo is accepted too", async () => {
    const { writes } = writeFetchersFor({ "Todo/addTodo": { id: 802, title: "S" } });

    expect(await writes.createTask({ title: "S" })).toEqual({ id: "802" });
  });
});

describe("verifyApplied", () => {
  test("a failed re-read reports nothing as unapplied and nothing as verified", () => {
    // A null re-read never turns an applied write into an error: the item stays
    // ok and reports verification "unavailable" instead.
    expect(verifyApplied("person", { emails: ["a@synthetic.example"] }, null)).toEqual({
      unappliedFields: [],
      comparedFields: [],
      verified: false,
    });
  });

  test("emails compare as a set, case-insensitively, after trimming", () => {
    expect(
      verifyApplied(
        "person",
        { emails: ["  Jan@Synthetic.example "] },
        person({ emails: ["jan@synthetic.example"] }),
      ),
    ).toEqual({ unappliedFields: [], comparedFields: ["emails"], verified: true });
  });

  test("a dropped email is reported by name", () => {
    expect(
      verifyApplied(
        "person",
        { emails: ["jan@synthetic.example", "second@synthetic.example"] },
        person({ emails: ["jan@synthetic.example"] }),
      ),
    ).toEqual({ unappliedFields: ["emails"], comparedFields: ["emails"], verified: true });
  });

  test("phones compare digits-only - upstream may strip the separators", () => {
    expect(
      verifyApplied(
        "person",
        { phones: ["+48 123 456 789"] },
        person({ phones: ["+48123456789"] }),
      ),
    ).toEqual({ unappliedFields: [], comparedFields: ["phones"], verified: true });
    expect(
      verifyApplied("person", { phones: ["+48 123 456 789"] }, person({ phones: [] }))
        .unappliedFields,
    ).toEqual(["phones"]);
  });

  test("a dropped scalar note is reported, and the comparison still counts as run", () => {
    expect(verifyApplied("person", { note: "Synthetic note text" }, person({ note: "" }))).toEqual(
      { unappliedFields: ["note"], comparedFields: ["note"], verified: true },
    );
  });

  test("the person company link compares against the mapped companyId", () => {
    expect(
      verifyApplied(
        "person",
        { companyId: "company-synthetic-101" },
        person({ companyId: "company-synthetic-101" }),
      ).unappliedFields,
    ).toEqual([]);
    expect(
      verifyApplied("person", { companyId: "company-synthetic-101" }, person({ companyId: null }))
        .unappliedFields,
    ).toEqual(["companyId"]);
  });

  test("company scalars compare trimmed-exact", () => {
    expect(
      verifyApplied(
        "company",
        { name: " Synthetic Company Alpha ", nip: "0000000000" },
        company(),
      ).unappliedFields,
    ).toEqual([]);
    expect(
      verifyApplied("company", { nip: "0000000001" }, company()).unappliedFields,
    ).toEqual(["nip"]);
  });

  test("a deal budget compares its sum against the upstream-computed value", () => {
    // Deal value is computed from the budget lines only (probe evidence 5), so
    // the sum is what the write can be checked against - within 0.01.
    expect(
      verifyApplied(
        "deal",
        { budget: [{ productName: "Synthetic line", price: 33.33, amount: 3 }] },
        deal({ value: 99.99 }),
      ),
    ).toEqual({ unappliedFields: [], comparedFields: ["budget"], verified: true });
    expect(
      verifyApplied(
        "deal",
        { budget: [{ productId: "product-synthetic-701", price: 111, amount: 3 }] },
        deal({ value: null }),
      ).unappliedFields,
    ).toEqual(["budget"]);
  });

  test("a deal status change compares against the mapped status", () => {
    expect(
      verifyApplied("deal", { status: "won" }, deal({ status: "won" })).unappliedFields,
    ).toEqual([]);
    expect(
      verifyApplied("deal", { status: "won" }, deal({ status: "open" })).unappliedFields,
    ).toEqual(["status"]);
  });

  test("booleans compare normalized, whichever spelling upstream used", () => {
    const stored = mapTask({ id: "task-synthetic-801", is_completed: "1" });
    expect(verifyApplied("task", { isCompleted: true }, stored).unappliedFields).toEqual([]);
    expect(verifyApplied("task", { isCompleted: false }, stored).unappliedFields).toEqual([
      "isCompleted",
    ]);
  });

  test("a date-only task date compares against the stored midnight timestamp", () => {
    expect(
      verifyApplied("task", { date: "2026-09-26" }, task({ dateFrom: "2026-09-26 00:00:00" }))
        .unappliedFields,
    ).toEqual([]);
    // Upstream timestamps carry a timezone suffix; only the calendar part and
    // the clock are compared.
    expect(
      verifyApplied(
        "task",
        { date: "2026-09-20 10:00" },
        task({ dateFrom: "2026-09-20 10:00:00+02" }),
      ).unappliedFields,
    ).toEqual([]);
    expect(
      verifyApplied("task", { date: "2026-09-26" }, task({ dateFrom: "" })).unappliedFields,
    ).toEqual(["date"]);
  });

  test("several sent fields report in the order they were sent", () => {
    expect(
      verifyApplied(
        "task",
        { title: "Synthetic Task One", description: "kept", isCompleted: true },
        task({ title: "Synthetic Task Two", description: "kept", isCompleted: false }),
      ).unappliedFields,
    ).toEqual(["title", "isCompleted"]);
  });

  test("fields the mapped record cannot speak about are left out of the verdict", () => {
    // The mapped person carries the composed `name` only, so firstname and
    // lastname have no stored counterpart to compare with. Reporting them as
    // unapplied would be a lie; the item still reports before -> after.
    // `comparedFields` is empty, which is how a caller tells "everything
    // landed" apart from "nothing was ever compared".
    expect(
      verifyApplied("person", { firstname: "Synthetic", lastname: "Person" }, person()),
    ).toEqual({ unappliedFields: [], comparedFields: [], verified: true });
  });

  test("comparedFields names the sent fields a comparator actually ran on", () => {
    // firstname has no comparator, emails and note do; an undefined value is
    // not a sent field at all.
    expect(
      verifyApplied(
        "person",
        {
          firstname: "Synthetic",
          emails: ["person.one@synthetic.example"],
          note: "Synthetic other note",
          companyId: undefined,
        },
        person(),
      ),
    ).toEqual({
      unappliedFields: ["note"],
      comparedFields: ["emails", "note"],
      verified: true,
    });
  });
});
