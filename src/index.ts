import { loadLivespaceConfig } from "./config/env.js";
import { loadServerConfig } from "./config/server-env.js";
import { LivespaceClient } from "./livespace/client.js";
import { buildApp } from "./server/app.js";
import packageJson from "../package.json";

const serverConfig = loadServerConfig(process.env);
const livespaceConfig = loadLivespaceConfig(process.env);
const client = new LivespaceClient(livespaceConfig);

const app = buildApp({
  config: serverConfig,
  version: packageJson.version,
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
  `livespace-mcp v${packageJson.version} listening on ` +
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
