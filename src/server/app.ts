import {
  createMcpHandler,
  hostHeaderValidationResponse,
  isJsonContentType,
  originValidationResponse,
  type AuthInfo,
} from "@modelcontextprotocol/server";
import { Hono } from "hono";
import { principalFromToken, tokensEqual } from "./auth.js";
import { readBodyWithCap } from "./body-limit.js";
import { createRequestLimiter } from "./limits.js";
import { createServerFactory, type AppDeps } from "./mcp.js";
import { PROTOCOL_VERSION } from "./tools/health.js";

const MAX_BODY_BYTES = 1024 * 1024;

interface IngressDeadline {
  signal: AbortSignal;
  didTimeout: () => boolean;
  dispose: () => void;
}

function createIngressDeadline(
  clientSignal: AbortSignal,
  timeoutMs: number,
): IngressDeadline {
  const controller = new AbortController();
  let timedOut = false;
  const onClientAbort = () => {
    controller.abort(
      clientSignal.reason ??
        new DOMException("The client disconnected.", "AbortError"),
    );
  };
  if (clientSignal.aborted) onClientAbort();
  else clientSignal.addEventListener("abort", onClientAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(
      new DOMException("Request ingress deadline exceeded.", "TimeoutError"),
    );
  }, timeoutMs);
  let disposed = false;
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      clientSignal.removeEventListener("abort", onClientAbort);
    },
  };
}

function requestTimedOut(): Response {
  return new Response(JSON.stringify({ error: "request_timeout" }), {
    status: 408,
    headers: { "content-type": "application/json" },
  });
}

function clientClosedRequest(): Response {
  return new Response(null, { status: 499 });
}

function rejectJsonRpcBatch(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32600,
        message: "Bad Request: JSON-RPC batches are not supported by this endpoint",
      },
      id: null,
    }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
}

function cancelUnreadBody(request: Request, reason: unknown): void {
  if (request.body !== null && !request.body.locked) {
    void request.body.cancel(reason).catch(() => undefined);
  }
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

function rateLimited(retryAfterSeconds: number): Response {
  return new Response(JSON.stringify({ error: "rate_limited" }), {
    status: 429,
    headers: {
      "content-type": "application/json",
      "retry-after": String(retryAfterSeconds),
    },
  });
}

export function buildApp(deps: AppDeps) {
  const handler = createMcpHandler(createServerFactory(deps), {
    legacy: "stateless",
    responseMode: "auto",
  });

  const limiter = createRequestLimiter({
    ratePerMinute: deps.config.rateLimitPerMinute,
    burst: deps.config.rateLimitBurst,
    maxConcurrent: deps.config.maxConcurrentRequests,
    maxQueue: deps.config.maxQueuedRequests,
  });
  const authFailureLimiter = createRequestLimiter({
    ratePerMinute: deps.config.rateLimitPerMinute,
    burst: deps.config.rateLimitBurst,
    maxConcurrent: deps.config.maxConcurrentRequests,
    // Authentication failures are answered immediately and never queue. One
    // fixed principal keeps this pre-authentication bucket constant-cardinality.
    maxQueue: 0,
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
        const failureAdmission = await authFailureLimiter.admit("unauthenticated");
        if (!failureAdmission.admitted) {
          return rateLimited(failureAdmission.retryAfterSeconds);
        }
        failureAdmission.release();
        return unauthorized();
      }
      const principal = await principalFromToken(deps.config.authToken);
      authInfo = { token: principal, clientId: principal, scopes: [] };
    }

    const principal = authInfo?.clientId ?? "anonymous";
    const ingress = createIngressDeadline(
      request.signal,
      deps.config.requestIngressTimeoutMs,
    );
    let admission: Awaited<ReturnType<typeof limiter.admit>> | undefined;

    try {
      admission = await limiter.admit(principal, ingress.signal);
      if (!admission.admitted) {
        return rateLimited(admission.retryAfterSeconds);
      }
      // Auth and admission run first so unauthenticated or over-limit callers
      // cannot make the server buffer request bodies.
      const read = await readBodyWithCap(
        request,
        MAX_BODY_BYTES,
        ingress.signal,
      );
      if (read.kind === "too_large") {
        return new Response(JSON.stringify({ error: "payload too large" }), {
          status: 413,
          headers: { "content-type": "application/json" },
        });
      }
      ingress.dispose();

      let parsedBody: unknown;
      let bodyParsed = false;
      if (
        read.body !== null &&
        request.method.toUpperCase() === "POST" &&
        isJsonContentType(request.headers.get("content-type"))
      ) {
        try {
          parsedBody = JSON.parse(new TextDecoder().decode(read.body));
          bodyParsed = true;
        } catch {
          // Keep the SDK's existing parse-error response for malformed JSON.
        }
      }
      if (bodyParsed && Array.isArray(parsedBody)) return rejectJsonRpcBatch();

      const forwarded =
        read.body === null
          ? request
          : new Request(request.url, {
              method: request.method,
              headers: request.headers,
              body: read.body,
              signal: request.signal,
            });

      // The slot is held until the response is prepared; for SSE responses the
      // stream may outlive it, which is an accepted simplification - response
      // preparation is the expensive part here.
      return await handler.fetch(
        forwarded,
        authInfo === undefined && !bodyParsed
          ? undefined
          : {
              ...(authInfo === undefined ? {} : { authInfo }),
              ...(bodyParsed ? { parsedBody } : {}),
            },
      );
    } catch (error) {
      cancelUnreadBody(request, error);
      if (ingress.didTimeout()) return requestTimedOut();
      if (request.signal.aborted) return clientClosedRequest();
      throw error;
    } finally {
      ingress.dispose();
      if (admission?.admitted) admission.release();
    }
  });

  return app;
}
