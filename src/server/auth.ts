async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time, portable bearer comparison: compare fixed-length digests so
// neither string length nor prefix leaks through timing.
export async function tokensEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < da.length; i += 1) diff |= (da[i] ?? 0) ^ (db[i] ?? 0);
  return diff === 0;
}

// Tools and the SDK request context must never see the raw bearer token
// (docs/security.md par. 1); they get a stable digest-based principal instead.
export async function principalFromToken(token: string): Promise<string> {
  const digest = await sha256(token);
  return `bearer:${toHex(digest).slice(0, 16)}`;
}
