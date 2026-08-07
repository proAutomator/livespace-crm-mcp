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

const MAX_BODY_BYTES = 1024 * 1024;

interface RequestDeadline {
  signal: AbortSignal;
  didTimeout: () => boolean;
  abort: (reason: unknown) => void;
  dispose: () => void;
}

function createRequestDeadline(
  clientSignal: AbortSignal,
  timeoutMs: number,
  timeoutMessage: string,
): RequestDeadline {
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
    controller.abort(new DOMException(timeoutMessage, "TimeoutError"));
  }, timeoutMs);
  let disposed = false;
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    abort: (reason) => controller.abort(reason),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      clientSignal.removeEventListener("abort", onClientAbort);
    },
  };
}

function createIngressDeadline(
  clientSignal: AbortSignal,
  timeoutMs: number,
): RequestDeadline {
  return createRequestDeadline(
    clientSignal,
    timeoutMs,
    "Request ingress deadline exceeded.",
  );
}

function keepDeadlineThroughResponse(
  response: Response,
  deadline: RequestDeadline,
  releaseAdmission: () => void,
): Response {
  if (response.body === null) {
    deadline.dispose();
    releaseAdmission();
    return response;
  }

  const reader = response.body.getReader();
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    deadline.signal.removeEventListener("abort", finish);
    deadline.dispose();
    releaseAdmission();
  };
  deadline.signal.addEventListener("abort", finish, { once: true });
  if (deadline.signal.aborted) finish();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          finish();
          controller.close();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      deadline.abort(
        reason ?? new DOMException("Response consumption was cancelled.", "AbortError"),
      );
      try {
        await reader.cancel(reason);
      } finally {
        finish();
      }
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function requestTimedOut(): Response {
  return new Response(JSON.stringify({ error: "request_timeout" }), {
    status: 408,
    headers: { "content-type": "application/json" },
  });
}

function executionTimedOut(): Response {
  return new Response(JSON.stringify({ error: "execution_timeout" }), {
    status: 504,
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

  app.use("/mcp", async (c, next) => {
    await next();
    c.res.headers.set("cache-control", "no-store");
    const vary = c.res.headers.get("vary");
    if (vary === null) c.res.headers.set("vary", "Authorization");
    else if (!vary.toLowerCase().split(/\s*,\s*/u).includes("authorization")) {
      c.res.headers.set("vary", `${vary}, Authorization`);
    }
  });

  app.get("/health", (c) => c.json({ status: "ok" }));

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
    let execution: RequestDeadline | undefined;

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

      execution = createRequestDeadline(
        request.signal,
        deps.config.requestExecutionTimeoutMs,
        "Request execution deadline exceeded.",
      );

      const forwarded =
        read.body === null
          ? new Request(request, { signal: execution.signal })
          : new Request(request.url, {
              method: request.method,
              headers: request.headers,
              body: read.body,
              signal: execution.signal,
            });

      const response = await handler.fetch(
        forwarded,
        authInfo === undefined && !bodyParsed
          ? undefined
          : {
              ...(authInfo === undefined ? {} : { authInfo }),
              ...(bodyParsed ? { parsedBody } : {}),
            },
      );
      const activeExecution = execution;
      const activeAdmission = admission;
      let admissionReleased = false;
      const releaseAdmission = (): void => {
        if (admissionReleased) return;
        admissionReleased = true;
        if (activeAdmission?.admitted) activeAdmission.release();
      };
      const wrapped = keepDeadlineThroughResponse(
        response,
        activeExecution,
        releaseAdmission,
      );
      execution = undefined;
      admission = undefined;
      return wrapped;
    } catch (error) {
      cancelUnreadBody(request, error);
      if (ingress.didTimeout()) return requestTimedOut();
      if (execution?.didTimeout()) return executionTimedOut();
      if (request.signal.aborted) return clientClosedRequest();
      throw error;
    } finally {
      ingress.dispose();
      execution?.dispose();
      if (admission?.admitted) admission.release();
    }
  });

  return app;
}
