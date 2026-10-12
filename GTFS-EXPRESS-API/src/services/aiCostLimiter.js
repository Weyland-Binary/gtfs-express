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
 *
 * On top of the counts, a licensed account's envelope in money (2026-10-12,
 * accounts/store.aiAllowanceOf: the trial's TRIAL_AI_BUDGET_EUR over its days,
 * a licence's LICENCE_AI_BUDGET_EUR_MONTH over the month), summed from what
 * every call really cost (llm/aiMeter, kept in projects.db: a restart does not
 * reset it). Spent, the call is refused AI_ALLOWANCE_EXHAUSTED — 402 for the
 * trial (the licence goes on), 429 for a licence's month — and `turnCeiling`
 * keeps one planner turn within what is left, so that the envelope holds.
 */

const config = require("../config");

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const _hourlyByKey = new Map();
const _dailyByKey = new Map();
let _globalDaily = [];
// The calls nobody pays for (the trial, the free messages): their own share of the global budget.
let _unpaidDaily = [];

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
 * @param {number} [opts.dailyLimit]  — per-code 24h cap override (beta tier /
 *        per-code quota). Falls back to NL2SQL_DAILY_LIMIT_PER_CODE.
 * @param {number} [opts.hourlyLimit] — per-code 1h cap override. Falls back to
 *        the scope's configured hourly cap.
 *        NB: the GLOBAL budget is never overridable — it always reads from
 *        config so it stays the operator-wide kill-switch for every key.
 * @param {"unpaid"} [opts.pool] — the call is nobody's paid one (betaLimitsFor
 *        says it): it also counts against NL2SQL_DAILY_BUDGET_UNPAID, so that
 *        the rest of the global budget stays the paying accounts'. Refused
 *        past it with the same BUDGET_EXHAUSTED.
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
const check = ({ key, scope, dailyLimit, hourlyLimit, pool = null, allowanceOf = null } = {}) => {
  // The account's envelope in money first: spent, nothing else is counted (no slot consumed).
  const allowance = typeof allowanceOf === "function" ? allowanceOf() : null;
  if (allowance && allowance.remaining_usd <= 0) {
    const status = allowance.kind === "trial" ? 402 : 429;
    const retryAfterSec = allowance.kind === "month" && allowance.until ? Math.max(1, Math.ceil((Date.parse(allowance.until) - Date.now()) / 1000)) : null;
    return { ok: false, code: "AI_ALLOWANCE_EXHAUSTED", status, retryAfterSec, allowance: allowanceSummary(allowance) };
  }
  const k = key || "anon";
  const s = scope === "chat" ? "chat" : "nl2sql";
  const now = Date.now();

  const hourly = _trim(_hourlyByKey.get(k) || [], now - HOUR_MS);
  const daily = _trim(_dailyByKey.get(k) || [], now - DAY_MS);
  const global = _trim(_globalDaily, now - DAY_MS);
  const unpaid = pool === "unpaid" ? _trim(_unpaidDaily, now - DAY_MS) : null;
  const unpaidLimit = _resolveLimit(config.NL2SQL_DAILY_BUDGET_UNPAID);

  // Per-code caps may be raised for beta-code holders via explicit overrides
  // (resolved by the caller from the code's tier / quota). The GLOBAL budget
  // is intentionally NOT overridable — it stays the operator-wide kill-switch.
  const hourlyCap =
    hourlyLimit != null ? _resolveLimit(hourlyLimit) : _hourlyLimitFor(s);
  const dailyCap =
    dailyLimit != null
      ? _resolveLimit(dailyLimit)
      : _resolveLimit(config.NL2SQL_DAILY_LIMIT_PER_CODE);
  const globalLimit = _resolveLimit(config.NL2SQL_DAILY_BUDGET_TOTAL);

  // Persist the trimmed copies so memory doesn't grow unbounded across
  // long-lived but seldom-used keys.
  _hourlyByKey.set(k, hourly);
  _dailyByKey.set(k, daily);
  _globalDaily = global;
  if (unpaid) _unpaidDaily = unpaid;

  const snapshot = () => ({
    hourly: { used: hourly.length, limit: hourlyCap },
    daily: { used: daily.length, limit: dailyCap },
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
  // The unpaid share spent: the same answer as the whole budget, for the unpaid calls only.
  if (unpaid && unpaid.length >= unpaidLimit) {
    const retryAfterSec = Math.max(1, Math.ceil((unpaid[0] + DAY_MS - now) / 1000));
    return { ok: false, code: "BUDGET_EXHAUSTED", retryAfterSec, pool: "unpaid", ...snapshot() };
  }
  if (daily.length >= dailyCap) {
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
  if (hourly.length >= hourlyCap) {
    const retryAfterSec = Math.max(
      1,
      Math.ceil((hourly[0] + HOUR_MS - now) / 1000),
    );
    return { ok: false, code: "RATE_LIMITED", retryAfterSec, ...snapshot() };
  }

  hourly.push(now);
  daily.push(now);
  global.push(now);
  if (unpaid) {
    unpaid.push(now);
    _unpaidDaily = unpaid;
  }
  _hourlyByKey.set(k, hourly);
  _dailyByKey.set(k, daily);
  _globalDaily = global;

  return { ok: true, ...snapshot(), ...(allowance ? { allowance: allowanceSummary(allowance), remainingUsd: allowance.remaining_usd } : {}) };
};

/** The envelope as an answer says it (euros spent and allowed, its kind and end). */
const allowanceSummary = (a) => ({ kind: a.kind, limit_eur: a.limit_eur, spent_eur: Math.round((a.spent_usd / config.AI_USD_PER_EUR) * 100) / 100, until: a.until || null });

/**
 * One planner turn's ceiling in weighted tokens (llm/turnBudget): the configured one, lowered to what the account's
 * envelope has left (`limit`, check()'s answer) at the turn's model input price — so that a turn started with 0.40 €
 * left stops near 0.40 €, not at the 2 USD a full turn may cost. 0 (no configured ceiling) keeps the envelope's.
 */
const turnCeiling = (max, limit, model) => {
  const remaining = limit && Number.isFinite(limit.remainingUsd) ? limit.remainingUsd : null;
  if (remaining == null) return max;
  const price = require("./llm/prices").priceOf(model) || require("./llm/prices").FALLBACK;
  const byEnvelope = Math.max(1, Math.floor((remaining / price.input) * 1e6));
  return max > 0 ? Math.min(max, byEnvelope) : byEnvelope;
};

/**
 * The per-account AI caps of a licensed account (req.betaTester: its licence's pseudo-key `user:<id>`), ready to
 * spread into check(). A paid licence gets the licensed caps (BETA_NL2SQL_DAILY_LIMIT_PER_CODE /
 * BETA_NL2SQL_RATE_LIMIT, the names kept from the retired beta codes); the free trial (tier "trial") its own daily
 * cap (TRIAL_AI_DAILY_LIMIT) and the unpaid share of the budget; the operator's own accounts (ADMIN_EMAILS,
 * `unlimited`) no cap at all — the server-wide budget still holds for them, it is the operator's own kill-switch.
 * Without a licence: {} in the open model (check() keeps the strict config defaults), the unpaid share under the
 * paid offer (the free messages, when the owner turns them on).
 *
 * @param {?{code?: string, unlimited?: boolean, tier?: string}} tester the licensed context (req.betaTester), or null.
 */
const betaLimitsFor = (tester) => {
  if (!tester || !tester.code) return config.PAID_ACCESS_ENABLED ? { pool: "unpaid" } : {};
  if (tester.unlimited) return { dailyLimit: 0, hourlyLimit: 0 };
  const envelope = envelopeOf(tester.code);
  const allowanceOf = envelope ? { allowanceOf: envelope } : {};
  if (tester.tier === "trial") {
    const daily = config.TRIAL_AI_DAILY_LIMIT;
    return { dailyLimit: daily, hourlyLimit: Math.min(config.BETA_NL2SQL_RATE_LIMIT, daily) || daily, pool: "unpaid", ...allowanceOf };
  }
  return { dailyLimit: config.BETA_NL2SQL_DAILY_LIMIT_PER_CODE, hourlyLimit: config.BETA_NL2SQL_RATE_LIMIT, ...allowanceOf };
};

/** The envelope of the account behind a licensed key (`user:<id>`), read when the call is checked; null otherwise. */
const envelopeOf = (code) => {
  const m = /^user:(.+)$/.exec(String(code || ""));
  if (!m || !config.ACCOUNTS_ENABLED) return null;
  return () => {
    const store = require("./accounts/store");
    return store.aiAllowanceOf(store.getUserById(m[1]));
  };
};

/**
 * Whether the server-wide budget leaves room for the per-account quotas below it. The global budget is checked
 * first and never overridden, so a per-account daily quota above it can never be reached: one account alone
 * exhausts the whole server's AI, for everyone, at the global figure. The values are the owner's; this only says
 * when they contradict each other — at boot in the logs, and in GET /admin/ai-usage — so that the contradiction
 * is a decision, not an accident (DEPLOYMENT.md, "AI budget and per-account quotas").
 *
 * @param {object} [cfg] config.js, or a stand-in in the tests.
 */
const budgetConsistency = (cfg = config) => {
  const global = _resolveLimit(cfg.NL2SQL_DAILY_BUDGET_TOTAL);
  const perCode = _resolveLimit(cfg.NL2SQL_DAILY_LIMIT_PER_CODE);
  const licensed = _resolveLimit(cfg.BETA_NL2SQL_DAILY_LIMIT_PER_CODE);
  const unpaid = _resolveLimit(cfg.NL2SQL_DAILY_BUDGET_UNPAID);
  const warnings = [];
  const above = (what, name, value) => {
    if (Number.isFinite(global) && value > global) warnings.push(`${what} (${name}=${value}) is above the server-wide budget (NL2SQL_DAILY_BUDGET_TOTAL=${global}): one account reaches the global budget first and the AI stops for everyone until it frees up.`);
  };
  above("The daily AI quota without a licence", "NL2SQL_DAILY_LIMIT_PER_CODE", perCode);
  above("The daily AI quota of a licensed account", "BETA_NL2SQL_DAILY_LIMIT_PER_CODE", licensed);
  const finite = (n) => (Number.isFinite(n) ? n : null);
  if (Number.isFinite(global) && Number.isFinite(unpaid) && unpaid >= global) warnings.push(`The share of the budget nobody pays for (NL2SQL_DAILY_BUDGET_UNPAID=${unpaid}) is not below the server-wide budget (NL2SQL_DAILY_BUDGET_TOTAL=${global}): the trials and the free messages can leave the paying accounts without AI.`);
  return { global_daily: finite(global), per_code_daily: finite(perCode), licensed_daily: finite(licensed), unpaid_daily: finite(unpaid), consistent: warnings.length === 0, warnings };
};

/** Read-only view for the admin dashboard. */
const snapshot = () => {
  const now = Date.now();
  const global = _trim(_globalDaily, now - DAY_MS);
  return {
    budget: budgetConsistency(config),
    global: {
      used: global.length,
      limit: _resolveLimit(config.NL2SQL_DAILY_BUDGET_TOTAL),
    },
    unpaid: {
      used: _trim(_unpaidDaily, now - DAY_MS).length,
      limit: _resolveLimit(config.NL2SQL_DAILY_BUDGET_UNPAID),
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
  _unpaidDaily = [];
};

module.exports = { check, betaLimitsFor, turnCeiling, budgetConsistency, snapshot, _reset };
