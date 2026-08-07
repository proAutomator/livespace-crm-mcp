import { describe, expect, test } from "bun:test";

const TOOLS = [
  "health",
  "crm_metadata",
  "search_crm",
  "get_records",
  "get_activity",
  "analyze",
  "create_records",
  "update_records",
  "log_activities",
  "move_deals_to_stage",
  "notify_user",
] as const;

async function readme(): Promise<string> {
  return Bun.file(new URL("../README.md", import.meta.url)).text();
}

describe("README v1 contract", () => {
  test("has one exact 11-row tool table with the important bounds", async () => {
    const text = await readme();
    const rows = [...text.matchAll(/^\| `([^`]+)` \|/gmu)]
      .map((match) => match[1])
      .filter((name): name is (typeof TOOLS)[number] => TOOLS.includes(name as never));
    expect(rows).toEqual([...TOOLS]);

    const prose = text.replace(/\s+/gu, " ");
    expect(prose).toContain("nine dictionary sections");
    expect(prose).toContain("200-record sort window");
    expect(prose).toContain("25 ids; walls for at most 5");
    expect(prose).toContain("Up to 10 items");
    expect(prose).toContain("Up to 15 notes or calls");
    expect(prose).toContain("5 per 10 minutes and 1 per recipient per minute");
  });

  test("states the runtime and single-user authentication constraints", async () => {
    const prose = (await readme()).replace(/\s+/gu, " ");
    expect(prose).toContain("Bun 1.3.14");
    expect(prose).toContain("single-user");
    expect(prose).toContain("no OAuth");
  });

  test("documents the complete network exposure contract", async () => {
    const prose = (await readme()).replace(/\s+/gu, " ");
    expect(prose).toContain("MCP_ALLOWED_HOSTS");
    expect(prose).toContain("MCP_ALLOWED_ORIGIN_HOSTNAMES");
    expect(prose).toContain("every `/mcp` request");
    expect(prose).toContain("including on loopback");
    expect(prose).toContain("TLS");
    expect(prose).toContain("reverse proxy");
    expect(prose).toContain("protecting `.env` at rest is the operator's responsibility");
  });

  test("describes elicitation, fallback and write outcomes without overclaiming", async () => {
    const prose = (await readme()).replace(/\s+/gu, " ");
    expect(prose).toContain("elicitation-first");
    expect(prose).toContain("confirm: true executes immediately");
    expect(prose).toContain("Preview first");
    expect(prose).toContain("requestState");
    expect(prose).toContain("recordsChanged");
    expect(prose).toContain(
      "A successful write can still report `verification: unavailable`",
    );
    expect(prose).toContain("unknown_outcome");
    expect(prose).toContain("verification: unavailable");
    expect(prose).toContain("not_attempted");
    expect(prose).toContain("dispatched, never as delivered");
    expect(prose).not.toContain("write may have landed but its follow-up read failed");
  });

  test("names the v1 product limits", async () => {
    const prose = (await readme()).replace(/\s+/gu, " ");
    expect(prose).toContain("No delete or merge");
    expect(prose).toContain("No tag or custom-field writes");
    expect(prose).toContain("Tasks created here cannot be linked to records");
    expect(prose).toContain("Logged notes and calls cannot be edited or removed");
    expect(prose).toContain("point-in-time estimate");
    expect(prose).toContain("bounded windows");
    expect(prose).toContain("mixed currencies");
    expect(prose).toContain("API ids differ from the ids shown in the Livespace UI");
  });

  test("uses ASCII hyphens and no false first-call guarantee", async () => {
    const text = await readme();
    expect(text).not.toMatch(/[—–]/u);
    expect(text).not.toContain("never write on the first call");
  });
});
