import { describe, expect, test } from "bun:test";
import { loadServerConfig } from "../../src/config/server-env.js";
import { listen } from "../../src/server/listen.js";

/**
 * Bun closes a connection that stays silent for `idleTimeout` seconds, 10 by
 * default, while a tool call may legitimately run for the whole execution
 * deadline (docs/security.md par. 2). The HTTP tests call `app.fetch` and never
 * reach `Bun.serve`, so this one goes through the real listener with a handler
 * that works past Bun's default before it answers. Only a request being
 * handled counts: Bun does not time out a connection that is still sending
 * headers or waiting to send its body.
 */

/**
 * Bun checks idle sockets on a coarse tick, so the 10 s default actually fires
 * somewhere between 10 and 14 s (12 s in the 2026-10-05 reproduction). 15 s is
 * past that window and well inside the configured timeout.
 */
const HANDLER_MS = 15_000;

describe("listen", () => {
  test(
    "a handler working past Bun's default idle timeout still answers",
    async () => {
      const server = listen(
        async () => {
          await Bun.sleep(HANDLER_MS);
          return new Response("done");
        },
        { ...loadServerConfig({}), port: 0 },
      );
      try {
        const response = await fetch(`http://127.0.0.1:${server.port}/`);
        expect(await response.text()).toBe("done");
      } finally {
        await server.stop(true);
      }
    },
    HANDLER_MS + 10_000,
  );
});
