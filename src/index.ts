import { loadLivespaceConfig, type LivespaceV1Config } from "./config/env.js";
import { loadServerConfig } from "./config/server-env.js";
import { createActivityFetchers } from "./livespace/activity.js";
import { LivespaceClient } from "./livespace/client.js";
import { createRecordFetchers } from "./livespace/records.js";
import { createDealStepReader } from "./livespace/stage-moves.js";
import { LivespaceV2Client } from "./livespace/v2/client.js";
import { readIntegrationUser } from "./livespace/v2/metadata.js";
import { createWriteFetchers } from "./livespace/writes.js";
import { buildApp } from "./server/app.js";
import { listen } from "./server/listen.js";
import { createMetadataService } from "./server/tools/crm-metadata.js";
import { createV1MetadataService } from "./server/v1-metadata.js";
import packageJson from "../package.json";

const serverConfig = loadServerConfig(process.env);
const livespaceConfig = loadLivespaceConfig(process.env);

// The signed-session (v1) client exists only when its optional key pair is
// set. Every tool that still reads through it is registered only then: the
// tools move to API v2 one area at a time on the feat/api-v2 branch.
function v1Deps(v1: LivespaceV1Config) {
  const client = new LivespaceClient(v1);
  return {
    // The v1 dictionaries these tools validate ids against, cached like the
    // v2 ones below.
    v1Metadata: createV1MetadataService(client),
    // Record and activity data is never cached (docs/security.md par. 8);
    // these fetchers are stateless and only share the client's throttle and
    // auth.
    records: createRecordFetchers(client, v1.subdomain),
    activity: createActivityFetchers(client),
    // A deal's own step state, read fresh on every stage move: the cached
    // dictionary numbers positions, the deal decides the flips.
    dealSteps: createDealStepReader(client),
    // Read-only is the default. The explicit write opt-in and emergency
    // kill-switch are resolved before anything can write: in read-only mode
    // the write fetchers are not built at all (docs/security.md par. 5).
    ...(serverConfig.readOnly ? {} : { writes: createWriteFetchers(client) }),
  };
}

// The API v2 client is the main backend: one per process, so its throttle and
// what it last heard about the rate limits are shared by every tool call.
const v2 = new LivespaceV2Client({
  subdomain: livespaceConfig.subdomain,
  apiKey: livespaceConfig.v2ApiKey,
  dailyReserve: livespaceConfig.dailyReserve,
});

// Built once per process: the dictionary cache lives here while the MCP
// protocol layer stays stateless (docs/security.md par. 8).
const metadata = createMetadataService(v2, {
  actingUserEmail: livespaceConfig.actingUserEmail,
});

const app = buildApp({
  config: serverConfig,
  version: packageJson.version,
  // Every notification deep link is built from this.
  subdomain: livespaceConfig.subdomain,
  v1Fallback: livespaceConfig.v1 !== null,
  livespace: {
    // `health` must answer while the daily reserve refuses everything else.
    v2Ping: (opts) => readIntegrationUser(v2, { ...opts, essential: true }),
    rateLimit: () => v2.rateLimit(),
    dailyReserve: livespaceConfig.dailyReserve,
    actingUser: (opts) => metadata.actingUser(opts),
  },
  metadata,
  ...(livespaceConfig.v1 === null ? {} : v1Deps(livespaceConfig.v1)),
});

const server = listen(app.fetch, serverConfig);

console.error(
  `livespace-crm-mcp v${packageJson.version} listening on ` +
    `${serverConfig.bindHost}:${serverConfig.port} ` +
    `(auth: ${serverConfig.authToken !== undefined ? "on" : "off"}, ` +
    `read-only: ${serverConfig.readOnly}, ` +
    `v1 fallback: ${livespaceConfig.v1 === null ? "off" : "on"})`,
);

function shutdown() {
  server.stop();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
