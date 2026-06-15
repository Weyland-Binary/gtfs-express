/**
 * aiCostLimiter — three-tier cost guard for Anthropic-backed endpoints.
 *
 * Layered windows (sliding):
 *   1. global daily — total Claude calls across ALL beta codes per 24h.
 *      Hard kill-switch budget. When hit, every code is blocked until the
 *      oldest call ages out. Protects the operator's wallet against runaway
 *      usage (compromised code, scripted client, upstream feedback loops).
 *   2. per-code daily — quota assigned to each beta code per 24h. Encourages
 *      fair sharing across testers and caps any single code's cost.
 *   3. per-code hourly — short-window burst guard, identical to the chat
 *      service's previous in-house limiter (kept for parity).
 *
 * Caller passes `scope` = "nl2sql" | "chat" so the right hourly cap is read
 * from config (`NL2SQL_RATE_LIMIT` for one-shot, `NL2SQL_CHAT_RATE_LIMIT`
 * for the streaming chat). Daily and global caps are shared.
 *
 * State is in-memory (per process). A restart resets every counter — that's
 * intentional: persisting across restarts adds operational complexity and
 * the windows are short enough that restart-induced over-spend is bounded.
 */

const config = require("../config");

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const _hourlyByKey = new Map();
const _dailyByKey = new Map();
let _globalDaily = [];

const _trim = (arr, cutoff) => {
  let head = 0;
  while (head < arr.length && arr[head] < cutoff) head++;
  return head > 0 ? arr.slice(head) : arr;
};

const _resolveLimit = (raw) =>
  Number.isFinite(raw) && raw > 0 ? raw : Infinity;

const _hourlyLimitFor = (scope) =>
  _resolveLimit(
    scope === "chat" ? config.NL2SQL_CHAT_RATE_LIMIT : config.NL2SQL_RATE_LIMIT,
  );

/**
 * Atomically check + record one AI call against all three tiers.
 *
 * @param {object} opts
 * @param {string} opts.key   — beta code (or `anon:<sessionId>` fallback).
 * @param {"nl2sql"|"chat"} opts.scope — selects the hourly limit to apply.
 * @returns {{ok: boolean, code?: string, retryAfterSec?: number,
 *            hourly: {used:number, limit:number},
 *            daily: {used:number, limit:number},
 *            global: {used:number, limit:number}}}
 *
 * On `ok: false` no slot is consumed. On `ok: true` the call is counted
 * in all three windows. The error code surfaces which tier blocked:
 *   • "BUDGET_EXHAUSTED"      — global cap reached
 *   • "DAILY_LIMIT_REACHED"   — per-code 24h cap reached
 *   • "RATE_LIMITED"          — per-code 1h cap reached (legacy code, kept
 *                               so existing chat clients keep working)
 */
const check = ({ key, scope }) => {
  const k = key || "anon";
  const s = scope === "chat" ? "chat" : "nl2sql";
  const now = Date.now();

  const hourly = _trim(_hourlyByKey.get(k) || [], now - HOUR_MS);
  const daily = _trim(_dailyByKey.get(k) || [], now - DAY_MS);
  const global = _trim(_globalDaily, now - DAY_MS);

  const hourlyLimit = _hourlyLimitFor(s);
  const dailyLimit = _resolveLimit(config.NL2SQL_DAILY_LIMIT_PER_CODE);
  const globalLimit = _resolveLimit(config.NL2SQL_DAILY_BUDGET_TOTAL);

  // Persist the trimmed copies so memory doesn't grow unbounded across
  // long-lived but seldom-used keys.
  _hourlyByKey.set(k, hourly);
  _dailyByKey.set(k, daily);
  _globalDaily = global;

  const snapshot = () => ({
    hourly: { used: hourly.length, limit: hourlyLimit },
    daily: { used: daily.length, limit: dailyLimit },
    global: { used: global.length, limit: globalLimit },
  });

  // Order matters: report the strictest blocker first so the client knows
  // the soonest-to-recover window — and so a budget freeze isn't masked
  // behind a per-code daily cap that would otherwise unblock sooner.
  if (global.length >= globalLimit) {
    const retryAfterSec = Math.max(
      1,
      Math.ceil((global[0] + DAY_MS - now) / 1000),
    );
    return { ok: false, code: "BUDGET_EXHAUSTED", retryAfterSec, ...snapshot() };
  }
  if (daily.length >= dailyLimit) {
    const retryAfterSec = Math.max(
      1,
      Math.ceil((daily[0] + DAY_MS - now) / 1000),
    );
    return {
      ok: false,
      code: "DAILY_LIMIT_REACHED",
      retryAfterSec,
      ...snapshot(),
    };
  }
  if (hourly.length >= hourlyLimit) {
    const retryAfterSec = Math.max(
      1,
      Math.ceil((hourly[0] + HOUR_MS - now) / 1000),
    );
    return { ok: false, code: "RATE_LIMITED", retryAfterSec, ...snapshot() };
  }

  hourly.push(now);
  daily.push(now);
  global.push(now);
  _hourlyByKey.set(k, hourly);
  _dailyByKey.set(k, daily);
  _globalDaily = global;

  return { ok: true, ...snapshot() };
};

/** Read-only view for the admin dashboard. */
const snapshot = () => {
  const now = Date.now();
  const global = _trim(_globalDaily, now - DAY_MS);
  return {
    global: {
      used: global.length,
      limit: _resolveLimit(config.NL2SQL_DAILY_BUDGET_TOTAL),
    },
    perCode: Array.from(_dailyByKey.entries()).map(([key, ts]) => ({
      key,
      daily: _trim(ts, now - DAY_MS).length,
      hourly: _trim(_hourlyByKey.get(key) || [], now - HOUR_MS).length,
    })),
  };
};

/** Test-only — wipe state between cases. */
const _reset = () => {
  _hourlyByKey.clear();
  _dailyByKey.clear();
  _globalDaily = [];
};

module.exports = { check, snapshot, _reset };
