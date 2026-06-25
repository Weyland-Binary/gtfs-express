/**
 * aiCostLimiter.test.js — unit tests for the three-tier AI cost guard.
 *
 * Three sliding windows enforced in this order on every check():
 *   1. global 24h budget across all keys
 *   2. per-key 24h cap
 *   3. per-key 1h cap (NL2SQL_RATE_LIMIT for one-shot, NL2SQL_CHAT_RATE_LIMIT
 *      for chat — the `scope` argument selects which one)
 *
 * Caps are read from env via config.js, so we set them BEFORE requiring
 * aiCostLimiter to make sure config snapshot picks them up.
 */

"use strict";

process.env.NODE_ENV = "test";
// Hourly caps must be >= daily cap on the scope you exercise, otherwise
// hourly always fires first and the daily-cap path is never reachable.
// Chat hourly (5) > daily (4) gives us a window where the daily cap can
// trigger. nl2sql hourly (3) is intentionally tighter so the hourly-cap
// test stays meaningful.
process.env.NL2SQL_RATE_LIMIT = "3";
process.env.NL2SQL_CHAT_RATE_LIMIT = "5";
process.env.NL2SQL_DAILY_LIMIT_PER_CODE = "4";
process.env.NL2SQL_DAILY_BUDGET_TOTAL = "20";
process.env.IP_HASH_SECRET = "test-ai-cost-limiter";

const aiCostLimiter = require("../services/aiCostLimiter");

describe("aiCostLimiter", () => {
  beforeEach(() => {
    aiCostLimiter._reset();
  });

  describe("happy path", () => {
    test("first call accepted, counters increment in all three windows", () => {
      const r = aiCostLimiter.check({ key: "CODE-A", scope: "nl2sql" });
      expect(r.ok).toBe(true);
      expect(r.hourly).toEqual({ used: 1, limit: 3 });
      expect(r.daily).toEqual({ used: 1, limit: 4 });
      expect(r.global).toEqual({ used: 1, limit: 20 });
    });

    test("scope=chat uses the chat-specific hourly cap", () => {
      const r = aiCostLimiter.check({ key: "CODE-A", scope: "chat" });
      expect(r.ok).toBe(true);
      expect(r.hourly.limit).toBe(5);
    });
  });

  describe("hourly per-code cap", () => {
    test("4th nl2sql call from same code returns RATE_LIMITED with retryAfterSec", () => {
      for (let i = 0; i < 3; i++) {
        const ok = aiCostLimiter.check({ key: "CODE-A", scope: "nl2sql" });
        expect(ok.ok).toBe(true);
      }
      const blocked = aiCostLimiter.check({ key: "CODE-A", scope: "nl2sql" });
      expect(blocked.ok).toBe(false);
      expect(blocked.code).toBe("RATE_LIMITED");
      expect(blocked.retryAfterSec).toBeGreaterThan(0);
      expect(blocked.retryAfterSec).toBeLessThanOrEqual(3600);
      expect(blocked.hourly.used).toBe(3);
    });

    test("rejected call does not consume a slot", () => {
      for (let i = 0; i < 3; i++)
        aiCostLimiter.check({ key: "CODE-A", scope: "nl2sql" });
      // Two more rejections must still report used=3.
      const r1 = aiCostLimiter.check({ key: "CODE-A", scope: "nl2sql" });
      const r2 = aiCostLimiter.check({ key: "CODE-A", scope: "nl2sql" });
      expect(r1.hourly.used).toBe(3);
      expect(r2.hourly.used).toBe(3);
    });
  });

  describe("per-key daily cap", () => {
    test("daily cap fires before chat hourly cap (chat hourly > daily)", () => {
      // Chat hourly = 5, daily = 4 — the 5th chat call must be blocked by
      // the daily cap (4 ≥ 4) BEFORE the chat hourly cap (5) fires. This
      // confirms the order-of-evaluation: daily check runs before hourly.
      for (let i = 0; i < 4; i++) {
        const r = aiCostLimiter.check({ key: "CODE-A", scope: "chat" });
        expect(r.ok).toBe(true);
      }
      const blocked = aiCostLimiter.check({ key: "CODE-A", scope: "chat" });
      expect(blocked.ok).toBe(false);
      expect(blocked.code).toBe("DAILY_LIMIT_REACHED");
      expect(blocked.daily).toEqual({ used: 4, limit: 4 });
    });
  });

  describe("global daily budget kill-switch", () => {
    test("budget fires when many distinct codes saturate it together", () => {
      // 20 distinct codes each making 1 call = 20 = global cap → 21st call
      // (any code) must be BUDGET_EXHAUSTED, even though no individual code
      // reached its per-code daily cap (4).
      for (let i = 0; i < 20; i++) {
        const r = aiCostLimiter.check({
          key: `CODE-${i}`,
          scope: "nl2sql",
        });
        expect(r.ok).toBe(true);
      }
      const blocked = aiCostLimiter.check({
        key: "CODE-FRESH",
        scope: "nl2sql",
      });
      expect(blocked.ok).toBe(false);
      expect(blocked.code).toBe("BUDGET_EXHAUSTED");
      expect(blocked.global.used).toBe(20);
      expect(blocked.global.limit).toBe(20);
    });
  });

  describe("key isolation", () => {
    test("two codes have independent hourly + daily counters", () => {
      for (let i = 0; i < 3; i++) {
        aiCostLimiter.check({ key: "CODE-A", scope: "nl2sql" });
      }
      // CODE-A is now at its hourly cap; CODE-B should still go through.
      const r = aiCostLimiter.check({ key: "CODE-B", scope: "nl2sql" });
      expect(r.ok).toBe(true);
      expect(r.hourly.used).toBe(1);
    });

    test("global counter is shared across keys", () => {
      const r1 = aiCostLimiter.check({ key: "CODE-A", scope: "nl2sql" });
      const r2 = aiCostLimiter.check({ key: "CODE-B", scope: "nl2sql" });
      expect(r1.global.used).toBe(1);
      expect(r2.global.used).toBe(2);
    });
  });

  describe("snapshot", () => {
    test("returns a per-code breakdown for the admin dashboard", () => {
      aiCostLimiter.check({ key: "CODE-A", scope: "nl2sql" });
      aiCostLimiter.check({ key: "CODE-A", scope: "chat" });
      aiCostLimiter.check({ key: "CODE-B", scope: "nl2sql" });

      const snap = aiCostLimiter.snapshot();
      expect(snap.global.used).toBe(3);
      expect(snap.global.limit).toBe(20);

      const a = snap.perCode.find((e) => e.key === "CODE-A");
      const b = snap.perCode.find((e) => e.key === "CODE-B");
      expect(a).toEqual({ key: "CODE-A", daily: 2, hourly: 2 });
      expect(b).toEqual({ key: "CODE-B", daily: 1, hourly: 1 });
    });
  });

  describe("anonymous fallback", () => {
    test("missing key collapses into a single bucket named 'anon'", () => {
      const r1 = aiCostLimiter.check({ key: "", scope: "nl2sql" });
      const r2 = aiCostLimiter.check({ key: null, scope: "nl2sql" });
      const r3 = aiCostLimiter.check({ key: undefined, scope: "nl2sql" });
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      expect(r3.ok).toBe(true);
      // All three calls land on the same key — used must increment to 3.
      expect(r3.hourly.used).toBe(3);
      const blocked = aiCostLimiter.check({ key: null, scope: "nl2sql" });
      expect(blocked.code).toBe("RATE_LIMITED");
    });
  });

  describe("per-code overrides (beta tier)", () => {
    test("dailyLimit override raises the per-code 24h cap", () => {
      // Default daily cap is 4; pass a higher per-code override and confirm
      // the 5th call (which would normally be DAILY_LIMIT_REACHED) succeeds.
      for (let i = 0; i < 5; i++) {
        const r = aiCostLimiter.check({
          key: "BETA-A",
          scope: "chat", // chat hourly (5) leaves room past the default daily (4)
          dailyLimit: 8,
          hourlyLimit: 8,
        });
        expect(r.ok).toBe(true);
        expect(r.daily.limit).toBe(8);
      }
    });

    test("hourlyLimit override raises the per-code 1h cap", () => {
      // Default nl2sql hourly cap is 3; override to 6.
      for (let i = 0; i < 6; i++) {
        const r = aiCostLimiter.check({
          key: "BETA-B",
          scope: "nl2sql",
          dailyLimit: 100,
          hourlyLimit: 6,
        });
        expect(r.ok).toBe(true);
        expect(r.hourly.limit).toBe(6);
      }
      const blocked = aiCostLimiter.check({
        key: "BETA-B",
        scope: "nl2sql",
        dailyLimit: 100,
        hourlyLimit: 6,
      });
      expect(blocked.code).toBe("RATE_LIMITED");
    });

    test("global budget still blocks every key even with a huge per-code override", () => {
      // Saturate the global budget (20) with distinct keys, then a call with a
      // sky-high per-code override must STILL be BUDGET_EXHAUSTED — the global
      // kill-switch is never raised per-code.
      for (let i = 0; i < 20; i++) {
        aiCostLimiter.check({ key: `seed-${i}`, scope: "nl2sql" });
      }
      const blocked = aiCostLimiter.check({
        key: "BETA-VIP",
        scope: "nl2sql",
        dailyLimit: 1000000,
        hourlyLimit: 1000000,
      });
      expect(blocked.ok).toBe(false);
      expect(blocked.code).toBe("BUDGET_EXHAUSTED");
    });
  });

  describe("betaLimitsFor", () => {
    test("returns {} for keyless / anon callers", () => {
      expect(aiCostLimiter.betaLimitsFor(null)).toEqual({});
      expect(aiCostLimiter.betaLimitsFor(undefined)).toEqual({});
      expect(aiCostLimiter.betaLimitsFor({})).toEqual({});
    });

    test("returns the beta tier defaults for a code with no quota", () => {
      // No BETA_* env set in this suite → config defaults (2000 / 300).
      const r = aiCostLimiter.betaLimitsFor({ code: "ABCD-EFGH-IJKL" });
      expect(r).toEqual({ dailyLimit: 2000, hourlyLimit: 300 });
    });

    test("per-code quota overrides the tier default", () => {
      const r = aiCostLimiter.betaLimitsFor({
        code: "ABCD-EFGH-IJKL",
        quota: { dailyAi: 5000 },
      });
      expect(r.dailyLimit).toBe(5000);
      expect(r.hourlyLimit).toBe(300); // unspecified → tier default
    });
  });
});
