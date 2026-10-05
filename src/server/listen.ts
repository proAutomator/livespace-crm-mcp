import { idleTimeoutSeconds, type ServerConfig } from "../config/server-env.js";

/** The one Bun-specific step: bind the HTTP handler to the configured address. */
export function listen(
  fetch: (request: Request) => Response | Promise<Response>,
  config: ServerConfig,
): Bun.Server<undefined> {
  return Bun.serve({
    hostname: config.bindHost,
    port: config.port,
    idleTimeout: idleTimeoutSeconds(config),
    fetch,
  });
}
