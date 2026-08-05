import {
  createMcpHandler,
  hostHeaderValidationResponse,
  originValidationResponse,
  type AuthInfo,
} from "@modelcontextprotocol/server";
import { Hono } from "hono";
import { principalFromToken, tokensEqual } from "./auth.js";
import { readBodyWithCap } from "./body-limit.js";
import { createServerFactory, type AppDeps } from "./mcp.js";
import { PROTOCOL_VERSION } from "./tools/health.js";

const MAX_BODY_BYTES = 1024 * 1024;

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "www-authenticate": 'Bearer realm="mcp"',
    },
  });
}

export function buildApp(deps: AppDeps) {
  const handler = createMcpHandler(createServerFactory(deps), {
    legacy: "stateless",
    responseMode: "auto",
  });

  const app = new Hono();

  app.use("*", async (c, next) => {
    const request = c.req.raw;
    const rejected =
      hostHeaderValidationResponse(request, deps.config.allowedHostnames) ??
      originValidationResponse(request, deps.config.allowedOriginHostnames);
    if (rejected) return rejected;
    await next();
  });

  app.get("/health", (c) =>
    c.json({
      status: "ok",
      version: deps.version,
      protocol: PROTOCOL_VERSION,
      readOnly: deps.config.readOnly,
      authEnabled: deps.config.authToken !== undefined,
    }),
  );

  app.all("/mcp", async (c) => {
    const request = c.req.raw;

    let authInfo: AuthInfo | undefined;
    if (deps.config.authToken !== undefined) {
      const header = c.req.header("authorization") ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7) : "";
      if (token === "" || !(await tokensEqual(token, deps.config.authToken))) {
        return unauthorized();
      }
      const principal = await principalFromToken(deps.config.authToken);
      authInfo = { token: principal, clientId: principal, scopes: [] };
    }

    // Auth runs first so unauthenticated callers cannot make the server
    // buffer request bodies.
    const read = await readBodyWithCap(request, MAX_BODY_BYTES);
    if (read.kind === "too_large") {
      return new Response(JSON.stringify({ error: "payload too large" }), {
        status: 413,
        headers: { "content-type": "application/json" },
      });
    }
    const forwarded =
      read.body === null
        ? request
        : new Request(request.url, {
            method: request.method,
            headers: request.headers,
            body: read.body,
          });

    return handler.fetch(forwarded, authInfo === undefined ? undefined : { authInfo });
  });

  return app;
}
