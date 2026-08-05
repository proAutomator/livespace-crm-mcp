import {
  createMcpHandler,
  hostHeaderValidationResponse,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import { Hono } from "hono";
import { createServerFactory, type AppDeps } from "./mcp.js";
import { PROTOCOL_VERSION } from "./tools/health.js";

const MAX_BODY_BYTES = 1024 * 1024;

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

// Constant-time, portable bearer comparison: compare fixed-length digests so
// neither string length nor prefix leaks through timing.
async function tokensEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < da.length; i += 1) diff |= (da[i] ?? 0) ^ (db[i] ?? 0);
  return diff === 0;
}

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

    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (contentLength > MAX_BODY_BYTES) {
      return new Response(JSON.stringify({ error: "payload too large" }), {
        status: 413,
        headers: { "content-type": "application/json" },
      });
    }

    if (deps.config.authToken !== undefined) {
      const header = c.req.header("authorization") ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7) : "";
      if (token === "" || !(await tokensEqual(token, deps.config.authToken))) {
        return unauthorized();
      }
    }

    return handler.fetch(request);
  });

  return app;
}
