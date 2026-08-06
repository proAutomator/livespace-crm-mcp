import type { LivespaceClient } from "./client.js";
import type { LivespaceError } from "./errors.js";
import { parseCommaDecimal, type RecordDataMap, type RecordKind } from "./records.js";
import { asName, asRecord, unexpectedShape, unwrapList } from "./shape.js";

/**
 * Typed write fetchers plus the post-write verifier.
 *
 * Four rules shape this module, all of them bought with live probes on a
 * sandbox account (2026-08-06, recorded in the M6 plan doc):
 *
 * 1. **The echo lies.** Every write endpoint answers with a copy of the input
 *    plus a generated id, whatever it actually stored: a scalar `email` on
 *    addContact comes straight back and persists NOTHING. So the id is all the
 *    response is trusted for, and `verifyApplied` compares what was sent with
 *    what a re-read actually holds.
 * 2. **Payloads are wrapped and shaped.** `{contact: {...}}`, `{company: {...}}`,
 *    `{deal: {...}}`, `{todo: {...}}`; contact channels are STRING ARRAYS; a
 *    person's company link and a deal's company/contact link are nested
 *    `{id}` objects; a deal's process is the SCALAR `process_id`; a task's date
 *    is the scalar `date`. Anything else is silently accepted and dropped.
 * 3. **Writes never suppress the CRM feed.** No `_wall` parameter is sent
 *    anywhere: the feed entry is the operator's audit trail of what the agent
 *    did, and hiding it would be the wrong default even if it worked.
 * 4. **Every write is dispatched once.** `{write: true}` tells the client that
 *    a mid-flight failure is WRITE_OUTCOME_UNKNOWN rather than something to
 *    retry (docs/security.md par. 5). The two dedupe lookups are plain reads.
 *
 * Deletes exist upstream and are deliberately absent here (par. 5: no delete,
 * no merge). Nothing is cached - record data is never cached (par. 8), so this
 * module must never import the server cache.
 */

export type NoteTargetKind = "person" | "company" | "deal";

export type CallDirection = "incoming" | "outgoing";

export type DealStatus = "open" | "won" | "lost";

export interface WriteCallOptions {
  signal?: AbortSignal;
}

export interface PersonWrite {
  firstname: string;
  lastname?: string;
  emails?: string[];
  phones?: string[];
  note?: string;
  companyId?: string;
}

export interface CompanyWrite {
  name: string;
  nip?: string;
}

/** Exactly one of `productId` (catalog line) or `productName` (custom line). */
export interface BudgetLineWrite {
  productId?: string;
  productName?: string;
  price: number;
  amount: number;
}

export interface DealWrite {
  name: string;
  companyId?: string;
  contactId?: string;
  processId?: string;
  /**
   * A deal's value is computed upstream from its budget lines and cannot be
   * set directly. Budget is CREATE-ONLY in v1: the append-vs-replace semantics
   * of a budget edit were never probed.
   */
  budget?: BudgetLineWrite[];
}

export interface TaskWrite {
  title: string;
  /** "YYYY-MM-DD" (stored as midnight, all-day) or "YYYY-MM-DD HH:MM:SS". */
  date?: string;
  description?: string;
}

export interface PersonUpdate {
  id: string;
  firstname?: string;
  lastname?: string;
  emails?: string[];
  phones?: string[];
  note?: string;
  companyId?: string;
}

export interface CompanyUpdate {
  id: string;
  name?: string;
  nip?: string;
}

/** Deal updates are name and status only in v1 - stages and budget are out. */
export interface DealUpdate {
  id: string;
  name?: string;
  status?: DealStatus;
}

export interface TaskUpdate {
  id: string;
  title?: string;
  date?: string;
  description?: string;
  isCompleted?: boolean;
}

export interface CallWrite {
  phone: string;
  direction: CallDirection;
  note?: string;
  date?: string;
}

export interface CreatedRecord {
  id: string;
}

export interface RecordPointer {
  id: string;
  name: string;
}

export interface WriteFetchers {
  createPerson(input: PersonWrite, opts?: WriteCallOptions): Promise<CreatedRecord>;
  createCompany(input: CompanyWrite, opts?: WriteCallOptions): Promise<CreatedRecord>;
  createDeal(input: DealWrite, opts?: WriteCallOptions): Promise<CreatedRecord>;
  createTask(input: TaskWrite, opts?: WriteCallOptions): Promise<CreatedRecord>;
  updatePerson(input: PersonUpdate, opts?: WriteCallOptions): Promise<void>;
  updateCompany(input: CompanyUpdate, opts?: WriteCallOptions): Promise<void>;
  updateDeal(input: DealUpdate, opts?: WriteCallOptions): Promise<void>;
  updateTask(input: TaskUpdate, opts?: WriteCallOptions): Promise<void>;
  addNote(
    kind: NoteTargetKind,
    id: string,
    note: string,
    opts?: WriteCallOptions,
  ): Promise<{ wallItemId: string | null }>;
  addCall(personId: string, input: CallWrite, opts?: WriteCallOptions): Promise<void>;
  findPersonByEmail(
    email: string,
    opts?: WriteCallOptions,
  ): Promise<RecordPointer | null>;
  findCompanyByName(
    name: string,
    opts?: WriteCallOptions,
  ): Promise<RecordPointer | null>;
}

/** Every shape failure in this module speaks about a write. */
function badShape(): LivespaceError {
  return unexpectedShape("write");
}

function put(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) target[key] = value;
}

function readId(value: unknown): string | null {
  if (value === null || value === undefined || typeof value === "object") return null;
  const id = String(value);
  return id === "" ? null : id;
}

/** The echo comes wrapped under the payload key, but bare shapes are accepted. */
function echoBody(payload: unknown, key: string): Record<string, unknown> | null {
  const data = asRecord(payload);
  if (data === null) return null;
  return asRecord(data[key]) ?? data;
}

function echoId(payload: unknown, key: string): string {
  const id = readId(echoBody(payload, key)?.["id"]);
  if (id === null) throw badShape();
  return id;
}

function personFields(input: PersonWrite | PersonUpdate): Record<string, unknown> {
  const contact: Record<string, unknown> = {};
  put(contact, "firstname", input.firstname);
  put(contact, "lastname", input.lastname);
  // String arrays. The scalar `email`/`phone` keys are echoed and stored
  // nowhere, so they are never sent.
  put(contact, "emails", input.emails);
  put(contact, "phones", input.phones);
  put(contact, "note", input.note);
  if (input.companyId !== undefined) contact["company"] = { id: input.companyId };
  return contact;
}

function companyFields(input: CompanyWrite | CompanyUpdate): Record<string, unknown> {
  const company: Record<string, unknown> = {};
  put(company, "name", input.name);
  put(company, "nip", input.nip);
  return company;
}

function budgetLine(line: BudgetLineWrite): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  put(mapped, "product_id", line.productId);
  put(mapped, "product_name", line.productName);
  mapped["price"] = line.price;
  mapped["amount"] = line.amount;
  return mapped;
}

function taskFields(input: TaskWrite | TaskUpdate): Record<string, unknown> {
  const todo: Record<string, unknown> = {};
  put(todo, "title", input.title);
  // The scalar `date` is the only date key that persists; `date_from`,
  // `date_to`, `datesPeriod` and `date_type` are accepted and dropped.
  put(todo, "date", input.date);
  put(todo, "description", input.description);
  const completed = "isCompleted" in input ? input.isCompleted : undefined;
  if (completed !== undefined) todo["is_completed"] = completed ? "1" : "0";
  return todo;
}

const NOTE_ENDPOINTS: Record<
  NoteTargetKind,
  { module: string; method: string; key: string }
> = {
  person: { module: "Contact", method: "addContactNote", key: "contact" },
  // A company id sent to addContactNote answers 420 (probe evidence 15).
  company: { module: "Contact", method: "addCompanyNote", key: "company" },
  deal: { module: "Deal", method: "addDealNote", key: "deal" },
};

/**
 * The dedupe verdict is the FIRST hit, so one row would answer it. The window
 * is two: a filter that quietly stopped being exact then comes back as a
 * two-row page instead of being truncated into a convincing single match.
 */
const EMAIL_LOOKUP_LIMIT = 2;

/**
 * Company names have no exact filter - only `condition: "like"` - so the page
 * is scanned locally. A name sharing its prefix with more than this many rows
 * can still hide behind them (documented caveat); like-page ordering is
 * unverified, so the scan never assumes the hit comes first.
 */
const COMPANY_LOOKUP_LIMIT = 25;

function rowPointer(row: unknown): RecordPointer | null {
  const data = asRecord(row);
  if (data === null) return null;
  const id = readId(data["id"]);
  if (id === null) return null;
  return { id, name: asName(data["name"]) };
}

export function createWriteFetchers(
  client: Pick<LivespaceClient, "call">,
): WriteFetchers {
  // One dispatch, no auto-retry, no `_wall`.
  const write = (
    module: string,
    method: string,
    params: Record<string, unknown>,
    opts?: WriteCallOptions,
  ): Promise<unknown> =>
    client.call(module, method, params, { write: true, signal: opts?.signal });

  // Dedupe lookups are ordinary reads: they change nothing and may retry.
  const read = (
    module: string,
    method: string,
    params: Record<string, unknown>,
    opts?: WriteCallOptions,
  ): Promise<unknown> => client.call(module, method, params, { signal: opts?.signal });

  return {
    createPerson: async (input, opts) => ({
      id: echoId(
        await write("Contact", "addContact", { contact: personFields(input) }, opts),
        "contact",
      ),
    }),

    createCompany: async (input, opts) => ({
      id: echoId(
        await write("Contact", "addCompany", { company: companyFields(input) }, opts),
        "company",
      ),
    }),

    createDeal: async (input, opts) => {
      const deal: Record<string, unknown> = { name: input.name };
      // A deal needs a company or a contact, nested: a scalar company_id is a
      // 420 (probe evidence 6). Which one it is, is the runner's business.
      if (input.companyId !== undefined) deal["company"] = { id: input.companyId };
      if (input.contactId !== undefined) deal["contact"] = { id: input.contactId };
      put(deal, "process_id", input.processId);
      if (input.budget !== undefined) deal["budget"] = input.budget.map(budgetLine);
      return { id: echoId(await write("Deal", "addDeal", { deal }, opts), "deal") };
    },

    createTask: async (input, opts) => ({
      id: echoId(await write("Todo", "addTodo", { todo: taskFields(input) }, opts), "todo"),
    }),

    // Updates MERGE upstream, so an unsent field is left alone rather than
    // blanked - only what the caller named travels.
    updatePerson: async (input, opts) => {
      const contact = { id: input.id, ...personFields(input) };
      await write("Contact", "editContact", { contact }, opts);
    },

    updateCompany: async (input, opts) => {
      const company = { id: input.id, ...companyFields(input) };
      await write("Contact", "editCompany", { company }, opts);
    },

    updateDeal: async (input, opts) => {
      const deal: Record<string, unknown> = { id: input.id };
      put(deal, "name", input.name);
      put(deal, "status", input.status);
      await write("Deal", "editDeal", { deal }, opts);
    },

    updateTask: async (input, opts) => {
      const todo = { id: input.id, ...taskFields(input) };
      await write("Todo", "editTodo", { todo }, opts);
    },

    addNote: async (kind, id, note, opts) => {
      const endpoint = NOTE_ENDPOINTS[kind];
      const payload = await write(
        endpoint.module,
        endpoint.method,
        // Notes are public-only: `access`, `is_public` and `visibility` are all
        // ignored upstream, so none of them is invented here.
        { [endpoint.key]: { id, note } },
        opts,
      );
      return { wallItemId: readId(echoBody(payload, endpoint.key)?.["wall_item_id"]) };
    },

    addCall: async (personId, input, opts) => {
      const contact: Record<string, unknown> = {
        id: personId,
        phone: input.phone,
        direction: input.direction,
      };
      put(contact, "note", input.note);
      // Unlike a task's dates, a call's date persists as sent.
      put(contact, "date", input.date);
      await write("Contact", "addContactCall", { contact }, opts);
    },

    findPersonByEmail: async (email, opts) => {
      const normalized = email.trim().toLowerCase();
      const payload = await read(
        "Contact",
        "getAll",
        { type: "contact", emails: normalized, limit: EMAIL_LOOKUP_LIMIT },
        opts,
      );
      for (const row of unwrapList(payload, ["contact"], badShape)) {
        const pointer = rowPointer(row);
        if (pointer !== null) return pointer;
      }
      return null;
    },

    findCompanyByName: async (name, opts) => {
      const wanted = name.trim();
      if (wanted === "") return null;
      const payload = await read(
        "Contact",
        "getAll",
        {
          type: "company",
          names: wanted,
          condition: "like",
          limit: COMPANY_LOOKUP_LIMIT,
        },
        opts,
      );
      const rows = unwrapList(payload, ["company", "contact"], badShape);
      const target = wanted.toLowerCase();
      for (const row of rows) {
        const pointer = rowPointer(row);
        if (pointer !== null && pointer.name.trim().toLowerCase() === target) {
          return pointer;
        }
      }
      return null;
    },
  };
}

/**
 * Post-write verification.
 *
 * `sent` is keyed by the TOOL field names, `reread` is the mapped record the
 * follow-up read returned. The verdict separates two outcomes that must never
 * be confused:
 *
 * - `verified: false` means the comparison never ran (no re-read). The item is
 *   still `ok` - a failed re-read cannot un-apply a write - and reports
 *   `verification: "unavailable"`.
 * - `verified: true` with a non-empty `unappliedFields` means the write landed
 *   but the CRM did not keep those fields.
 *
 * A field with no comparable counterpart on the mapped record - `firstname`
 * and `lastname`, which upstream composes into a single `name` - is left out of
 * the verdict entirely. Guessing at it would produce false "unapplied" reports;
 * the before/after pair still shows what changed.
 */
export interface AppliedVerdict {
  unappliedFields: string[];
  verified: boolean;
}

const NUMBER_TOLERANCE = 0.01;

function textOf(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function matchesScalar(value: unknown, stored: unknown): boolean {
  return textOf(value) === textOf(stored);
}

function matchesTextSet(
  value: unknown,
  stored: unknown,
  normalize: (text: string) => string,
): boolean {
  // Nothing comparable was sent - treated as "no claim", never as a failure.
  if (!Array.isArray(value)) return true;
  const storedValues = Array.isArray(stored) ? stored : [];
  const storedSet = new Set(storedValues.map((entry) => normalize(textOf(entry))));
  return value.every((entry) => storedSet.has(normalize(textOf(entry))));
}

function digitsOnly(text: string): string {
  return text.replace(/\D/gu, "");
}

function lowercase(text: string): string {
  return text.toLowerCase();
}

function matchesNumber(value: number, stored: unknown): boolean {
  const storedNumber =
    typeof stored === "number" ? stored : parseCommaDecimal(stored);
  return storedNumber !== null && Math.abs(value - storedNumber) <= NUMBER_TOLERANCE;
}

/** A deal's value is the sum of its budget lines, computed upstream. */
function budgetSum(value: unknown): number | null {
  if (!Array.isArray(value)) return null;
  let sum = 0;
  for (const line of value) {
    const data = asRecord(line);
    if (data === null) return null;
    const price = Number(data["price"]);
    const amount = Number(data["amount"]);
    if (!Number.isFinite(price) || !Number.isFinite(amount)) return null;
    sum += price * amount;
  }
  return sum;
}

function matchesBudget(value: unknown, stored: unknown): boolean {
  const sum = budgetSum(value);
  if (sum === null) return true;
  return matchesNumber(sum, stored);
}

function toBool(value: unknown): boolean | null {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  return null;
}

function matchesBool(value: unknown, stored: unknown): boolean {
  const sent = toBool(value);
  return sent !== null && sent === toBool(stored);
}

const TIMESTAMP_PATTERN = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2})(:\d{2})?)?/u;

/**
 * "2026-09-26" -> "2026-09-26 00:00:00", "2026-09-26 10:00" ->
 * "2026-09-26 10:00:00". Anything trailing the seconds - a timezone suffix,
 * above all - is cut: it is upstream formatting, not a different moment.
 */
export function normalizeWriteTimestamp(value: unknown): string | null {
  const match = TIMESTAMP_PATTERN.exec(textOf(value));
  if (match === null) return null;
  return `${match[1] ?? ""} ${match[2] ?? "00:00"}${match[3] ?? ":00"}`;
}

function matchesTimestamp(value: unknown, stored: unknown): boolean {
  const sent = normalizeWriteTimestamp(value);
  if (sent === null) return true;
  return normalizeWriteTimestamp(stored) === sent;
}

type FieldCheck = (value: unknown, stored: Record<string, unknown>) => boolean;

/**
 * The comparator per sent field, per kind. A field missing from its kind's
 * table is not verifiable and is skipped.
 */
const APPLIED_CHECKS: { [K in RecordKind]: Record<string, FieldCheck> } = {
  person: {
    emails: (value, stored) => matchesTextSet(value, stored["emails"], lowercase),
    // Upstream may store a number with the separators stripped.
    phones: (value, stored) => matchesTextSet(value, stored["phones"], digitsOnly),
    note: (value, stored) => matchesScalar(value, stored["note"]),
    companyId: (value, stored) => matchesScalar(value, stored["companyId"]),
  },
  company: {
    name: (value, stored) => matchesScalar(value, stored["name"]),
    nip: (value, stored) => matchesScalar(value, stored["nip"]),
  },
  deal: {
    name: (value, stored) => matchesScalar(value, stored["name"]),
    status: (value, stored) => matchesScalar(value, stored["status"]),
    budget: (value, stored) => matchesBudget(value, stored["value"]),
  },
  task: {
    title: (value, stored) => matchesScalar(value, stored["title"]),
    description: (value, stored) => matchesScalar(value, stored["description"]),
    // The write key is `date`; the record reads it back as `dateFrom`.
    date: (value, stored) => matchesTimestamp(value, stored["dateFrom"]),
    isCompleted: (value, stored) => matchesBool(value, stored["isCompleted"]),
  },
};

export function verifyApplied<K extends RecordKind>(
  kind: K,
  sent: Record<string, unknown>,
  reread: RecordDataMap[K] | null,
): AppliedVerdict {
  if (reread === null) return { unappliedFields: [], verified: false };
  const stored = reread as unknown as Record<string, unknown>;
  const checks = APPLIED_CHECKS[kind];
  const unappliedFields: string[] = [];
  for (const [field, value] of Object.entries(sent)) {
    if (value === undefined) continue;
    const check = checks[field];
    if (check === undefined) continue;
    if (!check(value, stored)) unappliedFields.push(field);
  }
  return { unappliedFields, verified: true };
}
