import type { HealthLivespaceDeps } from "../../src/server/tools/health.js";

/**
 * The Livespace half of `health` for wire tests that only care when and how
 * the ping runs. Whatever `ping` resolves to is replaced by a synthetic
 * integration user; a rejection passes through untouched.
 */
export function healthPing(
  ping: (opts?: { signal?: AbortSignal }) => Promise<unknown>,
): HealthLivespaceDeps {
  return {
    v2Ping: async (opts) => {
      await ping(opts);
      return { login: "synthetic-integration", timeZone: "Europe/Warsaw" };
    },
    rateLimit: () => ({
      burstLimit: null,
      burstRemaining: null,
      burstResetAt: null,
      dailyRemaining: null,
      observedAt: null,
    }),
    dailyReserve: 5000,
    actingUser: async () => ({ state: "not_configured", user: null }),
  };
}
