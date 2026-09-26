/**
 * Calendar operators — WHICH timetable a line runs on WHICH dates.
 *
 *   run_like             "During the school holidays lines 1-4 run the Saturday timetable",
 *                        "14 July: Sunday timetable", "25 December: no service".
 *   copy_day_service     "Line 204: Sunday service at Saturday levels from 30 August",
 *                        "line 7 now also runs on Saturdays, like on weekdays".
 *   remove_day_service   "No Sunday service on line 7 from 1 September".
 *   suspend_service      "Line F1 suspended from 6 July to 31 August (works); replacement buses".
 *   apply_holiday_rules  "Public holidays run the Sunday timetable; the airport line runs, the
 *                        others do not".
 *   extend_validity      "Extend the current timetables until 4 July 2027, with the 2027 holidays".
 *
 * ONE MACHINE (run_like). For each targeted line and each service date D of the scope, the
 * line's trips that ran on D stop running on D, and the line's trips of the `like` day type
 * run on D instead. The trips "of the like day type" are those running on the REFERENCE
 * date of D: the nearest regular date of that day type (ties: the earlier one). A regular
 * date is one whose weekday is that day type, that counts as that day type (below), and
 * whose set of running services recurs on other dates of that day type — a holiday or an
 * event day (a set seen once) is never a reference. On a feed without seasons this is the
 * representative date of the day type; on a seasonal feed a July holiday gets the SUMMER
 * Sunday timetable and a school-holiday weekday the holiday weekday timetable, as a
 * scheduler expects. A "weekday" whose timetable differs by day (a Friday variant) is a
 * question: like which day? — or `like_date`: a PERIOD's timetable ("in summer, weekdays run
 * the school-holiday timetable" — as on 12 April): the reference of D is then the date of
 * D's weekday in like_date's week (else the nearest), each weekday running its own; without
 * `like`, the date's own day type (a weekday stands for the weekday timetable).
 *
 * DAY TYPES OF DATES. A date counts as the day type whose usual services the network runs
 * that day: a Thursday holiday running the Sunday services counts as a Sunday. So "Sunday
 * service like Saturday" also covers the holidays that run the Sunday timetable (take them
 * out with `except`), and "weekdays of the school holidays" do not reach a holiday Monday.
 * A closure (no service at all while most of the same weekdays around it are served:
 * 25 December, 1 May) counts as no day type: a day-type scope never reopens it (warned);
 * explicit dates do. Taking a day type AWAY (remove_day_service, the replace mode of
 * copy_day_service, run_like with `days`) uses the day types of scope.js per service: the
 * Sunday service's trips go wherever they run in the scope, including the holidays it was
 * added on — and when a timetable is REPLACED, the `like` timetable runs on every date the
 * line's old one left, so such a holiday gets the new timetable, never nothing.
 *
 * HOW IT IS WRITTEN — compact and exact, never touching another line:
 *   • a service used only by the targeted lines is edited in place with calendar_dates
 *     exceptions (type 2 off, type 1 on: how producers write holidays). When the edit takes
 *     a weekday away for good the weekly flag changes instead, and when it makes the service
 *     stop more than 4 weeks before its end_date (or start more than 4 weeks after its
 *     start_date) its period shrinks, rather than piling up exceptions. Only what the edit
 *     changes: a producer's "daily minus exceptions" calendar keeps its flags, so one
 *     holiday is one row.
 *   • a service shared with lines that are not targeted (or targeted differently) is never
 *     changed: the targeted trips move to a service running exactly their new dates
 *     (scope.serviceForDates: an existing service with those dates is reused, else
 *     <service>~<hash>). Trip ids, stop_times, frequencies, shapes and trip-level transfers
 *     stay as they are: only trips.service_id changes.
 *   • trips left without any date are deleted (stop_times, frequencies, trip transfers). A
 *     line that would be left with no service in the whole feed is a question: remove the
 *     line instead, or narrow the dates.
 *   • idempotent: a date already running as asked changes nothing; a step changing nothing
 *     is skipped. The engine merges services that end up duplicating another's dates.
 *
 * SERVICE DAYS. Dates are GTFS service dates: a trip leaving at 25:10 belongs to the date it
 * starts on. When trips running past midnight are added or removed a warning says so, and
 * when a date left without service still sees the previous evening's trips after midnight.
 *
 * WARNINGS. Stops left with no service at all on some dates, vehicle blocks whose trips now
 * run on different dates, trip-to-trip transfers deleted or affected, trips past midnight,
 * running times of a copied day, dates outside the validity, short notice (< 7 days: GTFS-RT
 * is the channel), lines with nothing to run on a holiday.
 *
 * DEFAULTS AND CHOICES.
 *   • run_like needs a scope (dates, from_date/to_date, period, days) and `like`.
 *   • copy_day_service: mode "replace" (default: the old trips of those days go) or "add".
 *   • suspend_service needs from_date + to_date (to_date "until_further_notice" = to the end
 *     of the feed), or dates, or a period; the replacement is reported, not created.
 *   • apply_holiday_rules: period "public_holidays" by default (the plan's calendars or the
 *     feed's country), rule "sunday", all lines; except_routes keep their own timetable
 *     unless except_rule says otherwise. Lines with no trips of the rule's day type simply
 *     do not run on the holidays (warned). A hybrid rule (Sunday timetable with an earlier
 *     start) is run_like followed by a timetable operator.
 *   • extend_validity only extends: an end_date before the current end, or a start_date
 *     after the current start, is a question. The current validity is where trips run (a
 *     leftover service without trips does not count). Services last running within 7 days
 *     of the feed's last date (first running within 7 days of its first date) get the new
 *     dates; seasonal services that ended earlier do not. Each repeats the week it REALLY
 *     runs there (weekdays run on at least half of its last 8 weeks), whatever calendar.txt
 *     says: a producer writing every service "daily minus exceptions", a calendar with no
 *     flags and calendar_dates carrying the dates, a calendar_dates-only service. Written
 *     as the cheaper exact form: the calendar period moved to the new edge (exceptions for
 *     the days it does not run, and to keep the old dates between its end_date and the
 *     feed's as they were), or type 1 rows for the new dates. One-off exceptions of the old
 *     period (not its week) are NOT repeated; `holidays` + `holiday_rule` (default sunday)
 *     are applied to the NEW dates only. feed_info dates follow.
 */

"use strict";

const R = require("../resolve");
const G = require("../gtfsOps");
const S = require("../scope");
const calendars = require("../calendars");
const { buildFeedModel, tripStarts, _internals: fm } = require("../feedModel");

const DOW = G.DOW;
const COL = { mon: "monday", tue: "tuesday", wed: "wednesday", thu: "thursday", fri: "friday", sat: "saturday", sun: "sunday" };
const NAME = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };
const NEAR_EDGE_DAYS = 7; // a service ending this close to the feed's end runs "until the end"
const SHRINK_DAYS = 28; // a service stopping this long before its end_date gets a shorter period
const SHORT_NOTICE_DAYS = 7; // below this, GTFS-RT is the channel (GTFS Best Practices)
const MAX_VALIDITY_DAYS = 1100; // the feed model and scopes read at most ~1200 days
const TABLES = ["calendar", "calendar_dates", "trips", "stop_times", "frequencies", "transfers"];

// ── words ────────────────────────────────────────────────────────────────

const fmtDate = (d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
const describeDates = (dates) => {
  if (!dates.length) return "no date";
  if (dates.length <= 4) return dates.map(fmtDate).join(", ");
  return `${dates.length} dates from ${fmtDate(dates[0])} to ${fmtDate(dates[dates.length - 1])}`;
};
const hhmm = (sec) => fm.secToTime(sec).slice(0, 5);
const daysBetween = (a, b) => Math.round((fm.ymdToDate(b) - fm.ymdToDate(a)) / 86400000);
const todayOf = (ctx) => (ctx && ctx.today ? calendars.parseDate(ctx.today) : null) || fm.dateToYmd(new Date());
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const norm = (v) =>
  String(v ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const routeName = (model, id) => {
  const r = model.routes.get(id);
  return r ? r.short_name || r.id : id;
};
const linesLabel = (model, ids, { all = false, except = [] } = {}) => {
  if (all && !except.length) return "All lines";
  if (all) return `All lines except ${except.map((id) => routeName(model, id)).join(", ")}`;
  const names = ids.map((id) => routeName(model, id));
  const shown = names.length > 8 ? `${names.slice(0, 8).join(", ")} and ${names.length - 8} more` : names.join(", ");
  return `${names.length > 1 ? "Lines" : "Line"} ${shown}`;
};
const daysLabel = (dows, weekend) => {
  const wk = DOW.filter((d) => !weekend.includes(d));
  if (dows.length === 7) return "every day";
  if (dows.length === wk.length && wk.every((d) => dows.includes(d))) return "weekdays";
  if (dows.length === weekend.length && weekend.every((d) => dows.includes(d))) return "weekends";
  return dows.map((d) => `${NAME[d]}s`).join(", ");
};
// "Sunday service", "weekday service", "Saturday/Sunday service".
const daysAdj = (dows, weekend) => {
  const wk = DOW.filter((d) => !weekend.includes(d));
  if (dows.length === 7) return "daily";
  if (dows.length === wk.length && wk.every((d) => dows.includes(d))) return "weekday";
  if (dows.length === weekend.length && weekend.every((d) => dows.includes(d))) return "weekend";
  return dows.map((d) => NAME[d]).join("/");
};

// "the Sunday timetable", "saturday", "horaires du dimanche", "none" → a day type.
const LIKE_WORDS = {
  weekday: "weekday", weekdays: "weekday", workday: "weekday", workdays: "weekday", semaine: "weekday", ouvre: "weekday", ouvres: "weekday", "lundi vendredi": "weekday", "mon fri": "weekday",
  none: "none", no: "none", nothing: "none", off: "none", aucun: "none", aucune: "none", suspended: "none", closed: "none", "pas de": "none",
};
const FILLER = /\b(the|a|like|as|on|timetable|schedule|service|horaires?|du|de|des|la|le|les|comme|un|une|en|day|jour|jours|type)\b/g;
const LIKE_OPTIONS = ["weekday", "saturday", "sunday", "none", ...DOW];
const parseLike = (raw, weekend, param, { required = true } = {}) => {
  if (raw == null || raw === "") {
    if (!required) return { value: null };
    return { ambiguity: { param, code: `${param}_missing`, message: "Which timetable runs on these dates: weekday, saturday, sunday, a day (mon…sun), or none?", options: LIKE_OPTIONS } };
  }
  const k = norm(raw).replace(FILLER, " ").replace(/\s+/g, " ").trim();
  let key = LIKE_WORDS[k] || null;
  if (!key && k) {
    const d = R.days(k);
    if (d.value && d.value.length === 1) key = d.value[0];
    // "weekend", "sat-sun": two timetables — which one runs?
    else if (d.value && d.value.length > 1 && d.value.length < 7) return { ambiguity: { param, code: `${param}_ambiguous`, message: `"${raw}" is several days: which day's timetable runs (${d.value.map((w) => NAME[w]).join(" or ")})?`, options: d.value.map((w) => (w === "sat" ? "saturday" : w === "sun" ? "sunday" : w)) } };
  }
  if (!key) return { ambiguity: { param, code: `${param}_invalid`, message: `"${raw}" is not a day type: weekday, saturday, sunday, a day (mon…sun), or none?`, options: LIKE_OPTIONS } };
  if (key === "none") return { value: { key, dows: [], label: "no service", day: "none" } };
  if (key === "weekday") return { value: { key, dows: DOW.filter((d) => !weekend.includes(d)), label: "the weekday timetable", day: "weekday" } };
  return { value: { key, dows: [key], label: `the ${NAME[key]} timetable`, day: NAME[key] } };
};

// A list of lines, "all", or one line.
const ALL_WORDS = new Set(["all", "*", "all lines", "every line", "all routes", "toutes", "toutes les lignes", "tout le reseau", "reseau", "network"]);
const resolveRoutes = (model, raw, param, { required = true, fallbackAll = false } = {}) => {
  const allIds = [...model.routes.keys()].sort();
  const empty = raw == null || raw === "" || (Array.isArray(raw) && !raw.length);
  if (empty) {
    if (fallbackAll) return { ids: allIds, all: true, ambiguities: [] };
    const options = ["all", ...[...model.routes.values()].map(R.routeLabel)].slice(0, 12);
    return { ids: [], all: false, ambiguities: required ? [{ param, code: `${param}_missing`, message: "Which lines (a list, or \"all\")?", options }] : [] };
  }
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[,;]/).map((x) => x.trim()).filter(Boolean) : [raw];
  if (list.some((x) => typeof x === "string" && ALL_WORDS.has(norm(x)))) return { ids: allIds, all: true, ambiguities: [] };
  const ids = [];
  const ambiguities = [];
  for (const ref of list) {
    const r = R.route(model, ref);
    if (r.ambiguity) ambiguities.push({ param, ...r.ambiguity });
    else if (!ids.includes(r.value.id)) ids.push(r.value.id);
  }
  return { ids, all: ids.length === allIds.length, ambiguities };
};

// ── day types of dates, reference dates ─────────────────────────────────

const _info = new WeakMap();
/**
 * Per date of the validity: the services (with trips) running, and the day type the network
 * runs (its weekday when the set of services is the representative one, else the day type
 * whose representative set it equals — weekend days first —, else its weekday). A date
 * with no service at all while most of the same weekdays around it (4 weeks either side)
 * are served is a closure (25 December, 1 May, a fortnight in August): no day type (null),
 * so "weekdays of the holidays" or "Sundays" never reopen it — it takes an explicit date. A
 * weekday the network does not serve in that season (no Sunday service, or none in winter)
 * keeps its day type: that is where copy_day_service creates one.
 */
const dateInfo = (model) => {
  if (_info.has(model)) return _info.get(model);
  const used = new Set([...model.trips.values()].map((t) => t.service_id));
  const svcs = [...model.services.keys()].filter((s) => used.has(s)).sort();
  const dates = model.range ? calendars.rangeDates(model.range.start, model.range.end) : [];
  const sig = new Map(dates.map((d) => [d, svcs.filter((s) => model.runsOn(s, d)).join(",")]));
  const repSig = {};
  for (const w of DOW) {
    const d = model.representative[w];
    if (d) repSig[w] = sig.get(d) ?? svcs.filter((s) => model.runsOn(s, d)).join(",");
  }
  const order = ["sun", "sat", "fri", "thu", "wed", "tue", "mon"];
  const closure = (d) => {
    let n = 0;
    let served = 0;
    for (const k of [-4, -3, -2, -1, 1, 2, 3, 4]) {
      const x = fm.addDays(d, 7 * k);
      if (!sig.has(x)) continue;
      n += 1;
      if (sig.get(x)) served += 1;
    }
    return n > 0 && 2 * served > n;
  };
  const type = new Map();
  for (const d of dates) {
    const own = fm.dowOf(d);
    const s = sig.get(d);
    if (!s) type.set(d, closure(d) ? null : own);
    else type.set(d, repSig[own] === s ? own : order.find((w) => repSig[w] === s) || own);
  }
  const out = { dates, sig, type };
  _info.set(model, out);
  return out;
};

/** D → the nearest regular date of the day type `dows` (ties: the earlier), or null. */
const referenceFor = (model, dows) => {
  const info = dateInfo(model);
  const own = info.dates.filter((d) => dows.includes(fm.dowOf(d)) && dows.includes(info.type.get(d)) && info.sig.get(d) !== "");
  const seen = new Map();
  for (const d of own) seen.set(info.sig.get(d), (seen.get(info.sig.get(d)) || 0) + 1);
  const regular = own.filter((d) => seen.get(info.sig.get(d)) >= 2);
  const pool = regular.length ? regular : [...new Set(dows.map((w) => model.representative[w]).filter(Boolean))].sort();
  return (D) => {
    if (!pool.length) return null;
    let lo = 0;
    let hi = pool.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pool[mid] < D) lo = mid + 1;
      else hi = mid;
    }
    // pool[lo] is the first date ≥ D (or the last one); compare with the one before.
    const after = pool[lo];
    const before = lo > 0 ? pool[lo - 1] : null;
    if (after < D) return after;
    if (before && daysBetween(before, D) <= daysBetween(D, after)) return before;
    return after;
  };
};

/**
 * D → with `like_date` L: the date of the like day type in L's week (Monday to Sunday) — of
 * D's own weekday when that weekday is one of the day type's (Albi's Wednesday differs from
 * its Monday) —, else the nearest to L, preferring regular dates (L itself always allowed).
 * The week keeps every weekday in L's period: the Friday nearest a Monday that starts the
 * school term is the last holiday Friday. "The school-holiday timetable, as on 12 April"
 * is a period's timetable no nearest-regular-day rule can reach in summer.
 */
const referenceNear = (model, dows, L) => {
  const info = dateInfo(model);
  const own = info.dates.filter((d) => dows.includes(fm.dowOf(d)) && dows.includes(info.type.get(d)) && info.sig.get(d) !== "");
  const seen = new Map();
  for (const d of own) seen.set(info.sig.get(d), (seen.get(info.sig.get(d)) || 0) + 1);
  const monday = fm.addDays(L, -((DOW.indexOf(fm.dowOf(L)) + 7) % 7));
  const sunday = fm.addDays(monday, 6);
  const nearest = (list) => {
    let best = null;
    for (const d of list) {
      const k = (d >= monday && d <= sunday ? 0 : 1000) + Math.abs(daysBetween(L, d));
      if (!best || k < best.k || (k === best.k && d < best.d)) best = { d, k };
    }
    return best ? best.d : null;
  };
  const memo = new Map();
  return (D) => {
    const w = fm.dowOf(D);
    const key = dows.includes(w) ? w : "*";
    if (!memo.has(key)) {
      const pool = key === "*" ? own : own.filter((d) => fm.dowOf(d) === w);
      const regular = pool.filter((d) => d === L || seen.get(info.sig.get(d)) >= 2);
      memo.set(key, nearest(regular.length ? regular : pool));
    }
    return memo.get(key);
  };
};

/** The dates of a scope, day types read per date (see the header). */
const scopeDates = (model, scope) => {
  const info = dateInfo(model);
  const plain = { ...scope, dows: null };
  return info.dates.filter((d) => (!scope.dows || scope.dows.includes(info.type.get(d))) && S.inScope(plain, d));
};

// A date, strictly: YYYY-MM-DD, YYYYMMDD or DD/MM/YYYY, and a real day of the calendar.
const strictDate = (v) => {
  const s = String(v ?? "").trim();
  if (!/^\d{4}-?\d{2}-?\d{2}(T[\d:.]+Z?)?$/.test(s) && !/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) return null;
  const y = calendars.parseDate(s);
  return y && fm.dateToYmd(fm.ymdToDate(y)) === y ? y : null;
};

/**
 * `dates` and `except` read strictly before scope.resolveScope, which ignores a string of
 * dates (the scope would silently become every date), drops malformed dates of `except`
 * and reads "2026-07-14,2026-08-15" as one date: here each is a list, and a bad date is
 * a question.
 */
const normScope = (p) => {
  const ambiguities = [];
  const out = { ...p };
  for (const k of ["dates", "except"]) {
    const v = p[k];
    if (v == null || v === "" || (Array.isArray(v) && !v.length)) continue;
    if (k === "except" && !Array.isArray(v) && !/^\d/.test(String(v).trim())) continue; // a named period
    const list = (Array.isArray(v) ? v : String(v).split(/[,;\s]+/)).filter((x) => x != null && x !== "");
    out[k] = [];
    for (const x of list) {
      const y = strictDate(x);
      if (y) out[k].push(y);
      else ambiguities.push({ param: k, code: "date_invalid", message: `"${x}" is not a date (YYYY-MM-DD).` });
    }
  }
  return { params: out, ambiguities };
};

const scopeOf = async (model, raw, ctx, { requireScope = false, daysRequired = false, dows, closures = false } = {}) => {
  const n = normScope(raw);
  const p = n.params;
  const sc = await S.resolveScope(model, p, ctx, { daysRequired });
  const ambiguities = [...n.ambiguities, ...sc.ambiguities];
  const warnings = [...(sc.warnings || [])];
  if (ambiguities.length || !sc.value) return { ambiguities, warnings, scope: null, dates: [] };
  const scope = sc.value;
  if (dows !== undefined) scope.dows = dows && dows.length < 7 ? dows : null;
  // Asked only when no date is said: from_date/to_date spanning the whole validity is every date.
  const said = ["dates", "from_date", "to_date", "period", "days", "except"].some((k) => raw[k] != null && raw[k] !== "" && !(Array.isArray(raw[k]) && !raw[k].length));
  if (requireScope && !said) ambiguities.push({ param: "dates", code: "scope_missing", message: "On which dates: dates, from_date/to_date, a period or days?" });
  if (scope.dates && model.range) {
    const outside = [...scope.dates].filter((d) => d < model.range.start || d > model.range.end).sort();
    if (outside.length) warnings.push(`${plural(outside.length, "date")} outside the feed's validity (${fmtDate(model.range.start)} → ${fmtDate(model.range.end)}) ignored (${describeDates(outside)}): extend the validity first (extend_validity).`);
  }
  if (closures && scope.dows) {
    const info = dateInfo(model);
    const plain = { ...scope, dows: null };
    const closed = info.dates.filter((d) => info.type.get(d) === null && scope.dows.includes(fm.dowOf(d)) && S.inScope(plain, d));
    if (closed.length) warnings.push(`${plural(closed.length, "date")} of these days without any service in the feed (${describeDates(closed)}: a closure) left as ${closed.length === 1 ? "it is" : "they are"}: give ${closed.length === 1 ? "it" : "them"} in dates to run a timetable then.`);
  }
  return { scope, dates: scopeDates(model, scope), ambiguities, warnings };
};

// ── the plan: trips of each (service, group) and their new dates ────────

/**
 * A group of lines treated alike: on `dates` their trips of the reference date run
 * (`like`), and their trips in the scope stop running (mode "replace"; "add" keeps them).
 */
const makeGroup = (model, { routes, like, scope, dates, mode = "replace", likeDate = null }) => {
  const adds = Boolean(like && like.key !== "none");
  const g = {
    routes: new Set(routes),
    like,
    likeDate: adds ? likeDate : null,
    mode,
    dates,
    addDates: adds ? dates : [],
    ref: adds ? (likeDate ? referenceNear(model, like.dows, likeDate) : referenceFor(model, like.dows)) : null,
    removeIn: mode === "add" ? null : (sid, d) => S.inScope(scope, d, model, sid),
  };
  g.lost = g.ref && g.removeIn ? lostDates(model, g) : new Map();
  return g;
};

/**
 * Per line of a group that replaces a timetable by another: the dates it loses trips on.
 * Removal reads day types per service (a Sunday service's trips go wherever they ran, a
 * holiday included) while the dates getting the `like` timetable are read per date: on a
 * holiday the network does not run as a plain Sunday (a Friday-only service still running,
 * say), the line would otherwise lose its Sunday timetable and get nothing. The `like`
 * timetable runs wherever the old one stops.
 */
const lostDates = (model, g) => {
  const svcs = new Map();
  for (const t of model.trips.values()) {
    if (!g.routes.has(t.route_id)) continue;
    if (!svcs.has(t.route_id)) svcs.set(t.route_id, new Set());
    svcs.get(t.route_id).add(t.service_id);
  }
  const memo = new Map();
  const out = new Map();
  for (const [r, set] of svcs) {
    const dates = new Set();
    for (const sid of set) {
      if (!memo.has(sid)) memo.set(sid, S.activeDates(model, sid).filter((d) => g.removeIn(sid, d)));
      for (const d of memo.get(sid)) dates.add(d);
    }
    out.set(r, dates);
  }
  return out;
};

/** The dates a line of the group runs the `like` timetable on. */
const addDatesOf = (g, route) => {
  if (!g.addByRoute) g.addByRoute = new Map();
  if (!g.addByRoute.has(route)) {
    const own = new Set(g.addDates);
    const extra = [...(g.lost.get(route) || [])].filter((d) => !own.has(d));
    g.addByRoute.set(route, extra.length ? [...own, ...extra].sort() : g.addDates);
  }
  return g.addByRoute.get(route);
};

const computePlan = (model, groups) => {
  const groupOf = new Map();
  groups.forEach((g, i) => g.routes.forEach((r) => groupOf.set(r, i)));
  const byKey = new Map();
  const touched = new Set();
  for (const t of model.trips.values()) {
    const g = groupOf.has(t.route_id) ? groupOf.get(t.route_id) : -1;
    if (g >= 0) touched.add(t.service_id);
    // Targeted trips per line: a line's `like` dates can differ from another's (lostDates).
    const key = g >= 0 ? `${t.service_id}\u0000${g}\u0000${t.route_id}` : `${t.service_id}\u0000-1`;
    if (!byKey.has(key)) byKey.set(key, { sid: t.service_id, g, route: g >= 0 ? t.route_id : null, trips: [] });
    byKey.get(key).trips.push(t.id);
  }
  const parts = [];
  for (const p of byKey.values()) {
    if (!touched.has(p.sid)) continue;
    const before = S.activeDates(model, p.sid);
    let after = before;
    if (p.g >= 0) {
      const g = groups[p.g];
      const set = new Set(g.removeIn ? before.filter((d) => !g.removeIn(p.sid, d)) : before);
      if (g.ref) {
        for (const D of addDatesOf(g, p.route)) {
          const ref = g.ref(D);
          if (ref && model.runsOn(p.sid, ref)) set.add(D);
        }
      }
      after = [...set].sort();
    }
    p.trips.sort();
    parts.push({ ...p, before, after, changed: after.join(",") !== before.join(",") });
  }
  const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  parts.sort((a, b) => cmp(a.sid, b.sid) || a.g - b.g || cmp(String(a.route), String(b.route)));
  return { parts, groups };
};

// Dates on which some targeted trips start running (the `like` timetable arrives).
const gainedDates = (plan) => {
  const out = new Set();
  for (const p of plan.parts) {
    if (p.g < 0 || !p.changed) continue;
    const b = new Set(p.before);
    for (const d of p.after) if (!b.has(d)) out.add(d);
  }
  return [...out].sort();
};

const changedDates = (plan) => {
  const out = new Set();
  for (const p of plan.parts) {
    if (!p.changed) continue;
    const a = new Set(p.after);
    const b = new Set(p.before);
    for (const d of p.before) if (!a.has(d)) out.add(d);
    for (const d of p.after) if (!b.has(d)) out.add(d);
  }
  return [...out].sort();
};

// Departures a day of the targeted lines (frequencies expanded), before and after.
const dayCounts = (model, plan, D) => {
  let before = 0;
  let after = 0;
  for (const p of plan.parts) {
    if (p.g < 0) continue;
    const n = p.trips.reduce((s, id) => s + tripStarts(model, model.trips.get(id)).length, 0);
    if (p.before.includes(D)) before += n;
    if (p.after.includes(D)) after += n;
  }
  return { before, after };
};

// Lines of a group lacking trips on a reference date (nothing to run like that day).
const likeGaps = (model, group) => {
  if (!group.ref) return [];
  const svcs = new Map();
  for (const t of model.trips.values()) {
    if (!group.routes.has(t.route_id)) continue;
    if (!svcs.has(t.route_id)) svcs.set(t.route_id, new Set());
    svcs.get(t.route_id).add(t.service_id);
  }
  const gaps = [];
  for (const r of [...group.routes].sort()) {
    const own = [...(svcs.get(r) || [])];
    const dates = addDatesOf(group, r);
    const refs = [...new Set(dates.map((d) => group.ref(d)))];
    const miss = refs.find((ref) => !ref || !own.some((s) => model.runsOn(s, ref)));
    if (miss !== undefined) gaps.push({ route: r, ref: miss || null, runs: dates.some((d) => own.some((s) => model.runsOn(s, d))) });
  }
  return gaps;
};

const dayTypesOfRoute = (model, routeId, weekend) => {
  const own = [...new Set([...model.trips.values()].filter((t) => t.route_id === routeId).map((t) => t.service_id))];
  const runs = (w) => model.representative[w] && own.some((s) => model.runsOn(s, model.representative[w]));
  const out = [];
  if (DOW.filter((d) => !weekend.includes(d)).some(runs)) out.push("weekday");
  for (const w of weekend) if (runs(w)) out.push(NAME[w].toLowerCase());
  return [...out, "none"];
};

// "weekday" when the lines do not run the same services every weekday.
const weekdayVariants = (model, group) => {
  if (!group.like || group.like.key !== "weekday" || group.likeDate) return null;
  const svcs = new Set([...model.trips.values()].filter((t) => group.routes.has(t.route_id)).map((t) => t.service_id));
  const sigs = new Map();
  for (const w of group.like.dows) {
    const d = model.representative[w];
    if (!d) continue;
    const sig = [...svcs].filter((s) => model.runsOn(s, d)).sort().join(",");
    if (!sigs.has(sig)) sigs.set(sig, []);
    sigs.get(sig).push(w);
  }
  return sigs.size > 1 ? [...sigs.values()] : null;
};

// Targeted lines that would have no date of service left in the whole feed.
const orphanedRoutes = (model, plan) => {
  const alive = new Set();
  const changed = new Set();
  for (const p of plan.parts) {
    if (p.g < 0) continue;
    for (const id of p.trips) {
      const r = model.trips.get(id).route_id;
      if (p.after.length) alive.add(r);
      if (p.changed) changed.add(r);
    }
  }
  return [...changed].filter((r) => !alive.has(r)).sort();
};

/**
 * Groups → plan, with the questions it raises. `strict`: a line with nothing to run on a
 * reference date is a question (the brief named it); otherwise it simply does not run then.
 */
const planGroups = (model, specs, { strict = true, weekend }) => {
  const ambiguities = [];
  const warnings = [];
  const groups = specs.map((s) => makeGroup(model, s));
  groups.forEach((g, i) => {
    const param = specs[i].likeParam || "like";
    const variants = weekdayVariants(model, g);
    if (variants) {
      ambiguities.push({ param, code: "like_ambiguous", message: `These lines do not run the same timetable every weekday (${variants.map((v) => v.map((w) => NAME[w]).join("/")).join(" vs ")}): like which day? Or give like_date, a date whose timetable runs (each weekday then runs its own).`, options: g.like.dows });
      return;
    }
    const gaps = likeGaps(model, g);
    if (!gaps.length) return;
    const day = g.like.day === "weekday" ? "weekday" : g.like.day;
    if (strict) {
      for (const x of gaps) {
        const where = x.ref ? ` (on ${fmtDate(x.ref)}, the ${g.likeDate ? `${day} nearest ${fmtDate(g.likeDate)}` : `nearest regular ${day}`})` : " (the feed has none)";
        ambiguities.push({ param, code: "like_day_without_service", message: `Line ${routeName(model, x.route)} has no ${day} trips to run${where}. Run it like another day, or "none"?`, options: dayTypesOfRoute(model, x.route, weekend) });
      }
    } else {
      const losing = gaps.filter((x) => x.runs).map((x) => x.route);
      if (losing.length) warnings.push(`${linesLabel(model, losing)} ${losing.length > 1 ? "have" : "has"} no ${day} timetable${g.likeDate ? ` as on ${fmtDate(g.likeDate)}` : ""}: no service on these dates.`);
    }
  });
  if (ambiguities.length) return { ambiguities, warnings };
  const plan = computePlan(model, groups);
  for (const r of orphanedRoutes(model, plan)) {
    ambiguities.push({ param: "routes", code: "line_left_without_service", message: `Line ${routeName(model, r)} would have no service left in the whole feed: remove the line instead (remove_route), or narrow the dates.` });
  }
  return { plan, ambiguities, warnings };
};

// ── writing services ────────────────────────────────────────────────────

/** The dates a service runs, read from the tables (the model may predate this step). */
const datesOf = (db, sid) => {
  const cal = db.prepare("SELECT * FROM calendar WHERE service_id = ?").get(sid);
  const set = new Set();
  if (cal) for (const d of calendars.rangeDates(String(cal.start_date), String(cal.end_date))) if (String(cal[COL[fm.dowOf(d)]]) === "1") set.add(d);
  for (const r of db.prepare("SELECT date, exception_type FROM calendar_dates WHERE service_id = ?").all(sid)) {
    if (String(r.exception_type) === "1") set.add(String(r.date));
    else if (String(r.exception_type) === "2") set.delete(String(r.date));
  }
  return [...set].sort();
};

/**
 * Make a service run exactly `dates`, in place, changing only what the edit changes: a
 * weekly flag flips when the edit turns that weekday's majority over the period (a line
 * losing every Sunday), the period shrinks when the edit moves the service's first or last
 * date weeks away from its edge, and calendar_dates exceptions make it exact. A calendar
 * whose flags were already not the service's real week (a producer writing every service
 * as "daily" minus exceptions) keeps them: one holiday is one row, not a rewrite. Rows
 * that were already meaningless (a type 2 on a day the calendar does not run) are left
 * alone. Returns the rows changed.
 */
const writeDates = (db, sid, dates) => {
  const want = new Set(dates);
  const first = dates[0];
  const last = dates[dates.length - 1];
  const cal = db.prepare("SELECT * FROM calendar WHERE service_id = ?").get(sid);
  let changedRows = 0;
  let oldBase = () => false;
  let base = () => false;
  let lo = first;
  let hi = last;
  if (cal) {
    const old = datesOf(db, sid);
    const had = new Set(old);
    const s0 = String(cal.start_date);
    const e0 = String(cal.end_date);
    const oldFlags = Object.fromEntries(DOW.map((w) => [w, String(cal[COL[w]]) === "1" ? 1 : 0]));
    oldBase = (d) => d >= s0 && d <= e0 && oldFlags[fm.dowOf(d)] === 1;
    let start = s0;
    let end = e0;
    if (first !== old[0] && first > fm.addDays(s0, SHRINK_DAYS) && first <= e0) start = first;
    if (last !== old[old.length - 1] && last < fm.addDays(e0, -SHRINK_DAYS) && last >= start) end = last;
    const total = {};
    const before = {};
    const after = {};
    for (const d of calendars.rangeDates(start, end)) {
      const w = fm.dowOf(d);
      total[w] = (total[w] || 0) + 1;
      if (had.has(d)) before[w] = (before[w] || 0) + 1;
      if (want.has(d)) after[w] = (after[w] || 0) + 1;
    }
    const majority = (a, n) => (!n || 2 * a === n ? null : 2 * a > n ? 1 : 0);
    const flags = {};
    for (const w of DOW) {
      const was = majority(before[w] || 0, total[w] || 0);
      const now = majority(after[w] || 0, total[w] || 0);
      flags[w] = now === null || now === was ? oldFlags[w] : now;
    }
    if (start !== s0 || end !== e0 || DOW.some((w) => flags[w] !== oldFlags[w])) {
      db.prepare(`UPDATE calendar SET start_date = ?, end_date = ?, ${DOW.map((w) => `${COL[w]} = ?`).join(", ")} WHERE service_id = ?`).run(start, end, ...DOW.map((w) => String(flags[w])), sid);
      changedRows += 1;
    }
    base = (d) => d >= start && d <= end && flags[fm.dowOf(d)] === 1;
    lo = [first, s0].sort()[0];
    hi = [last, e0].sort()[1];
  }
  const rows = new Map(db.prepare("SELECT date, exception_type FROM calendar_dates WHERE service_id = ?").all(sid).map((r) => [String(r.date), String(r.exception_type)]));
  const del = db.prepare("DELETE FROM calendar_dates WHERE service_id = ? AND date = ?");
  const ins = db.prepare("INSERT OR REPLACE INTO calendar_dates (service_id, date, exception_type) VALUES (?, ?, ?)");
  // Every date that may need a row, and every date that has one (a type 1 before the new
  // first date must go too).
  const span = [...new Set([...calendars.rangeDates(lo, hi), ...rows.keys()])].sort();
  for (const d of span) {
    const w = want.has(d);
    const b = base(d);
    const desired = w === b ? null : w ? "1" : "2";
    const cur = rows.get(d) ?? null;
    if (desired === cur) continue;
    if (desired == null && ((cur === "2" && !oldBase(d) && !w) || (cur === "1" && oldBase(d) && w))) continue;
    if (desired == null) del.run(sid, d);
    else ins.run(sid, d, desired);
    changedRows += 1;
  }
  return changedRows;
};

// A new service for `dates` when serviceForDates would hand back one this step rewrites.
const freshService = (db, baseId, dates, existing) => {
  const taken = db.prepare("SELECT 1 FROM calendar WHERE service_id = ? UNION SELECT 1 FROM calendar_dates WHERE service_id = ? LIMIT 1");
  const stem = `${String(baseId).slice(0, 56)}~cal`;
  let id = stem;
  for (let n = 2; taken.get(id, id); n++) id = `${stem}${n}`;
  const base = db.prepare("SELECT * FROM calendar WHERE service_id = ?").get(baseId);
  if (base) {
    const row = { ...base, service_id: id, start_date: dates[0], end_date: dates[dates.length - 1] };
    const cols = Object.keys(row);
    db.prepare(`INSERT INTO calendar (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(cols.map((c) => row[c]));
  }
  writeDates(db, id, dates);
  existing.set(dates.join(","), id);
  return id;
};

const endsAfterMidnight = (model, t) => {
  const f = model.frequencies.get(t.id);
  const run = t.lastArr != null && t.first != null ? t.lastArr - t.first : 0;
  const end = f && f.length ? Math.max(...f.map((w) => w.end)) + run : t.lastArr;
  return end != null && end > 86400 ? end : null;
};

/**
 * What the plan does to passengers and operations, read before anything is written.
 * `spill`: the step means "nothing runs on these dates" (no service, a suspension).
 */
const consequences = (db, model, plan, { spill: spillWarn = false } = {}) => {
  const warnings = [];
  const changed = plan.parts.filter((p) => p.changed);
  if (!changed.length) return warnings;

  // Trips past midnight added or removed.
  let addLate = 0;
  let remLate = 0;
  let latest = 0;
  for (const p of changed) {
    const a = new Set(p.after);
    const b = new Set(p.before);
    const gains = p.after.some((d) => !b.has(d));
    const loses = p.before.some((d) => !a.has(d));
    for (const id of p.trips) {
      const end = endsAfterMidnight(model, model.trips.get(id));
      if (end == null) continue;
      if (gains) {
        addLate += 1;
        latest = Math.max(latest, end);
      }
      if (loses) remLate += 1;
    }
  }
  if (addLate) warnings.push(`${plural(addLate, "trip")} now running on these dates continue past midnight (until ${hhmm(latest - 86400)} the next morning): in GTFS they belong to the date they start on.`);
  if (remLate) warnings.push(`${plural(remLate, "trip")} no longer running on some of these dates ran past midnight: the early morning after each such date loses them too.`);

  // A date the lines no longer serve at all still sees the previous evening's trips running
  // past midnight: they belong to the day before.
  const targeted = plan.parts.filter((p) => p.g >= 0);
  const emptied = !spillWarn ? [] : [...new Set(changed.flatMap((p) => p.before))].filter((d) => targeted.some((p) => p.before.includes(d)) && !targeted.some((p) => p.after.includes(d))).sort();
  const spill = new Set();
  const spillDates = new Set();
  let spillEnd = 0;
  for (const d of emptied) {
    const prev = fm.addDays(d, -1);
    for (const p of targeted) {
      if (!p.after.includes(prev)) continue;
      for (const id of p.trips) {
        const end = endsAfterMidnight(model, model.trips.get(id));
        if (end == null) continue;
        spill.add(id);
        spillDates.add(d);
        spillEnd = Math.max(spillEnd, end);
      }
    }
  }
  if (spill.size) {
    const list = [...spillDates].sort();
    warnings.push(`${plural(spill.size, "trip")} of the day before still run after midnight on ${describeDates(list)} (until ${hhmm(spillEnd - 86400)}): in GTFS they belong to the previous date — take that date out too if nothing may run.`);
  }

  // Stops left with no service at all on some dates.
  const stopsOf = (ids) => {
    const s = new Set();
    for (const id of ids) for (const x of model.trips.get(id).stops) s.add(x);
    return s;
  };
  const partStops = plan.parts.map((p) => stopsOf(p.trips));
  const afterSets = plan.parts.map((p) => new Set(p.after));
  const touched = new Set(plan.parts.map((p) => p.sid));
  const others = new Map();
  for (const t of model.trips.values()) {
    if (touched.has(t.service_id)) continue;
    if (!others.has(t.service_id)) others.set(t.service_id, new Set());
    for (const x of t.stops) others.get(t.service_id).add(x);
  }
  const lost = new Map();
  let lostDates = 0;
  const memo = new Map();
  const losingDates = new Set();
  plan.parts.forEach((p, i) => {
    if (p.changed) for (const d of p.before) if (!afterSets[i].has(d)) losingDates.add(d);
  });
  for (const d of [...losingDates].sort()) {
    const bIdx = [];
    const aIdx = [];
    plan.parts.forEach((p, i) => {
      if (model.runsOn(p.sid, d)) bIdx.push(i);
      if (afterSets[i].has(d)) aIdx.push(i);
    });
    const oth = [...others.keys()].filter((s) => model.runsOn(s, d));
    const key = `${bIdx}|${aIdx}|${oth}`;
    if (!memo.has(key)) {
      const served = new Set();
      for (const i of aIdx) partStops[i].forEach((x) => served.add(x));
      for (const s of oth) others.get(s).forEach((x) => served.add(x));
      const out = new Set();
      for (const i of bIdx) for (const x of partStops[i]) if (!served.has(x)) out.add(x);
      memo.set(key, out);
    }
    const out = memo.get(key);
    if (out.size) lostDates += 1;
    for (const x of out) lost.set(x, (lost.get(x) || 0) + 1);
  }
  if (lost.size) {
    const names = [...new Set([...lost.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).map(([id]) => model.stops.get(id)?.name || id))];
    warnings.push(`On ${plural(lostDates, "date")} ${plural(lost.size, "stop")} ${lost.size === 1 ? "has" : "have"} no service at all (e.g. ${names.slice(0, 5).join(", ")}${names.length > 5 ? "…" : ""}); they stay in stops.txt.`);
  }

  // Vehicle blocks whose trips now run on different dates.
  const partOf = new Map();
  plan.parts.forEach((p) => p.trips.forEach((id) => partOf.set(id, p)));
  const intern = new Map();
  const sigId = (arr) => {
    const k = arr.join(",");
    if (!intern.has(k)) intern.set(k, intern.size);
    return intern.get(k);
  };
  const blocks = new Map();
  for (const t of model.trips.values()) {
    if (!t.block_id) continue;
    const p = partOf.get(t.id);
    if (!blocks.has(t.block_id)) blocks.set(t.block_id, { before: new Set(), after: new Set(), touched: false });
    const b = blocks.get(t.block_id);
    const sb = sigId(S.activeDates(model, t.service_id));
    b.before.add(sb);
    b.after.add(p ? sigId(p.after) : sb);
    if (p && p.changed) b.touched = true;
  }
  const broken = [...blocks.entries()].filter(([, b]) => b.touched && b.after.size > b.before.size).map(([id]) => id).sort();
  if (broken.length) warnings.push(`${plural(broken.length, "vehicle block")} (block_id, e.g. ${broken.slice(0, 3).join(", ")}) now mix trips running on different dates: re-cut the vehicle schedules.`);

  // Trip-to-trip transfers.
  if (db.prepare("PRAGMA table_info(transfers)").all().some((c) => c.name === "from_trip_id")) {
    const rows = db.prepare("SELECT from_trip_id AS f, to_trip_id AS t FROM transfers WHERE (from_trip_id IS NOT NULL AND from_trip_id != '') OR (to_trip_id IS NOT NULL AND to_trip_id != '')").all();
    if (rows.length) {
      const doomed = new Set(changed.filter((p) => !p.after.length).flatMap((p) => p.trips));
      const moved = new Set(changed.filter((p) => p.after.length).flatMap((p) => p.trips));
      const del = rows.filter((r) => doomed.has(r.f) || doomed.has(r.t)).length;
      const aff = rows.filter((r) => !(doomed.has(r.f) || doomed.has(r.t)) && (moved.has(r.f) || moved.has(r.t))).length;
      if (del) warnings.push(`${plural(del, "trip-to-trip transfer")} in transfers.txt referenced deleted trips and ${del === 1 ? "was" : "were"} removed.`);
      if (aff) warnings.push(`${plural(aff, "trip-to-trip transfer")} in transfers.txt involve trips whose dates changed: check the connections still meet.`);
    }
  }
  return warnings;
};

/**
 * Write the plan: services edited in place (used only by trips getting the same dates), or
 * the changed trips moved to a service running exactly their dates, or deleted.
 */
const executePlan = (db, model, plan, opts = {}) => {
  const warnings = consequences(db, model, plan, opts);
  const out = { warnings, moved: 0, deleted: 0, created: [], edited: [], rows: 0 };
  const bySvc = new Map();
  for (const p of plan.parts) {
    if (!bySvc.has(p.sid)) bySvc.set(p.sid, []);
    bySvc.get(p.sid).push(p);
  }
  const inPlace = new Map();
  const moves = [];
  const doomed = [];
  for (const [sid, parts] of bySvc) {
    const changed = parts.filter((p) => p.changed);
    if (!changed.length) continue;
    if (parts.some((p) => !p.changed)) {
      moves.push(...changed);
      continue;
    }
    // Every trip of the service changes: the largest group keeps the service id.
    const host = [...changed].sort((a, b) => b.trips.length - a.trips.length || a.g - b.g)[0];
    const key = host.after.join(",");
    inPlace.set(sid, host.after);
    for (const p of changed) {
      if (p.after.join(",") !== key) moves.push(p);
      else if (!key) doomed.push(...p.trips);
    }
  }
  const existing = new Map();
  for (const sid of [...model.services.keys()].sort()) {
    if (inPlace.has(sid)) continue;
    const k = S.activeDates(model, sid).join(",");
    if (k && !existing.has(k)) existing.set(k, sid);
  }
  const setSvc = db.prepare("UPDATE trips SET service_id = ? WHERE trip_id = ?");
  for (const p of moves) {
    if (!p.after.length) {
      doomed.push(...p.trips);
      continue;
    }
    let sid = S.serviceForDates(db, model, p.sid, p.after, { existing });
    if (inPlace.has(sid) || (model.services.has(sid) && S.activeDates(model, sid).join(",") !== p.after.join(","))) sid = freshService(db, p.sid, p.after, existing);
    if (!model.services.has(sid) && !out.created.includes(sid)) out.created.push(sid);
    for (const id of p.trips) setSvc.run(sid, id);
    out.moved += p.trips.length;
  }
  for (const [sid, dates] of inPlace) {
    if (!dates.length) continue;
    out.rows += writeDates(db, sid, dates);
    out.edited.push(sid);
  }
  if (doomed.length) out.deleted = G.deleteTrips(db, doomed);
  G.dropUnusedServices(db, [...bySvc.keys()]);
  return out;
};

const howWritten = (out) => {
  const parts = [];
  if (out.edited.length) parts.push(`service ${out.edited.join(", ")} edited (${plural(out.rows, "calendar row")})`);
  if (out.moved) parts.push(`${plural(out.moved, "trip")} moved to ${out.created.length ? `service ${out.created.join(", ")}` : "an existing service"}`);
  if (out.deleted) parts.push(`${plural(out.deleted, "trip")} deleted (no date left)`);
  return parts.join("; ");
};

/**
 * The common apply: nothing to change → skipped; else counts on the first changed date,
 * the plan written, the operator's sentence.
 */
const runPlan = (db, model, v, sentence) => {
  const changed = changedDates(v.plan);
  if (!changed.length) return { summary: v.noopText, noop: true, warnings: [] };
  const counts = dayCounts(model, v.plan, changed[0]);
  const out = executePlan(db, model, v.plan, { spill: Boolean(v.spill) });
  const day = `${fmtDate(changed[0])}: ${counts.before} → ${counts.after} trips`;
  return { summary: `${sentence(changed)} (${day})${v.tail || ""}; ${howWritten(out)}.`, warnings: [...new Set([...(v.applyWarnings ? v.applyWarnings(changed) : []), ...out.warnings])] };
};

const holidaysAmong = (dates, dows) => dates.filter((d) => !dows.includes(fm.dowOf(d)));

// ── run_like ─────────────────────────────────────────────────────────────

/** like_date → { value: YYYYMMDD, like: the date's own day type } or a question. */
const likeDateOf = (model, raw, weekend) => {
  if (raw == null || raw === "") return { value: null };
  const y = strictDate(raw);
  if (!y) return { ambiguity: { param: "like_date", code: "date_invalid", message: `"${raw}" is not a date (YYYY-MM-DD).` } };
  const info = dateInfo(model);
  if (!info.sig.has(y)) return { ambiguity: { param: "like_date", code: "like_date_outside_validity", message: `${fmtDate(y)} is outside the feed's validity (${fmtDate(model.range.start)} → ${fmtDate(model.range.end)}): which date's timetable runs?` } };
  if (!info.sig.get(y)) return { ambiguity: { param: "like_date", code: "like_date_without_service", message: `Nothing runs on ${fmtDate(y)}: which date's timetable runs (or like "none")?` } };
  // A weekday stands for the weekday timetable (each weekday its own), a weekend day for itself.
  const type = info.type.get(y) || fm.dowOf(y);
  const like = parseLike(weekend.includes(type) ? NAME[type] : "weekday", weekend, "like").value;
  return { value: y, like };
};

const resolveRunLike = async (model, p, ctx = {}) => {
  const weekend = ctx.weekend || model.weekend || ["sat", "sun"];
  const ambiguities = [];
  const rt = resolveRoutes(model, p.routes ?? p.route, "routes");
  const ex = resolveRoutes(model, p.except_routes, "except_routes", { required: false });
  ambiguities.push(...rt.ambiguities, ...ex.ambiguities);
  // like_date: the timetable as it ran on (near) that date — a period's timetable.
  const ld = likeDateOf(model, p.like_date, weekend);
  if (ld.ambiguity) ambiguities.push(ld.ambiguity);
  // Without like, the date's own day type (a date that is itself a question asks nothing more).
  const like = p.like == null && (ld.value || ld.ambiguity) ? { value: ld.value ? ld.like : null } : parseLike(p.like, weekend, "like");
  if (like.ambiguity) ambiguities.push(like.ambiguity);
  const sc = await scopeOf(model, p, ctx, { requireScope: true, closures: Boolean(like.value && like.value.key !== "none") });
  ambiguities.push(...sc.ambiguities);
  const warnings = [...sc.warnings];
  if (ambiguities.length) return { ambiguities, warnings };
  const routes = rt.ids.filter((r) => !ex.ids.includes(r));
  if (!routes.length) return { ambiguities: [{ param: "except_routes", code: "routes_empty", message: "Every line listed is also an exception: which lines change?" }], warnings };
  const likeDate = like.value.key === "none" ? null : ld.value;
  if (ld.value && !likeDate) warnings.push(`like_date (${fmtDate(ld.value)}) is not used: like is "none" (no service).`);
  const pg = planGroups(model, [{ routes, like: like.value, scope: sc.scope, dates: sc.dates, likeDate }], { strict: !rt.all, weekend });
  warnings.push(...pg.warnings);
  if (pg.ambiguities.length) return { ambiguities: pg.ambiguities, warnings };
  if (!sc.dates.length && !pg.plan.parts.some((x) => x.changed)) return { ambiguities: [{ param: "dates", code: "scope_empty", message: "No service date of the feed falls in this scope: which dates?" }], warnings };
  const label = linesLabel(model, routes, { all: rt.all, except: ex.ids });
  const lv = likeDate ? { ...like.value, label: `${like.value.label} as on ${fmtDate(likeDate)}` } : like.value;
  if (likeDate) {
    const g = pg.plan.groups[0];
    const refs = [...new Set(sc.dates.map((d) => g.ref(d)).filter(Boolean))].sort();
    const far = refs.filter((d) => Math.abs(daysBetween(likeDate, d)) > 6);
    warnings.push(`The timetable is taken from ${describeDates(refs)}${far.length ? ` — ${describeDates(far)} more than a week from ${fmtDate(likeDate)} (no such day nearer): check it is the same period` : ""}.`);
  }
  return {
    value: {
      plan: pg.plan,
      noopText: lv.key === "none" ? `${label} already ${routes.length === 1 && !rt.all ? "has" : "have"} no service on ${describeDates(sc.dates)}: nothing to change.` : `${label} already run${routes.length === 1 && !rt.all ? "s" : ""} ${lv.label} on ${describeDates(sc.dates)}: nothing to change.`,
      sentence: lv.key === "none" ? `${label}: no service on` : `${label} run${routes.length === 1 && !rt.all ? "s" : ""} ${lv.label} on`,
      spill: lv.key === "none",
    },
    ambiguities: [],
    warnings,
  };
};

const applyRunLike = (db, v, { model }) => runPlan(db, model, v, (changed) => `${v.sentence} ${describeDates(changed)}`);

// ── copy_day_service ─────────────────────────────────────────────────────

const resolveCopy = async (model, p, ctx = {}) => {
  const weekend = ctx.weekend || model.weekend || ["sat", "sun"];
  const ambiguities = [];
  const warnings = [];
  const rt = resolveRoutes(model, p.routes ?? p.route, "routes");
  const ex = resolveRoutes(model, p.except_routes, "except_routes", { required: false });
  ambiguities.push(...rt.ambiguities, ...ex.ambiguities);
  const from = parseLike(p.from_day, weekend, "from_day");
  if (from.ambiguity) ambiguities.push(from.ambiguity);
  else if (from.value.key === "none") ambiguities.push({ param: "from_day", code: "from_day_invalid", message: "copy_day_service copies a timetable: which day's (weekday, saturday, sunday…)? To stop a day's service use remove_day_service.", options: LIKE_OPTIONS.filter((x) => x !== "none") });
  let toDays = null;
  if (p.to_days == null || p.to_days === "" || (Array.isArray(p.to_days) && !p.to_days.length)) ambiguities.push({ param: "to_days", code: "to_days_missing", message: "Which days get the copied timetable (e.g. sunday)?", options: ["weekday", "saturday", "sunday", ...DOW] });
  else {
    const d = R.days(p.to_days);
    if (d.ambiguity) ambiguities.push({ param: "to_days", ...d.ambiguity });
    else toDays = d.value;
  }
  const mode = p.mode == null || p.mode === "" ? "replace" : String(p.mode).toLowerCase();
  if (!["replace", "add"].includes(mode)) ambiguities.push({ param: "mode", code: "mode_invalid", message: "mode is \"replace\" (the old trips of those days go) or \"add\" (they stay alongside the copy).", options: ["replace", "add"] });
  const sc = await scopeOf(model, { ...p, days: null }, ctx, { dows: toDays || undefined, closures: true });
  ambiguities.push(...sc.ambiguities);
  warnings.push(...sc.warnings);
  if (ambiguities.length) return { ambiguities, warnings };
  const routes = rt.ids.filter((r) => !ex.ids.includes(r));
  if (!routes.length) return { ambiguities: [{ param: "except_routes", code: "routes_empty", message: "Every line listed is also an exception: which lines change?" }], warnings };
  const pg = planGroups(model, [{ routes, like: from.value, scope: sc.scope, dates: sc.dates, mode, likeParam: "from_day" }], { strict: true, weekend });
  warnings.push(...pg.warnings);
  if (pg.ambiguities.length) return { ambiguities: pg.ambiguities, warnings };
  if (!sc.dates.length) return { ambiguities: [{ param: "to_days", code: "scope_empty", message: `No ${daysLabel(toDays, weekend)} in the feed's validity within this scope: which dates?` }], warnings };
  const toLabel = daysLabel(toDays, weekend);
  if (toDays.some((d) => !from.value.dows.includes(d))) warnings.push(`Running times and span (first and last departures) are copied from ${from.value.label}: on ${toLabel} traffic and the start of service often differ — check them.`);
  if (mode === "add") {
    const set = new Set(sc.dates);
    const already = pg.plan.parts.filter((x) => x.g >= 0 && x.before.some((d) => set.has(d))).reduce((n, x) => n + x.trips.length, 0);
    if (already) warnings.push(`${plural(already, "trip")} of these lines already ran on ${toLabel}: kept alongside the copy (mode add) — check for duplicates.`);
  }
  const label = linesLabel(model, routes, { all: rt.all, except: ex.ids });
  return {
    value: {
      plan: pg.plan,
      noopText: `${label}: ${from.value.label} already runs on ${toLabel} in this period — nothing to change.`,
      from: from.value,
      toDays,
      toLabel,
      label,
      mode,
    },
    ambiguities: [],
    warnings,
  };
};

const applyCopy = (db, v, { model }) =>
  runPlan(db, model, v, (changed) => {
    // Holidays the network runs as to_days that now get the copied timetable.
    const hol = holidaysAmong(gainedDates(v.plan), v.toDays).length;
    return `${v.label}: ${v.from.label} ${v.mode === "add" ? "added" : "copied"} to ${v.toLabel} on ${describeDates(changed)}${hol ? ` (incl. ${plural(hol, "holiday")} run as ${v.toLabel})` : ""}`;
  });

// ── remove_day_service ───────────────────────────────────────────────────

const resolveRemove = async (model, p, ctx = {}) => {
  const weekend = ctx.weekend || model.weekend || ["sat", "sun"];
  const ambiguities = [];
  const rt = resolveRoutes(model, p.routes ?? p.route, "routes");
  const ex = resolveRoutes(model, p.except_routes, "except_routes", { required: false });
  ambiguities.push(...rt.ambiguities, ...ex.ambiguities);
  const sc = await scopeOf(model, p, ctx, { daysRequired: true });
  ambiguities.push(...sc.ambiguities);
  const warnings = [...sc.warnings];
  if (ambiguities.length) return { ambiguities, warnings };
  const routes = rt.ids.filter((r) => !ex.ids.includes(r));
  if (!routes.length) return { ambiguities: [{ param: "except_routes", code: "routes_empty", message: "Every line listed is also an exception: which lines change?" }], warnings };
  const pg = planGroups(model, [{ routes, like: null, scope: sc.scope, dates: sc.dates }], { weekend });
  if (pg.ambiguities.length) return { ambiguities: pg.ambiguities, warnings };
  const dows = sc.scope.dows || DOW;
  const dayLabel = daysAdj(dows, weekend);
  const label = linesLabel(model, routes, { all: rt.all, except: ex.ids });
  const when = S.isAll({ ...sc.scope, dows: null }) ? "" : ` (${S.describeScope({ ...sc.scope, dows: null })})`;
  return {
    value: {
      plan: pg.plan,
      noopText: `${label}: no ${dayLabel} service to remove${when}.`,
      label,
      dayLabel,
      dows,
      applyWarnings: (changed) => {
        const hol = holidaysAmong(changed, dows);
        return hol.length ? [`The ${dayLabel} timetable also ran on ${plural(hol.length, "other date")} (${describeDates(hol)}, e.g. holidays): no service then either — take them out with except if it should run.`] : [];
      },
    },
    ambiguities: [],
    warnings,
  };
};

const applyRemove = (db, v, { model }) => runPlan(db, model, v, (changed) => `${v.label}: no more ${v.dayLabel} service on ${describeDates(changed)}`);

// ── suspend_service ──────────────────────────────────────────────────────

const OPEN_END = new Set(["until further notice", "open", "indefinite", "indefinitely", "end", "none", "jusqu a nouvel ordre", "sine die"]);

const resolveSuspend = async (model, p, ctx = {}) => {
  const weekend = ctx.weekend || model.weekend || ["sat", "sun"];
  const ambiguities = [];
  const warnings = [];
  const rt = resolveRoutes(model, p.routes ?? p.route, "routes");
  const ex = resolveRoutes(model, p.except_routes, "except_routes", { required: false });
  ambiguities.push(...rt.ambiguities, ...ex.ambiguities);
  const given = (v) => v != null && v !== "" && !(Array.isArray(v) && !v.length);
  const openEnd = given(p.to_date) && OPEN_END.has(norm(p.to_date));
  if (!given(p.dates) && !given(p.period)) {
    if (!given(p.from_date) && !given(p.to_date)) ambiguities.push({ param: "from_date", code: "dates_missing", message: "When is the service suspended? Give from_date and to_date (or dates, or a period)." });
    else if (!given(p.from_date)) ambiguities.push({ param: "from_date", code: "from_date_missing", message: "From which date is the service suspended (from_date)?" });
    else if (!given(p.to_date)) ambiguities.push({ param: "to_date", code: "to_date_missing", message: "Until when (to_date, inclusive)? Or \"until_further_notice\".", options: ["until_further_notice"] });
  }
  const sc = await scopeOf(model, { ...p, to_date: openEnd ? null : p.to_date }, ctx);
  ambiguities.push(...sc.ambiguities);
  warnings.push(...sc.warnings);
  if (ambiguities.length) return { ambiguities, warnings };
  const routes = rt.ids.filter((r) => !ex.ids.includes(r));
  if (!routes.length) return { ambiguities: [{ param: "except_routes", code: "routes_empty", message: "Every line listed is also an exception: which lines are suspended?" }], warnings };
  const pg = planGroups(model, [{ routes, like: null, scope: sc.scope, dates: sc.dates }], { weekend });
  if (pg.ambiguities.length) return { ambiguities: pg.ambiguities, warnings };
  if (!sc.dates.length && !pg.plan.parts.some((x) => x.changed)) return { ambiguities: [{ param: "from_date", code: "scope_empty", message: "No service date of the feed falls in these dates: which dates?" }], warnings };
  if (openEnd) warnings.push(`Suspended until further notice: until the end of the feed (${fmtDate(model.range.end)}); publish the resumption date as soon as it is known.`);
  const first = sc.dates[0];
  const today = todayOf(ctx);
  if (first) {
    const lead = daysBetween(today, first);
    if (lead < 0) warnings.push(`The suspension starts on ${fmtDate(first)}, before today (${fmtDate(today)}): check the dates.`);
    else if (lead < SHORT_NOTICE_DAYS) warnings.push(`The suspension starts on ${fmtDate(first)}, within ${SHORT_NOTICE_DAYS} days: journey planners take days to load a new feed — announce it through GTFS-RT (service alerts, trip updates) too.`);
  }
  const replacement = String(p.replacement ?? "").trim();
  if (replacement) warnings.push(`The replacement (${replacement}) is not created by this step: add it as a line with its own stops (route_type 3, or 714 for rail replacement buses).`);
  else warnings.push("No replacement service stated: if substitute buses run, add them as a line with its own stops.");
  const label = linesLabel(model, routes, { all: rt.all, except: ex.ids });
  return {
    value: {
      plan: pg.plan,
      noopText: `${label}: no service to suspend on these dates.`,
      label,
      replacement,
      tail: replacement ? ` — replacement: ${replacement}` : " — no replacement stated",
      spill: true,
    },
    ambiguities: [],
    warnings,
  };
};

const applySuspend = (db, v, { model }) => runPlan(db, model, v, (changed) => `${v.label} suspended on ${describeDates(changed)}`);

// ── apply_holiday_rules ──────────────────────────────────────────────────

const resolveHolidays = async (model, p, ctx = {}) => {
  const weekend = ctx.weekend || model.weekend || ["sat", "sun"];
  const ambiguities = [];
  const rt = resolveRoutes(model, p.routes ?? p.route, "routes", { fallbackAll: true });
  const ex = resolveRoutes(model, p.except_routes, "except_routes", { required: false });
  ambiguities.push(...rt.ambiguities, ...ex.ambiguities);
  const rule = parseLike(p.rule ?? p.like ?? "sunday", weekend, "rule");
  if (rule.ambiguity) ambiguities.push(rule.ambiguity);
  const exRule = parseLike(p.except_rule, weekend, "except_rule", { required: false });
  if (exRule.ambiguity) ambiguities.push(exRule.ambiguity);
  else if (exRule.value && !ex.ids.length && !ex.ambiguities.length) ambiguities.push({ param: "except_routes", code: "except_routes_missing", message: "except_rule is given: which lines follow it (except_routes)?" });
  const hasDates = (Array.isArray(p.dates) && p.dates.length) || (p.dates && !Array.isArray(p.dates));
  const params = { ...p, days: null, period: p.period || (hasDates ? null : "public_holidays") };
  const sc = await scopeOf(model, params, ctx);
  ambiguities.push(...sc.ambiguities);
  const warnings = [...sc.warnings];
  if (ambiguities.length) return { ambiguities, warnings };
  if (!sc.dates.length) return { ambiguities: [{ param: "dates", code: "scope_empty", message: "No holiday falls in the feed's validity: which dates?" }], warnings };
  const main = rt.ids.filter((r) => !ex.ids.includes(r));
  const specs = [];
  if (main.length) specs.push({ routes: main, like: rule.value, scope: sc.scope, dates: sc.dates, likeParam: "rule" });
  if (exRule.value) specs.push({ routes: ex.ids, like: exRule.value, scope: sc.scope, dates: sc.dates, likeParam: "except_rule" });
  if (!specs.length) return { ambiguities: [{ param: "except_routes", code: "routes_empty", message: "Every line is an exception and no except_rule is given: which lines change?" }], warnings };
  const pg = planGroups(model, specs, { strict: false, weekend });
  warnings.push(...pg.warnings);
  if (pg.ambiguities.length) return { ambiguities: pg.ambiguities, warnings };
  const ruleText = (lv, one) => (lv.key === "none" ? (one ? "does not run" : "do not run") : `run${one ? "s" : ""} ${lv.label}`);
  const parts = [];
  if (main.length) parts.push(`${linesLabel(model, main, { all: rt.all, except: ex.ids })} ${ruleText(rule.value, main.length === 1 && !rt.all)}`);
  if (exRule.value) parts.push(`${linesLabel(model, ex.ids)} ${ruleText(exRule.value, ex.ids.length === 1)}`);
  else if (ex.ids.length) parts.push(`${linesLabel(model, ex.ids)} keep${ex.ids.length === 1 ? "s" : ""} ${ex.ids.length === 1 ? "its" : "their"} own timetable`);
  const period = String(sc.scope.periodLabel || "").replace(/_/g, " ");
  const what = period ? `${period[0].toUpperCase()}${period.slice(1)}` : "Holidays";
  return {
    value: {
      plan: pg.plan,
      noopText: `${what} (${describeDates(sc.dates)}): already as asked — ${parts.join("; ")}.`,
      what,
      rules: parts.join("; "),
      total: sc.dates.length,
      spill: rule.value.key === "none",
    },
    ambiguities: [],
    warnings,
  };
};

const applyHolidays = (db, v, { model }) => runPlan(db, model, v, (changed) => `${v.what}, ${plural(v.total, "date")} in the feed: ${v.rules} — ${changed.length} changed (${describeDates(changed)})`);

// ── extend_validity ──────────────────────────────────────────────────────

/**
 * The weekdays a service really runs near one end of its dates: those it ran on at least
 * half of the last (first) 8 weeks — whatever calendar.txt says. A holiday taken out stays
 * a one-off; a producer's "daily minus exceptions" Saturday service is a Saturday service.
 */
const weeklyPattern = (dates, side) => {
  if (!dates.length) return [];
  const edge = side === "end" ? dates[dates.length - 1] : dates[0];
  let lo = side === "end" ? fm.addDays(edge, -55) : edge;
  let hi = side === "end" ? edge : fm.addDays(edge, 55);
  if (lo < dates[0]) lo = dates[0];
  if (hi > dates[dates.length - 1]) hi = dates[dates.length - 1];
  const active = new Set(dates);
  const out = [];
  for (const w of DOW) {
    let n = 0;
    let a = 0;
    for (const d of calendars.rangeDates(lo, hi)) {
      if (fm.dowOf(d) !== w) continue;
      n += 1;
      if (active.has(d)) a += 1;
    }
    if (n && a * 2 >= n) out.push(w);
  }
  return DOW.filter((w) => out.includes(w));
};

const resolveExtend = async (model, p, ctx = {}) => {
  const weekend = ctx.weekend || model.weekend || ["sat", "sun"];
  const ambiguities = [];
  const warnings = [];
  // The validity is where trips run: a leftover service without trips (calendar to 2099,
  // say) neither blocks an extension nor pushes the new dates past a gap.
  const used = new Set([...model.trips.values()].map((t) => t.service_id));
  const svcs = [...model.services.values()].filter((s) => used.has(s.id)).sort((a, b) => (a.id < b.id ? -1 : 1));
  const act = new Map(svcs.map((s) => [s.id, S.activeDates(model, s.id)]));
  const served = svcs.map((s) => act.get(s.id)).filter((a) => a.length);
  if (!model.range || !served.length) return { ambiguities: [{ param: "end_date", code: "feed_without_dates", message: "The feed has no service dates to extend: add calendars first." }], warnings };
  const cur = { start: served.map((a) => a[0]).sort()[0], end: served.map((a) => a[a.length - 1]).sort().at(-1) };
  const dates = {};
  for (const k of ["end_date", "start_date"]) {
    if (p[k] == null || p[k] === "") continue;
    const y = strictDate(p[k]);
    if (!y) ambiguities.push({ param: k, code: "date_invalid", message: `"${p[k]}" is not a date (YYYY-MM-DD).` });
    else dates[k] = y;
  }
  const endGiven = p.end_date != null && p.end_date !== "";
  const startGiven = p.start_date != null && p.start_date !== "";
  if (!endGiven && !startGiven) ambiguities.push({ param: "end_date", code: "end_date_missing", message: `Until when should the feed run? It ends on ${fmtDate(cur.end)}: give end_date (and/or an earlier start_date).` });
  if (dates.end_date && dates.end_date < cur.end) ambiguities.push({ param: "end_date", code: "end_date_before_current", message: `The feed already runs until ${fmtDate(cur.end)}: extend_validity only extends. To stop service earlier, suspend or remove it after that date. Which end_date after ${fmtDate(cur.end)}?` });
  if (dates.start_date && dates.start_date > cur.start) ambiguities.push({ param: "start_date", code: "start_date_after_current", message: `The feed already starts on ${fmtDate(cur.start)}: a later start would drop service dates, which extend_validity does not do. Give a start_date on or before ${fmtDate(cur.start)}, or leave it out.` });
  const newStart = dates.start_date && dates.start_date < cur.start ? dates.start_date : cur.start;
  const newEnd = dates.end_date && dates.end_date > cur.end ? dates.end_date : cur.end;
  if (daysBetween(newStart, newEnd) > MAX_VALIDITY_DAYS) ambiguities.push({ param: "end_date", code: "validity_too_long", message: `${fmtDate(newStart)} → ${fmtDate(newEnd)} is more than ${MAX_VALIDITY_DAYS} days: publish a shorter validity (usually one year or less).` });
  const isNew = (d) => (d > cur.end && d <= newEnd) || (d < cur.start && d >= newStart);

  // Holidays of the NEW dates.
  const holGiven = p.holidays != null && p.holidays !== "" && !(Array.isArray(p.holidays) && !p.holidays.length);
  const ruleGiven = p.holiday_rule != null && p.holiday_rule !== "";
  let rule = null;
  if (holGiven || ruleGiven) {
    const r = parseLike(ruleGiven ? p.holiday_rule : "sunday", weekend, "holiday_rule");
    if (r.ambiguity) ambiguities.push(r.ambiguity);
    else rule = r.value;
  }
  if (ruleGiven && !holGiven) ambiguities.push({ param: "holidays", code: "holidays_missing", message: "holiday_rule is given: which holidays (\"public_holidays\", or a list of dates)?", options: ["public_holidays"] });
  let holidays = [];
  if (holGiven && !ambiguities.length) {
    const list = Array.isArray(p.holidays) ? p.holidays : /^\d/.test(String(p.holidays).trim()) ? String(p.holidays).split(/[,;\s]+/).filter(Boolean) : null;
    if (list) {
      for (const d of list) {
        const y = strictDate(d);
        if (!y) ambiguities.push({ param: "holidays", code: "date_invalid", message: `"${d}" is not a date (YYYY-MM-DD).` });
        else holidays.push(y);
      }
    } else {
      const n = await calendars.named(p.holidays, { calendars: ctx.calendars || null, country: ctx.country || null, region: p.region || ctx.region || null, from: newStart, to: newEnd, fetchImpl: ctx.fetchImpl || null });
      if (n.ambiguity) ambiguities.push({ param: "holidays", ...n.ambiguity });
      else holidays = [...n.dates];
    }
    holidays = [...new Set(holidays)].sort();
    const old = holidays.filter((d) => !isNew(d));
    holidays = holidays.filter(isNew);
    if (old.length && !ambiguities.length) warnings.push(`${plural(old.length, "holiday")} outside the new dates left as they are (${describeDates(old)}): the rule applies to the new dates only (apply_holiday_rules for the others).`);
  }
  if (ambiguities.length) return { ambiguities, warnings };

  // Which services follow: those running up to the feed's edge (by the dates they really
  // run, not calendar.txt's end_date), each on the week it really runs there.
  const feedLast = cur.end;
  const feedFirst = cur.start;
  const endDates = newEnd > cur.end ? calendars.rangeDates(fm.addDays(cur.end, 1), newEnd) : [];
  const startDates = newStart < cur.start ? calendars.rangeDates(newStart, fm.addDays(cur.start, -1)) : [];
  const plans = [];
  const seasonal = [];
  const late = [];
  const stuck = [];
  const cdOnly = [];
  const reshaped = [];
  const oneOff = new Set();
  const noted = new Set();
  const dayList = (dows) => (dows.length === 7 ? "every day" : dows.map((w) => NAME[w].slice(0, 3)).join(", "));
  for (const s of svcs) {
    const dates = act.get(s.id);
    if (!dates.length) continue;
    const plan = { sid: s.id, dates: [], end: false, start: false };
    for (const [side, list, near] of [["end", endDates, dates.at(-1) >= fm.addDays(feedLast, -NEAR_EDGE_DAYS)], ["start", startDates, dates[0] <= fm.addDays(feedFirst, NEAR_EDGE_DAYS)]]) {
      if (!list.length) continue;
      if (!near) {
        (side === "end" ? seasonal : late).push(`${s.id} (${side === "end" ? `last runs ${fmtDate(dates.at(-1))}` : `first runs ${fmtDate(dates[0])}`})`);
        continue;
      }
      const dows = weeklyPattern(dates, side);
      if (!dows.length) {
        stuck.push(s.id);
        continue;
      }
      plan[side] = true;
      plan.dates.push(...list.filter((d) => dows.includes(fm.dowOf(d))));
      const flags = DOW.filter((w) => s.days.has(w));
      if (!noted.has(s.id)) {
        if (!s.start) cdOnly.push(`${s.id} (${dayList(dows)})`);
        else if (flags.join() !== dows.join()) reshaped.push(`${s.id} (${flags.length ? dayList(flags) : "no day"} in calendar.txt, ${dayList(dows)} in practice)`);
        noted.add(s.id);
      }
      // Its exceptions that are not its week (a holiday off, an extra day) are one-offs.
      for (const d of s.added) if (!dows.includes(fm.dowOf(d))) oneOff.add(d);
      for (const d of s.removed) if (dows.includes(fm.dowOf(d)) && d >= cur.start && d <= cur.end) oneOff.add(d);
    }
    plan.dates = [...new Set(plan.dates)].sort();
    if (plan.dates.length) plans.push(plan);
  }
  const some = (list) => `${list.slice(0, 6).join(", ")}${list.length > 6 ? "…" : ""}`;
  if (seasonal.length) warnings.push(`${plural(seasonal.length, "service")} ending before the feed's last date ${seasonal.length === 1 ? "was" : "were"} not extended (seasonal): ${some(seasonal)}.`);
  if (late.length) warnings.push(`${plural(late.length, "service")} starting after the feed's first date ${late.length === 1 ? "was" : "were"} not extended back (seasonal): ${some(late)}.`);
  if (cdOnly.length) warnings.push(`${plural(cdOnly.length, "service")} without a calendar.txt row: ${cdOnly.length === 1 ? "its" : "their"} weekly pattern was repeated on the new dates (calendar_dates): ${some(cdOnly)}.`);
  if (reshaped.length) warnings.push(`${plural(reshaped.length, "service")} ${reshaped.length === 1 ? "does" : "do"} not run the days calendar.txt says: the new dates repeat the days ${reshaped.length === 1 ? "it" : "they"} ran in the last 8 weeks, not the calendar's: ${some(reshaped)}.`);
  if (stuck.length) warnings.push(`${plural(new Set(stuck).size, "service")} without a weekly pattern (no weekday run on half of the last 8 weeks) not extended: ${some([...new Set(stuck)])} — give their new dates explicitly.`);
  if (endDates.length || startDates.length) {
    const list = [...oneOff].sort();
    if (list.length && !holidays.length) warnings.push(`The one-off exceptions of the current period (${plural(list.length, "date")}: ${describeDates(list)}) are not repeated: the new dates run the plain weekly pattern. Give holidays (public_holidays or dates) to run the holiday timetable on the new ones.`);
  }
  const feedInfo = Boolean(model.feedInfo);
  if (!feedInfo) warnings.push("The feed has no feed_info.txt: add one with feed_start_date and feed_end_date (GTFS Best Practices).");
  else if (model.feedInfo.feed_version) warnings.push(`feed_version (${model.feedInfo.feed_version}) is unchanged: update it when you publish.`);
  const today = todayOf(ctx);
  const left = daysBetween(today, cur.end);
  if (endDates.length && left >= 0 && left < SHORT_NOTICE_DAYS) warnings.push(`The current feed expires on ${fmtDate(cur.end)}, within ${SHORT_NOTICE_DAYS} days: publish the extended feed now (at least 7 days before expiry).`);
  return {
    value: { cur, newStart, newEnd, startGiven: Boolean(dates.start_date), plans, holidays, rule, feedInfo },
    ambiguities: [],
    warnings,
  };
};

/**
 * The calendar_dates rows that make a service with calendar `cal` ({ start, end, flags } or
 * null) run exactly `want` over `window`, as few as possible: a row already giving the right
 * answer stays. → [{ date, type }] (type null: delete the row).
 */
const exceptionOps = (rows, cal, want, window) => {
  const ops = [];
  for (const d of window) {
    const w = want.has(d);
    const b = Boolean(cal && d >= cal.start && d <= cal.end && cal.flags[fm.dowOf(d)] === 1);
    const cur = rows.get(d) ?? null;
    const eff = cur === "1" ? true : cur === "2" ? false : b;
    if (eff === w) continue;
    ops.push({ date: d, type: w === b ? null : w ? "1" : "2" });
  }
  return ops;
};

/**
 * A service keeps its old dates and runs `plan.dates` too (new, outside the old validity).
 * Either its calendar period reaches the new edge and exceptions take out the days it does
 * not really run (and keep the old dates between its end_date and the feed's end as they
 * were), or its calendar stays and each new date gets a type 1 row: whichever writes fewer
 * rows (a calendar_dates-only service always gets rows). → rows written, or null.
 */
const extendService = (db, model, plan, v) => {
  const sid = plan.sid;
  const cal = db.prepare("SELECT * FROM calendar WHERE service_id = ?").get(sid);
  const rows = new Map(db.prepare("SELECT date, exception_type FROM calendar_dates WHERE service_id = ?").all(sid).map((r) => [String(r.date), String(r.exception_type)]));
  const want = new Set([...S.activeDates(model, sid), ...plan.dates]);
  const window = calendars.rangeDates(v.newStart, v.newEnd);
  const flags = cal && Object.fromEntries(DOW.map((w) => [w, String(cal[COL[w]]) === "1" ? 1 : 0]));
  const s0 = cal && String(cal.start_date);
  const e0 = cal && String(cal.end_date);
  const kept = exceptionOps(rows, cal && { start: s0, end: e0, flags }, want, window);
  let best = { period: null, ops: kept, cost: kept.length };
  if (cal) {
    const start = plan.start && v.newStart < s0 ? v.newStart : s0;
    const end = plan.end && v.newEnd > e0 ? v.newEnd : e0;
    if (start !== s0 || end !== e0) {
      const ops = exceptionOps(rows, { start, end, flags }, want, window);
      if (ops.length + 1 <= best.cost) best = { period: { start, end }, ops, cost: ops.length + 1 };
    }
  }
  if (!best.cost) return null;
  if (best.period) db.prepare("UPDATE calendar SET start_date = ?, end_date = ? WHERE service_id = ?").run(best.period.start, best.period.end, sid);
  const del = db.prepare("DELETE FROM calendar_dates WHERE service_id = ? AND date = ?");
  const ins = db.prepare("INSERT OR REPLACE INTO calendar_dates (service_id, date, exception_type) VALUES (?, ?, ?)");
  for (const o of best.ops) {
    if (o.type == null) del.run(sid, o.date);
    else ins.run(sid, o.date, o.type);
  }
  return best.ops.length;
};

const applyExtend = (db, v, { model, weekend }) => {
  const warnings = [];
  let services = 0;
  let cdRows = 0;
  for (const plan of v.plans) {
    const n = extendService(db, model, plan, v);
    if (n == null) continue;
    services += 1;
    cdRows += n;
  }
  let feedInfo = false;
  if (v.feedInfo) {
    const rows = db.prepare("SELECT feed_start_date AS s, feed_end_date AS e FROM feed_info").all();
    if (rows.some((r) => String(r.e ?? "") !== v.newEnd || (v.startGiven && String(r.s ?? "") !== v.newStart))) {
      if (v.startGiven) db.prepare("UPDATE feed_info SET feed_start_date = ?, feed_end_date = ?").run(v.newStart, v.newEnd);
      else db.prepare("UPDATE feed_info SET feed_end_date = ?").run(v.newEnd);
      feedInfo = true;
    }
  }
  // Holidays on the new dates: run_like on the extended feed.
  let holText = "";
  if (v.holidays.length && v.rule) {
    const m2 = buildFeedModel(db, { weekend });
    const dates = v.holidays.filter((d) => m2.range && d >= m2.range.start && d <= m2.range.end);
    const scope = { dows: null, from: null, to: null, dates: new Set(dates), except: null };
    const group = makeGroup(m2, { routes: [...m2.routes.keys()], like: v.rule, scope, dates });
    const gaps = likeGaps(m2, group).filter((x) => x.runs).map((x) => x.route);
    if (gaps.length) warnings.push(`${linesLabel(m2, gaps)} ${gaps.length > 1 ? "have" : "has"} no ${v.rule.day} timetable: no service on the new holidays.`);
    const plan = computePlan(m2, [group]);
    const changed = changedDates(plan);
    if (changed.length) {
      const out = executePlan(db, m2, plan);
      warnings.push(...out.warnings);
    }
    holText = `; ${plural(dates.length, "new holiday")} ${v.rule.key === "none" ? "without service" : `on ${v.rule.label}`} (${describeDates(dates)})`;
  }
  const noop = !services && !feedInfo && !holText;
  if (noop) return { summary: `The feed already runs from ${fmtDate(v.cur.start)} to ${fmtDate(v.newEnd)}: nothing to extend.`, noop: true, warnings: [] };
  const parts = [`${plural(services, "service")} extended`];
  if (cdRows) parts.push(`${plural(cdRows, "calendar_dates row")} written`);
  if (feedInfo) parts.push("feed_info dates updated");
  return {
    summary: `Validity ${fmtDate(v.cur.start)} → ${fmtDate(v.cur.end)} extended to ${fmtDate(v.newStart)} → ${fmtDate(v.newEnd)}: ${parts.join(", ")}${holText}.`,
    warnings: [...new Set(warnings)],
  };
};

// ── the catalogue ───────────────────────────────────────────────────────

const ROUTES_PARAM = { name: "routes", type: "routes", required: true, description: "The lines: a list (short names or ids), one line, or \"all\"." };
const EXCEPT_ROUTES_PARAM = { name: "except_routes", type: "routes", required: false, description: "Lines left out (they keep their own timetable)." };

module.exports = [
  {
    type: "run_like",
    title: "Run another day's timetable on some dates",
    category: "calendar",
    tables: TABLES,
    description: "On the scope's dates the lines run the timetable of another day type (the nearest regular such day), or none. Written as calendar_dates exceptions when their services are theirs alone; otherwise their trips move to a service running exactly the new dates.",
    params: [
      ROUTES_PARAM,
      { name: "like", type: "enum", enum: ["weekday", "saturday", "sunday", "none", ...DOW], required: true, description: "The day type whose timetable runs: weekday, saturday, sunday, a day (mon…sun), or none (no service)." },
      { name: "like_date", type: "date", required: false, description: "The timetable as it ran on this date (each weekday runs its own, from the same days nearest it): the school-holiday timetable as on 19 April, say. Without like, the date's own day type." },
      { name: "days", type: "days", required: false, description: "Only the dates of these day types within the scope (e.g. weekday during the school holidays)." },
      ...S.SCOPE_PARAMS,
      EXCEPT_ROUTES_PARAM,
    ],
    example: { routes: "all", like: "sunday", dates: ["2026-07-14"] },
    resolve: resolveRunLike,
    apply: applyRunLike,
  },
  {
    type: "copy_day_service",
    title: "Give a line another day's timetable on a day type",
    category: "calendar",
    tables: TABLES,
    description: "The lines run from_day's timetable on to_days (e.g. Sunday service at Saturday levels), from a date on or over a period. mode replace (default) drops their old trips of those days; add keeps them alongside.",
    params: [
      ROUTES_PARAM,
      { name: "from_day", type: "enum", enum: ["weekday", "saturday", "sunday", ...DOW], required: true, description: "The day type whose timetable is copied." },
      { name: "to_days", type: "days", required: true, description: "The day types that get it (e.g. sunday)." },
      { name: "mode", type: "enum", enum: ["replace", "add"], required: false, description: "replace (default): the lines' existing trips of to_days go; add: they stay alongside the copy." },
      ...S.SCOPE_PARAMS,
      EXCEPT_ROUTES_PARAM,
    ],
    example: { routes: ["B1"], from_day: "saturday", to_days: "sunday", from_date: "2026-08-30" },
    resolve: resolveCopy,
    apply: applyCopy,
  },
  {
    type: "remove_day_service",
    title: "Stop a line's service on a day type",
    category: "calendar",
    tables: TABLES,
    description: "The lines' trips of those day types stop running in the scope (by default for the whole validity), including the holidays that ran that day type's timetable. Other days keep their timetable.",
    params: [ROUTES_PARAM, { name: "days", type: "days", required: true, description: "The day types that lose service (e.g. sunday)." }, ...S.SCOPE_PARAMS, EXCEPT_ROUTES_PARAM],
    example: { routes: ["B1"], days: "sunday", from_date: "2026-09-01" },
    resolve: resolveRemove,
    apply: applyRemove,
  },
  {
    type: "suspend_service",
    title: "Suspend lines over a period",
    category: "calendar",
    tables: TABLES,
    description: "No service on the lines over a date range (works, season, strike): from_date + to_date (or \"until_further_notice\"), dates or a period. The replacement service is reported, not created.",
    params: [
      ROUTES_PARAM,
      ...S.SCOPE_PARAMS,
      { name: "days", type: "days", required: false, description: "Only these day types within the period (default: every day)." },
      { name: "replacement", type: "string", required: false, description: "The substitute service, as the brief states it (reported in the summary)." },
      EXCEPT_ROUTES_PARAM,
    ],
    example: { routes: ["F1"], from_date: "2026-07-06", to_date: "2026-08-31", replacement: "Shuttle buses between Wall St and Dumbo" },
    resolve: resolveSuspend,
    apply: applySuspend,
  },
  {
    type: "apply_holiday_rules",
    title: "Set the timetable of public holidays",
    category: "calendar",
    tables: TABLES,
    description: "On the holidays (dates, or period public_holidays by default) the lines run the rule's timetable (sunday by default, saturday, a day, or none); except_routes keep theirs or follow except_rule. Lines without trips of that day type do not run then.",
    params: [
      { name: "routes", type: "routes", required: false, description: "The lines (default: all)." },
      { name: "rule", type: "enum", enum: ["sunday", "saturday", "weekday", "none", ...DOW], required: false, description: "The timetable of the holidays (default: sunday)." },
      EXCEPT_ROUTES_PARAM,
      { name: "except_rule", type: "enum", enum: ["sunday", "saturday", "weekday", "none", ...DOW], required: false, description: "The timetable of except_routes on the holidays (default: they keep their own)." },
      ...S.SCOPE_PARAMS,
    ],
    example: { period: "public_holidays", rule: "sunday", except_routes: ["B1"], except_rule: "none" },
    resolve: resolveHolidays,
    apply: applyHolidays,
  },
  {
    type: "extend_validity",
    title: "Extend the feed's validity",
    category: "calendar",
    tables: [...TABLES, "feed_info"],
    description: "Roll the calendar forward to a new end_date (and/or back to an earlier start_date): services running to the feed's edge follow, seasonal ones do not, feed_info follows; old one-off exceptions are not repeated, holidays of the new dates get holiday_rule.",
    params: [
      { name: "end_date", type: "date", required: true, description: "The new last date (after the current one). Required unless start_date is given." },
      { name: "start_date", type: "date", required: false, description: "A new, earlier first date." },
      { name: "holidays", type: "period", required: false, description: "Holidays of the new dates: public_holidays, a period of the plan, or a list of dates." },
      { name: "holiday_rule", type: "enum", enum: ["sunday", "saturday", "weekday", "none", ...DOW], required: false, description: "The timetable of those holidays (default: sunday)." },
      { name: "region", type: "string", required: false, description: "Region, when the holidays depend on it." },
    ],
    example: { end_date: "2027-07-04", holidays: "public_holidays", holiday_rule: "sunday" },
    resolve: resolveExtend,
    apply: applyExtend,
  },
];

module.exports._internals = { parseLike, resolveRoutes, dateInfo, referenceFor, scopeDates, computePlan, writeDates };
