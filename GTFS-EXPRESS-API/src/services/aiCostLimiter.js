/**
 * The AI endpoints' cost guard: sliding windows per key (a global daily kill-switch, a per-key daily quota, a per-key
 * hourly burst cap, and the unpaid calls' own share of the global budget), then an account's envelope in money
 * (llm/aiMeter, persisted). The counts are in memory: a restart resets them, and the windows are short enough to bound it.
 */

const config = require("../config");

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const _hourlyByKey = new Map();
const _dailyByKey = new Map();
let _globalDaily = [];
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

// Never a session id or a header: a client changes those at will, and a key changed on every request has no cap.
const anonymousKey = (req) => `anon:${require("./eventLogger").hashIp(req?.ip || "unknown")}`;

/**
 * Check and record one call against every tier; a refusal consumes no slot. `dailyLimit` / `hourlyLimit` override
 * the per-key caps (betaLimitsFor); the global budget is never overridable. `pool: "unpaid"` also counts the call
 * against NL2SQL_DAILY_BUDGET_UNPAID.
 */
const check = ({ key, scope, dailyLimit, hourlyLimit, pool = null, allowanceOf = null } = {}) => {
  // The envelope first: spent, nothing else is counted.
  const allowance = typeof allowanceOf === "function" ? allowanceOf() : null;
  const spent = allowanceRefusal(allowance);
  if (spent) return spent;
  const k = key || "anon";
  const s = scope === "chat" ? "chat" : "nl2sql";
  const now = Date.now();

  const hourly = _trim(_hourlyByKey.get(k) || [], now - HOUR_MS);
  const daily = _trim(_dailyByKey.get(k) || [], now - DAY_MS);
  const global = _trim(_globalDaily, now - DAY_MS);
  const unpaid = pool === "unpaid" ? _trim(_unpaidDaily, now - DAY_MS) : null;
  const unpaidLimit = _resolveLimit(config.NL2SQL_DAILY_BUDGET_UNPAID);

  const hourlyCap =
    hourlyLimit != null ? _resolveLimit(hourlyLimit) : _hourlyLimitFor(s);
  const dailyCap =
    dailyLimit != null
      ? _resolveLimit(dailyLimit)
      : _resolveLimit(config.NL2SQL_DAILY_LIMIT_PER_CODE);
  const globalLimit = _resolveLimit(config.NL2SQL_DAILY_BUDGET_TOTAL);

  // Keep the trimmed copies so memory does not grow across seldom-used keys.
  _hourlyByKey.set(k, hourly);
  _dailyByKey.set(k, daily);
  _globalDaily = global;
  if (unpaid) _unpaidDaily = unpaid;

  const snapshot = () => ({
    hourly: { used: hourly.length, limit: hourlyCap },
    daily: { used: daily.length, limit: dailyCap },
    global: { used: global.length, limit: globalLimit },
  });

  // The strictest blocker first, so that a budget freeze is never masked by a per-key cap that recovers sooner.
  if (global.length >= globalLimit) {
    const retryAfterSec = Math.max(
      1,
      Math.ceil((global[0] + DAY_MS - now) / 1000),
    );
    return { ok: false, code: "BUDGET_EXHAUSTED", retryAfterSec, ...snapshot() };
  }
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

/** 429 for a licence's month, 402 otherwise (the trial, the reading companion: the offer leads on); null while it holds. */
const allowanceRefusal = (allowance) => {
  if (!allowance || allowance.remaining_usd > 0) return null;
  const status = allowance.kind === "month" ? 429 : 402;
  const retryAfterSec = (allowance.kind === "month" || allowance.kind === "reader") && allowance.until ? Math.max(1, Math.ceil((Date.parse(allowance.until) - Date.now()) / 1000)) : null;
  return { ok: false, code: "AI_ALLOWANCE_EXHAUSTED", status, retryAfterSec, allowance: allowanceSummary(allowance) };
};

const allowanceSummary = (a) => ({ kind: a.kind, limit_eur: a.limit_eur, spent_eur: Math.round((a.spent_usd / config.AI_USD_PER_EUR) * 100) / 100, until: a.until || null });

/**
 * The turn's ceiling in weighted tokens (llm/turnBudget), lowered to what the envelope has left at the model's input
 * price, so that a turn started with 0.40 € left stops near 0.40 €. A configured 0 keeps the envelope's.
 */
const turnCeiling = (max, limit, model) => {
  const remaining = limit && Number.isFinite(limit.remainingUsd) ? limit.remainingUsd : null;
  if (remaining == null) return max;
  const price = require("./llm/prices").priceOf(model) || require("./llm/prices").FALLBACK;
  const byEnvelope = Math.max(1, Math.floor((remaining / price.input) * 1e6));
  return max > 0 ? Math.min(max, byEnvelope) : byEnvelope;
};

/**
 * The caps of a licensed context (req.betaTester): the licensed caps for a licence, the trial's daily cap and the
 * unpaid share for a trial, none for the operator's own accounts (the global budget still holds). Without a licence,
 * the unpaid share under the paid offer, else the strict defaults.
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

// The reading companion's calls: nobody pays for them, so the unpaid share and the companion's own envelope.
const readerLimitsFor = (userId) => ({
  pool: "unpaid",
  allowanceOf: () => {
    const store = require("./accounts/store");
    return store.readerAllowanceOf(store.getUserById(userId));
  },
});

const envelopeOf = (code) => {
  const m = /^user:(.+)$/.exec(String(code || ""));
  if (!m || !config.ACCOUNTS_ENABLED) return null;
  return () => {
    const store = require("./accounts/store");
    return store.aiAllowanceOf(store.getUserById(m[1]));
  };
};

/**
 * Whether the global budget leaves room for the per-account quotas: it is checked first and never overridden, so a
 * quota above it lets one account stop the AI for everyone. Reported at boot and in GET /admin/ai-usage.
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

const _reset = () => {
  _hourlyByKey.clear();
  _dailyByKey.clear();
  _globalDaily = [];
  _unpaidDaily = [];
};

module.exports = { check, anonymousKey, allowanceRefusal, betaLimitsFor, readerLimitsFor, turnCeiling, budgetConsistency, snapshot, _reset };
