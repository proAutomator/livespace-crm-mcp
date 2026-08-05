export interface LivespaceConfig {
  subdomain: string;
  apiKey: string;
  apiSecret: string;
}

const SUBDOMAIN_RE = /^[a-z0-9][a-z0-9-]{0,62}$/i;

export function loadLivespaceConfig(
  env: Record<string, string | undefined>,
): LivespaceConfig {
  const subdomain = env["LIVESPACE_SUBDOMAIN"]?.trim() ?? "";
  const apiKey = env["LIVESPACE_API_KEY"]?.trim() ?? "";
  const apiSecret = env["LIVESPACE_API_SECRET"]?.trim() ?? "";

  const missing = (
    [
      ["LIVESPACE_SUBDOMAIN", subdomain],
      ["LIVESPACE_API_KEY", apiKey],
      ["LIVESPACE_API_SECRET", apiSecret],
    ] as const
  )
    .filter(([, value]) => value === "")
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(
      `Missing required configuration: ${missing.join(", ")}. ` +
        "Copy .env.example to .env and fill in the values.",
    );
  }

  // The subdomain is interpolated into the request URL, so its shape must be
  // constrained (docs/security.md par. 1).
  if (!SUBDOMAIN_RE.test(subdomain)) {
    throw new Error(
      "LIVESPACE_SUBDOMAIN must be the bare subdomain name " +
        "(letters, digits, hyphens) without protocol or domain suffix.",
    );
  }

  return { subdomain, apiKey, apiSecret };
}
