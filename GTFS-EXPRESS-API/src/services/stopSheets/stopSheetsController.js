/**
 * The stop sheets' routes: what can be printed (the stops and lines, the feed's validity, the default period), the
 * sheets of a batch of stops over a period, and on a draft the stops whose sheet the draft changes (compared with the
 * working copy it was made from). Reading the sheets is free like the reader, so anyone sees what the module makes;
 * printing them is part of the licence: under the paid offer a sheet carries a watermark unless its reader holds a
 * licence that delivers (« trial » during the trial, which lets nothing it produces leave; « preview » without a
 * licence, whose print opens the offer on the web).
 */

"use strict";

const { requireSession } = require("../edit/_editCore");
const { ensureDbHandle } = require("../db/connection");
const { getDataVersion } = require("../../middleware/readCache");
const { buildFeedModel } = require("../transform/feedModel");
const dayTypes = require("../coherence/dayTypes");
const { agencyTimezone, _internals: coherence } = require("../coherence/coherenceService");
const { sessionCountryCode } = require("../sessionCountry");
const draftSession = require("../transform/draftSession");
const trialWork = require("../trialWork");
const paidAccess = require("../paidAccess");
const { refusal } = require("../refusal");
const sheets = require("./stopSheets");
const sheetCalendar = require("./sheetCalendar");

const MAX_STOPS = 200;
const MAX_MODELS = 4;
const REGION_RE = /^[A-Za-z0-9-]{1,12}$/;

const _models = new Map();
const modelOf = (sessionId, db) => {
  const key = `${sessionId}|${getDataVersion(db)}`;
  if (_models.has(key)) return _models.get(key);
  const model = buildFeedModel(db);
  _models.set(key, model);
  while (_models.size > MAX_MODELS) _models.delete(_models.keys().next().value);
  return model;
};

const iso = (ymd) => (ymd ? `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}` : null);
const langOf = (v) => {
  const l = String(v || "").slice(0, 2).toLowerCase();
  return sheets.LANGS.includes(l) ? l : "en";
};

/** The watermark a reader's sheets carry: null, "trial" or "preview". */
const watermarkOf = (req) => {
  if (!paidAccess.isPaidModel() || trialWork.holdsDelivery(req)) return null;
  return trialWork.isTrial(req) ? "trial" : "preview";
};

/** The school calendar the period's weekdays are split by, as the answer shows it. */
const schoolOf = async (model, db, sessionId, period, region) => {
  const timezone = agencyTimezone(db);
  const country = dayTypes.countryOfFeed({ timezone }, sessionCountryCode(sessionId));
  const window = { from: period.from, to: period.to };
  const index = coherence.dayIndex(model, window);
  const school = await dayTypes.schoolCalendarFor({ country, region, regionSource: region ? "asked" : null, territory: null, window, signatures: index.keys, timezone });
  return { school, country, keys: index.keys };
};
const regionOf = (v) => (typeof v === "string" && REGION_RE.test(v) ? v : null);
// The names are the working copy's: a draft reads and writes its working copy's calendar.
const calendarSessionOf = (sessionId) => draftSession.mainOf(sessionId) || sessionId;
const storedNamesOf = (sessionId) => sheetCalendar.namesOf(sheetCalendar.load(calendarSessionOf(sessionId)));
const publicSchool = (school) =>
  school
    ? {
        status: school.status,
        region: school.region || null,
        region_source: school.region_source || null,
        covered_until: iso(school.covered_until),
        periods: (school.periods || []).map((p) => ({ name: p.name, from: iso(p.from), to: iso(p.to), ...(p.assumed ? { assumed: true } : {}) })),
      }
    : null;

/**
 * GET /documents/sheets/setup?region=: the stops and lines to choose from, the feed's validity, the timetable periods
 * from today (the default period is the first) and the school calendar that splits the weekdays.
 */
const getSetup = async (req, res, next) => {
  const ctx = requireSession(req, res);
  if (!ctx) return;
  try {
    const model = modelOf(ctx.sessionId, ctx.db);
    const today = sheets.todayIn(agencyTimezone(ctx.db));
    const window = model.range ? sheets.periodOf(model, { from: today > model.range.start && today <= model.range.end ? today : model.range.start, to: model.range.end }) : null;
    let periods = [];
    let school = null;
    if (window) {
      const found = await schoolOf(model, ctx.db, ctx.sessionId, window, regionOf(req.query?.region));
      school = found.school;
      periods = sheets.timetablePeriods(sheets.calendarOf(model, window, { keys: found.keys, school: found.school, names: storedNamesOf(ctx.sessionId) }), found.keys);
    }
    const stored = sheetCalendar.load(calendarSessionOf(ctx.sessionId));
    const { stops, routes } = sheets.catalogueOf(model);
    const agency = ctx.db.prepare("SELECT agency_name, agency_url, agency_phone FROM agency LIMIT 1").get() || {};
    res.json({
      range: model.range ? { from: iso(model.range.start), to: iso(model.range.end) } : null,
      periods: periods.map((p) => ({ from: iso(p.from), to: iso(p.to) })),
      period: periods.length ? { from: iso(periods[0].from), to: iso(periods[0].to) } : null,
      today: iso(today),
      school: publicSchool(school),
      agency: { name: agency.agency_name || "", url: agency.agency_url || "", phone: agency.agency_phone || "" },
      draft: Boolean(draftSession.mainOf(ctx.sessionId)),
      watermark: watermarkOf(req),
      calendar: { updatedAt: stored.updatedAt, confirmed: stored.periods.filter((p) => p.confirmed).length + stored.holidays.filter((h) => h.confirmed).length, proposed: stored.periods.filter((p) => !p.confirmed).length + stored.holidays.filter((h) => !h.confirmed).length },
      stops,
      routes,
    });
  } catch (err) {
    next(err);
  }
};

const periodOfBody = (model, body, timezone) => sheets.periodOf(model, { from: body.from, to: body.to, today: sheets.todayIn(timezone) });

/** POST /documents/sheets: { stop_ids, from?, to?, lang?, region?, route_id? } → the sheets of those stops over the period (that line alone). */
const postSheets = async (req, res, next) => {
  const ctx = requireSession(req, res);
  if (!ctx) return;
  const body = req.body || {};
  const ids = Array.isArray(body.stop_ids) ? [...new Set(body.stop_ids.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()))] : [];
  if (!ids.length) return next(refusal(400, "INVALID_INPUT", "stop_ids is required."));
  if (ids.length > MAX_STOPS) return next(refusal(413, "TOO_MANY_STOPS", `At most ${MAX_STOPS} stops a request.`, { max: MAX_STOPS }));
  const region = regionOf(body.region);
  try {
    const model = modelOf(ctx.sessionId, ctx.db);
    const timezone = agencyTimezone(ctx.db);
    const period = periodOfBody(model, body, timezone);
    if (!period) return next(refusal(422, "NO_SERVICE_DATES", "The feed has no service dates."));
    const { school, keys } = await schoolOf(model, ctx.db, ctx.sessionId, period, region);
    const lang = langOf(body.lang);
    const routeId = typeof body.route_id === "string" && body.route_id ? body.route_id : null;
    const out = sheets.sheetsOf(model, { stopIds: ids, period, keys, school, names: storedNamesOf(ctx.sessionId), lang, today: sheets.todayIn(timezone), routeId });
    res.json({
      period: { from: iso(period.from), to: iso(period.to), clamped: period.clamped, capped: period.capped },
      school: publicSchool(school),
      undated: out.undated,
      classes: out.classes,
      lang,
      labels: out.labels,
      watermark: watermarkOf(req),
      sheets: out.sheets,
      unknown: out.unknown,
    });
  } catch (err) {
    next(err);
  }
};

/** POST /documents/sheets/changes: { from?, to? } → on a draft, the stops whose sheet differs from the working copy's. */
const postChanges = (req, res, next) => {
  const ctx = requireSession(req, res);
  if (!ctx) return;
  try {
    const mainId = draftSession.mainOf(ctx.sessionId);
    const baseDb = mainId ? ensureDbHandle(mainId) : null;
    if (!baseDb) return res.json({ draft: false, changed: [] });
    const after = modelOf(ctx.sessionId, ctx.db);
    const before = modelOf(mainId, baseDb);
    const period = periodOfBody(after, req.body || {}, agencyTimezone(ctx.db));
    if (!period) return res.json({ draft: true, changed: [] });
    res.json({ draft: true, period: { from: iso(period.from), to: iso(period.to) }, changed: sheets.changedSheets(before, after, period) });
  } catch (err) {
    next(err);
  }
};

/** The calendar's shape for the client: dates as ISO, the day classes the period shows with the names they carry. */
const calendarOut = async (ctx, req, body) => {
  const model = modelOf(ctx.sessionId, ctx.db);
  const timezone = agencyTimezone(ctx.db);
  const period = periodOfBody(model, body, timezone);
  if (!period) return null;
  const region = regionOf(body.region);
  const lang = langOf(body.lang);
  const { school, keys } = await schoolOf(model, ctx.db, ctx.sessionId, period, region);
  const stored = sheetCalendar.load(calendarSessionOf(ctx.sessionId));
  const classes = sheets.calendarSummary(model, period, { keys, school, names: sheetCalendar.namesOf(stored), lang });
  const isoRange = ([a, b]) => ({ from: iso(a), to: iso(b) });
  return {
    period: { from: iso(period.from), to: iso(period.to) },
    lang,
    school: publicSchool(school),
    classes: classes.map((c) => ({ ...c, ranges: c.ranges.map(isoRange), holidays: c.holidays.map((h) => ({ date: iso(h.date), name: h.name })) })),
    updatedAt: stored.updatedAt,
    periods: stored.periods.map((p) => ({ ...p, from: iso(p.from), to: iso(p.to) })),
    holidays: stored.holidays.map((h) => ({ ...h, date: iso(h.date) })),
  };
};

/** GET /documents/sheets/calendar?from&to&lang&region: the day classes of the period and the names kept for them. */
const getCalendar = async (req, res, next) => {
  const ctx = requireSession(req, res);
  if (!ctx) return;
  try {
    const out = await calendarOut(ctx, req, req.query || {});
    if (!out) return next(refusal(422, "NO_SERVICE_DATES", "The feed has no service dates."));
    res.json(out);
  } catch (err) {
    next(err);
  }
};

/** PUT /documents/sheets/calendar { periods, holidays, from?, to?, lang? }: the names as the person leaves them. */
const putCalendar = async (req, res, next) => {
  const ctx = requireSession(req, res);
  if (!ctx) return;
  const body = req.body || {};
  if (!Array.isArray(body.periods) && !Array.isArray(body.holidays)) return next(refusal(400, "INVALID_INPUT", "periods or holidays is required."));
  try {
    sheetCalendar.save(calendarSessionOf(ctx.sessionId), body);
    const out = await calendarOut(ctx, req, body);
    if (!out) return next(refusal(422, "NO_SERVICE_DATES", "The feed has no service dates."));
    res.json(out);
  } catch (err) {
    next(err);
  }
};

/**
 * POST /documents/sheets/calendar/suggest { from?, to?, lang?, region? }: the model names the blocks of dates and the
 * public holidays the network shows over the period, in the sheet's language; its proposals wait in the calendar,
 * unconfirmed, beside the dates they name. Behind the licence or the trial, on the account's AI envelope.
 */
const suggestCalendar = async (req, res, next) => {
  const ctx = requireSession(req, res);
  if (!ctx) return;
  const body = req.body || {};
  const aiCostLimiter = require("../aiCostLimiter");
  const nl2sqlChatService = require("../nl2sqlChatService");
  const llm = require("../llm/provider");
  const config = require("../../config");
  const rateKey = req.betaTester?.code || aiCostLimiter.anonymousKey(req);
  const limit = aiCostLimiter.check({ key: rateKey, scope: "chat", ...aiCostLimiter.betaLimitsFor(req.betaTester) });
  if (!limit.ok) {
    const status = limit.status || (limit.code === "BUDGET_EXHAUSTED" ? 503 : 429);
    return res.status(status).json({ error: limit.code, message: limit.code === "AI_ALLOWANCE_EXHAUSTED" ? "The AI envelope of this account is spent." : "AI request limit reached. Try again later.", retryAfterSec: limit.retryAfterSec, ...(limit.allowance ? { allowance: limit.allowance } : {}) });
  }
  let client;
  try {
    client = nl2sqlChatService.getClient();
  } catch (err) {
    return res.status(err.status || 503).json({ error: err.code || "AI_UNAVAILABLE", message: err.message });
  }
  try {
    const model = modelOf(ctx.sessionId, ctx.db);
    const timezone = agencyTimezone(ctx.db);
    const period = periodOfBody(model, body, timezone);
    if (!period) return next(refusal(422, "NO_SERVICE_DATES", "The feed has no service dates."));
    const lang = langOf(body.lang);
    const { school, keys } = await schoolOf(model, ctx.db, ctx.sessionId, period, regionOf(body.region));
    const cal = sheets.calendarOf(model, period, { keys, school, names: storedNamesOf(ctx.sessionId) });
    const agency = ctx.db.prepare("SELECT agency_name FROM agency LIMIT 1").get()?.agency_name || null;
    require("../llm/aiMeter").setFeature("sheets");
    const proposals = await sheetCalendar.suggestNames({ client, model: llm.modelId(nl2sqlChatService.resolveChatModel({ freeTier: Boolean(req.freeTier) }), config.LLM_PROVIDER), language: lang, timezone, agency, period, classes: cal.classes, holidays: [...cal.holidays] });
    sheetCalendar.merge(calendarSessionOf(ctx.sessionId), proposals);
    const out = await calendarOut(ctx, req, body);
    res.json({ ...out, proposed: { periods: proposals.periods.length, holidays: proposals.holidays.length } });
  } catch (err) {
    next(err);
  }
};

module.exports = { getSetup, postSheets, postChanges, getCalendar, putCalendar, suggestCalendar, MAX_STOPS, _internals: { watermarkOf } };
