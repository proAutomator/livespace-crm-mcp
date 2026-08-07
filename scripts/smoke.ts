import { loadLivespaceConfig } from "../src/config/env.js";
import { LivespaceClient } from "../src/livespace/client.js";

// Reads the same macOS Keychain entries the local `livespace` skill uses
// (service "livespace-api", accounts subdomain / api-key / api-secret) so the
// sandbox credentials never need to exist in a file.
function keychain(account: string): string | undefined {
  if (process.platform !== "darwin") return undefined;
  const proc = Bun.spawnSync([
    "security",
    "find-generic-password",
    "-s",
    "livespace-api",
    "-a",
    account,
    "-w",
  ]);
  if (proc.exitCode !== 0) return undefined;
  const value = proc.stdout.toString().trim();
  return value === "" ? undefined : value;
}

const config = loadLivespaceConfig({
  LIVESPACE_SUBDOMAIN: process.env["LIVESPACE_SUBDOMAIN"] ?? keychain("subdomain"),
  LIVESPACE_API_KEY: process.env["LIVESPACE_API_KEY"] ?? keychain("api-key"),
  LIVESPACE_API_SECRET: process.env["LIVESPACE_API_SECRET"] ?? keychain("api-secret"),
});

const client = new LivespaceClient(config);

// Never print raw responses here: Default/ping echoes the request payload,
// and this script's output may land in terminals, CI logs, or transcripts.
const ping = await client.call<Record<string, string>>("Default", "ping", {
  check: "smoke",
});
console.log(`ping: ${ping["check"] === "smoke" ? "OK" : "unexpected echo"}`);

const me = await client.call<{ name?: string; login?: string }>(
  "Default",
  "User_getInfo",
);
console.log(
  `identity: ${me.name !== undefined || me.login !== undefined ? "OK" : "missing"}`,
);
console.log("smoke: OK");
