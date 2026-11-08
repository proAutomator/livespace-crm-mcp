/** Credentials of the signed-session API (v1.13), now an optional fallback. */
export interface LivespaceV1Config {
  subdomain: string;
  apiKey: string;
  apiSecret: string;
}

export interface LivespaceConfig {
  subdomain: string;
  /** Bearer key of the public API v2; it acts as the account's integration user. */
  v2ApiKey: string;
  /** Present only when both v1 variables are set (docs/security.md par. 1). */
  v1: LivespaceV1Config | null;
  /** The human the integration acts for; required later for `mine` and writes. */
  actingUserEmail: string | null;
  /** Daily requests kept free for the account's other integrations. */
  dailyReserve: number;
}

/** Shape of a v2 service key, from the API contract. */
export const V2_KEY_SHAPE = /^ls_[A-Za-z0-9_-]{43}$/;
export const DAILY_RESERVE_DEFAULT = 5000;
const DAILY_RESERVE_MAX = 1_000_000;

const SUBDOMAIN_RE = /^[a-z0-9][a-z0-9-]{0,62}$/i;
/** A deliberately plain check: one `@`, a dotted domain, no whitespace. */
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{1,63}$/;

function read(env: Record<string, string | undefined>, name: string): string {
  return env[name]?.trim() ?? "";
}

// Every message below names variables, never values (docs/security.md par. 1).
export function loadLivespaceConfig(
  env: Record<string, string | undefined>,
): LivespaceConfig {
  const subdomain = read(env, "LIVESPACE_SUBDOMAIN");
  const v2ApiKey = read(env, "LIVESPACE_API_V2_KEY");

  const missing = (
    [
      ["LIVESPACE_SUBDOMAIN", subdomain],
      ["LIVESPACE_API_V2_KEY", v2ApiKey],
    ] as const
  )
    .filter(([, value]) => value === "")
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(
      `Missing required configuration: ${missing.join(", ")}. ` +
        "Copy .env.example to .env and fill in the values." +
        (v2ApiKey === ""
          ? " LIVESPACE_API_V2_KEY is required from 0.2.0; for the v1 API " +
            "use livespace-crm-mcp@0.1."
          : ""),
    );
  }

  checkSubdomain(subdomain);

  if (!V2_KEY_SHAPE.test(v2ApiKey)) {
    throw new Error(
      "LIVESPACE_API_V2_KEY does not look like a Livespace API v2 key " +
        "(ls_ followed by 43 letters, digits, '_' or '-').",
    );
  }

  return {
    subdomain,
    v2ApiKey,
    v1: loadV1Pair(env, subdomain),
    actingUserEmail: loadActingUserEmail(env),
    dailyReserve: loadDailyReserve(env),
  };
}

/**
 * The v1 credentials alone, for `scripts/smoke.ts`: the signed-session smoke
 * needs no v2 key, the server itself always does.
 */
export function loadLivespaceV1Config(
  env: Record<string, string | undefined>,
): LivespaceV1Config {
  const missing = ["LIVESPACE_SUBDOMAIN", "LIVESPACE_API_KEY", "LIVESPACE_API_SECRET"]
    .filter((name) => read(env, name) === "");
  if (missing.length > 0) {
    throw new Error(`Missing required configuration: ${missing.join(", ")}.`);
  }
  const subdomain = read(env, "LIVESPACE_SUBDOMAIN");
  checkSubdomain(subdomain);
  return {
    subdomain,
    apiKey: read(env, "LIVESPACE_API_KEY"),
    apiSecret: read(env, "LIVESPACE_API_SECRET"),
  };
}

// The subdomain is interpolated into the request URL, so its shape must be
// constrained (docs/security.md par. 1).
function checkSubdomain(subdomain: string): void {
  if (!SUBDOMAIN_RE.test(subdomain)) {
    throw new Error(
      "LIVESPACE_SUBDOMAIN must be the bare subdomain name " +
        "(letters, digits, hyphens) without protocol or domain suffix.",
    );
  }
}

function loadV1Pair(
  env: Record<string, string | undefined>,
  subdomain: string,
): LivespaceV1Config | null {
  const apiKey = read(env, "LIVESPACE_API_KEY");
  const apiSecret = read(env, "LIVESPACE_API_SECRET");
  if (apiKey === "" && apiSecret === "") return null;
  if (apiKey === "" || apiSecret === "") {
    const absent = apiKey === "" ? "LIVESPACE_API_KEY" : "LIVESPACE_API_SECRET";
    throw new Error(
      `${absent} is missing: the optional v1 credentials ` +
        "(LIVESPACE_API_KEY and LIVESPACE_API_SECRET) come as a pair or not at all.",
    );
  }
  return { subdomain, apiKey, apiSecret };
}

function loadActingUserEmail(env: Record<string, string | undefined>): string | null {
  const email = read(env, "LIVESPACE_ACTING_USER_EMAIL");
  if (email === "") return null;
  if (email.length > 254 || !EMAIL_RE.test(email)) {
    throw new Error(
      "LIVESPACE_ACTING_USER_EMAIL must be the e-mail address of a Livespace user.",
    );
  }
  return email;
}

function loadDailyReserve(env: Record<string, string | undefined>): number {
  const raw = read(env, "LIVESPACE_V2_DAILY_RESERVE");
  if (raw === "") return DAILY_RESERVE_DEFAULT;
  // Digits only: Number() would also take "1e3", "0x10" or " 1 ".
  const value = /^\d{1,7}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(value) || value > DAILY_RESERVE_MAX) {
    throw new Error(
      `LIVESPACE_V2_DAILY_RESERVE must be an integer from 0 to ${DAILY_RESERVE_MAX} ` +
        "(0 turns the daily budget guard off).",
    );
  }
  return value;
}
