import { LivespaceError } from "../errors.js";

/**
 * Load discipline for API v2 (docs/security.md par. 3). Livespace counts every
 * request twice: against a burst window per key (100 per 10 s) and against a
 * daily budget per ACCOUNT, shared by every key and integration of that
 * customer. The tracker remembers what the last responses said about both;
 * the call budget caps how many requests one tool call may spend.
 */

export interface RateLimitSnapshot {
  burstLimit: number | null;
  burstRemaining: number | null;
  /** Epoch ms when the burst window resets. */
  burstResetAt: number | null;
  dailyRemaining: number | null;
  /** Epoch ms of the last observation that carried a usable value. */
  observedAt: number | null;
}

/** A non-negative integer header, digits only; anything else is "absent". */
function integerHeader(headers: Headers, name: string): number | null {
  const raw = headers.get(name)?.trim();
  if (raw === undefined || !/^\d{1,15}$/.test(raw)) return null;
  return Number(raw);
}

export class RateLimitTracker {
  private state: RateLimitSnapshot = {
    burstLimit: null,
    burstRemaining: null,
    burstResetAt: null,
    dailyRemaining: null,
    observedAt: null,
  };

  constructor(private readonly now: () => number = Date.now) {}

  /** Ignores absent or malformed headers and keeps the last good values. */
  observe(headers: Headers): void {
    const limit = integerHeader(headers, "x-ratelimit-limit");
    const remaining = integerHeader(headers, "x-ratelimit-remaining");
    const reset = integerHeader(headers, "x-ratelimit-reset");
    const daily = integerHeader(headers, "x-ratelimit-daily-remaining");
    if (limit === null && remaining === null && reset === null && daily === null) return;
    this.state = {
      burstLimit: limit ?? this.state.burstLimit,
      burstRemaining: remaining ?? this.state.burstRemaining,
      burstResetAt: reset === null ? this.state.burstResetAt : reset * 1000,
      dailyRemaining: daily ?? this.state.dailyRemaining,
      observedAt: this.now(),
    };
  }

  snapshot(): RateLimitSnapshot {
    return { ...this.state };
  }

  /** ms to wait before the next request, 0 when none. */
  burstWaitMs(): number {
    const { burstRemaining, burstResetAt } = this.state;
    if (burstRemaining !== 0 || burstResetAt === null) return 0;
    return Math.max(0, burstResetAt - this.now());
  }

  /**
   * True once the account's daily budget is at or below the reserve. Never
   * while unknown (no counted response yet), and never with a zero reserve,
   * which turns the guard off.
   */
  isDailyBudgetLow(reserve: number): boolean {
    const { dailyRemaining } = this.state;
    if (reserve <= 0 || dailyRemaining === null) return false;
    return dailyRemaining <= reserve;
  }
}

/** Requests one tool call may spend, retries included. */
export const CALL_BUDGETS = { read: 60, analyze: 150, write: 80, sync: 120 } as const;

/**
 * The request budget of one tool call. Every HTTP attempt spends one unit
 * before it goes out, so a call that would exceed it stops before the
 * request, never after (docs/security.md par. 3).
 */
export class CallBudget {
  private spent = 0;

  constructor(readonly max: number) {
    if (!Number.isInteger(max) || max < 1) {
      throw new RangeError("A call budget must be a positive integer.");
    }
  }

  get used(): number {
    return this.spent;
  }

  spend(): void {
    if (this.spent >= this.max) {
      throw new LivespaceError(
        "CALL_BUDGET_EXCEEDED",
        `This call reached its limit of ${this.max} Livespace requests.`,
        "Narrow the request - fewer ids, fewer includes or a shorter date " +
          "range - and split the rest into further calls.",
      );
    }
    this.spent += 1;
  }
}
