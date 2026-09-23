import { loadLivespaceConfig } from "./config/env.js";
import { loadServerConfig } from "./config/server-env.js";
import { createActivityFetchers } from "./livespace/activity.js";
import { LivespaceClient } from "./livespace/client.js";
import { createRecordFetchers } from "./livespace/records.js";
import { createDealStepReader } from "./livespace/stage-moves.js";
import { createWriteFetchers } from "./livespace/writes.js";
import { buildApp } from "./server/app.js";
import { createMetadataService } from "./server/tools/crm-metadata.js";
import packageJson from "../package.json";

const serverConfig = loadServerConfig(process.env);
const livespaceConfig = loadLivespaceConfig(process.env);
const client = new LivespaceClient(livespaceConfig);

const app = buildApp({
  config: serverConfig,
  version: packageJson.version,
  // Built once per process: the dictionary cache lives here while the MCP
  // protocol layer stays stateless (docs/security.md par. 8).
  metadata: createMetadataService(client),
  // Record and activity data is never cached (docs/security.md par. 8); these
  // fetchers are stateless and only share the client's throttle and auth.
  records: createRecordFetchers(client, livespaceConfig.subdomain),
  activity: createActivityFetchers(client),
  // A deal's own step state, read fresh on every stage move: the cached
  // dictionary numbers positions, the deal decides the flips.
  dealSteps: createDealStepReader(client),
  // Every notification deep link is built from this.
  subdomain: livespaceConfig.subdomain,
  // Read-only is the default. The explicit write opt-in and emergency
  // kill-switch are resolved before anything can write: in read-only mode the
  // write fetchers are not built at all (docs/security.md par. 5).
  ...(serverConfig.readOnly ? {} : { writes: createWriteFetchers(client) }),
  livespacePing: (opts) =>
    client.call<{ name?: string; login?: string }>(
      "Default",
      "User_getInfo",
      {},
      opts ?? {},
    ),
});

const server = Bun.serve({
  hostname: serverConfig.bindHost,
  port: serverConfig.port,
  fetch: app.fetch,
});

console.error(
  `livespace-crm-mcp v${packageJson.version} listening on ` +
    `${serverConfig.bindHost}:${serverConfig.port} ` +
    `(auth: ${serverConfig.authToken !== undefined ? "on" : "off"}, ` +
    `read-only: ${serverConfig.readOnly})`,
);

function shutdown() {
  server.stop();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
