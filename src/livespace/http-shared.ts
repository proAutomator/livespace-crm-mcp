/**
 * Transport helpers shared by the v1 (signed-session) and v2 (Bearer) clients.
 * Nothing here reads a response body: bodies are upstream data and each
 * client decides what of them, if anything, may pass (docs/security.md par. 6).
 */

// Only the delta-seconds form is honored; HTTP-date values are ignored.
export function parseRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.round(seconds * 1000);
}
