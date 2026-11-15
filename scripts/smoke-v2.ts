import { loadLivespaceConfig } from "../src/config/env.js";
import { LivespaceError } from "../src/livespace/errors.js";
import { LivespaceV2Client } from "../src/livespace/v2/client.js";
import { MEDIA_MINIMAL } from "../src/livespace/v2/media-types.js";

// Read-only live check of the API v2 client. Run it against a demo or sandbox
// account only, never a production CRM. It reads LIVESPACE_SUBDOMAIN and
// LIVESPACE_API_V2_KEY from the environment (Bun loads a local .env, or a
// secret manager can inject them) and makes two logical requests (reads may
// retry a transport failure, so at most six HTTP attempts).
//
// Output is statuses and counts only: never record content, never the key.
// This script's output may land in terminals, CI logs or transcripts.

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

function requestIdState(requestId: string | null): string {
  return requestId === null ? "missing" : "present";
}

try {
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

  const daily = client.rateLimit().dailyRemaining;
  console.log(`dailyRemaining: ${daily ?? "unknown"}`);
  console.log("smoke-v2: OK");
} catch (error) {
  // A LivespaceError carries only our fixed wording (docs/security.md par. 6).
  if (error instanceof LivespaceError) {
    console.error(`smoke-v2: ${error.code} - ${error.message}`);
  } else {
    console.error("smoke-v2: unexpected failure");
  }
  process.exit(1);
}
