import { loadLivespaceConfig } from "./config/env.js";
import { loadServerConfig } from "./config/server-env.js";
import { LivespaceClient } from "./livespace/client.js";
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
