/**
 * admin/adminConsole — the operator's console (/gtfs/admin/*, behind middleware/adminGate): what it reads, one
 * handler per screen, every answer computed on demand from the stores (never cached: the operator reads now).
 *
 *   GET  /admin/me                   who is signed in to the console, and what the server runs (flags, providers)
 *   GET  /admin/overview?days=       the period's figures (accounts, licences, AI, API, work, health) and what needs
 *                                    the operator (« attention »: quotes to answer, trials ending, envelopes spent…)
 *   GET  /admin/users/:id            one account in full: licence, AI and API use, devices, projects, events, mails
 *   POST /admin/users/:id/logout     end every session of an account
 *   GET  /admin/usage/ai?days=       the AI's cost per day, function, model and account; the limiter's live state
 *   GET  /admin/usage/api?days=      the API's calls per day, route and account, their refusals and time
 *   GET  /admin/errors?days=         the server errors answered (route, status, CODE, account)
 *   GET  /admin/billing              subscriptions, trials, grants, the provider's events
 *   GET  /admin/quotes               the quotes asked; PATCH /admin/quotes/:id { status, note }
 *   GET  /admin/projects             every project (owner, network, versions, deliveries, size)
 *   GET  /admin/events?type=&user=&q=&before=&limit=   the event log, newest first, filtered on the server
 *   GET  /admin/audit                the administrator's own acts
 *   GET  /admin/mail                 the e-mails sent or refused (kind, address masked, account), newest first
 *   DELETE /admin/sessions/:id       end a working copy now (its snapshot taken first, as the sweep does)
 *
 * An AI call made before the console counted functions has none: it is listed as « unattributed ».
 *
 * Accounts off: the account, AI, API, billing and quote screens answer 503 ACCOUNTS_DISABLED (the console says so);
 * the event log, the projects and the sessions stay readable. Amounts are in USD as the provider bills them, with
 * their EUR (AI_USD_PER_EUR) beside them. Everything here is the operator's own data: nothing reaches a model.
 */

"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const readline = require("readline");
const config = require("../../config");
const opsData = require("./opsData");
const usageLedger = require("./usageLedger");

const DAY_MS = 24 * 60 * 60 * 1000;
const ROLES = ["authority", "operator", "consultancy", "other"];

const noStore = (res) => res.setHeader("Cache-Control", "no-store");
const accountsOff = (res) => res.status(503).json({ error: "ACCOUNTS_DISABLED", message: "Accounts are off on this server." });
const store = () => require("../accounts/store");
const eurOf = (usd) => (Number(usd) || 0) / (config.AI_USD_PER_EUR || 1);
const round = (n, d = 4) => Math.round((Number(n) || 0) * 10 ** d) / 10 ** d;

/** The period a screen reads: `days` (1 to 365, 30 by default), its start, and the period before it. */
const periodOf = (req, now = Date.now()) => {
  const asked = parseInt(req.query && req.query.days, 10);
  const days = Number.isFinite(asked) ? Math.min(Math.max(asked, 1), 365) : 30;
  const since = new Date(now - days * DAY_MS);
  const prevSince = new Date(now - 2 * days * DAY_MS);
  return { days, since: since.toISOString(), until: new Date(now).toISOString(), prev_since: prevSince.toISOString(), sinceDay: since.toISOString().slice(0, 10), prevDay: prevSince.toISOString().slice(0, 10) };
};

/** The days of a period, oldest first, as YYYY-MM-DD (the charts' axis, every day present). */
const daysOf = (period) => {
  const out = [];
  for (let t = Date.parse(`${period.sinceDay}T00:00:00Z`); t <= Date.parse(period.until); t += DAY_MS) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};

/** The accounts by id, for naming the rows of a usage table (id → { email, display_name, organisation }). */
const accountIndex = () => {
  const rows = store().getDb().prepare("SELECT id, email, display_name, organisation, disabled FROM users").all();
  return new Map(rows.map((r) => [r.id, { email: r.email, display_name: r.display_name || null, organisation: r.organisation || null, disabled: Boolean(r.disabled) }]));
};
const named = (index, userId) => (userId ? { user_id: userId, ...(index.get(userId) || { email: null, display_name: null, organisation: null, deleted: true }) } : { user_id: null, email: null, display_name: null, organisation: null });

const workspace = () => {
  try {
    const ws = require("../workspace/workspaceStore");
    return ws.enabled() && ws.exists() ? ws : null;
  } catch {
    return null;
  }
};

// ── Who is signed in ───────────────────────────────────────────────────────

const me = (req, res) => {
  noStore(res);
  let operator = null;
  if (req.admin && req.admin.via === "account" && config.ACCOUNTS_ENABLED) {
    const user = store().getUserById(req.admin.user_id);
    operator = user ? { email: user.email, display_name: user.display_name || null } : null;
  }
  res.json({
    via: req.admin ? req.admin.via : "token",
    operator,
    server: {
      env: process.env.NODE_ENV || "development",
      node: process.version,
      started_at: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      accounts: Boolean(config.ACCOUNTS_ENABLED),
      paid: Boolean(config.PAID_ACCESS_ENABLED),
      workspace: Boolean(config.WORKSPACE_ENABLED),
      network_studio: Boolean(config.NETWORK_STUDIO_ENABLED),
      mail_provider: config.MAIL_PROVIDER || null,
      ai_provider: config.LLM_PROVIDER || null,
      max_sessions: config.MAX_SESSIONS,
      log_retention_days: config.LOG_RETENTION_DAYS,
      quote_retention_days: opsData.QUOTE_RETENTION_DAYS,
      prices: { year_eur: config.LICENCE_PRICE_EUR_YEAR, month_eur: config.LICENCE_PRICE_EUR_MONTH },
      envelopes: { trial_eur: config.TRIAL_AI_BUDGET_EUR, licence_month_eur: config.LICENCE_AI_BUDGET_EUR_MONTH, reader_month_eur: config.READER_AI_BUDGET_EUR_MONTH, reader_questions_month: config.READER_AI_QUESTIONS_MONTH },
      trial_days: config.TRIAL_DAYS,
    },
  });
};

// ── Licences, computed once per request ────────────────────────────────────

/** Every account with its licence and AI envelope now (one pass: the overview, billing and attention read it). */
const accountsWithLicence = (now = Date.now()) => {
  const s = store();
  return s.listUsers().map((user) => {
    const sub = s.subscriptionOf(user.id);
    const licence = s.licenceOf(user, sub, now);
    const allowance = s.publicAllowance(s.aiAllowanceOf(user, sub, now));
    return { user, sub, licence, allowance };
  });
};

const attentionOf = (rows, now = Date.now()) => {
  const items = [];
  const soon = (iso, days) => iso && Date.parse(iso) > now && Date.parse(iso) - now <= days * DAY_MS;
  const who = ({ user }) => ({ user_id: user.id, email: user.email, display_name: user.display_name || null, organisation: user.organisation || null });
  const quotes = opsData.listQuotes().filter((q) => q.status === "new");
  if (quotes.length) items.push({ kind: "quotes_new", severity: "action", count: quotes.length, items: quotes.slice(0, 5).map((q) => ({ id: q.id, organisation: q.organisation, name: q.name, at: q.at })) });
  const trialsEnding = rows.filter((r) => r.licence.active && r.licence.source === "trial" && soon(r.licence.until, 3));
  if (trialsEnding.length) items.push({ kind: "trials_ending", severity: "info", count: trialsEnding.length, items: trialsEnding.map((r) => ({ ...who(r), until: r.licence.until })) });
  const grantsEnding = rows.filter((r) => r.licence.active && r.licence.source === "admin" && soon(r.licence.until, 30));
  if (grantsEnding.length) items.push({ kind: "grants_ending", severity: "action", count: grantsEnding.length, items: grantsEnding.map((r) => ({ ...who(r), until: r.licence.until })) });
  const cancelling = rows.filter((r) => r.sub && store().isEntitledSubscription(r.sub) && r.sub.cancel_at_period_end);
  if (cancelling.length) items.push({ kind: "subscriptions_cancelling", severity: "info", count: cancelling.length, items: cancelling.map((r) => ({ ...who(r), until: r.sub.current_period_end })) });
  const pastDue = rows.filter((r) => r.sub && r.sub.status === "past_due");
  if (pastDue.length) items.push({ kind: "payments_failing", severity: "action", count: pastDue.length, items: pastDue.map(who) });
  const spent = rows.filter((r) => r.allowance && r.allowance.exhausted);
  if (spent.length) items.push({ kind: "allowance_exhausted", severity: "info", count: spent.length, items: spent.map((r) => ({ ...who(r), kind: r.allowance.kind, limit_eur: r.allowance.limit_eur })) });
  const errors = store().getDb().prepare("SELECT COUNT(*) AS n FROM server_errors WHERE at >= ?").get(new Date(now - DAY_MS).toISOString()).n;
  if (errors) items.push({ kind: "server_errors", severity: "alert", count: errors });
  const active = require("../sessionManager").getActiveSessionsCount();
  if (active >= Math.ceil(config.MAX_SESSIONS * 0.8)) items.push({ kind: "capacity", severity: active >= config.MAX_SESSIONS ? "alert" : "action", count: active, limit: config.MAX_SESSIONS });
  const budget = require("../aiCostLimiter").snapshot().global;
  if (budget && budget.limit && budget.used >= budget.limit * 0.8) items.push({ kind: "ai_budget", severity: budget.used >= budget.limit ? "alert" : "action", count: budget.used, limit: budget.limit });
  return items;
};

// ── Overview ───────────────────────────────────────────────────────────────

const overview = (req, res) => {
  noStore(res);
  if (!config.ACCOUNTS_ENABLED) return accountsOff(res);
  usageLedger.flush();
  const now = Date.now();
  const period = periodOf(req, now);
  const db = store().getDb();
  const rows = accountsWithLicence(now);
  const index = accountIndex();

  const activeIn = (sinceIso, untilIso, sinceDay, untilDay) =>
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT id AS u FROM users WHERE last_login_at >= ? AND last_login_at < ?
           UNION SELECT user_id FROM user_sessions WHERE last_seen_at >= ? AND last_seen_at < ?
           UNION SELECT user_id FROM api_usage WHERE user_id <> '' AND day >= ? AND day < ?)`,
      )
      .get(sinceIso, untilIso, sinceIso, untilIso, sinceDay, untilDay).n;
  const tomorrow = new Date(now + DAY_MS).toISOString().slice(0, 10);
  const bySource = { owner: 0, subscription: 0, admin: 0, trial: 0 };
  for (const r of rows) if (r.licence.active && bySource[r.licence.source] !== undefined) bySource[r.licence.source] += 1;
  const trialsStarted = rows.filter((r) => r.user.trial_started_at && r.user.trial_started_at >= period.since);
  const trialsConverted = rows.filter((r) => r.user.trial_started_at && r.licence.active && (r.licence.source === "subscription" || r.licence.source === "admin"));
  const trialsEver = rows.filter((r) => r.user.trial_started_at);
  const trialsEnded = trialsEver.filter((r) => r.user.trial_until && Date.parse(r.user.trial_until) <= now);

  const ai = db.prepare("SELECT COALESCE(SUM(usd), 0) AS usd, COUNT(*) AS calls FROM ai_usage WHERE at >= ?").get(period.since);
  const aiPrev = db.prepare("SELECT COALESCE(SUM(usd), 0) AS usd FROM ai_usage WHERE at >= ? AND at < ?").get(period.prev_since, period.since);
  const aiDays = new Map(db.prepare("SELECT substr(at, 1, 10) AS day, SUM(usd) AS usd FROM ai_usage WHERE at >= ? GROUP BY day").all(period.since).map((r) => [r.day, r.usd]));
  const aiFeatures = db.prepare("SELECT COALESCE(feature, 'unattributed') AS feature, SUM(usd) AS usd, COUNT(*) AS calls FROM ai_usage WHERE at >= ? GROUP BY 1 ORDER BY usd DESC").all(period.since);
  const api = db.prepare("SELECT COALESCE(SUM(calls), 0) AS calls, COALESCE(SUM(server_errors), 0) AS errors, COALESCE(SUM(rate_limited), 0) AS limited, COALESCE(SUM(client_errors), 0) AS refused FROM api_usage WHERE day >= ?").get(period.sinceDay);
  const apiPrev = db.prepare("SELECT COALESCE(SUM(calls), 0) AS calls FROM api_usage WHERE day >= ? AND day < ?").get(period.prevDay, period.sinceDay);
  const apiDays = new Map(db.prepare("SELECT day, SUM(calls) AS calls, SUM(server_errors) AS errors FROM api_usage WHERE day >= ? GROUP BY day").all(period.sinceDay).map((r) => [r.day, r]));

  const top = db
    .prepare(
      `SELECT u AS user_id, SUM(usd) AS usd, SUM(calls) AS calls FROM (
         SELECT user_id AS u, usd, 0 AS calls FROM ai_usage WHERE at >= ? AND user_id IS NOT NULL
         UNION ALL SELECT user_id, 0, calls FROM api_usage WHERE day >= ? AND user_id <> '')
       GROUP BY u ORDER BY usd DESC, calls DESC LIMIT 8`,
    )
    .all(period.since, period.sinceDay)
    .map((r) => ({ ...named(index, r.user_id), usd: round(r.usd), eur: round(eurOf(r.usd)), calls: r.calls }));

  let work = null;
  const ws = workspace();
  if (ws) {
    const wdb = ws.db();
    work = {
      projects: wdb.prepare("SELECT COUNT(*) AS n FROM projects").get().n,
      projects_created: wdb.prepare("SELECT COUNT(*) AS n FROM projects WHERE created_at >= ?").get(period.since).n,
      projects_active: wdb.prepare("SELECT COUNT(*) AS n FROM projects WHERE updated_at >= ?").get(period.since).n,
      versions_applied: wdb.prepare("SELECT COUNT(*) AS n FROM versions WHERE kind IN ('applied', 'built') AND created_at >= ?").get(period.since).n,
      deliveries: wdb.prepare("SELECT COUNT(*) AS n FROM versions WHERE delivered = 1 AND created_at >= ?").get(period.since).n,
    };
  }

  const perf = require("../perfStats").summarize();
  const sampled = perf.routes.reduce((n, r) => n + r.count, 0);
  const slow = perf.routes.filter((r) => r.count >= 5).sort((a, b) => b.p95 - a.p95)[0] || null;

  res.json({
    period,
    accounts: {
      total: rows.length,
      new: rows.filter((r) => r.user.created_at && r.user.created_at >= period.since).length,
      new_prev: rows.filter((r) => r.user.created_at && r.user.created_at >= period.prev_since && r.user.created_at < period.since).length,
      active: activeIn(period.since, new Date(now + DAY_MS).toISOString(), period.sinceDay, tomorrow),
      active_prev: activeIn(period.prev_since, period.since, period.prevDay, period.sinceDay),
      disabled: rows.filter((r) => r.user.disabled).length,
    },
    licences: {
      active: Object.values(bySource).reduce((a, b) => a + b, 0),
      by_source: bySource,
      trials_started: trialsStarted.length,
      trials_running: bySource.trial,
      trials_converted: trialsConverted.length,
      trials_ended: trialsEnded.length,
      conversion_rate: trialsEver.length ? round(trialsConverted.length / trialsEver.length, 3) : null,
    },
    ai: {
      usd: round(ai.usd),
      eur: round(eurOf(ai.usd)),
      usd_prev: round(aiPrev.usd),
      calls: ai.calls,
      by_feature: aiFeatures.map((r) => ({ feature: r.feature, usd: round(r.usd), eur: round(eurOf(r.usd)), calls: r.calls })),
      by_day: daysOf(period).map((day) => ({ day, usd: round(aiDays.get(day) || 0) })),
    },
    api: {
      calls: api.calls,
      calls_prev: apiPrev.calls,
      server_errors: api.errors,
      rate_limited: api.limited,
      refused: api.refused,
      by_day: daysOf(period).map((day) => ({ day, calls: apiDays.get(day)?.calls || 0, errors: apiDays.get(day)?.errors || 0 })),
    },
    work,
    health: {
      active_sessions: require("../sessionManager").getActiveSessionsCount(),
      max_sessions: config.MAX_SESSIONS,
      uptime_s: Math.round(process.uptime()),
      memory_rss: process.memoryUsage().rss,
      requests_sampled: sampled,
      slowest: slow ? { route: slow.route, p95: round(slow.p95, 1), count: slow.count } : null,
      server_errors_24h: db.prepare("SELECT COUNT(*) AS n FROM server_errors WHERE at >= ?").get(new Date(now - DAY_MS).toISOString()).n,
    },
    top_accounts: top,
    attention: attentionOf(rows, now),
  });
};

// ── The accounts ───────────────────────────────────────────────────────────

/** The listing's extras for every account at once: its projects, its calls over 30 days, its last activity. */
const listingExtras = () => {
  const db = store().getDb();
  const since = new Date(Date.now() - 30 * DAY_MS).toISOString().slice(0, 10);
  const calls = new Map(db.prepare("SELECT user_id, SUM(calls) AS calls, MAX(day) AS last_day FROM api_usage WHERE user_id <> '' AND day >= ? GROUP BY user_id").all(since).map((r) => [r.user_id, r]));
  const seen = new Map(db.prepare("SELECT user_id, MAX(last_seen_at) AS seen, COUNT(*) AS devices FROM user_sessions GROUP BY user_id").all().map((r) => [r.user_id, r]));
  const month = store().monthKeyOf();
  const reader = new Map(db.prepare("SELECT user_id, count FROM reader_questions WHERE month = ?").all(month).map((r) => [r.user_id, r.count]));
  const projects = new Map();
  const ws = workspace();
  if (ws) {
    for (const r of ws.db().prepare("SELECT owner_user_id AS u, COUNT(*) AS n, MAX(updated_at) AS updated FROM projects WHERE owner_user_id IS NOT NULL GROUP BY owner_user_id").all()) projects.set(r.u, { projects: r.n, updated: r.updated });
    for (const r of ws.db().prepare("SELECT p.owner_user_id AS u, COUNT(*) AS n FROM versions v JOIN projects p ON p.id = v.project_id WHERE v.delivered = 1 AND p.owner_user_id IS NOT NULL GROUP BY p.owner_user_id").all()) {
      projects.set(r.u, { ...(projects.get(r.u) || { projects: 0, updated: null }), deliveries: r.n });
    }
  }
  return (user) => {
    const c = calls.get(user.id);
    const sess = seen.get(user.id);
    const p = projects.get(user.id) || {};
    const last = [user.last_login_at, sess && sess.seen, c && c.last_day ? `${c.last_day}T00:00:00.000Z` : null, p.updated].filter(Boolean).sort().pop() || null;
    return { calls_30d: c ? c.calls : 0, devices: sess ? sess.devices : 0, last_active_at: last, projects: p.projects || 0, deliveries: p.deliveries || 0, reader_questions_month: reader.get(user.id) || 0, language: user.language, site_origin: user.site_origin };
  };
};

/** GET /admin/users: every account, with what the console lists of it (no hash). */
const listUsers = (req, res) => {
  noStore(res);
  const extras = listingExtras();
  const users = store()
    .listUsers()
    .map((u) => {
      const out = store().adminUser(u);
      return { ...out, ...extras(u), ai_eur: { month: round(eurOf(out.ai_usd.month)), total: round(eurOf(out.ai_usd.total)) } };
    });
  return res.json({ users, roles: ROLES, ts: new Date().toISOString() });
};

/** GET /admin/users/:id — one account in full. */
const userDetail = async (req, res, next) => {
  try {
    noStore(res);
    usageLedger.flush();
    const user = store().getUserById(req.params.id);
    if (!user) return res.status(404).json({ error: "USER_NOT_FOUND", message: "No account with this id." });
    const db = store().getDb();
    const id = user.id;
    const since30 = new Date(Date.now() - 30 * DAY_MS).toISOString().slice(0, 10);
    const ai = {
      total: db.prepare("SELECT COALESCE(SUM(usd), 0) AS usd, COUNT(*) AS calls, COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens FROM ai_usage WHERE user_id = ?").get(id),
      by_month: db.prepare("SELECT substr(at, 1, 7) AS month, SUM(usd) AS usd, COUNT(*) AS calls FROM ai_usage WHERE user_id = ? GROUP BY month ORDER BY month DESC LIMIT 12").all(id),
      by_feature: db.prepare("SELECT COALESCE(feature, 'unattributed') AS feature, SUM(usd) AS usd, COUNT(*) AS calls FROM ai_usage WHERE user_id = ? GROUP BY 1 ORDER BY usd DESC").all(id),
      by_model: db.prepare("SELECT COALESCE(model, '?') AS model, SUM(usd) AS usd, COUNT(*) AS calls FROM ai_usage WHERE user_id = ? GROUP BY 1 ORDER BY usd DESC").all(id),
    };
    for (const list of [ai.by_month, ai.by_feature, ai.by_model]) for (const r of list) Object.assign(r, { usd: round(r.usd), eur: round(eurOf(r.usd)) });
    ai.total = { ...ai.total, usd: round(ai.total.usd), eur: round(eurOf(ai.total.usd)) };
    const api = {
      total: db.prepare("SELECT COALESCE(SUM(calls), 0) AS calls, COALESCE(SUM(client_errors), 0) AS refused, COALESCE(SUM(rate_limited), 0) AS rate_limited, COALESCE(SUM(server_errors), 0) AS server_errors FROM api_usage WHERE user_id = ? AND day >= ?").get(id, since30),
      by_day: db.prepare("SELECT day, SUM(calls) AS calls FROM api_usage WHERE user_id = ? AND day >= ? GROUP BY day ORDER BY day").all(id, since30),
      routes: db.prepare("SELECT route, SUM(calls) AS calls, SUM(client_errors) AS refused, SUM(rate_limited) AS rate_limited, SUM(server_errors) AS server_errors, SUM(ms_total) / MAX(SUM(calls), 1) AS avg_ms FROM api_usage WHERE user_id = ? AND day >= ? GROUP BY route ORDER BY calls DESC LIMIT 40").all(id, since30).map((r) => ({ ...r, avg_ms: round(r.avg_ms, 1) })),
    };
    const sessions = db.prepare("SELECT created_at, last_seen_at, expires_at, user_agent_hash AS device FROM user_sessions WHERE user_id = ? ORDER BY last_seen_at DESC").all(id);
    let projects = [];
    const ws = workspace();
    if (ws) projects = projectRows(ws, "WHERE p.owner_user_id = ? OR p.id IN (SELECT project_id FROM project_members WHERE user_id = ?)", [id, id]).map((p) => ({ ...p, role: p.owner_user_id === id ? "owner" : "member" }));
    const events = (await readEvents({ user: id, limit: 60 })).events;
    const month = store().readerQuestionsOf(id, config.READER_AI_QUESTIONS_MONTH);
    return res.json({
      user: { ...store().adminUser(user), language: user.language, site_origin: user.site_origin, email_verified_at: user.email_verified_at, trial_reminded_at: user.trial_reminded_at, trial_ended_mailed_at: user.trial_ended_mailed_at },
      ai,
      reader: month,
      api,
      sessions,
      projects,
      events,
      mails: opsData.listMail({ userId: id, limit: 30 }),
      audit: opsData.listAdminActions({ target: id, limit: 30 }).map((a) => ({ ...a, actor: a.actor_user_id ? named(accountIndex(), a.actor_user_id).email : null })),
    });
  } catch (err) {
    return next(err);
  }
};

/** POST /admin/users/:id/logout — every session of the account ends; its devices sign in again by a code. */
const logoutUser = (req, res) => {
  noStore(res);
  const user = store().getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: "USER_NOT_FOUND", message: "No account with this id." });
  const ended = store().deleteSessionsForUser(user.id);
  opsData.logAdminAction(req.admin, "account.logout", user.id, { sessions: ended });
  return res.json({ ended });
};

// ── Usage ──────────────────────────────────────────────────────────────────

const aiUsage = (req, res) => {
  noStore(res);
  if (!config.ACCOUNTS_ENABLED) return accountsOff(res);
  const period = periodOf(req);
  const db = store().getDb();
  const index = accountIndex();
  const totals = db
    .prepare(
      `SELECT COALESCE(SUM(usd), 0) AS usd, COUNT(*) AS calls, COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens, COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
              COALESCE(SUM(CASE WHEN user_id IS NULL THEN usd ELSE 0 END), 0) AS anonymous_usd FROM ai_usage WHERE at >= ?`,
    )
    .get(period.since);
  const prev = db.prepare("SELECT COALESCE(SUM(usd), 0) AS usd FROM ai_usage WHERE at >= ? AND at < ?").get(period.prev_since, period.since).usd;
  const dayRows = db.prepare("SELECT substr(at, 1, 10) AS day, COALESCE(feature, 'unattributed') AS feature, SUM(usd) AS usd FROM ai_usage WHERE at >= ? GROUP BY day, 2").all(period.since);
  const byDay = new Map(daysOf(period).map((day) => [day, { day, total: 0 }]));
  for (const r of dayRows) {
    const row = byDay.get(r.day);
    if (!row) continue;
    row[r.feature] = round((row[r.feature] || 0) + r.usd);
    row.total = round(row.total + r.usd);
  }
  const withEur = (r) => ({ ...r, usd: round(r.usd), eur: round(eurOf(r.usd)) });
  const accounts = db
    .prepare("SELECT user_id, SUM(usd) AS usd, COUNT(*) AS calls, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, MAX(at) AS last_at FROM ai_usage WHERE at >= ? AND user_id IS NOT NULL GROUP BY user_id ORDER BY usd DESC LIMIT 100")
    .all(period.since)
    .map((r) => {
      const user = store().getUserById(r.user_id);
      const allowance = user ? store().publicAllowance(store().aiAllowanceOf(user)) : null;
      return { ...named(index, r.user_id), ...withEur(r), allowance };
    });
  const month = store().monthKeyOf();
  const reader = db.prepare("SELECT COALESCE(SUM(count), 0) AS questions, COUNT(*) AS accounts FROM reader_questions WHERE month = ?").get(month);
  res.json({
    period,
    totals: { ...withEur(totals), anonymous_usd: round(totals.anonymous_usd), cache_ratio: totals.input_tokens + totals.cache_read_tokens ? round(totals.cache_read_tokens / (totals.input_tokens + totals.cache_read_tokens), 3) : null },
    usd_prev: round(prev),
    by_day: [...byDay.values()],
    by_feature: db.prepare("SELECT COALESCE(feature, 'unattributed') AS feature, SUM(usd) AS usd, COUNT(*) AS calls FROM ai_usage WHERE at >= ? GROUP BY 1 ORDER BY usd DESC").all(period.since).map(withEur),
    by_model: db.prepare("SELECT COALESCE(model, '?') AS model, SUM(usd) AS usd, COUNT(*) AS calls, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens FROM ai_usage WHERE at >= ? GROUP BY 1 ORDER BY usd DESC").all(period.since).map(withEur),
    accounts,
    reader: { month, ...reader, limit: config.READER_AI_QUESTIONS_MONTH },
    envelopes: { trial_eur: config.TRIAL_AI_BUDGET_EUR, licence_month_eur: config.LICENCE_AI_BUDGET_EUR_MONTH, reader_month_eur: config.READER_AI_BUDGET_EUR_MONTH, usd_per_eur: config.AI_USD_PER_EUR },
    limiter: require("../aiCostLimiter").snapshot(),
  });
};

const apiUsage = (req, res) => {
  noStore(res);
  if (!config.ACCOUNTS_ENABLED) return accountsOff(res);
  usageLedger.flush();
  const period = periodOf(req);
  const db = store().getDb();
  const index = accountIndex();
  const totals = db
    .prepare("SELECT COALESCE(SUM(calls), 0) AS calls, COALESCE(SUM(client_errors), 0) AS refused, COALESCE(SUM(rate_limited), 0) AS rate_limited, COALESCE(SUM(server_errors), 0) AS server_errors, COALESCE(SUM(ms_total), 0) AS ms_total, COUNT(DISTINCT NULLIF(user_id, '')) AS accounts FROM api_usage WHERE day >= ?")
    .get(period.sinceDay);
  const prev = db.prepare("SELECT COALESCE(SUM(calls), 0) AS calls FROM api_usage WHERE day >= ? AND day < ?").get(period.prevDay, period.sinceDay).calls;
  const days = new Map(db.prepare("SELECT day, SUM(calls) AS calls, SUM(client_errors) AS refused, SUM(rate_limited) AS rate_limited, SUM(server_errors) AS server_errors FROM api_usage WHERE day >= ? GROUP BY day").all(period.sinceDay).map((r) => [r.day, r]));
  const routes = db
    .prepare(
      `SELECT route, SUM(calls) AS calls, SUM(client_errors) AS refused, SUM(rate_limited) AS rate_limited, SUM(server_errors) AS server_errors,
              SUM(ms_total) / MAX(SUM(calls), 1) AS avg_ms, MAX(ms_max) AS max_ms, COUNT(DISTINCT NULLIF(user_id, '')) AS accounts
       FROM api_usage WHERE day >= ? GROUP BY route ORDER BY calls DESC LIMIT 200`,
    )
    .all(period.sinceDay)
    .map((r) => ({ ...r, avg_ms: round(r.avg_ms, 1), max_ms: round(r.max_ms, 1) }));
  const accounts = db
    .prepare("SELECT user_id, SUM(calls) AS calls, SUM(client_errors) AS refused, SUM(rate_limited) AS rate_limited, SUM(server_errors) AS server_errors, SUM(ms_total) / MAX(SUM(calls), 1) AS avg_ms, MAX(day) AS last_day, COUNT(DISTINCT route) AS routes FROM api_usage WHERE day >= ? GROUP BY user_id ORDER BY calls DESC LIMIT 200")
    .all(period.sinceDay)
    .map((r) => ({ ...named(index, r.user_id || null), anonymous: !r.user_id, calls: r.calls, refused: r.refused, rate_limited: r.rate_limited, server_errors: r.server_errors, avg_ms: round(r.avg_ms, 1), last_day: r.last_day, routes: r.routes }));
  res.json({
    period,
    totals: { calls: totals.calls, refused: totals.refused, rate_limited: totals.rate_limited, server_errors: totals.server_errors, avg_ms: totals.calls ? round(totals.ms_total / totals.calls, 1) : null, accounts: totals.accounts },
    calls_prev: prev,
    by_day: daysOf(period).map((day) => ({ day, calls: 0, refused: 0, rate_limited: 0, server_errors: 0, ...(days.get(day) || {}) })),
    routes,
    accounts,
    live: require("../perfStats").summarize(),
  });
};

const errors = (req, res) => {
  noStore(res);
  if (!config.ACCOUNTS_ENABLED) return accountsOff(res);
  usageLedger.flush();
  const period = periodOf(req);
  const db = store().getDb();
  const index = accountIndex();
  const items = db.prepare("SELECT * FROM server_errors WHERE at >= ? ORDER BY at DESC, id DESC LIMIT 500").all(period.since).map((r) => ({ ...r, ...named(index, r.user_id) }));
  const byRoute = db.prepare("SELECT route, COUNT(*) AS count, MAX(at) AS last_at, GROUP_CONCAT(DISTINCT code) AS codes FROM server_errors WHERE at >= ? GROUP BY route ORDER BY count DESC").all(period.since);
  res.json({ period, items, by_route: byRoute });
};

// ── Billing and quotes ─────────────────────────────────────────────────────

const billing = (req, res) => {
  noStore(res);
  if (!config.ACCOUNTS_ENABLED) return accountsOff(res);
  const now = Date.now();
  const rows = accountsWithLicence(now);
  const db = store().getDb();
  const who = (u) => ({ user_id: u.id, email: u.email, display_name: u.display_name || null, organisation: u.organisation || null, org_role: u.org_role || null });
  const subRows = db.prepare("SELECT * FROM subscriptions ORDER BY updated_at DESC").all();
  const users = new Map(rows.map((r) => [r.user.id, r]));
  const subscriptions = subRows.map((row) => {
    const r = users.get(row.user_id);
    const sub = store().subscriptionOf(row.user_id);
    return { ...(r ? who(r.user) : { user_id: row.user_id, email: null }), plan: sub.plan || null, status: sub.status, active: store().isEntitledSubscription(sub, now), current_period_end: sub.current_period_end || null, cancel_at_period_end: Boolean(sub.cancel_at_period_end), updated_at: row.updated_at || null };
  });
  const trials = rows
    .filter((r) => r.user.trial_started_at)
    .map((r) => ({
      ...who(r.user),
      network: r.user.network || null,
      phone: r.user.phone || null,
      started_at: r.user.trial_started_at,
      until: r.user.trial_until,
      state: r.licence.active && r.licence.source === "trial" ? "running" : r.licence.active ? "converted" : "ended",
      licence_source: r.licence.active ? r.licence.source : null,
      ai_spent_eur: r.allowance && r.allowance.kind === "trial" ? r.allowance.spent_eur : null,
    }))
    .sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
  const grants = rows
    .filter((r) => r.user.grant_until || (r.user.entitlements || []).length)
    .map((r) => ({ ...who(r.user), until: r.user.grant_until || null, active: r.licence.active && r.licence.source === "admin", granted: r.user.entitlements }));
  const events = db.prepare("SELECT type, COUNT(*) AS count, MAX(received_at) AS last_at FROM billing_events GROUP BY type ORDER BY last_at DESC").all();
  const converted = trials.filter((t) => t.state === "converted").length;
  res.json({
    paid: Boolean(config.PAID_ACCESS_ENABLED),
    prices: { year_eur: config.LICENCE_PRICE_EUR_YEAR, month_eur: config.LICENCE_PRICE_EUR_MONTH },
    trial_days: config.TRIAL_DAYS,
    summary: {
      subscriptions_active: subscriptions.filter((x) => x.active).length,
      subscriptions_cancelling: subscriptions.filter((x) => x.active && x.cancel_at_period_end).length,
      grants_active: grants.filter((g) => g.active).length,
      trials_running: trials.filter((t) => t.state === "running").length,
      trials_total: trials.length,
      trials_converted: converted,
      conversion_rate: trials.length ? round(converted / trials.length, 3) : null,
      quotes_new: opsData.listQuotes().filter((q) => q.status === "new").length,
    },
    subscriptions,
    trials,
    grants,
    provider_events: events,
  });
};

const quotes = (req, res) => {
  noStore(res);
  if (!config.ACCOUNTS_ENABLED) return accountsOff(res);
  res.json({ quotes: opsData.listQuotes(), retention_days: opsData.QUOTE_RETENTION_DAYS, statuses: opsData.QUOTE_STATUSES });
};

const updateQuote = (req, res) => {
  noStore(res);
  if (!config.ACCOUNTS_ENABLED) return accountsOff(res);
  const body = req.body || {};
  if (body.status !== undefined && !opsData.QUOTE_STATUSES.includes(body.status)) return res.status(400).json({ error: "INVALID_INPUT", message: `status is one of ${opsData.QUOTE_STATUSES.join(", ")}.` });
  if (body.note !== undefined && body.note !== null && typeof body.note !== "string") return res.status(400).json({ error: "INVALID_INPUT", message: "note must be a string." });
  const quote = opsData.updateQuote(req.params.id, { status: body.status, note: body.note === null ? "" : body.note });
  if (!quote) return res.status(404).json({ error: "NOT_FOUND", message: "No quote request with this id." });
  opsData.logAdminAction(req.admin, "quote.update", quote.id, { status: quote.status });
  return res.json({ quote });
};

// ── Projects ───────────────────────────────────────────────────────────────

/** The projects matching `where` (on `projects p`), each with its versions, deliveries and members counted. */
const projectRows = (ws, where = "", values = []) =>
  ws
    .db()
    .prepare(
      `SELECT p.id, p.owner_user_id, p.bytes, p.created_at, p.updated_at, p.retention_until,
              json_extract(p.data, '$.name') AS name, json_extract(p.data, '$.job') AS job,
              json_extract(p.data, '$.network.name') AS network, json_extract(p.data, '$.context.draft_kind') AS draft_kind,
              json_extract(p.data, '$.step') AS step,
              (SELECT COUNT(*) FROM versions v WHERE v.project_id = p.id) AS versions,
              (SELECT COUNT(*) FROM versions v WHERE v.project_id = p.id AND v.delivered = 1) AS deliveries,
              (SELECT COUNT(*) FROM project_members m WHERE m.project_id = p.id) AS members,
              (SELECT COUNT(*) FROM documents d WHERE d.project_id = p.id) AS documents
       FROM projects p ${where} ORDER BY p.updated_at DESC LIMIT 2000`,
    )
    .all(...values);

const projects = (req, res) => {
  noStore(res);
  const ws = workspace();
  if (!ws) return res.json({ projects: [], enabled: Boolean(config.WORKSPACE_ENABLED) });
  const index = config.ACCOUNTS_ENABLED ? accountIndex() : new Map();
  res.json({ enabled: true, projects: projectRows(ws).map((p) => ({ ...p, owner: p.owner_user_id ? named(index, p.owner_user_id) : null })) });
};

// ── Events ─────────────────────────────────────────────────────────────────

const EVENTS_FILE = () => path.join(config.GTFS_UPLOAD_DIR, "_events.jsonl");

/**
 * The event log read line by line (never whole in memory), newest first: the `limit` last events matching the
 * filters, before `before` (an ISO time: the next page), and the count of each type among the lines read.
 */
const readEvents = async ({ type = null, user = null, session = null, q = null, before = null, limit = 200 } = {}) => {
  const file = EVENTS_FILE();
  const n = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  const types = {};
  if (!fs.existsSync(file)) return { events: [], types, next_before: null };
  const ring = [];
  const needle = q ? String(q).toLowerCase() : null;
  const typePrefix = type ? String(type) : null;
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e || !e.type) continue;
    types[e.type] = (types[e.type] || 0) + 1;
    if (before && !(e.ts < before)) continue;
    if (typePrefix && !(e.type === typePrefix || e.type.startsWith(`${typePrefix}.`))) continue;
    const uid = e.user_id || (e.data && e.data.user_id) || null;
    if (user && uid !== user) continue;
    if (session && e.session !== session) continue;
    if (needle && !line.toLowerCase().includes(needle)) continue;
    ring.push({ ts: e.ts, type: e.type, session: e.session || null, user_id: uid, ip_hash: e.ip_hash || null, data: e.data || {} });
    if (ring.length > n) ring.shift();
  }
  const events = ring.reverse();
  return { events, types, next_before: events.length === n ? events[events.length - 1].ts : null };
};

const events = async (req, res, next) => {
  try {
    noStore(res);
    const q = req.query || {};
    const out = await readEvents({ type: q.type || null, user: q.user || null, session: q.session || null, q: q.q || null, before: q.before || null, limit: q.limit });
    const index = config.ACCOUNTS_ENABLED ? accountIndex() : new Map();
    res.json({ ...out, events: out.events.map((e) => ({ ...e, email: e.user_id ? (index.get(e.user_id) || {}).email || null : null })) });
  } catch (err) {
    next(err);
  }
};

const audit = (req, res) => {
  noStore(res);
  if (!config.ACCOUNTS_ENABLED) return accountsOff(res);
  const index = accountIndex();
  res.json({ actions: opsData.listAdminActions({ limit: 300 }).map((a) => ({ ...a, actor: a.actor_user_id ? named(index, a.actor_user_id).email : null, target_email: a.target ? (index.get(a.target) || {}).email || null : null })) });
};

const mail = (req, res) => {
  noStore(res);
  if (!config.ACCOUNTS_ENABLED) return accountsOff(res);
  const index = accountIndex();
  res.json({ provider: config.MAIL_PROVIDER || null, mails: opsData.listMail({ limit: 500 }).map((m) => ({ ...m, ...(m.user_id ? { email: (index.get(m.user_id) || {}).email || null } : { email: null }) })) });
};

// ── Sessions (working copies) ──────────────────────────────────────────────

/** GET /admin/sessions — every working copy, its feed, its owner, how long idle and when it expires. */
const sessions = async (req, res, next) => {
  try {
    noStore(res);
    const sm = require("../sessionManager");
    const list = await require("../adminStatsService").getActiveSessionsDetails();
    const index = config.ACCOUNTS_ENABLED ? accountIndex() : new Map();
    const out = [];
    for (const s of list) {
      const expiry = await sm.sessionExpiryOf(s.session_id);
      const owner = s.meta && s.meta.owner_user_id ? named(index, s.meta.owner_user_id) : null;
      out.push({ ...s, idle_ms: expiry ? expiry.idleMs : null, expires_at: expiry ? new Date(expiry.expiresAt).toISOString() : null, owner, busy: sm.isSessionMutationActive(s.session_id) });
    }
    res.json({ sessions: out, count: out.length, maxSessions: config.MAX_SESSIONS, maxKeylessSessions: config.MAX_KEYLESS_SESSIONS, ts: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
};

/** DELETE /admin/sessions/:id — end a working copy now: its snapshot taken first (the sweep's hook), then removed. */
const endSession = async (req, res, next) => {
  try {
    noStore(res);
    const sm = require("../sessionManager");
    const id = String(req.params.id || "");
    if (!sm.validateSessionId(id)) return res.status(400).json({ error: "INVALID_SESSION", message: "Invalid session id." });
    const folder = path.join(sm.GTFS_UPLOAD_DIR, id);
    if (!fs.existsSync(folder)) return res.status(404).json({ error: "SESSION_NOT_FOUND", message: "No working copy with this id." });
    if (sm.isSessionMutationActive(id) || sm.isUploadInProgress(id)) return res.status(409).json({ error: "BUSY", message: "This working copy is being changed right now: try again in a moment." });
    await sm.runBeforePurge(id);
    sm.clearSessionCache(id);
    await fsp.rm(folder, { recursive: true, force: true });
    opsData.logAdminAction(req.admin, "session.end", id, null);
    res.json({ ended: true });
  } catch (err) {
    next(err);
  }
};

module.exports = { me, overview, listUsers, userDetail, logoutUser, aiUsage, apiUsage, errors, billing, quotes, updateQuote, projects, events, audit, mail, sessions, endSession, _internals: { periodOf, readEvents } };
