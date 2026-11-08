/**
 * Synthetic API v2 traffic for tests. Every value here is invented: the key
 * carries the word "synthetic" (AGENTS.md), ids are UUID-shaped zeros and
 * names start with SYNTHETIC.
 */

/** Matches the v2 key shape `^ls_[A-Za-z0-9_-]{43}$`. */
export const SYNTHETIC_V2_KEY = "ls_synthetic" + "0".repeat(34);
export const SYNTHETIC_REQUEST_ID = "0123456789abcdef0123456789abcdef";

/** `00000000-0000-4000-8000-000000000001` for 1, and so on. */
export function syntheticId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

interface ResponseOptions {
  status?: number;
  headers?: Record<string, string>;
}

/** A v2 success envelope `{meta, data, extra}`. */
export function v2Envelope(
  data: unknown,
  extra: Record<string, unknown> = {},
  options: ResponseOptions = {},
): Response {
  return new Response(JSON.stringify({ meta: { version: "2.0.0" }, data, extra }), {
    status: options.status ?? 200,
    headers: {
      "content-type": "application/json",
      "x-request-id": SYNTHETIC_REQUEST_ID,
      ...options.headers,
    },
  });
}

/** An RFC 9457 problem as the v2 draft sends it; `type` is the slug. */
export function v2Problem(
  status: number,
  type: string,
  extras: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return new Response(
    JSON.stringify({
      type: `https://api.livespace.io/problems/${type}`,
      title: "SYNTHETIC problem title",
      status,
      detail: "SYNTHETIC problem detail",
      requestId: SYNTHETIC_REQUEST_ID,
      ...extras,
    }),
    {
      status,
      headers: {
        "content-type": "application/problem+json",
        "x-request-id": SYNTHETIC_REQUEST_ID,
        ...headers,
      },
    },
  );
}

/** One request the fake fetch saw. */
export interface V2Call {
  method: string;
  url: string;
  /** `METHOD /path` below `/api/v2`, without the query. */
  route: string;
  headers: Headers;
  body: string | undefined;
  init: RequestInit;
}

/** A response factory, or a thrown value to simulate a transport failure. */
export type V2Handler = (call: V2Call) => Response | Promise<Response>;

/**
 * A fetch that answers by `METHOD /path`. An array answers its handlers in
 * order, one per call; an unrouted or exhausted route answers 418 so the
 * test sees a non-retryable failure instead of a hang.
 */
export function routedV2Fetch(
  routes: Record<string, V2Handler | V2Handler[]>,
  calls: V2Call[],
): typeof fetch {
  const cursors = new Map<string, number>();
  const impl = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init.method ?? "GET").toUpperCase();
    const pathname = new URL(url).pathname.replace(/^\/api\/v2/u, "");
    const route = `${method} ${pathname}`;
    const call: V2Call = {
      method,
      url,
      route,
      headers: new Headers(init.headers),
      body: typeof init.body === "string" ? init.body : undefined,
      init,
    };
    calls.push(call);
    const entry = routes[route];
    let handler: V2Handler | undefined;
    if (Array.isArray(entry)) {
      const index = cursors.get(route) ?? 0;
      cursors.set(route, index + 1);
      handler = entry[index];
    } else {
      handler = entry;
    }
    if (handler === undefined) {
      return new Response("SYNTHETIC unrouted", { status: 418 });
    }
    return handler(call);
  };
  return impl as typeof fetch;
}

/** The DOMException `AbortSignal.timeout` rejects a fetch with. */
export function timeoutError(): DOMException {
  return new DOMException("The operation timed out.", "TimeoutError");
}
