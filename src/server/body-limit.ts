export type BodyReadResult =
  | { kind: "ok"; body: Uint8Array<ArrayBuffer> | null }
  | { kind: "too_large" };

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ?? new DOMException("The request was aborted.", "AbortError")
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

// Content-Length alone is advisory: chunked requests and requests without the
// header would bypass a header-only check. The cap is enforced on the bytes
// actually read (docs/security.md par. 2).
export async function readBodyWithCap(
  request: Request,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<BodyReadResult> {
  throwIfAborted(signal);
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) return { kind: "too_large" };
  if (request.body === null) return { kind: "ok", body: null };

  const reader = request.body.getReader();
  let onAbort: (() => void) | undefined;
  const aborted =
    signal === undefined
      ? undefined
      : new Promise<never>((_resolve, reject) => {
          onAbort = () => {
            const reason = abortReason(signal);
            void reader.cancel(reason).catch(() => undefined);
            reject(reason);
          };
          signal.addEventListener("abort", onAbort, { once: true });
        });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next =
        aborted === undefined
          ? await reader.read()
          : await Promise.race([reader.read(), aborted]);
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => undefined);
        return { kind: "too_large" };
      }
      chunks.push(next.value);
    }
    throwIfAborted(signal);
  } finally {
    if (signal !== undefined && onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: "ok", body };
}
