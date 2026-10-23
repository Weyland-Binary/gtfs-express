/**
 * When a clause is measured. A time clause is measured on every distinct timetable of its scope, never a sample:
 * the dates of its window (undated, the validity from `today`) of the day type it asks, grouped by the services the
 * line runs that date. The worst timetable decides. A weekday of the school holidays is a weekday: only a public
 * holiday is retyped (feedView).
 */

"use strict";

const { str, fmt, iso, given, clockOf } = require("./values");
const { DAY_S, EARLY_MORNING_S } = require("../../utils/time");

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

/** Null when the clause names no date. A named period comes resolved in ctx.periods[clause id] (feedView). */
const windowOf = (c, ctx) => {
  const p = c.params || {};
  if (!given(p.dates) && !given(p.from_date) && !given(p.to_date) && !given(p.period)) return null;
  const w = { from: null, to: null, dates: null, periodDates: null, labels: [] };
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
    const r = ctx.periods?.[c.id];
    if (!r) return { error: `the period "${name}" could not be resolved: give its dates (from_date/to_date or dates)` };
    if (r.error) return { error: `the period "${name}" could not be resolved (${r.error}): give its dates` };
    w.periodDates = r.dates instanceof Set ? r.dates : new Set(r.dates || []);
    w.labels.push(r.label || name);
  }
  return w;
};

const hashOf = (text) => {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(36);
};

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

/** `validity` overrides the calendar's (unchanged_except measures both feeds'). */
const scopeOf = (c, ctx, { defaultDay = null, everyDate = false, validity = null } = {}) => {
  const { spec } = ctx;
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
  const v = validity || spec.validity;
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
    const type = spec.dateTypeOf(d);
    return type != null && days.includes(type); // another day type, or a public holiday left out
  }) : candidates;
  const labels = w?.labels || [];
  const label = [days ? days.join(",") : null, ...labels].filter(Boolean).join(", ");
  if (!dates.length) return { note: `no ${days ? days.join(",") : "service"} date in the window (${labels.join(", ") || "validity"})` };
  return { dates, days, label, labels, from: dates[0], to: dates[dates.length - 1], key: `${dates.length}|${dates[0]}|${dates[dates.length - 1]}|${hashOf(dates.join(""))}` };
};

/** Each timetable is measured once, on its first date. `splitBy(date)` adds a key (same_as like_week: the weekday). */
const gridOf = (scope, ctx, lines, { splitBy = null } = {}) => {
  const { spec } = ctx;
  const group = () => {
    const groups = new Map();
    for (const d of scope.dates) {
      const sig = spec.dateSignature(d, lines);
      const key = splitBy ? `${sig}|${splitBy(d)}` : sig;
      if (!groups.has(key)) groups.set(key, { sig, dates: [] });
      groups.get(key).dates.push(d);
    }
    return [...groups.entries()].map(([key, g]) => ({ key, sig: g.sig, dates: g.dates }));
  };
  const groups = typeof spec.memo === "function" && !splitBy ? spec.memo(`grid|${lines.map((l) => l.id).join(",")}|${scope.key}`, group) : group();
  return groups.map((g) => {
    const date = g.dates[0];
    return {
      key: g.key,
      date,
      dates: g.dates,
      dates_count: g.dates.length,
      label: iso(date),
      day: dowOfYmd(date),
      deps: (line, purpose) => spec.departuresOnDate(line, date, purpose),
    };
  });
};

/** `lines()` are a verdict's anchors: never a line the measure skipped. */
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
    suffix: () =>
      failing.length ? ` — ${failing.length} of ${plural(seen.length, "timetable")} fail${failing.length === 1 ? "s" : ""} (${plural(failDates(), "date")})` : ` — ${plural(seen.length, "timetable")}, ${plural(scope.dates.length, "date")}`,
    measuredOn: () => [...new Set(seen.map((pt) => pt.date).filter(Boolean))].sort(),
  };
};

const where = (point) => (point?.date ? ` on ${iso(point.date)}` : "");

// ── The service day's clock

// A timetable running past this hour may write a time after midnight as a small hour (00:30 for 24:30).
const LATE_EVENING_S = 20 * 3600;

/** The service day's clock: a window ending before it starts runs past midnight (23:00–01:00 is 23:00–25:00). */
const serviceDayEnd = (from, to) => (from != null && to != null && to < from ? to + DAY_S : to);

const flagOf = (v) => (v === true || v === "true" ? true : v === false || v === "false" ? false : null);

/**
 * The readings of the clock times a clause gives (null: not given) on a timetable whose last departure is `latest`:
 * as written and, when all are small hours (before EARLY_MORNING_S) on a timetable running past LATE_EVENING_S, 24 h
 * later too (00:30 may mean 24:30); after_midnight settles it. A verdict holding under one reading only is a
 * question (readBoth).
 */
const clockReadings = (values, latest, afterMidnight = null) => {
  const given_ = values.filter((v) => v != null);
  if (!given_.length || !given_.every((v) => v < EARLY_MORNING_S)) return [values];
  const late = values.map((v) => (v == null ? v : v + DAY_S));
  const flag = flagOf(afterMidnight);
  if (flag === true) return [late];
  if (flag === false) return [values];
  return latest != null && latest >= LATE_EVENING_S ? [values, late] : [values];
};
const clocksText = (values, sep = "–") => values.map((v) => (v == null ? "…" : fmt(v))).join(sep);
const readingNote = (values, sep = "–") => `the verdict depends on whether ${clocksText(values, sep)} means ${clocksText(values, sep)} or ${clocksText(values.map((v) => (v == null ? v : v + DAY_S)), sep)} (after midnight): the brief does not say (after_midnight)`;
/**
 * `measure(reading)` → { bad, … } on each reading: the first reading's measure (`better(x, y)`: the other when the
 * verdicts agree and it reads better), flagged `ambiguous` when the verdicts differ.
 */
const readBoth = (readings, measure, better = null) => {
  const out = readings.map(measure);
  if (out.length < 2) return { ...out[0], ambiguous: false };
  const ambiguous = Boolean(out[0].bad) !== Boolean(out[1].bad);
  const pick = !ambiguous && better && better(out[1], out[0]) ? out[1] : out[0];
  return { ...pick, ambiguous };
};

/** The clause's departure window, from / to inclusive, on the service day's clock (serviceDayEnd). */
const clockWindow = (p) => {
  const from = given(p.from) ? clockOf(p.from) : null;
  const to = given(p.to) ? serviceDayEnd(from, clockOf(p.to)) : null;
  if (given(p.from) && from == null) return { error: `incomplete clause (from "${p.from}" is not a time, HH:MM)` };
  if (given(p.to) && to == null) return { error: `incomplete clause (to "${p.to}" is not a time, HH:MM)` };
  const all = from == null && to == null;
  const within = (f, t) => (x) => x != null && (f == null || x >= f) && (t == null || x <= t);
  return {
    all,
    from,
    to,
    has: within(from, to),
    // The window's readings on a timetable (clockReadings): [{ from, to, has, values }].
    readings: (latest) => (all ? [{ from, to, has: within(from, to), values: [from, to] }] : clockReadings([from, to], latest, p.after_midnight).map(([f, t]) => ({ from: f, to: t, has: within(f, t), values: [f, t] }))),
    text: all ? "" : `, leaving ${clocksText([from, to])}`,
  };
};

/** Weeks run Monday to Sunday. */
const weekDay = (anyDate, dow) => {
  const d = ymdDate(anyDate);
  const monday = (d.getUTCDay() + 6) % 7;
  const target = (DOW.indexOf(dow) + 6) % 7;
  d.setUTCDate(d.getUTCDate() - monday + target);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
};
const weekDates = (anyDate) => DAY_KEYS.map((d) => weekDay(anyDate, d));

module.exports = { daysOf, DOW, dowOfYmd, parseYmd, canonicalPeriod, windowOf, dayWordsOf, dayLabel, scopeOf, gridOf, gridTally, where, LATE_EVENING_S, serviceDayEnd, clockReadings, clocksText, readingNote, readBoth, clockWindow, weekDay, weekDates };
