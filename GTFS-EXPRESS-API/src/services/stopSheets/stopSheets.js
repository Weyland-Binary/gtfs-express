/**
 * Stop timetable sheets over a period: for each line and direction calling at a stop, one column per day class the
 * network itself shows (dayClasses: the working days, the blocks of dates run with another timetable, the rest days
 * with the public holidays run like them; identical columns merged), the departures by hour, and the notes the
 * calendars imply, computed rather than typed: a departure that does not run on every date of its column gets a mark
 * whose text says when it runs (only some weekdays, except a few dates, only a few dates), one ending short of the
 * line's usual terminus says where it ends, a call on booking or on request says so. The next stops come from the
 * direction's most common pattern, with their running time and the other lines met there.
 *
 * A departure is a call where boarding is allowed (pickup_type 1 and a trip's last call are not departures). Times keep
 * the service day's order (00:30 of the night after comes after 23:50). Nothing here guesses a calendar: a class is
 * labelled by its days and dates, and by a name only when a source gives one (the school calendar, the network's own
 * names confirmed by the person).
 */

"use strict";

const crypto = require("crypto");
const { _internals: fm } = require("../transform/feedModel");
const { wordsOf, fill, dateText, dayText } = require("./sheetWords");
const { classesOf, dowRun, rangesOf, DOWS: DOW_ORDER } = require("./dayClasses");

const { addDays, dowOf } = fm;
const DOW_INDEX = Object.freeze({ sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 });
const MAX_PERIOD_DAYS = 400;
const DEFAULT_PERIOD_DAYS = 365;
// A note lists at most this many dates or date ranges; beyond, it says how many days.
const MAX_NOTE_RANGES = 3;
const MAX_CLOSED_RANGES = 4;
const MAX_FREQ_DEPARTURES = 300;
const NEXT_SAMPLE = 40;
const MAX_LINKS = 6;
// Two regimes differing by fewer trips than this share of the larger are the same day class: notes say the rest.
const SIMILAR_SHARE = 0.15;
const DEFAULT_COLOR = "1E88E5";

const isYmd = (v) => /^\d{8}$/.test(String(v || ""));
const ymdOf = (v) => {
  const s = String(v ?? "").trim().slice(0, 10).replace(/-/g, "");
  return isYmd(s) ? s : null;
};
const daysBetween = (a, b) => Math.round((Date.UTC(+b.slice(0, 4), +b.slice(4, 6) - 1, +b.slice(6, 8)) - Date.UTC(+a.slice(0, 4), +a.slice(4, 6) - 1, +a.slice(6, 8))) / 86400000);
const two = (n) => String(n).padStart(2, "0");
// A sheet reads a clock: 25:10 of the service day is printed 01:10.
const clock = (sec) => `${two(Math.floor(sec / 3600) % 24)}:${two(Math.floor((sec % 3600) / 60))}`;
const hexOr = (v, fallback) => (/^[0-9A-Fa-f]{6}$/.test(String(v || "")) ? String(v).toUpperCase() : fallback);
const textOn = (hex) => {
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? "111111" : "FFFFFF";
};
const routeOf = (model, routeId) => {
  const r = model.routes.get(routeId) || { id: routeId, short_name: routeId, long_name: "" };
  const color = hexOr(r.color, DEFAULT_COLOR);
  const sort = r.sort === null || r.sort === undefined || r.sort === "" ? null : Number(r.sort);
  return { id: r.id, short: r.short_name || r.long_name || r.id, long: r.long_name || "", color, text: hexOr(r.text_color, textOn(color)), sort: Number.isFinite(sort) ? sort : null };
};
// The feed's own order of its lines (route_sort_order), then their names as a person reads them.
const byLine = (a, b) => (a.sort ?? Infinity) - (b.sort ?? Infinity) || String(a.short).localeCompare(String(b.short), undefined, { numeric: true }) || String(a.id).localeCompare(String(b.id));
const listText = (items, w) => (items.length <= 1 ? items[0] || "" : `${items.slice(0, -1).join(", ")}${w.join}${items[items.length - 1]}`);
const shortHash = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);

// ── Period and calendar

/** Today in the network's timezone (the sheets are dated where they are posted). */
const todayIn = (timezone) => {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
    const get = (t) => parts.find((p) => p.type === t)?.value;
    return `${get("year")}${get("month")}${get("day")}`;
  } catch {
    return new Date().toISOString().slice(0, 10).replace(/-/g, "");
  }
};

/**
 * The period a batch of sheets covers, inside the feed's validity: asked, else from today (or the feed's start) for a
 * year at most. `clamped` when the asked period reached past the feed, `capped` when it was longer than MAX_PERIOD_DAYS.
 */
const periodOf = (model, { from = null, to = null, today } = {}) => {
  const range = model.range;
  if (!range) return null;
  const askedFrom = ymdOf(from);
  const askedTo = ymdOf(to);
  let a = askedFrom || (today && today > range.start && today <= range.end ? today : range.start);
  let b = askedTo || [range.end, addDays(a, DEFAULT_PERIOD_DAYS - 1)].sort()[0];
  let clamped = false;
  if (a < range.start) [a, clamped] = [range.start, true];
  if (b > range.end) [b, clamped] = [range.end, true];
  if (a > range.end || b < range.start || b < a) return { from: range.start, to: [range.end, addDays(range.start, DEFAULT_PERIOD_DAYS - 1)].sort()[0], clamped: true, capped: false };
  let capped = false;
  if (daysBetween(a, b) >= MAX_PERIOD_DAYS) [b, capped] = [addDays(a, MAX_PERIOD_DAYS - 1), true];
  return { from: a, to: b, clamped, capped };
};

/** The names laid over the classes: the school calendar's periods and whatever a person confirmed, merged. */
const namesOf = (school, names) => {
  const periods = [];
  if (school && (school.status === "ok" || school.status === "region_unknown")) for (const p of school.periods || []) if (p.from && p.to && !p.assumed) periods.push({ from: p.from, to: p.to, name: p.name || null, kind: "school" });
  for (const p of names?.periods || []) if (p.from && p.to) periods.push({ from: p.from, to: p.to, name: p.name || null, kind: p.kind || "other" });
  const holidays = new Map();
  for (const [d, n] of names?.holidays instanceof Map ? names.holidays : Object.entries(names?.holidays || {})) if (n) holidays.set(d, n);
  return { periods, holidays };
};

/**
 * The period's dates by day class (read from the regimes of the network, `keys`: date → the services running, computed
 * here when not given), and each service's dates in it (memoised).
 */
const calendarOf = (model, period, { keys = null, school = null, names = null } = {}) => {
  const dates = [];
  for (let d = period.from, i = 0; d <= period.to && i < MAX_PERIOD_DAYS; d = addDays(d, 1), i++) dates.push(d);
  const memo = new Map();
  const datesOfService = (sid) => {
    if (!memo.has(sid)) {
      const set = new Set();
      for (const d of dates) if (model.runsOn(sid, d)) set.add(d);
      memo.set(sid, set);
    }
    return memo.get(sid);
  };
  let sigs = keys;
  if (!sigs) {
    sigs = new Map(dates.map((d) => [d, []]));
    for (const sid of model.services.keys()) for (const d of datesOfService(sid)) sigs.get(d).push(sid);
    for (const [d, list] of sigs) sigs.set(d, list.sort().join(","));
  }
  const sigOf = (d) => sigs.get(d) ?? "";
  const tripsOf = new Map();
  for (const t of model.trips.values()) tripsOf.set(t.service_id, (tripsOf.get(t.service_id) || 0) + 1);
  const weightOf = (sids) => sids.reduce((n, sid) => n + (tripsOf.get(sid) || 0), 0);
  const alike = new Map();
  const similar = (a, b) => {
    if (a === b) return true;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (!alike.has(key)) {
      const A = new Set(a ? a.split(",") : []);
      const B = new Set(b ? b.split(",") : []);
      const diff = weightOf([...A].filter((x) => !B.has(x))) + weightOf([...B].filter((x) => !A.has(x)));
      const base = Math.max(weightOf([...A]), weightOf([...B]));
      alike.set(key, base > 0 && diff / base < SIMILAR_SHARE);
    }
    return alike.get(key);
  };
  const { classes, classOf, holidays } = classesOf({ dates, sigOf, dowOf, similar, names: namesOf(school, names) });
  return { period, dates, classes, classOf, holidays, sigOf, undated: 0, datesOfService };
};

// ── Indexes of the model (built once per model)

const _indexes = new WeakMap();
const indexesOf = (model) => {
  if (_indexes.has(model)) return _indexes.get(model);
  // Every call where boarding may happen: stop → [{ trip, i }].
  const calls = new Map();
  for (const t of model.trips.values()) {
    const n = t.stops.length;
    for (let i = 0; i < n - 1; i++) {
      const sid = t.stops[i];
      if (!calls.has(sid)) calls.set(sid, []);
      calls.get(sid).push({ trip: t, i });
    }
  }
  // The lines met at a place (a station's quays count as one place).
  const placeOf = (sid) => model.stops.get(sid)?.parent || sid;
  const linesAt = new Map();
  for (const p of model.patterns.values()) {
    for (const sid of p.stops) {
      const place = placeOf(sid);
      if (!linesAt.has(place)) linesAt.set(place, new Set());
      linesAt.get(place).add(p.route_id);
    }
  }
  const children = new Map();
  for (const s of model.stops.values()) {
    if (!s.parent) continue;
    if (!children.has(s.parent)) children.set(s.parent, []);
    children.get(s.parent).push(s.id);
  }
  const out = { calls, linesAt, placeOf, children };
  _indexes.set(model, out);
  return out;
};

/** The stops a sheet covers: the stop itself, or a station's stops. */
const membersOf = (model, stopId) => {
  const stop = model.stops.get(stopId);
  if (!stop) return null;
  if (stop.location_type === "1") return new Set(indexesOf(model).children.get(stopId) || []);
  return new Set([stopId]);
};

// ── Notes

// A range within one month names the month once: « du 6 au 13 novembre ».
const rangeText = (a, b, w, lang) => (a === b ? fill(w.on, { date: dateText(a, lang) }) : fill(w.range, { from: a.slice(0, 6) === b.slice(0, 6) ? dayText(a, lang) : dateText(a, lang), to: dateText(b, lang) }));
const rangesText = (ranges, w, lang) => listText(ranges.map(([a, b]) => rangeText(a, b, w, lang)), w);
const dowsText = (dows, w) => listText(DOW_ORDER.filter((d) => dows.has(d)).map((d) => w.dows[DOW_INDEX[d]]), w);
const dowWord = (dow, w) => w.dows[DOW_INDEX[dow]];
/** Days of the week as the sheet says them: « lundi à vendredi », « tous les jours », « samedi et dimanche ». */
const daysText = (dows, w) => {
  const run = dowRun(dows);
  if (run && run.from === "mon" && run.to === "sun") return w.everyDay;
  if (run && run.from !== run.to) return fill(w.dayRange, { from: dowWord(run.from, w), to: dowWord(run.to, w) });
  return dowsText(new Set(dows), w);
};

/**
 * When a departure runs among the dates of its column, in words, or null when it runs on all of them. Every exact
 * wording that applies is a candidate (some weekdays only, perhaps except a few dates; except one weekday over
 * consecutive weeks; except a few dates; only a few dates) and the shortest is printed; none: how many days.
 */
const describeDates = (runs, base, w, lang) => {
  if (runs.length === base.length) return null;
  const runSet = new Set(runs);
  const candidates = [];
  const dowsRun = new Set(runs.map(dowOf));
  const dowsBase = new Set(base.map(dowOf));
  if (dowsRun.size < dowsBase.size) {
    const sameDows = base.filter((d) => dowsRun.has(dowOf(d)));
    const missing = sameDows.filter((d) => !runSet.has(d));
    const r = rangesOf(missing, sameDows);
    if (!missing.length) candidates.push(fill(w.onlyDows, { dows: dowsText(dowsRun, w) }));
    else if (r.length <= 2) candidates.push(fill(w.onlyDowsExcept, { dows: dowsText(dowsRun, w), dates: rangesText(r, w, lang) }));
  }
  const missing = base.filter((d) => !runSet.has(d));
  const missingDows = new Set(missing.map(dowOf));
  if (missingDows.size === 1) {
    const [dow] = missingDows;
    const r = rangesOf(missing, base.filter((d) => dowOf(d) === dow));
    if (r.length === 1 && r[0][0] !== r[0][1]) candidates.push(fill(w.exceptDow, { dow: w.dows[DOW_INDEX[dow]], dates: rangeText(r[0][0], r[0][1], w, lang) }));
  }
  const rMissing = rangesOf(missing, base);
  if (rMissing.length <= MAX_NOTE_RANGES) candidates.push(fill(w.except, { dates: rangesText(rMissing, w, lang) }));
  const rRuns = rangesOf(runs, base);
  if (rRuns.length <= MAX_NOTE_RANGES) {
    const only = fill(w.only, { dates: rangesText(rRuns, w, lang) });
    // One or two dates read best as dates (a public holiday is not « Wednesday only »).
    if (runs.length <= 2) return only;
    candidates.push(only);
  }
  if (!candidates.length) return fill(w.some, { n: runs.length, m: base.length });
  return candidates.reduce((best, c) => (c.length < best.length ? c : best));
};

const capitalise = (s) => (s ? s.charAt(0).toLocaleUpperCase() + s.slice(1) : s);

/**
 * The label of a column standing for one or more day classes: their days as a run (« Lundi à vendredi », « Tous les
 * jours »), then what sets them apart: the school period or the holidays when a named block exists beside them, a
 * block's name or its dates, the public holidays a rest class holds. Classes of different kinds merged read as their
 * days alone: the timetable is the same.
 */
const columnLabel = (classes, w, lang) => {
  const kinds = new Set(classes.map((c) => c.kind));
  const dows = [...new Set(classes.flatMap((c) => c.dows))];
  const days = daysText(dows, w);
  let text = days;
  if (kinds.size === 1 && kinds.has("work") && classes[0].school) text = fill(w.daysSchool, { days });
  else if (kinds.size === 1 && kinds.has("alt")) {
    const [cls] = classes;
    if (cls.name?.kind === "school") text = fill(w.daysHolidays, { days });
    else if (cls.name?.text) text = fill(w.daysNamed, { days, name: cls.name.text });
    else text = fill(w.daysDates, { days, dates: rangesText(cls.ranges.slice(0, MAX_NOTE_RANGES), w, lang) });
  }
  if (classes.some((c) => c.holidays?.length)) text = fill(w.daysAndHolidays, { days: text });
  return capitalise(text);
};
/** The days types without service, one label each, with a middle dot between them (their labels hold commas). */
const absentText = (classes, w, lang) => classes.map((c) => columnLabel([c], w, lang)).join(" · ");

const markOf = (i) => {
  let n = i;
  let s = "";
  do {
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
};

// ── Departures

/** The departures at a set of stops whose service runs in the period, frequencies expanded. */
const departuresAt = (model, cal, members) => {
  const { calls } = indexesOf(model);
  const deps = [];
  let untimed = 0;
  for (const sid of members) {
    for (const { trip: t, i } of calls.get(sid) || []) {
      const dates = cal.datesOfService(t.service_id);
      if (!dates.size) continue;
      const flex = t.flex ? t.flex.find((f) => f[0] === i) : null;
      const pickup = flex ? flex[1] : "0";
      if (pickup === "1") continue;
      if (t.dep[i] == null) {
        untimed += 1;
        continue;
      }
      const freq = model.frequencies.get(t.id);
      if (!freq) {
        deps.push({ trip: t, i, sec: t.dep[i], dates, pickup });
        continue;
      }
      const offset = t.dep[i] - (t.first ?? t.dep[i]);
      for (const f of freq) {
        let k = 0;
        for (let x = f.start; x < f.end && k < MAX_FREQ_DEPARTURES; x += f.headway, k++) deps.push({ trip: t, i, sec: x + offset, dates, pickup });
      }
    }
  }
  return { deps, untimed };
};

const lastName = (model, t) => model.stops.get(t.stops[t.stops.length - 1])?.name || t.stops[t.stops.length - 1];
// A terminus as a passenger reads it: its station's name when it is one of a station's quays.
const placeName = (model, stopId) => {
  const stop = model.stops.get(stopId);
  const parent = stop?.parent ? model.stops.get(stop.parent) : null;
  return parent?.name || stop?.name || stopId;
};
// Headsigns that name no place (« Aller », « Retour », a direction's number): the terminus says where the bus goes.
const GENERIC_HEADSIGN = /^(aller|retour|a|r|0|1|outbound|inbound|ida|vuelta|hin|rück|rueck|ida e volta|direction\s*[01ab]?)$/i;
const directionName = (headsign, terminusStop, model) => (headsign && !GENERIC_HEADSIGN.test(headsign.trim()) ? headsign : placeName(model, terminusStop));
const mostCommon = (values) => {
  const counts = new Map();
  for (const v of values) if (v) counts.set(v, (counts.get(v) || 0) + 1);
  let best = null;
  for (const [v, n] of counts) if (!best || n > best[1]) best = [v, n];
  return best ? best[0] : null;
};
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/**
 * The direction's path on its most common pattern (to the usual terminus): every stop, the one of the sheet marked,
 * the running time from it to each stop after, and the other lines met at each. Two quays of one place in a row are
 * one stop to a passenger.
 */
const pathOf = (model, deps, members, routeId, mainTerminus) => {
  const { linesAt, placeOf } = indexesOf(model);
  const pattern = mostCommon(deps.filter((d) => lastName(model, d.trip) === mainTerminus).map((d) => d.trip.pattern)) || mostCommon(deps.map((d) => d.trip.pattern));
  if (!pattern) return { stops: [], here: -1 };
  const trips = [...new Set(deps.filter((d) => d.trip.pattern === pattern).map((d) => d.trip))].slice(0, NEXT_SAMPLE);
  const stops = trips[0].stops;
  const at = stops.findIndex((x) => members.has(x));
  if (at < 0) return { stops: [], here: -1 };
  const out = [];
  let here = -1;
  for (let j = 0; j < stops.length; j++) {
    const name = model.stops.get(stops[j])?.name || stops[j];
    const prev = out[out.length - 1];
    if (prev && prev.name === name && j !== at) continue;
    const minutes = j > at ? median(trips.map((t) => (t.arr[j] ?? t.dep[j]) - t.dep[at]).filter((x) => Number.isFinite(x) && x >= 0)) : null;
    const links = j < at ? [] : [...(linesAt.get(placeOf(stops[j])) || [])].filter((r) => r !== routeId).map((r) => routeOf(model, r)).sort(byLine);
    if (prev && prev.name === name) out.pop();
    if (j === at) here = out.length;
    out.push({ name, min: minutes == null ? null : Math.round(minutes / 60), links: links.slice(0, MAX_LINKS), more: Math.max(0, links.length - MAX_LINKS) });
  }
  return { stops: out, here };
};

/** The days a line runs at the stop, in words, from the classes of its columns: « Du lundi au vendredi, en période scolaire ». */
const runsText = (classes, w, lang) => {
  const dows = [...new Set(classes.flatMap((c) => c.dows))];
  const run = dowRun(dows);
  let text = run && run.from === "mon" && run.to === "sun" ? w.runsEveryDay : run && run.from !== run.to ? fill(w.runsRange, { from: dowWord(run.from, w), to: dowWord(run.to, w) }) : dows.length === 1 ? fill(w.runsDay, { day: dowWord(dows[0], w) }) : dowsText(new Set(dows), w);
  const kinds = new Set(classes.map((c) => c.kind));
  const work = classes.find((c) => c.kind === "work");
  const alts = classes.filter((c) => c.kind === "alt");
  if (!kinds.has("alt") && work?.school) text += w.runsSchool;
  else if (!kinds.has("work") && alts.length === 1) {
    const [cls] = alts;
    text += cls.name?.kind === "school" ? w.runsHolidays : cls.name?.text ? fill(w.runsNamed, { name: cls.name.text }) : fill(w.runsDates, { dates: rangesText(cls.ranges.slice(0, MAX_NOTE_RANGES), w, lang) });
  }
  if (classes.some((c) => c.holidays?.length)) text += w.runsAndHolidays;
  return capitalise(text);
};

// The weekday headway the header shows: the median gap between 7:00 and 19:00 on the weekday column.
const PEAK_FROM = 7 * 3600;
const PEAK_TO = 19 * 3600;
const headwayOf = (columns) => {
  const c = columns.find((x) => x.classes.some((k) => k.kind === "work")) || columns.find((x) => x.classes.some((k) => k.kind === "alt"));
  if (!c) return null;
  const secs = [...new Set(c.list.filter((e) => !e.note && e.sec >= PEAK_FROM && e.sec < PEAK_TO).map((e) => e.sec))].sort((x, y) => x - y);
  if (secs.length < 4) return null;
  const gap = median(secs.slice(1).map((x, i) => x - secs[i]));
  return gap ? Math.round(gap / 60) : null;
};

/** One line and direction at the stop: its columns, notes and next stops. */
const blockOf = (model, cal, members, deps, w, lang, warnings) => {
  const t0 = deps[0].trip;
  const route = routeOf(model, t0.route_id);
  const mainTerminus = mostCommon(deps.map((d) => lastName(model, d.trip)));
  const toMain = deps.filter((d) => lastName(model, d.trip) === mainTerminus);
  const headsign = directionName(mostCommon(toMain.map((d) => d.trip.headsign)), toMain[0].trip.stops[toMain[0].trip.stops.length - 1], model);
  const columns = [];
  const absent = [];
  let duplicates = 0;
  for (const cls of cal.classes) {
    const base = cls.dates;
    // The dates of the type on which the line runs at this stop: notes are read against them, the others are said once.
    const runsByService = new Map();
    const served = new Set();
    for (const d of deps) {
      if (!runsByService.has(d.trip.service_id)) runsByService.set(d.trip.service_id, base.filter((x) => d.dates.has(x)));
      for (const x of runsByService.get(d.trip.service_id)) served.add(x);
    }
    if (!served.size) {
      absent.push(cls);
      continue;
    }
    const covered = base.filter((x) => served.has(x));
    const closed = base.filter((x) => !served.has(x));
    // A departure is a time to a terminus with a boarding rule: the trips leaving then (a Monday-to-Thursday trip and
    // its Friday twin) add their dates. Two trips at the same time on the same date are the same departure twice.
    const byTime = new Map();
    for (const d of deps) {
      const runs = runsByService.get(d.trip.service_id);
      if (!runs.length) continue;
      const end = lastName(model, d.trip);
      const key = `${d.sec}|${end}|${d.pickup}`;
      let e = byTime.get(key);
      if (!e) byTime.set(key, (e = { sec: d.sec, end, pickup: d.pickup, dates: new Set(), trips: new Set() }));
      if (!e.trips.has(d.trip) && runs.some((x) => e.dates.has(x))) duplicates += 1;
      e.trips.add(d.trip);
      for (const x of runs) e.dates.add(x);
    }
    const noteOfDates = new Map();
    const departures = [...byTime.values()].map((e) => {
      const runs = covered.filter((x) => e.dates.has(x));
      const datesKey = runs.join(",");
      if (!noteOfDates.has(datesKey)) noteOfDates.set(datesKey, describeDates(runs, covered, w, lang));
      return { ...e, dateNote: noteOfDates.get(datesKey) };
    });
    // A date note most of the column's departures share (the network's own exceptions, a holiday it does not know
    // as one) is the column's, said once beside its title; the departures that differ keep their marks.
    const counts = new Map();
    for (const d of departures) if (d.dateNote) counts.set(d.dateNote, (counts.get(d.dateNote) || 0) + 1);
    const [common, shared] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] || [null, 0];
    const columnNote = common && shared * 2 > departures.length ? common : null;
    const entries = new Map();
    for (const e of departures) {
      const parts = [e.dateNote === columnNote ? null : e.dateNote];
      if (e.end !== mainTerminus) parts.push(fill(w.terminus, { stop: e.end }));
      if (e.pickup === "2") parts.push(w.booking);
      else if (e.pickup === "3") parts.push(w.driver);
      const note = capitalise(parts.filter(Boolean).join(" ; ")) || null;
      const key = `${e.sec}|${note || ""}`;
      if (!entries.has(key)) entries.set(key, { sec: e.sec, note });
    }
    const list = [...entries.values()].sort((a, b) => a.sec - b.sec);
    const closedRanges = rangesOf(closed, base);
    const closedText = !closed.length ? null : closedRanges.length <= MAX_CLOSED_RANGES ? fill(w.closed, { dates: rangesText(closedRanges, w, lang) }) : fill(w.closedSome, { n: closed.length, m: base.length });
    // The public holidays a rest class holds, listed once beside its title.
    const held = (cls.holidays || []).filter((x) => served.has(x));
    const holidaysText = held.length ? fill(w.holidaysList, { dates: listText(held.map((x) => dateText(x, lang)), w) }) : null;
    columns.push({ classes: [cls], types: [cls.colour], list, closed: closedText, note: [columnNote ? capitalise(columnNote) : null, holidaysText].filter(Boolean).join(" · ") || null });
  }
  // Day classes with the same departures and notes read as one column.
  const merged = [];
  for (const c of columns) {
    const sig = JSON.stringify([c.list.map((e) => [e.sec, e.note]), c.closed, c.note]);
    const same = merged.find((m) => m.sig === sig);
    if (same) {
      same.classes.push(...c.classes);
      same.types.push(...c.types);
    } else merged.push({ ...c, classes: [...c.classes], types: [...c.types], sig });
  }
  // Marks follow the reading order: the columns left to right, each from the first departure.
  const marks = new Map();
  for (const c of merged) for (const e of c.list) if (e.note && !marks.has(e.note)) marks.set(e.note, markOf(marks.size));
  const hours = [...new Set(merged.flatMap((c) => c.list.map((e) => Math.floor(e.sec / 3600))))].sort((a, b) => a - b);
  const out = {
    key: `${route.id}|${t0.direction_id}`,
    route,
    direction_id: t0.direction_id,
    headsign,
    terminus: mainTerminus,
    hours: hours.map((h) => ({ h, label: two(h % 24) })),
    columns: merged.map((c) => ({
      types: c.types,
      classes: c.classes.map((k) => k.id),
      label: columnLabel(c.classes, w, lang),
      cells: hours.map((h) => c.list.filter((e) => Math.floor(e.sec / 3600) === h).map((e) => ({ m: two(Math.floor((e.sec % 3600) / 60)), sec: e.sec, ...(e.note ? { mark: marks.get(e.note) } : {}) }))),
      first: c.list.length ? clock(c.list[0].sec) : null,
      last: c.list.length ? clock(c.list[c.list.length - 1].sec) : null,
      count: c.list.length,
      closed: c.closed,
      note: c.note,
    })),
    absent: absent.length ? fill(w.noService, { types: absentText(absent, w, lang) }) : null,
    notes: [...marks.entries()].map(([text, mark]) => ({ mark, text })),
    path: pathOf(model, deps, members, route.id, mainTerminus),
  };
  const secs = merged.flatMap((c) => c.list.map((e) => e.sec));
  out.summary = {
    days: runsText(merged.flatMap((c) => c.classes), w, lang),
    first: secs.length ? clock(Math.min(...secs)) : null,
    last: secs.length ? clock(Math.max(...secs)) : null,
    headway: headwayOf(merged),
  };
  if (duplicates) warnings.push({ code: "duplicate_departures", line: route.short, count: duplicates });
  return out;
};

/**
 * The sheet of one stop (or station): its blocks by line and direction (`routeId`: that line's alone), and what to
 * check before printing it.
 */
const sheetOf = (model, cal, stopId, w, lang, routeId = null) => {
  const stop = model.stops.get(stopId);
  const members = membersOf(model, stopId);
  if (!stop || !members) return null;
  const warnings = [];
  const { deps, untimed } = departuresAt(model, cal, members);
  const groups = new Map();
  for (const d of deps) {
    if (routeId && d.trip.route_id !== routeId) continue;
    const key = `${d.trip.route_id}|${d.trip.direction_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  }
  const blocks = [...groups.values()].map((g) => blockOf(model, cal, members, g, w, lang, warnings)).filter((b) => b.columns.length);
  blocks.sort((a, b) => byLine(a.route, b.route) || a.direction_id.localeCompare(b.direction_id));
  if (!blocks.length) warnings.push({ code: "no_departures" });
  if (untimed) warnings.push({ code: "untimed_calls", count: untimed });
  const parent = stop.parent ? model.stops.get(stop.parent) : null;
  return {
    stop: { id: stop.id, name: stop.name, code: stop.code || null, station: stop.location_type === "1", parent: parent ? parent.name : null },
    blocks,
    warnings,
  };
};

/** The day classes of a calendar as the screen lists them: their days, dates, name and label. */
const classesSummary = (cal, w, lang) => cal.classes.map((c) => ({ id: c.id, kind: c.kind, dows: c.dows, ranges: c.kind === "alt" ? c.ranges : rangesOf(c.dates, cal.dates), dates: c.dates.length, name: c.name || null, holidays: c.holidayNames || [], label: columnLabel([c], w, lang) }));
const calendarSummary = (model, period, { keys = null, school = null, names = null, lang = "en" } = {}) => classesSummary(calendarOf(model, period, { keys, school, names }), wordsOf(lang), lang);

/**
 * The sheets of a batch of stops over a period. `school` is dayTypes.schoolCalendarFor's answer and `names` the
 * person's confirmed names: both only name what the network shows. Unknown stop ids come back in `unknown`.
 */
const sheetsOf = (model, { stopIds, period, keys = null, school = null, names = null, lang = "en", today = null, routeId = null }) => {
  const w = wordsOf(lang);
  const cal = calendarOf(model, period, { keys, school, names });
  const sheets = [];
  const unknown = [];
  for (const id of stopIds) {
    const sheet = sheetOf(model, cal, id, w, lang, routeId);
    if (sheet) sheets.push(sheet);
    else unknown.push(id);
  }
  return {
    sheets,
    unknown,
    undated: 0,
    classes: classesSummary(cal, w, lang),
    labels: {
      ...w,
      validityText: fill(w.validity, { from: dateText(period.from, lang, { year: true }), to: dateText(period.to, lang, { year: true }) }),
      // A sheet valid to the end of the timetable says from when; one for a part of it, until when too.
      validText: model.range && period.to >= model.range.end ? fill(w.validFrom, { date: dateText(period.from, lang, { year: true, weekday: true }) }) : fill(w.validity, { from: dateText(period.from, lang, { year: true, weekday: true }), to: dateText(period.to, lang, { year: true, weekday: true }) }),
      editedText: fill(w.edited, { date: dateText(today || period.from, lang, { year: true }) }),
    },
  };
};

// ── Timetable periods

// A new timetable is one that holds on at least this many dates of a day type and weekday in a row.
const MIN_REGIME_RUN = 2;
const MIN_PERIOD_DAYS = 3;

/**
 * The periods over which the network's timetable stays the same, so a sheet can be valid for one of them without a
 * note for the others. Each weekday of each day type is a series of dates with the services running on it; the
 * timetable changes where a series moves to another set of services for good (a one-off date is a note, not a
 * period). The changes falling together make one cut: at the latest moment they allow for a new timetable, at the
 * earliest for a return to one seen before (a special period ends as soon as it can). `keys`: date → its services.
 */
const timetablePeriods = (cal, keys = null) => {
  const series = new Map();
  const sigOf = (d) => (keys ? keys.get(d) || "" : cal.sigOf(d));
  for (const d of cal.dates) {
    // A public holiday is an exception of its own, not part of its day's series.
    if (cal.holidays.has(d)) continue;
    const k = dowOf(d);
    if (!series.has(k)) series.set(k, []);
    series.get(k).push([d, sigOf(d)]);
  }
  const changes = [];
  for (const list of series.values()) {
    const runs = [];
    for (const [d, sig] of list) {
      const last = runs[runs.length - 1];
      if (last && last.sig === sig) [last.to, last.n] = [d, last.n + 1];
      else runs.push({ sig, from: d, to: d, n: 1 });
    }
    let current = null;
    const seen = new Set();
    for (const r of runs) {
      if (r.n < MIN_REGIME_RUN) continue;
      if (current && r.sig !== current.sig) changes.push({ lo: addDays(current.to, 1), hi: r.from, back: seen.has(r.sig) });
      seen.add(r.sig);
      current = r;
    }
  }
  changes.sort((a, b) => a.lo.localeCompare(b.lo) || a.hi.localeCompare(b.hi));
  const cuts = new Set();
  let group = null;
  const close = () => group && cuts.add(group.back ? group.lo : group.hi);
  for (const c of changes) {
    if (group && c.lo <= group.hi && c.hi >= group.lo) {
      group.lo = c.lo > group.lo ? c.lo : group.lo;
      group.hi = c.hi < group.hi ? c.hi : group.hi;
      group.back = group.back && c.back;
    } else {
      close();
      group = { ...c };
    }
  }
  close();
  const out = [];
  let from = cal.period.from;
  for (const cut of [...cuts].filter((d) => d > cal.period.from && d <= cal.period.to).sort()) {
    if (daysBetween(from, cut) < MIN_PERIOD_DAYS) continue;
    out.push({ from, to: addDays(cut, -1) });
    from = cut;
  }
  if (out.length && daysBetween(from, cal.period.to) + 1 < MIN_PERIOD_DAYS) out[out.length - 1].to = cal.period.to;
  else out.push({ from, to: cal.period.to });
  return out;
};

// ── What the sheets offer to choose from

/** The stops with departures (and the stations over them), each with its lines, and the lines with their stops in order. */
const catalogueOf = (model) => {
  const { calls, children } = indexesOf(model);
  const linesOfStop = new Map();
  for (const [sid, list] of calls) linesOfStop.set(sid, new Set(list.map((c) => c.trip.route_id)));
  const stops = [];
  for (const s of model.stops.values()) {
    if (s.location_type === "1") {
      const lines = new Set();
      for (const c of children.get(s.id) || []) for (const r of linesOfStop.get(c) || []) lines.add(r);
      if (lines.size) stops.push({ id: s.id, name: s.name, code: s.code || null, station: true, parent: null, lines: [...lines] });
    } else if (linesOfStop.has(s.id)) {
      stops.push({ id: s.id, name: s.name, code: s.code || null, station: false, parent: s.parent || null, lines: [...linesOfStop.get(s.id)] });
    }
  }
  stops.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) || String(a.code || a.id).localeCompare(String(b.code || b.id), undefined, { numeric: true }));
  const routes = [];
  for (const r of model.routes.values()) {
    if (!r.patterns || !r.patterns.length) continue;
    // Each direction's stops along its most common pattern, a stop only another pattern serves placed right after the
    // stop it follows there, not at the end (a terminus has no departure: no sheet).
    const directions = [];
    for (const dir of [...new Set(r.patterns.map((p) => p.direction_id))].sort()) {
      const patterns = r.patterns.filter((x) => x.direction_id === dir);
      const order = [];
      for (const p of patterns) {
        let at = -1;
        for (let i = 0; i < p.stops.length - 1; i++) {
          const known = order.indexOf(p.stops[i]);
          if (known >= 0) at = known;
          else order.splice(++at, 0, p.stops[i]);
        }
      }
      const main = patterns[0];
      const trips = patterns.flatMap((p) => p.trips).map((id) => model.trips.get(id)).filter(Boolean);
      const terminus = placeName(model, main.stops[main.stops.length - 1]);
      directions.push({ direction_id: dir, headsign: directionName(mostCommon(trips.map((t) => t.headsign)), main.stops[main.stops.length - 1], model), terminus, stops: order });
    }
    routes.push({ ...routeOf(model, r.id), directions });
  }
  routes.sort(byLine);
  return { stops, routes };
};

// ── What a change does to the sheets

/** Per stop, the departures a sheet shows over the period, as a multiset of comparable keys. */
const departureKeys = (model, cal) => {
  const { calls } = indexesOf(model);
  const datesKey = new Map();
  const keyOfDates = (sid) => {
    if (!datesKey.has(sid)) datesKey.set(sid, shortHash([...cal.datesOfService(sid)].sort().join(",")));
    return datesKey.get(sid);
  };
  const out = new Map();
  for (const [sid, list] of calls) {
    const keys = new Map();
    for (const { trip: t, i } of list) {
      if (!cal.datesOfService(t.service_id).size) continue;
      const flex = t.flex ? t.flex.find((f) => f[0] === i) : null;
      const pickup = flex ? flex[1] : "0";
      if (pickup === "1" || t.dep[i] == null) continue;
      const route = model.routes.get(t.route_id);
      const base = `${route?.short_name || t.route_id}|${t.direction_id}|${keyOfDates(t.service_id)}|${lastName(model, t)}|${pickup}`;
      const freq = model.frequencies.get(t.id);
      const secs = freq ? freq.map((f) => `${f.start}-${f.end}/${f.headway}+${t.dep[i] - (t.first ?? t.dep[i])}`) : [String(t.dep[i])];
      for (const s of secs) keys.set(`${base}|${s}`, (keys.get(`${base}|${s}`) || 0) + 1);
    }
    if (keys.size) out.set(sid, keys);
  }
  return out;
};

/**
 * The stops whose sheet a change alters over the period, read from both feeds: departures added and removed (a moved
 * time is one of each), and the lines concerned. Stops are matched by id.
 */
const changedSheets = (before, after, period) => {
  const a = departureKeys(before, calendarOf(before, period));
  const b = departureKeys(after, calendarOf(after, period));
  const out = [];
  for (const sid of new Set([...a.keys(), ...b.keys()])) {
    const ka = a.get(sid) || new Map();
    const kb = b.get(sid) || new Map();
    let added = 0;
    let removed = 0;
    const lines = new Set();
    for (const k of new Set([...ka.keys(), ...kb.keys()])) {
      const d = (kb.get(k) || 0) - (ka.get(k) || 0);
      if (!d) continue;
      if (d > 0) added += d;
      else removed -= d;
      lines.add(k.split("|")[0]);
    }
    if (added || removed) out.push({ stop_id: sid, added, removed, lines: [...lines].sort((x, y) => x.localeCompare(y, undefined, { numeric: true })) });
  }
  return out;
};

module.exports = { sheetsOf, periodOf, calendarOf, calendarSummary, namesOf, timetablePeriods, catalogueOf, changedSheets, todayIn, MAX_PERIOD_DAYS, LANGS: require("./sheetWords").LANGS, _internals: { describeDates, rangesOf, columnLabel, markOf, clock } };
