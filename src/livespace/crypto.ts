// WebCrypto on purpose: identical behavior on Bun, Node 20+, and Cloudflare
// Workers. SHA-1 is Livespace's request-signing scheme, not our choice of
// hash for anything security-critical on our side.
export async function sha1Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function buildSignature(
  apiKey: string,
  token: string,
  apiSecret: string,
): Promise<string> {
  return sha1Hex(`${apiKey}${token}${apiSecret}`);
}
