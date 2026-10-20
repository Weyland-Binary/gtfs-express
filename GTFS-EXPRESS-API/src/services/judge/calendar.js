/**
 * calendar — when a clause is measured: the days a day word names, the dates
 * of a clause's window, the day types it asks and the distinct timetables of
 * its scope (the grid), on a feed's calendars or a design's.
 *
 *
 * The time clauses (every kind but line_exists, termini, via, serves, mode,
 * lines_max, lines_min, fleet_max, budget_max and the identity, accessibility,
 * validity, coverage and volume kinds) are measured on EVERY
 * distinct timetable of their scope, never a sample (gridOf): the dates of
 * their window — `dates`, `from_date` / `to_date` (inclusive), `period`
 * (school_days, school_holidays, public_holidays or a period the plan's
 * calendars define) or, undated, the whole validity from `today` — whose day
 * type they ask, grouped by the services the measured line runs that date.
 * The worst timetable decides; `measured_on` lists one date per timetable
 * and `grid` counts them. A Monday is a Monday: a weekday of the school
 * holidays is a weekday (only a public holiday is retyped, feedView). On a
 * designed network without dates, the grid is structural: the calendars of
 * a day word, split into school term and school holidays when the design
 * has school calendars.
 */

"use strict";

const networkSpec = require("../network/networkSpec");
const { str, fmt, iso, given, clockOf } = require("./values");

const { departuresOf } = networkSpec;

const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_WORDS = { weekday: null, weekdays: null, workday: null, saturday: ["sat"], sunday: ["sun"], weekend: null, daily: DAY_KEYS };

/** Days a day word names, following the local weekend. */
const daysOf = (raw, spec) => {
  const weekend = Array.isArray(spec.weekend) && spec.weekend.length ? spec.weekend : ["sat", "sun"];
  const list = Array.isArray(raw) ? raw : [raw];
  const out = new Set();
  for (const r of list) {
    const k = str(r).toLowerCase();
    if (!k) continue;
    if (["weekday", "weekdays", "workday", "workdays"].includes(k)) DAY_KEYS.filter((d) => !weekend.includes(d)).forEach((d) => out.add(d));
    else if (k === "weekend") weekend.forEach((d) => out.add(d));
    else if (DAY_WORDS[k]) DAY_WORDS[k].forEach((d) => out.add(d));
    else if (DAY_KEYS.includes(k.slice(0, 3))) out.add(k.slice(0, 3));
  }
  return [...out];
};

// Departures (seconds, at the first stop) of a line on a day, per direction:
// the services whose calendar runs that day (`runs(calendar)`, by default
// the calendar's weekly days). A feed view (transform/feedView) measures the
// real timetable instead: headways at the trunk, spans at the termini, on
// the representative date.
const departuresByDirection = (line, spec, day, purpose = "headway", runs = null) => {
  if (!runs && typeof spec.departuresOf === "function") return spec.departuresOf(line, day, purpose);
  const runsOn = runs || ((c) => (c.days || []).includes(day));
  const cal = new Map((spec.calendars || []).map((c) => [c.id, c]));
  const out = new Map((line.directions || []).map((d) => [d.id, []]));
  for (const svc of line.services || []) {
    const c = cal.get(svc.calendar_id);
    if (!c || !runsOn(c)) continue;
    const deps = departuresOf(svc);
    for (const d of line.directions || []) {
      if (svc.direction !== "both" && svc.direction !== d.id) continue;
      let times = deps;
      if (d.id === "1" && svc.direction === "both" && svc.reverse_offset_min != null) times = deps.map((t) => t + Math.round(svc.reverse_offset_min * 60));
      out.get(d.id).push(...times);
    }
  }
  for (const [k, v] of out) out.set(k, [...new Set(v)].sort((a, b) => a - b));
  return out;
};

// ── When: every distinct timetable of the clause's scope ──────────────────
//
// A time clause is measured on its SCOPE: the dates of its window (`dates`,
// `from_date` / `to_date`, `period`; undated, the validity from `today`)
// whose day type it asks (scopeOf), grouped by the timetable the measured
// line runs that date (gridOf: the sorted ids of its services — a design:
// its calendars). EVERY group is measured, on its first date, with no cap:
// the worst decides, `measured_on` lists every group's date and `grid`
// counts them. A clause without a line is gridded per line. Only
// od_max_time (a CSA run per timetable) is capped: above MAX_OD_TIMETABLES
// it is unknown, never passed on a sample. An undated clause on a designed
// network is gridded on its calendars (structuralPoints).

const MAX_OD_TIMETABLES = 12;
const MAX_WINDOW_DAYS = 800;
const DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const ymdDate = (ymd) => new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)));
const dowOfYmd = (ymd) => DOW[ymdDate(ymd).getUTCDay()];
const nextYmd = (ymd) => {
  const d = ymdDate(ymd);
  d.setUTCDate(d.getUTCDate() + 1);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
};
const parseYmd = (v) => require("../transform/calendars").parseDate(v);
const canonicalPeriod = (name) => require("../transform/calendars").canonical(name);

/**
 * The dates a clause names, or null when it names none. A named period is
 * resolved by the caller (transform/feedView.resolveClausePeriods) into
 * ctx.periods[clause id] = { dates, label } | { error }; on a designed
 * network, school_days / school_holidays select the calendars of that
 * period (calendar.period) and public_holidays the spec's holidays.
 */
const windowOf = (c, ctx) => {
  const p = c.params || {};
  if (!given(p.dates) && !given(p.from_date) && !given(p.to_date) && !given(p.period)) return null;
  const w = { from: null, to: null, dates: null, periodDates: null, calendarFilter: null, labels: [] };
  for (const [k, key] of [["from_date", "from"], ["to_date", "to"]]) {
    if (!given(p[k])) continue;
    const y = parseYmd(p[k]);
    if (!y) return { error: `${k} "${p[k]}" is not a date (YYYY-MM-DD)` };
    w[key] = y;
  }
  if (w.from && w.to && w.to < w.from) return { error: `the window ends (${iso(w.to)}) before it starts (${iso(w.from)})` };
  if (w.from || w.to) w.labels.push(`${w.from ? iso(w.from) : "…"} → ${w.to ? iso(w.to) : "…"}`);
  if (given(p.dates)) {
    const list = Array.isArray(p.dates) ? p.dates : String(p.dates).split(/[\s,;]+/).filter(Boolean);
    const set = new Set();
    for (const d of list.slice(0, 400)) {
      const y = parseYmd(d);
      if (!y) return { error: `"${d}" is not a date (YYYY-MM-DD)` };
      set.add(y);
    }
    w.dates = set;
    w.labels.push(set.size === 1 ? iso([...set][0]) : `${set.size} dates`);
  }
  if (given(p.period)) {
    const name = str(p.period);
    const kind = canonicalPeriod(name);
    if (ctx.spec.kind === "feed") {
      const r = ctx.periods?.[c.id];
      if (!r) return { error: `the period "${name}" could not be resolved: give its dates (from_date/to_date or dates)` };
      if (r.error) return { error: `the period "${name}" could not be resolved (${r.error}): give its dates` };
      w.periodDates = r.dates instanceof Set ? r.dates : new Set(r.dates || []);
      w.labels.push(r.label || name);
    } else if (kind === "school_days" || kind === "school_holidays") {
      // A design's calendars say which period they run in (none: all year).
      w.calendarFilter = (cal) => !cal.period || canonicalPeriod(cal.period) === kind;
      w.labels.push(kind.replace("_", " "));
    } else if (kind === "public_holidays") {
      w.periodDates = new Set((ctx.spec.holidays || []).map(String));
      w.labels.push("public holidays");
    } else return { error: `the period "${name}" is not defined for a designed network: give its dates (from_date/to_date or dates)` };
  }
  return w;
};

// The day type a public holiday runs like: the compiler's rule
// (compiler.holidayDayType) — "sunday"/"saturday" name the local rest days.
const holidayDayOf = (spec) => {
  if (spec.holiday_service === "none") return null;
  const named = spec.holiday_service === "saturday" ? "sat" : "sun";
  const weekend = Array.isArray(spec.weekend) && spec.weekend.length ? spec.weekend : ["sat", "sun"];
  if (weekend.includes(named)) return named;
  return spec.holiday_service === "saturday" ? weekend[weekend.length - 1] : weekend[0];
};

/** The services of compiled tables running on a date (calendar + calendar_dates). */
const tableServicesOn = (tables, ymd) => {
  const col = { mon: "monday", tue: "tuesday", wed: "wednesday", thu: "thursday", fri: "friday", sat: "saturday", sun: "sunday" }[dowOfYmd(ymd)];
  const out = new Set((tables?.calendar || []).filter((c) => String(c[col]) === "1" && String(c.start_date) <= ymd && ymd <= String(c.end_date)).map((c) => c.service_id));
  for (const d of tables?.calendar_dates || []) {
    if (String(d.date) !== ymd) continue;
    if (String(d.exception_type) === "1") out.add(d.service_id);
    else out.delete(d.service_id);
  }
  return out;
};

/**
 * The dates of a designed network: a calendar runs on a date inside its
 * validity when the date is one of its weekly days — unless the date is
 * explicitly excluded or included (exclude_dates / include_dates), or a
 * public holiday of the spec (it then runs like the holiday day type).
 * networkSpec.runsOnSpecCalendar decides the weekly part when it exists.
 */
const designCalendar = (spec) => {
  const holidays = new Set((spec.holidays || []).map(String));
  const holidayDay = holidayDayOf(spec);
  const runsOn = (cal, ymd) => {
    if (Array.isArray(cal.include_dates) && cal.include_dates.map(String).includes(ymd)) return true;
    if (Array.isArray(cal.exclude_dates) && cal.exclude_dates.map(String).includes(ymd)) return false;
    const start = cal.start_date || spec.feed?.start_date;
    const end = cal.end_date || spec.feed?.end_date;
    if ((start && ymd < start) || (end && ymd > end)) return false;
    if (holidays.has(ymd)) return holidayDay ? (cal.days || []).includes(holidayDay) : false;
    if (typeof networkSpec.runsOnSpecCalendar === "function") {
      const runs = networkSpec.runsOnSpecCalendar(cal, ymd);
      // A school calendar whose dates are not known yet: the clause cannot be measured on dates (unknown, never a guess).
      if (runs === null) throw new Error(`the dates of calendar ${cal.id} (${cal.period}${cal.region ? `, zone ${cal.region}` : ""}) are not known yet: they come from the territory's school holidays`);
      return runs;
    }
    return (cal.days || []).includes(dowOfYmd(ymd));
  };
  const cals = new Map((spec.calendars || []).map((c) => [c.id, c]));
  return {
    validity: spec.feed?.start_date && spec.feed?.end_date ? { start: spec.feed.start_date, end: spec.feed.end_date } : null,
    representativeDate: () => null,
    // A holiday counts as the day type it runs like (none: not a service day).
    dateTypeOf: (ymd) => (holidays.has(ymd) ? holidayDay : dowOfYmd(ymd)),
    dateSignature: (ymd, lines, filter) =>
      [...new Set(lines.flatMap((l) => (l.services || []).map((s) => s.calendar_id)))]
        .filter((id) => cals.has(id) && (!filter || filter(cals.get(id))) && runsOn(cals.get(id), ymd))
        .sort()
        .join(","),
    departuresOnDate: (line, ymd, purpose, filter) => departuresByDirection(line, spec, null, purpose, (cal) => (!filter || filter(cal)) && runsOn(cal, ymd)),
    serviceIdsOnDate: (ymd, tables) => tableServicesOn(tables, ymd),
  };
};

/** The calendar a check reads dates from: a feed view brings its own. */
const calendarOf = (spec) => (spec.kind === "feed" && typeof spec.departuresOnDate === "function" ? spec : designCalendar(spec));

const hashOf = (text) => {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(36);
};

// The day words of a clause: `day`, else `days` (the list days / no_service take).
const dayWordsOf = (p) => (given(p.day) ? p.day : given(p.days) ? p.days : null);
const WEEKDAY_SET = (spec) => daysOf("weekday", spec).join(",");
/** A list of day keys as the brief says it: weekday, daily, saturday… or the keys. */
const dayLabel = (days, spec) => {
  const k = [...days].sort((a, b) => DAY_KEYS.indexOf(a) - DAY_KEYS.indexOf(b)).join(",");
  if (k === WEEKDAY_SET(spec)) return "weekday";
  if (k === DAY_KEYS.join(",")) return "daily";
  if (k === daysOf("weekend", spec).sort((a, b) => DAY_KEYS.indexOf(a) - DAY_KEYS.indexOf(b)).join(",")) return "weekend";
  if (k === "sat") return "saturday";
  if (k === "sun") return "sunday";
  return k;
};

/**
 * The dates a clause is measured on (the full grid):
 *   window  its dates, from_date / to_date and period (windowOf); undated,
 *           the measured feed's validity from ctx.today (when inside it)
 *   days    the dates whose day type (calendar.dateTypeOf) is one of the
 *           clause's day words, else of `defaultDay`; listed dates without
 *           a day word, a public-holidays period without one, or
 *           `everyDate` keep every date as it is
 * → { dates, days, label, labels, from, to, key } | { structural, days, label }
 *   (an undated clause on a design) | { error } | { note }
 * `validity` overrides the calendar's (unchanged_except: both feeds').
 */
const scopeOf = (c, ctx, { defaultDay = null, everyDate = false, validity = null } = {}) => {
  const { spec } = ctx;
  const cal = calendarOf(spec);
  const p = c.params || {};
  const w = windowOf(c, ctx);
  if (w && w.error) return { error: w.error };
  const said = dayWordsOf(p);
  const publicPeriod = Boolean(w?.periodDates) && canonicalPeriod(str(p.period)) === "public_holidays";
  // Listed dates are measured as they are; so are a public-holidays period and a dated clause of a kind without a default day.
  const unfiltered = !said && (Boolean(w?.dates) || publicPeriod || everyDate || (Boolean(w) && !defaultDay));
  const days = said ? daysOf(said, spec) : unfiltered ? null : defaultDay ? daysOf(defaultDay, spec) : null;
  if (said && !days.length) return { note: "no day named" };
  if (!days && !unfiltered) return { note: "no day named" };
  if (!w && spec.kind !== "feed") {
    if (!days) return { note: "no day named: a design is measured on day types" };
    return { structural: true, days, label: days.join(","), labels: [] };
  }
  const v = validity || cal.validity;
  let from;
  let to;
  if (!w) {
    from = v?.start || null;
    to = v?.end || null;
    if (ctx.today && v && ctx.today >= v.start && ctx.today <= v.end) from = ctx.today;
  } else {
    from = w.from || v?.start || null;
    to = w.to || v?.end || null;
  }
  let candidates;
  if (w?.periodDates) candidates = [...w.periodDates].filter((d) => (!from || d >= from) && (!to || d <= to) && (!w.dates || w.dates.has(d)));
  else if (w?.dates) candidates = [...w.dates].filter((d) => (!w.from || d >= w.from) && (!w.to || d <= w.to));
  else {
    candidates = [];
    if (from && to) for (let d = from, i = 0; d <= to && i < MAX_WINDOW_DAYS; d = nextYmd(d), i++) candidates.push(d);
  }
  candidates = [...new Set(candidates)].sort();
  const dates = days ? candidates.filter((d) => {
    const type = cal.dateTypeOf(d);
    return type != null && days.includes(type); // another day type, or a public holiday left out
  }) : candidates;
  const labels = w?.labels || [];
  const label = [days ? days.join(",") : null, ...labels].filter(Boolean).join(", ");
  if (!dates.length) return { note: `no ${days ? days.join(",") : "service"} date in the window (${labels.join(", ") || "validity"})` };
  return { dates, days, label, labels, from: dates[0], to: dates[dates.length - 1], key: `${dates.length}|${dates[0]}|${dates[dates.length - 1]}|${hashOf(dates.join(""))}`, filter: w?.calendarFilter || null };
};

// A design's calendar is a school one: its period, canonical.
const schoolPeriodOf = (cal) => {
  const k = cal && cal.period ? canonicalPeriod(cal.period) : null;
  return k === "school_days" || k === "school_holidays" ? k : null;
};

/**
 * The timetables of an undated clause on a design, for these lines: for
 * each day word, the calendars running it — split into school term (the
 * all-year calendars and the school_days ones) and school holidays (the
 * all-year ones and the school_holidays ones) when the design has school
 * calendars, even when no calendar runs in the holidays (a line whose only
 * weekday calendar is a school one then has no holiday service, which a
 * weekday clause must see). Days with the same calendars are one timetable.
 */
const structuralPoints = (ctx, lines, days) => {
  const { spec } = ctx;
  const cals = spec.calendars || [];
  const ofLines = new Set(lines.flatMap((l) => (l.services || []).map((s) => s.calendar_id)));
  const schools = cals.some((cl) => schoolPeriodOf(cl));
  const groups = new Map();
  for (const d of days) {
    const runs = (cl) => (cl.days || []).includes(d);
    const all = cals.filter((cl) => !schoolPeriodOf(cl) && runs(cl));
    const sets = schools
      ? [
          ["term", [...all, ...cals.filter((cl) => schoolPeriodOf(cl) === "school_days" && runs(cl))]],
          ["holidays", [...all, ...cals.filter((cl) => schoolPeriodOf(cl) === "school_holidays" && runs(cl))]],
        ]
      : [["all", all]];
    for (const [kind, set] of sets) {
      const ids = [...new Set(set.map((cl) => cl.id))].filter((id) => ofLines.has(id)).sort();
      const key = ids.join(",");
      if (!groups.has(key)) groups.set(key, { ids, days: new Set(), kinds: new Set() });
      groups.get(key).days.add(d);
      groups.get(key).kinds.add(kind);
    }
  }
  return [...groups.values()].map((g) => {
    const dayList = [...g.days];
    const period = g.kinds.has("all") || (g.kinds.has("term") && g.kinds.has("holidays")) ? "" : g.kinds.has("term") ? ", school term" : ", school holidays";
    const idSet = new Set(g.ids);
    return {
      key: g.ids.join(","),
      date: null,
      structural: true,
      split: Boolean(period),
      dates: [],
      dates_count: 0,
      label: `${dayLabel(dayList, spec)}${period}`,
      day: dayList[0],
      calendarIds: g.ids,
      deps: (line, purpose) => departuresByDirection(line, spec, dayList[0], purpose, (cl) => idSet.has(cl.id)),
      serviceIds: () => new Set(g.ids),
    };
  });
};

/**
 * The timetables of a scope for these lines, each measured once:
 *   → [{ key, date|null, dates, dates_count, label, day, calendarIds?,
 *        deps(line, purpose), serviceIds() }]
 * Dates: grouped by the lines' services (a design: calendars) running that
 * date, in date order, memoised per model, lines and scope on a feed.
 * `splitBy(date)`: a further key (same_as like_week: the weekday).
 */
const gridOf = (scope, ctx, lines, { splitBy = null } = {}) => {
  if (scope.structural) return structuralPoints(ctx, lines, scope.days);
  const { spec } = ctx;
  const cal = calendarOf(spec);
  const filter = scope.filter || null;
  const group = () => {
    const groups = new Map();
    for (const d of scope.dates) {
      const sig = cal.dateSignature(d, lines, filter);
      const key = splitBy ? `${sig}|${splitBy(d)}` : sig;
      if (!groups.has(key)) groups.set(key, { sig, dates: [] });
      groups.get(key).dates.push(d);
    }
    return [...groups.entries()].map(([key, g]) => ({ key, sig: g.sig, dates: g.dates }));
  };
  const groups = spec.kind === "feed" && typeof spec.memo === "function" && !splitBy ? spec.memo(`grid|${lines.map((l) => l.id).join(",")}|${scope.key}`, group) : group();
  return groups.map((g) => {
    const date = g.dates[0];
    return {
      key: g.key,
      date,
      dates: g.dates,
      dates_count: g.dates.length,
      label: iso(date),
      day: dowOfYmd(date),
      calendarIds: spec.kind === "feed" ? null : g.sig.split(",").filter(Boolean),
      deps: (line, purpose) => cal.departuresOnDate(line, date, purpose, filter),
      serviceIds: () => cal.serviceIdsOnDate(date, ctx.tables),
    };
  });
};

/**
 * What a grid measured, as the result reports it: every timetable of every
 * line (add), the failing ones (add(..., true)).
 *   grid()    → { timetables, dates, failing, from, to }
 *   suffix()  → " — 1 of 2 timetables fails (29 dates)" | " — 2 timetables, 169 dates";
 *               nothing for a single structural timetable (a design's day type, as always)
 *   measuredOn() → one date per timetable, all of them, sorted
 *   lines()   → the ids of the lines measured, in order (a verdict's anchors: never a line the measure skipped)
 */
const gridTally = (scope) => {
  const seen = [];
  const failing = [];
  const lines = [];
  const add = (line, point, bad = false) => {
    seen.push(point);
    if (bad) failing.push(point);
    if (line && line.id != null && !lines.includes(line.id)) lines.push(line.id);
  };
  const failDates = () => new Set(failing.flatMap((pt) => pt.dates || [])).size;
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return {
    add,
    count: () => seen.length,
    failingCount: () => failing.length,
    lines: () => [...lines],
    grid: () => ({ timetables: seen.length, dates: scope.dates ? scope.dates.length : 0, failing: failing.length, from: scope.from || null, to: scope.to || null }),
    suffix: () => {
      if (scope.structural) {
        if (seen.length <= 1) return "";
        return failing.length ? ` — ${failing.length} of ${seen.length} timetables fail${failing.length === 1 ? "s" : ""}` : ` — ${plural(seen.length, "timetable")}`;
      }
      return failing.length ? ` — ${failing.length} of ${plural(seen.length, "timetable")} fail${failing.length === 1 ? "s" : ""} (${plural(failDates(), "date")})` : ` — ${plural(seen.length, "timetable")}, ${plural(scope.dates.length, "date")}`;
    },
    measuredOn: () => [...new Set(seen.map((pt) => pt.date).filter(Boolean))].sort(),
  };
};

/**
 * Where a measure was taken, in a measured text: " on 2026-11-18" for a
 * date, " (weekday, school holidays)" for a design's school timetable
 * (`always`: any design timetable), nothing for a design's day type.
 */
const where = (point, always = false) => (point?.date ? ` on ${iso(point.date)}` : point?.structural && (point.split || always) ? ` (${point.label})` : "");

/** The window of a clause on a trip's departure (from / to, HH:MM, inclusive). */
const clockWindow = (p) => {
  const from = given(p.from) ? clockOf(p.from) : null;
  const to = given(p.to) ? clockOf(p.to) : null;
  if (given(p.from) && from == null) return { error: `incomplete clause (from "${p.from}" is not a time, HH:MM)` };
  if (given(p.to) && to == null) return { error: `incomplete clause (to "${p.to}" is not a time, HH:MM)` };
  const all = from == null && to == null;
  return { all, has: (t) => t != null && (from == null || t >= from) && (to == null || t <= to), text: all ? "" : `, leaving ${from != null ? fmt(from) : "…"}–${to != null ? fmt(to) : "…"}` };
};

/** The date of the week of `anyDate` (Monday to Sunday) that falls on `dow`. */
const weekDay = (anyDate, dow) => {
  const d = ymdDate(anyDate);
  const monday = (d.getUTCDay() + 6) % 7;
  const target = (DOW.indexOf(dow) + 6) % 7;
  d.setUTCDate(d.getUTCDate() - monday + target);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
};
const weekDates = (anyDate) => DAY_KEYS.map((d) => weekDay(anyDate, d));

module.exports = { daysOf, departuresByDirection, MAX_OD_TIMETABLES, DOW, dowOfYmd, parseYmd, canonicalPeriod, windowOf, holidayDayOf, designCalendar, calendarOf, dayWordsOf, dayLabel, scopeOf, structuralPoints, gridOf, gridTally, where, clockWindow, weekDay, weekDates };
