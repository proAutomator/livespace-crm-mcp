export type BodyReadResult =
  | { kind: "ok"; body: Uint8Array<ArrayBuffer> | null }
  | { kind: "too_large" };

// Content-Length alone is advisory: chunked requests and requests without the
// header would bypass a header-only check. The cap is enforced on the bytes
// actually read (docs/security.md par. 2).
export async function readBodyWithCap(
  request: Request,
  maxBytes: number,
): Promise<BodyReadResult> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) return { kind: "too_large" };
  if (request.body === null) return { kind: "ok", body: null };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return { kind: "too_large" };
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: "ok", body };
}
