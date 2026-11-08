import { describe, expect, test } from "bun:test";
import { LivespaceError } from "../../../src/livespace/errors.js";
import {
  CALL_BUDGETS,
  CallBudget,
  RateLimitTracker,
} from "../../../src/livespace/v2/budget.js";

/** A fixed clock: 2026-10-25T12:00:00Z, a whole second. */
const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);
const NOW_S = NOW / 1000;

function rateHeaders(values: Record<string, string>): Headers {
  return new Headers(
    Object.fromEntries(Object.entries(values).map(([key, value]) => [`x-ratelimit-${key}`, value])),
  );
}

function tracker(clock: { now: number } = { now: NOW }): RateLimitTracker {
  return new RateLimitTracker(() => clock.now);
}

describe("RateLimitTracker", () => {
  test("starts unknown", () => {
    expect(tracker().snapshot()).toEqual({
      burstLimit: null,
      burstRemaining: null,
      burstResetAt: null,
      dailyRemaining: null,
      observedAt: null,
    });
  });

  test("observes burst and daily headers", () => {
    const rate = tracker();
    rate.observe(
      rateHeaders({
        limit: "100",
        remaining: "42",
        reset: String(NOW_S + 5),
        "daily-remaining": "49900",
      }),
    );
    expect(rate.snapshot()).toEqual({
      burstLimit: 100,
      burstRemaining: 42,
      burstResetAt: NOW + 5000,
      dailyRemaining: 49900,
      observedAt: NOW,
    });
  });

  test("ignores missing or malformed headers and keeps the last good values", () => {
    const clock = { now: NOW };
    const rate = tracker(clock);
    rate.observe(
      rateHeaders({
        limit: "100",
        remaining: "42",
        reset: String(NOW_S + 5),
        "daily-remaining": "49900",
      }),
    );
    const good = rate.snapshot();
    clock.now = NOW + 1000;
    rate.observe(new Headers());
    rate.observe(
      rateHeaders({
        limit: "abc",
        remaining: "-1",
        reset: "1.5",
        "daily-remaining": "1e3",
      }),
    );
    rate.observe(rateHeaders({ remaining: " ", "daily-remaining": "9".repeat(20) }));
    expect(rate.snapshot()).toEqual(good);
  });

  test("a later partial observation updates only what it carries", () => {
    const clock = { now: NOW };
    const rate = tracker(clock);
    rate.observe(rateHeaders({ remaining: "42", "daily-remaining": "49900" }));
    clock.now = NOW + 2000;
    rate.observe(rateHeaders({ "daily-remaining": "49899" }));
    expect(rate.snapshot()).toMatchObject({
      burstRemaining: 42,
      dailyRemaining: 49899,
      observedAt: NOW + 2000,
    });
  });

  test("waits until reset when the burst is spent", () => {
    const clock = { now: NOW };
    const rate = tracker(clock);
    expect(rate.burstWaitMs()).toBe(0);
    rate.observe(rateHeaders({ remaining: "0", reset: String(NOW_S + 3) }));
    expect(rate.burstWaitMs()).toBe(3000);
    clock.now = NOW + 1000;
    expect(rate.burstWaitMs()).toBe(2000);
    clock.now = NOW + 4000;
    expect(rate.burstWaitMs()).toBe(0);
    rate.observe(rateHeaders({ remaining: "5", reset: String(NOW_S + 10) }));
    expect(rate.burstWaitMs()).toBe(0);
  });

  test("daily budget is low at or below the reserve, never while unknown", () => {
    const rate = tracker();
    expect(rate.isDailyBudgetLow(5000)).toBe(false);
    rate.observe(rateHeaders({ "daily-remaining": "100" }));
    expect(rate.isDailyBudgetLow(100)).toBe(true);
    expect(rate.isDailyBudgetLow(101)).toBe(true);
    expect(rate.isDailyBudgetLow(99)).toBe(false);
  });

  test("a zero reserve turns the daily guard off", () => {
    const rate = tracker();
    rate.observe(rateHeaders({ "daily-remaining": "0" }));
    expect(rate.isDailyBudgetLow(0)).toBe(false);
  });
});

describe("CallBudget", () => {
  test("default budgets per tool kind", () => {
    expect(CALL_BUDGETS).toEqual({ read: 60, analyze: 150, write: 80, sync: 120 });
  });

  test("a call over its request budget stops before the next request", () => {
    const budget = new CallBudget(2);
    budget.spend();
    budget.spend();
    expect(budget.used).toBe(2);
    expect(budget.max).toBe(2);
    let thrown: unknown;
    try {
      budget.spend();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LivespaceError);
    const error = thrown as LivespaceError;
    expect(error.code).toBe("CALL_BUDGET_EXCEEDED");
    expect(error.transport).toBe(false);
    expect(error.hint).toMatch(/narrow/i);
    expect(budget.used).toBe(2);
  });

  test("a budget must be a positive integer", () => {
    for (const max of [0, -1, 1.5, Number.NaN]) {
      expect(() => new CallBudget(max)).toThrow();
    }
  });
});
