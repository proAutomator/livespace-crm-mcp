import { fileURLToPath } from "node:url";
import { loadLivespaceConfig } from "../src/config/env.js";
import { LivespaceError } from "../src/livespace/errors.js";
import { LivespaceV2Client } from "../src/livespace/v2/client.js";
import { MEDIA_MINIMAL } from "../src/livespace/v2/media-types.js";
import { V2_METADATA_SECTIONS } from "../src/livespace/v2/metadata.js";

// Read-only live check of API v2. Run it against a demo or sandbox account
// only, never a production CRM. It reads LIVESPACE_SUBDOMAIN and
// LIVESPACE_API_V2_KEY from the environment (Bun loads a local .env, or a
// secret manager can inject them) and runs in two parts:
//
// 1. The client alone: `GET /users/me` and one deal search (two logical
//    requests; a read may retry a transport failure).
// 2. The real server: `src/index.ts` started as a child process in read-only
//    mode on loopback, then `health` and `crm_metadata` called over HTTP, one
//    dictionary section at a time. About 35 requests. The child gets its
//    settings from this script alone: it does not load a `.env` file.
// 3. The record tools through the same server: `search_crm` (filters, counts,
//    paging, sort, dates, tasks, phrase) and `get_records` (every include).
//    About 110 more requests, half of them the `health` calls that measure
//    what each tool call cost.
//
// Output is statuses and counts only: never record content, never the key.
// This script's output may land in terminals, CI logs or transcripts.

const PROTOCOL = "2026-07-28";
const WRITE_TOOLS = [
  "create_records",
  "update_records",
  "move_deals_to_stage",
  "log_activities",
  "notify_user",
];

class SmokeFailure extends Error {}

function requestIdState(requestId: string | null): string {
  return requestId === null ? "missing" : "present";
}

function present(value: unknown): string {
  return typeof value === "string" && value !== "" ? "present" : "missing";
}

async function checkClient(): Promise<void> {
  const config = loadLivespaceConfig({
    LIVESPACE_SUBDOMAIN: process.env["LIVESPACE_SUBDOMAIN"],
    LIVESPACE_API_V2_KEY: process.env["LIVESPACE_API_V2_KEY"],
    LIVESPACE_V2_DAILY_RESERVE: process.env["LIVESPACE_V2_DAILY_RESERVE"],
  });
  const client = new LivespaceV2Client({
    subdomain: config.subdomain,
    apiKey: config.v2ApiKey,
    dailyReserve: config.dailyReserve,
  });

  // A success from the client is a 2xx; the contract lists only 200 for both.
  const me = await client.request<Record<string, unknown>>(
    { method: "GET", path: "/users/me" },
    { essential: true },
  );
  console.log(`GET /users/me: 200, requestId ${requestIdState(me.requestId)}`);

  // A search is a read sent as POST: `write: false` lets it retry.
  const deals = await client.request<unknown[]>(
    { method: "POST", path: "/deals/searches", body: { perPage: 1 }, accept: MEDIA_MINIMAL },
    { write: false },
  );
  const total = deals.extra["totalCount"];
  const rows = Array.isArray(deals.data) ? deals.data.length : "not a list";
  console.log(
    `POST /deals/searches: 200, totalCount ${typeof total === "number" ? total : "missing"}, ` +
      `rows ${rows}, requestId ${requestIdState(deals.requestId)}`,
  );
  console.log(`dailyRemaining: ${client.rateLimit().dailyRemaining ?? "unknown"}`);
}

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

/** One modern-era MCP request to the local server; SSE or plain JSON back. */
async function mcp(
  base: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const name = typeof params["name"] === "string" ? params["name"] : undefined;
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL,
      "mcp-method": method,
      ...(name === undefined ? {} : { "mcp-name": name }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": PROTOCOL,
          "io.modelcontextprotocol/clientInfo": { name: "smoke-v2", version: "0.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  let payload: unknown;
  try {
    payload = JSON.parse(dataLine === undefined ? text : dataLine.slice(6));
  } catch {
    payload = undefined;
  }
  const result = (payload as { result?: unknown } | undefined)?.result;
  if (response.status !== 200 || result === null || typeof result !== "object") {
    // The body may quote tool output, so only the status is printed.
    throw new SmokeFailure(`${method} answered HTTP ${response.status} without a result`);
  }
  return result as Record<string, unknown>;
}

async function callTool(
  base: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  return (await mcp(base, "tools/call", { name, arguments: args })) as ToolResult;
}

/** `health` with the Livespace check; returns the daily budget it reports. */
async function dailyRemaining(base: string): Promise<number | null> {
  const health = await callTool(base, "health", { checkLivespace: true });
  const livespace = health.structuredContent?.["livespace"] as
    | Record<string, unknown>
    | undefined;
  if (livespace?.["reachable"] !== true) {
    throw new SmokeFailure("health: Livespace API v2 is not reachable through the server");
  }
  const left = livespace["dailyRemaining"];
  return typeof left === "number" ? left : null;
}

type Structured = Record<string, unknown>;

function asObject(value: unknown): Structured {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Structured)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Error codes and sanitized pointers only: both are this server's wording. */
function errorCodes(errors: unknown): string {
  return asArray(errors)
    .map((raw) => {
      const error = asObject(raw);
      const fields = asArray(error["fields"]);
      const kind = typeof error["kind"] === "string" ? `${error["kind"]}: ` : "";
      const include = typeof error["include"] === "string" ? `${error["include"]}: ` : "";
      return `${kind}${include}${String(error["code"])}${fields.length > 0 ? ` at ${fields.join(" ")}` : ""}`;
    })
    .join("; ");
}

/**
 * The record tools through the server, read-only. Prints statuses and counts
 * only. Values read from the CRM (an id, a name fragment, a tag) are used as
 * arguments of the next call and never printed.
 */
async function checkRecordTools(base: string, actingResolved: boolean): Promise<void> {
  let before = await dailyRemaining(base);
  let spent = 0;
  const problems: string[] = [];

  /** One tool call plus what it cost the account's daily budget. */
  async function measured(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ out: Structured; isError: boolean; requests: number | null }> {
    const result = await callTool(base, name, args);
    const after = await dailyRemaining(base);
    const requests = before === null || after === null ? null : before - after - 1;
    before = after;
    if (requests !== null) spent += requests;
    return { out: result.structuredContent ?? {}, isError: result.isError === true, requests };
  }

  /** A filter search of one kind: prints the totals, returns the envelope. */
  async function search(
    label: string,
    kind: string,
    args: Record<string, unknown>,
    expectOk = true,
  ): Promise<Structured> {
    const { out, isError, requests } = await measured("search_crm", {
      kinds: [kind],
      ...args,
    });
    const envelope = asObject(asObject(out["results"])[kind]);
    const errors = errorCodes(out["errors"]);
    const total = envelope["totalCount"];
    console.log(
      `search_crm ${label}: ${isError ? "ERROR" : "ok"}` +
        (typeof total === "number"
          ? `, totalCount ${total}${envelope["totalCountExact"] === false ? "+" : ""}`
          : "") +
        (typeof envelope["returned"] === "number" ? `, returned ${envelope["returned"]}` : "") +
        (envelope["hasMore"] === true ? ", more" : "") +
        (errors === "" ? "" : `, ${errors}`) +
        `, requests ${requests ?? "unknown"}`,
    );
    if (expectOk && (isError || typeof total !== "number")) problems.push(label);
    return envelope;
  }

  const count = async (label: string, kind: string, filters: Structured): Promise<number> => {
    const envelope = await search(label, kind, { filters, countOnly: true });
    return typeof envelope["totalCount"] === "number" ? envelope["totalCount"] : -1;
  };

  // --- deals: totals, paging, detail, sort ---------------------------------
  const allDeals = await count("deals, every status, countOnly", "deals", { status: "all" });
  const openDeals = await count("deals, open (default), countOnly", "deals", {});
  let closed = 0;
  for (const status of ["won", "lost", "outdated"]) {
    closed += await count(`deals, ${status}, countOnly`, "deals", { status });
  }
  console.log(
    `deal statuses: open ${openDeals} + closed ${closed} = ${openDeals + closed}, every status ${allDeals}`,
  );
  if (openDeals + closed !== allDeals) problems.push("deal status counts do not add up");

  const page = await search("deals, standard, perPage 5", "deals", {
    filters: { status: "all" },
    perPage: 5,
  });
  const dealRows = asArray(page["items"]).map(asObject);
  const dealIds = dealRows.map((row) => row["id"]).filter((id): id is string => typeof id === "string");
  const second = await search("deals, page 2, perPage 5", "deals", {
    filters: { status: "all" },
    perPage: 5,
    page: 2,
  });
  const secondIds = asArray(second["items"]).map((row) => asObject(row)["id"]);
  if (allDeals > 5 && secondIds.some((id) => dealIds.includes(id as string))) {
    problems.push("page 2 repeats a record of page 1");
  }
  await search("deals, minimal, sort createdAt desc", "deals", {
    filters: { status: "all" },
    detail: "minimal",
    sort: { field: "createdAt", direction: "desc" },
    perPage: 3,
  });
  await search("deals, full, sort expectedCloseDate asc", "deals", {
    filters: {},
    detail: "full",
    sort: { field: "expectedCloseDate", direction: "asc" },
    perPage: 3,
  });

  // --- mine: refused without an acting user, never empty --------------------
  const mine = await measured("search_crm", { kinds: ["deals"], filters: { mine: true } });
  const mineErrors = errorCodes(mine.out["errors"]);
  const mineTotal = asObject(asObject(mine.out["results"])["deals"])["totalCount"];
  console.log(
    `search_crm deals, mine: ${mine.isError ? `refused (${mineErrors})` : `ok, totalCount ${String(mineTotal)}`}, ` +
      `acting user ${actingResolved ? "resolved" : "not resolved"}, requests ${mine.requests ?? "unknown"}`,
  );
  if (actingResolved ? mine.isError : !mineErrors.includes("NO_ACTING_USER")) {
    problems.push("mine");
  }
  if (actingResolved) {
    await count("tasks, mine, countOnly", "tasks", { mine: true });
  }

  // --- dates: datetime bounds in the account zone, bare days on date fields --
  const year = new Date().getUTCFullYear();
  const createdThisYear = await count("deals, created this year", "deals", {
    status: "all",
    createdFrom: `${year}-01-01`,
    createdTo: `${year}-12-31`,
  });
  const createdBefore = await count("deals, created before this year", "deals", {
    status: "all",
    createdTo: `${year - 1}-12-31`,
  });
  console.log(
    `created: this year ${createdThisYear} + before ${createdBefore} = ` +
      `${createdThisYear + createdBefore}, every status ${allDeals}`,
  );
  if (createdThisYear + createdBefore !== allDeals) {
    problems.push("created-date ranges do not add up (day bounds or time zone)");
  }
  await count("deals, updated since 1 January", "deals", {
    status: "all",
    updatedFrom: `${year}-01-01`,
  });
  await count("deals, status changed this year", "deals", {
    status: "all",
    statusChangedFrom: `${year}-01-01`,
    statusChangedTo: `${year}-12-31`,
  });
  await count("deals, expected close this year", "deals", {
    expectedCloseFrom: `${year}-01-01`,
    expectedCloseTo: `${year}-12-31`,
  });
  await count("deals, expected close from 1 January", "deals", {
    expectedCloseFrom: `${year}-01-01`,
  });

  // --- countOnly per stage of one process ------------------------------------
  const metadata = await callTool(base, "crm_metadata", {
    sections: ["processes", "tags", "customFields"],
  });
  const sections = asObject(metadata.structuredContent?.["sections"]);
  // The dictionaries are normally still cached from part 2; a new baseline
  // keeps a refetch out of the next tool call's count.
  before = await dailyRemaining(base);
  const processes = asArray(asObject(sections["processes"])["data"]).map(asObject);
  const process =
    processes.find((row) => row["isDefault"] === true && row["selectable"] === true) ??
    processes.find((row) => row["selectable"] === true);
  if (process === undefined || typeof process["id"] !== "string") {
    console.log("stages: no selectable process, skipped");
  } else {
    const processTotal = await count("deals, open in one process", "deals", {
      processId: process["id"],
    });
    const stages = asArray(process["stages"]).map(asObject).slice(0, 12);
    const perStage: number[] = [];
    for (const [index, stage] of stages.entries()) {
      perStage.push(
        await count(`deals, open in stage ${index + 1}/${stages.length}`, "deals", {
          processId: process["id"],
          stageIds: [stage["id"]],
        }),
      );
    }
    const sum = perStage.reduce((total, value) => total + Math.max(value, 0), 0);
    console.log(
      `stages: [${perStage.join(", ")}] sum ${sum}, open in the process ${processTotal} ` +
        "(compare one stage with the Livespace UI)",
    );
    if (sum > processTotal) problems.push("stage counts exceed the process total");
    const firstTwo = stages.slice(0, 2).map((stage) => stage["id"]);
    if (firstTwo.length === 2) {
      const both = await count("deals, open in stages 1 and 2 together", "deals", {
        processId: process["id"],
        stageIds: firstTwo,
      });
      if (both !== Math.max(perStage[0] ?? 0, 0) + Math.max(perStage[1] ?? 0, 0)) {
        problems.push("stageIds does not behave as any-of");
      }
    }
  }

  // --- tags, owners, links, names --------------------------------------------
  const tag = asArray(asObject(sections["tags"])["data"]).find(
    (value): value is string => typeof value === "string",
  );
  if (tag === undefined) {
    console.log("tags: the account has none, skipped");
  } else {
    for (const kind of ["deals", "persons", "companies"]) {
      await count(`${kind}, one tag`, kind, kind === "deals" ? { status: "all", tags: [tag] } : { tags: [tag] });
    }
  }
  const firstDeal = dealRows[0] ?? {};
  const owner = asObject(firstDeal["owner"])["id"];
  if (typeof owner === "string") {
    await count("deals, one owner", "deals", { status: "all", ownerIds: [owner] });
    await count("tasks, one assignee", "tasks", { ownerIds: [owner] });
  }
  const company = asObject(firstDeal["company"])["id"];
  if (typeof company === "string") {
    await count("deals of one company", "deals", { status: "all", companyId: company });
    await count("persons of one company", "persons", { companyId: company });
  }
  const dealName = typeof firstDeal["name"] === "string" ? firstDeal["name"] : "";
  const fragment = dealName.trim().slice(1, 5).trim();
  if (fragment.length >= 2) {
    const inside = await count("deals, nameContains (inside a word)", "deals", {
      status: "all",
      nameContains: fragment,
    });
    if (inside < 1) problems.push("nameContains did not find the record it was taken from");
  }

  // --- persons, companies, tasks ---------------------------------------------
  const persons = await search("persons, standard, sort name", "persons", {
    filters: {},
    sort: { field: "name", direction: "asc" },
    perPage: 3,
  });
  const companies = await search("companies, standard, sort name", "companies", {
    filters: {},
    sort: { field: "name", direction: "asc" },
    perPage: 3,
  });
  const personRows = asArray(persons["items"]).map(asObject);
  const lastName = typeof personRows[0]?.["lastName"] === "string" ? personRows[0]["lastName"] : "";
  if (lastName.trim().length >= 2) {
    const byName = await count("persons, nameContains", "persons", {
      nameContains: lastName.trim().slice(0, 4),
    });
    if (byName < 1) problems.push("persons nameContains did not find its own record");
  }
  await count("persons, created this year", "persons", { createdFrom: `${year}-01-01` });
  await count("companies, updated this year", "companies", { updatedFrom: `${year}-01-01` });

  const tasks = await search("tasks, standard, perPage 5", "tasks", { filters: {}, perPage: 5 });
  const openTasks = await count("tasks, not completed", "tasks", { completed: false });
  const doneTasks = await count("tasks, completed", "tasks", { completed: true });
  const allTasks = typeof tasks["totalCount"] === "number" ? tasks["totalCount"] : -1;
  console.log(`tasks: open ${openTasks} + done ${doneTasks} = ${openTasks + doneTasks}, all ${allTasks}`);
  if (openTasks + doneTasks !== allTasks) problems.push("task completion counts do not add up");
  await count("tasks, overdue", "tasks", { overdue: true });
  await count("tasks, due this year (bare days)", "tasks", {
    dueFrom: `${year}-01-01`,
    dueTo: `${year}-12-31`,
  });
  await count("tasks, updated this year", "tasks", { updatedFrom: `${year}-01-01` });
  if (dealIds[0] !== undefined) {
    await count("tasks linked to one deal", "tasks", { linkedTo: { kind: "deal", id: dealIds[0] } });
  }

  // --- custom fields ----------------------------------------------------------
  const customFields = asObject(asObject(sections["customFields"])["data"]);
  const filterable = (
    [
      ["persons", "person"],
      ["companies", "company"],
      ["deals", "deal"],
    ] as const
  ).flatMap(([argKind, kind]) =>
    asArray(customFields[kind])
      .map(asObject)
      .filter((field) => field["filterable"] === true && typeof field["id"] === "string")
      .slice(0, 1)
      .map((field) => ({ argKind, id: field["id"] as string, type: String(field["type"]) })),
  );
  if (filterable.length === 0) {
    console.log("custom fields: no filterable field on persons, companies or deals, skipped");
  }
  for (const field of filterable) {
    await count(`${field.argKind}, custom field isNotEmpty`, field.argKind, {
      ...(field.argKind === "deals" ? { status: "all" } : {}),
      customFields: [{ fieldId: field.id, operator: "isNotEmpty" }],
    });
  }

  // --- phrase ------------------------------------------------------------------
  const word = dealName.trim().split(/\s+/u)[0] ?? "";
  if (word.length < 2) {
    console.log("phrase: no deal name to take a word from, skipped");
  } else {
    const phrase = await measured("search_crm", {
      phrase: word.slice(0, 20),
      kinds: ["persons", "companies", "deals", "notes"],
    });
    const block = asObject(phrase.out["phrase"]);
    const results = asObject(phrase.out["results"]);
    const perKind = ["persons", "companies", "deals", "notes"]
      .map((kind) => `${kind} ${String(asObject(results[kind])["returned"])}`)
      .join(", ");
    console.log(
      `search_crm phrase: ${phrase.isError ? `ERROR ${errorCodes(phrase.out["errors"])}` : "ok"}, ` +
        `totalCount ${String(block["totalCount"])}, ${perKind}, requests ${phrase.requests ?? "unknown"}`,
    );
    const dealHits = asObject(results["deals"])["returned"];
    if (phrase.isError || typeof dealHits !== "number" || dealHits < 1) {
      problems.push("phrase did not find the deal its word was taken from");
    }
  }

  // --- get_records ---------------------------------------------------------------
  const synthetic = await search("deals, nameContains SYNTHETIC", "deals", {
    filters: { status: "all", nameContains: "SYNTHETIC" },
    perPage: 1,
  });
  const syntheticId = asObject(asArray(synthetic["items"])[0])["id"];
  const target = typeof syntheticId === "string" ? syntheticId : dealIds[0];
  console.log(`get_records target: ${typeof syntheticId === "string" ? "the SYNTHETIC deal" : "the first listed deal"}`);

  async function records(label: string, args: Record<string, unknown>): Promise<Structured[]> {
    const { out, isError, requests } = await measured("get_records", args);
    const summary = asObject(out["summary"]);
    const items = asArray(out["items"]).map(asObject);
    const includeErrors = items.flatMap((item) => asArray(item["includeErrors"]));
    const unavailable = asArray(out["unavailable"])
      .map((entry) => String(asObject(entry)["include"]))
      .join(", ");
    console.log(
      `get_records ${label}: ${isError ? "ERROR" : "ok"}, ok ${String(summary["ok"])}, ` +
        `not_found ${String(summary["notFound"])}, failed ${String(summary["failed"])}` +
        (includeErrors.length === 0 ? "" : `, include errors: ${errorCodes(includeErrors)}`) +
        (unavailable === "" ? "" : `, unavailable: ${unavailable}`) +
        (errorCodes(out["errors"]) === "" ? "" : `, ${errorCodes(out["errors"])}`) +
        `, requests ${requests ?? "unknown"}`,
    );
    if (isError) problems.push(`get_records ${label}`);
    return items;
  }

  if (target === undefined) {
    console.log("get_records: the account has no deal, skipped");
  } else {
    const [deal] = await records("deal, full, every include", {
      kind: "deal",
      ids: [target],
      detail: "full",
      include: ["process", "products", "budget", "notes", "calls", "emails", "tasks", "wall"],
    });
    const item = deal ?? {};
    const process = asObject(item["process"]);
    const stages = asArray(process["stages"]).map(asObject);
    const steps = stages.flatMap((stage) => asArray(stage["steps"]).map(asObject));
    const list = (key: string, inner: string): string => {
      const block = asObject(item[key]);
      return key in item
        ? `${key} ${asArray(block[inner]).length}/${String(block["totalCount"])}`
        : `${key} absent`;
    };
    console.log(
      `  includes: process ${"process" in item ? `${stages.length} stages, ` +
        `${stages.filter((stage) => stage["state"] === "current").length} current, ` +
        `${steps.length} steps (${steps.filter((step) => step["required"] === true).length} required, ` +
        `${steps.filter((step) => step["completed"] === true).length} completed)` : "absent"}; ` +
        `${list("products", "lines")}; budget ${"budget" in item ? (item["budget"] === null ? "null" : "present") : "absent"}; ` +
        `${list("notes", "entries")}; ${list("calls", "entries")}; ${list("emails", "entries")}; ${list("tasks", "items")}`,
    );
    if (item["status"] !== "ok" || !("process" in item)) problems.push("deal with includes");
    if ("process" in item && stages.filter((stage) => stage["state"] === "current").length !== 1) {
      problems.push("the process does not have exactly one current stage");
    }
  }
  if (dealIds.length > 0) {
    await records(`${dealIds.length} deals, minimal`, { kind: "deal", ids: dealIds, detail: "minimal" });
  }
  const personId = personRows[0]?.["id"];
  if (typeof personId === "string") {
    await records("person, activity includes", {
      kind: "person",
      ids: [personId],
      include: ["notes", "calls", "emails", "tasks"],
    });
  }
  const companyId = asObject(asArray(companies["items"])[0])["id"];
  if (typeof companyId === "string") {
    await records("company, activity includes", {
      kind: "company",
      ids: [companyId],
      include: ["notes", "calls", "emails", "tasks"],
    });
  }
  const taskId = asObject(asArray(tasks["items"])[0])["id"];
  if (typeof taskId === "string") {
    await records("task, full", { kind: "task", ids: [taskId], detail: "full" });
  }
  const [unknown] = await records("an id that does not exist", {
    kind: "deal",
    ids: [crypto.randomUUID()],
  });
  if (unknown?.["status"] !== "not_found") problems.push("an unknown id is not reported as not_found");

  // --- refusals that must cost nothing ---------------------------------------------
  const refusals: [string, string, Record<string, unknown>][] = [
    ["search_crm, a deal filter on persons", "search_crm", { kinds: ["persons"], filters: { status: "won" } }],
    ["search_crm, a sort the kind does not have", "search_crm", { kinds: ["deals"], filters: {}, sort: { field: "value", direction: "desc" } }],
    [
      "get_records, 25 ids with two includes",
      "get_records",
      {
        kind: "deal",
        ids: Array.from({ length: 25 }, () => crypto.randomUUID()),
        include: ["process", "notes"],
      },
    ],
  ];
  for (const [label, name, args] of refusals) {
    const refused = await measured(name, args);
    console.log(
      `refusal ${label}: ${refused.isError ? errorCodes(refused.out["errors"]) : "NOT REFUSED"}, ` +
        `requests ${refused.requests ?? "unknown"}`,
    );
    if (!refused.isError || (refused.requests !== null && refused.requests !== 0)) {
      problems.push(`refusal: ${label}`);
    }
  }

  console.log(`record tools: ${spent} requests (plus one health call after each tool call)`);
  console.log(`dailyRemaining: ${before ?? "unknown"}`);
  if (problems.length > 0) {
    throw new SmokeFailure(`record tools: ${problems.length} check(s) failed: ${problems.join("; ")}`);
  }
}

async function waitUntilUp(base: string, child: { exitCode: number | null }): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new SmokeFailure("the server exited during startup");
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await Bun.sleep(200);
  }
  throw new SmokeFailure("the server did not answer /health within 10 s");
}

async function checkServer(): Promise<void> {
  const port = process.env["SMOKE_V2_PORT"]?.trim() || "3049";
  const base = `http://127.0.0.1:${port}`;
  // Only what the server needs, and `--no-env-file` below, so neither the
  // caller's environment nor a local `.env` can switch writes, a bearer token
  // or a network bind on. No v1 pair: the v2 tools stand alone.
  const env: Record<string, string> = {
    LIVESPACE_MCP_READ_ONLY: "true",
    MCP_BIND_HOST: "127.0.0.1",
    MCP_PORT: port,
    // The run makes about 150 MCP calls in a row; the defaults allow a burst of 30.
    MCP_RATE_LIMIT_PER_MINUTE: "1200",
    MCP_RATE_LIMIT_BURST: "400",
  };
  for (const name of [
    "LIVESPACE_SUBDOMAIN",
    "LIVESPACE_API_V2_KEY",
    "LIVESPACE_V2_DAILY_RESERVE",
    "LIVESPACE_ACTING_USER_EMAIL",
  ]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "run",
      fileURLToPath(new URL("../src/index.ts", import.meta.url)),
    ],
    { env, stdout: "ignore", stderr: "ignore" },
  );
  // `finally` does not run when this process is signalled, and an orphaned
  // server would keep the port and the key in memory.
  const stopOnSignal = (): void => {
    child.kill();
    process.exit(130);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, stopOnSignal);
  }
  // A server that answers while the child is gone is somebody else's.
  const ownServer = (): void => {
    if (child.exitCode !== null) {
      throw new SmokeFailure(
        `the server exited; if port ${port} is taken, set SMOKE_V2_PORT to a free one`,
      );
    }
  };

  try {
    await waitUntilUp(base, child);
    await Bun.sleep(300);
    ownServer();

    const listed = await mcp(base, "tools/list");
    const tools = Array.isArray(listed["tools"])
      ? listed["tools"].map((tool) => String((tool as { name?: unknown }).name))
      : [];
    console.log(`server tools (read-only, no v1 pair): ${tools.join(", ")}`);
    for (const tool of ["health", "crm_metadata", "search_crm", "get_records"]) {
      if (!tools.includes(tool)) throw new SmokeFailure(`${tool} must be listed`);
    }
    if (tools.some((tool) => WRITE_TOOLS.includes(tool))) {
      throw new SmokeFailure("a write tool is listed in read-only mode");
    }

    const health = await callTool(base, "health", { checkLivespace: true });
    const structured = health.structuredContent ?? {};
    const livespace = (structured["livespace"] ?? {}) as Record<string, unknown>;
    const backend = (structured["backend"] ?? {}) as Record<string, unknown>;
    const acting = !("actingUser" in livespace)
      ? "not checked"
      : livespace["actingUser"] === null
        ? "none"
        : "resolved";
    console.log(
      `health: ok ${structured["ok"] === true}, readOnly ${structured["readOnly"] === true}, ` +
        `backend ${String(backend["api"])}, v1Fallback ${backend["v1Fallback"] === true}, ` +
        `reachable ${livespace["reachable"] === true}, ` +
        `integrationUser ${present(livespace["integrationUser"])}, ` +
        `timeZone ${present(livespace["timeZone"])}, actingUser ${acting}, ` +
        `dailyRemaining ${typeof livespace["dailyRemaining"] === "number" ? livespace["dailyRemaining"] : "unknown"}, ` +
        `dailyReserve ${String(livespace["dailyReserve"])}`,
    );
    if (structured["ok"] !== true || livespace["reachable"] !== true) {
      throw new SmokeFailure("health did not reach Livespace API v2");
    }

    // One section per call on a cold cache. The cost of a section is the drop
    // of the account's daily budget around it, minus the one request the
    // following `health` spends itself. Another integration working on the
    // account at the same moment would inflate a count. The baseline is a
    // second `health`: with an acting user configured the first one also read
    // the user list, after it took its own count (so `users` then costs 0).
    let before = await dailyRemaining(base);
    let failed = 0;
    let spent = 0;
    for (const section of V2_METADATA_SECTIONS) {
      const result = await callTool(base, "crm_metadata", { sections: [section] });
      const sections = (result.structuredContent?.["sections"] ?? {}) as Record<
        string,
        Record<string, unknown>
      >;
      const errors = (result.structuredContent?.["errors"] ?? []) as Array<
        Record<string, unknown>
      >;
      const after = await dailyRemaining(base);
      const requests = before === null || after === null ? null : before - after - 1;
      before = after;
      if (requests !== null) spent += requests;
      const envelope = sections[section];
      if (envelope === undefined) {
        failed += 1;
        console.log(
          `crm_metadata ${section}: ERROR ${String(errors[0]?.["code"] ?? "unknown")}, ` +
            `requests ${requests ?? "unknown"}`,
        );
        continue;
      }
      const items =
        typeof envelope["totalItems"] === "number" ? `items ${envelope["totalItems"]}, ` : "";
      console.log(
        `crm_metadata ${section}: ok, ${items}truncated ${envelope["truncated"] === true}, ` +
          `stale ${envelope["stale"] === true}, hint ${typeof envelope["hint"] === "string" ? "yes" : "no"}, ` +
          `requests ${requests ?? "unknown"}`,
      );
    }

    const all = await callTool(base, "crm_metadata", {});
    const allSections = Object.keys(
      (all.structuredContent?.["sections"] ?? {}) as Record<string, unknown>,
    ).length;
    const after = await dailyRemaining(base);
    const cached = before === null || after === null ? null : before - after - 1;
    console.log(
      `crm_metadata all sections: ${allSections}/${V2_METADATA_SECTIONS.length} ok, ` +
        `requests ${cached ?? "unknown"} (served from the cache)`,
    );
    console.log(`crm_metadata total on a cold cache: ${spent} requests`);
    console.log(`dailyRemaining: ${after ?? "unknown"}`);

    ownServer();
    if (failed > 0 || allSections !== V2_METADATA_SECTIONS.length) {
      throw new SmokeFailure(`${failed} section(s) failed`);
    }

    await checkRecordTools(base, acting === "resolved");
    ownServer();
  } finally {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.off(signal, stopOnSignal);
    }
    child.kill();
    await child.exited;
  }
}

try {
  await checkClient();
  await checkServer();
  console.log("smoke-v2: OK");
} catch (error) {
  // A LivespaceError carries only our fixed wording (docs/security.md par. 6),
  // and a SmokeFailure only what this script wrote itself.
  if (error instanceof LivespaceError) {
    console.error(`smoke-v2: ${error.code} - ${error.message}`);
  } else if (error instanceof SmokeFailure) {
    console.error(`smoke-v2: ${error.message}`);
  } else {
    console.error("smoke-v2: unexpected failure");
  }
  process.exit(1);
}
