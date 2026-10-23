/**
 * The day type of each date of a feed and the school calendar it rests on. School holidays come from the
 * territory dossier when it covers the feed, else from OpenHolidays; when no school zone stands out from
 * the feed's own calendars, only the holidays common to every zone count, so nothing is guessed silently.
 */

"use strict";

const config = require("../../config");
const territoryService = require("../network/territoryService");
const { _internals: school } = require("../network/schoolCalendar");

const { matchEntries, schoolRegions, addDays, END_OF_CLASSES_RE, SUMMER_ASSUMED_MAX_DAYS } = school;

// The order of the report's columns and filters.
const DAY_TYPE_ORDER = Object.freeze(["school_weekday", "holiday_weekday", "weekday", "saturday", "sunday_holiday"]);
const DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const TTL_MS = 24 * 3600 * 1000;
const FAILURE_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 6000;
const LOOKBEHIND_DAYS = 31;
const LOOKAHEAD_DAYS = 200;
const MAX_WINDOW_DAYS = 1095;
const MAX_PERIODS_REPORTED = 24;

// Tests inject a scripted fetch here; production uses the global fetch.
const deps = { fetchImpl: null };
const _cache = new Map();

// France and its overseas departments, by the agency's timezone (OpenHolidays lists the overseas
// zones as subdivisions).
const FRENCH_TIMEZONES = new Set(["Europe/Paris", "America/Guadeloupe", "America/Martinique", "America/Cayenne", "Indian/Reunion", "Indian/Mayotte", "America/Miquelon", "America/St_Barthelemy", "America/Marigot"]);
const METROPOLITAN_ZONES = ["A", "B", "C"];

const ymdOf = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
const dateOf = (ymd) => new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)));
const dowOf = (ymd) => DOW[dateOf(ymd).getUTCDay()];
const isoOf = (ymd) => `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;

// ── Country and public holidays

/** The feed's country: the session's when set, else France when the agency's timezone is French. */
const countryOfFeed = (model, sessionCountry = null) => {
  const cc = String(sessionCountry || "").trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(cc)) return cc;
  return model?.timezone && FRENCH_TIMEZONES.has(model.timezone) ? "FR" : null;
};

/** Easter Sunday of a year (anonymous Gregorian algorithm) as a UTC date. */
const easterOf = (year) => {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
};

/** France's eleven national public holidays of a year (the Alsace-Moselle ones are local, not counted). */
const frenchHolidays = (year) => {
  const easter = ymdOf(easterOf(year));
  const fixed = ["0101", "0501", "0508", "0714", "0815", "1101", "1111", "1225"].map((md) => `${year}${md}`);
  return [...fixed, addDays(easter, 1), addDays(easter, 39), addDays(easter, 50)];
};

/** The public holidays the server knows for a country and years (France only: elsewhere Sundays alone make the day type). */
const publicHolidays = (country, years) => {
  const out = new Set();
  if (country !== "FR") return out;
  for (const y of years) for (const d of frenchHolidays(y)) out.add(d);
  return out;
};

// ── School holidays

const withTimeout = (fetchImpl) => async (url, init = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

/** OpenHolidays is asked only when configuration allows it, and never from a test that did not inject its fetch. */
const fetcher = () => {
  if (deps.fetchImpl) return deps.fetchImpl;
  if (!config.SCHOOL_HOLIDAYS_FETCH_ENABLED || process.env.NODE_ENV === "test" || typeof fetch !== "function") return null;
  return withTimeout(fetch);
};

/** School holiday entries { start, end, name, regions, nationwide } of a country for [from, to] (YYYYMMDD), cached. */
const fetchEntries = async (country, from, to) => {
  const key = `${country}:${from}:${to}`;
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < (hit.error ? FAILURE_TTL_MS : TTL_MS)) {
    if (hit.error) throw new Error(hit.error);
    return hit.entries;
  }
  const doFetch = fetcher();
  if (!doFetch) throw Object.assign(new Error("fetching school holidays is off on this server"), { offline: true });
  try {
    const entries = [];
    for (let a = from, n = 0; a <= to && n < 3; a = addDays(a, MAX_WINDOW_DAYS), n++) {
      const b = [addDays(a, MAX_WINDOW_DAYS - 1), to].sort()[0];
      entries.push(...(await territoryService._internals.fetchSchoolHolidays(country, isoOf(a), isoOf(b), doFetch)));
    }
    const unique = [...new Map(entries.filter((e) => e.start && e.end).map((e) => [`${e.start}|${e.end}|${e.name}|${e.regions.join(",")}`, e])).values()];
    _cache.set(key, { at: Date.now(), entries: unique });
    return unique;
  } catch (err) {
    const message = err.name === "AbortError" ? "timeout" : String(err.message || err);
    _cache.set(key, { at: Date.now(), error: message });
    throw new Error(message);
  }
};

/** The dossier's school holidays, when they cover the window. */
const dossierEntries = (territory, window) => {
  const list = Array.isArray(territory?.school_holidays) ? territory.school_holidays : null;
  if (!list || !list.length) return null;
  const entries = list.map((h) => ({ start: String(h.start || "").replace(/-/g, "").slice(0, 8), end: String(h.end || "").replace(/-/g, "").slice(0, 8), name: String(h.name || ""), regions: Array.isArray(h.regions) ? h.regions : [], nationwide: h.nationwide === true || !(Array.isArray(h.regions) && h.regions.length) })).filter((e) => /^\d{8}$/.test(e.start) && /^\d{8}$/.test(e.end));
  const year = parseInt(String(territory.generatedAt || "").slice(0, 4), 10);
  const known = Number.isFinite(year) ? [`${year}0101`, `${year + 1}1231`] : null;
  return known && window.from >= known[0] && window.to <= known[1] ? entries : null;
};

/**
 * Whether school holidays reach the end of the window, counting the summer assumed after an "end of
 * classes" marker: a dossier built before the next school year was published does not.
 */
const reachesEnd = (entries, window) => {
  const last = entries.reduce((m, e) => (e.end > m ? e.end : m), "");
  if (!last) return false;
  if (last >= window.to) return true;
  return entries.some((e) => e.end === last && END_OF_CLASSES_RE.test(e.name)) && addDays(last, SUMMER_ASSUMED_MAX_DAYS) >= window.to;
};

/**
 * The sorted periods of a region (null: those common to every candidate region), with the summer
 * holidays assumed after an "end of classes" marker when the next school year is not published yet.
 */
const periodsOf = (entries, region, country, candidates) => {
  const listFor = (r) => {
    const matched = matchEntries(entries, r, country);
    return [...new Map(matched.map((m) => [`${m.start}|${m.end}`, { start: m.start, end: m.end, name: m.name }])).values()].sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
  };
  let periods;
  if (region) periods = listFor(region);
  else {
    // Dates on holiday in every candidate region: the intersection, as periods.
    const sets = candidates.map((r) => {
      const s = new Map();
      for (const p of listFor(r)) for (let d = p.start, i = 0; d <= p.end && i < 400; d = addDays(d, 1), i++) s.set(d, p.name);
      return s;
    });
    const common = sets.length ? [...sets[0].keys()].filter((d) => sets.every((s) => s.has(d))).sort() : [];
    periods = [];
    for (const d of common) {
      const last = periods[periods.length - 1];
      if (last && addDays(last.end, 1) === d) last.end = d;
      else periods.push({ start: d, end: d, name: sets[0].get(d) });
    }
  }
  const assumed = [];
  for (const m of periods.filter((p) => p.start === p.end && END_OF_CLASSES_RE.test(p.name))) {
    const later = periods.filter((p) => p.start > m.end).map((p) => p.start).sort();
    if (later.length && later[0] <= addDays(m.end, 7)) continue;
    const cap = addDays(m.end, SUMMER_ASSUMED_MAX_DAYS);
    assumed.push({ start: addDays(m.end, 1), end: later.length ? [addDays(later[0], -1), cap].sort()[0] : cap, name: m.name, assumed: true });
  }
  // The marker itself is a school day's end, not a holiday.
  return [...periods.filter((p) => !(p.start === p.end && END_OF_CLASSES_RE.test(p.name))), ...assumed].sort((a, b) => a.start.localeCompare(b.start));
};

const holidaySet = (periods, window) => {
  const out = new Set();
  for (const p of periods) {
    const a = p.start > window.from ? p.start : window.from;
    const b = p.end < window.to ? p.end : window.to;
    for (let d = a, i = 0; d <= b && i < 1200; d = addDays(d, 1), i++) out.add(d);
  }
  return out;
};

/**
 * The zone the feed's own calendars follow: the candidate with the most weekdays where "the timetable
 * differs from that weekday's usual one" agrees with "it is a school holiday there"; null unless it is the only best.
 */
const inferRegion = (candidates, entries, country, window, signatures, publicDays) => {
  if (!signatures || !candidates.length) return { region: null, scores: {} };
  const usual = {};
  const counts = {};
  for (const [d, sig] of signatures) {
    const dow = dowOf(d);
    if (dow === "sat" || dow === "sun" || publicDays.has(d)) continue;
    counts[dow] = counts[dow] || new Map();
    counts[dow].set(sig, (counts[dow].get(sig) || 0) + 1);
  }
  for (const [dow, m] of Object.entries(counts)) usual[dow] = [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
  // A timetable that never differs from its usual weekday says nothing of a zone: the zone with the fewest
  // holidays in the window would "agree" most (a feed running the same every weekday got Corsica's).
  const unusual = [...signatures].some(([d, sig]) => usual[dowOf(d)] && !publicDays.has(d) && sig !== usual[dowOf(d)]);
  if (!unusual) return { region: null, scores: {} };
  const scores = {};
  for (const r of candidates) {
    const holidays = holidaySet(periodsOf(entries, r, country, candidates), window);
    let agree = 0;
    for (const [d, sig] of signatures) {
      const dow = dowOf(d);
      if (!usual[dow] || publicDays.has(d)) continue;
      if ((sig !== usual[dow]) === holidays.has(d)) agree += 1;
    }
    scores[r] = agree;
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1] || METROPOLITAN_ZONES.indexOf(b[0]) - METROPOLITAN_ZONES.indexOf(a[0]));
  if (!ranked.length || (ranked[1] && ranked[1][1] === ranked[0][1])) return { region: null, scores };
  return { region: ranked[0][0], scores };
};

/** The school calendar of a feed's window. status: ok | not_france | no_country | unavailable | region_unknown */
const schoolCalendarFor = async ({ country = null, region = null, regionSource = null, territory = null, window, signatures = null, timezone = null } = {}) => {
  const base = { country: country || null, region: null, region_source: null, source: null, covered_until: null, periods: [], holidays: null };
  if (!window) return { ...base, status: "unavailable", reason: "no service dates" };
  if (!country) return { ...base, status: "no_country" };
  if (country !== "FR") return { ...base, status: "not_france" };
  const from = addDays(window.from, -LOOKBEHIND_DAYS);
  const to = addDays(window.to, LOOKAHEAD_DAYS);
  // The dossier's holidays when they reach the window's end; else the published calendar, the dossier's
  // kept when that cannot be read (better a part of the window than none).
  const dossier = dossierEntries(territory, window);
  let entries = dossier && reachesEnd(dossier, window) ? dossier : null;
  let source = entries ? "territory" : "openholidays";
  if (!entries) {
    try {
      entries = await fetchEntries(country, from, to);
    } catch (err) {
      if (!dossier) return { ...base, status: "unavailable", reason: err.message };
      entries = dossier;
      source = "territory";
    }
  }
  if (!entries.length) return { ...base, source, status: "unavailable", reason: "no school holidays published" };
  const regional = entries.some((e) => !e.nationwide);
  let candidates = regional ? schoolRegions({ place: { country_code: country }, school_holidays: entries }) : [];
  // A metropolitan network: its zone is A, B or C (Corsica aside); an overseas one, its own.
  if (timezone === "Europe/Paris" && candidates.some((c) => METROPOLITAN_ZONES.includes(c))) candidates = candidates.filter((c) => METROPOLITAN_ZONES.includes(c) || c === "CO");
  const publicDays = publicHolidays(country, yearsOf(window));
  let chosen = null;
  let chosenSource = null;
  let status = "ok";
  if (regional && region) {
    const known = matchEntries(entries, region, country).some((e) => !e.nationwide);
    if (known) {
      chosen = region;
      chosenSource = regionSource || "asked";
    } else status = "region_unknown";
  }
  let scores = null;
  if (regional && !chosen) {
    const inferred = inferRegion(candidates, entries, country, window, signatures, publicDays);
    scores = inferred.scores;
    if (inferred.region) {
      chosen = inferred.region;
      chosenSource = "inferred";
    } else chosenSource = "common";
  }
  const periods = periodsOf(entries, regional ? chosen : null, country, regional ? candidates : []);
  const coveredUntil = periods.length ? periods.reduce((m, p) => (p.end > m ? p.end : m), periods[0].end) : null;
  // A calendar ending before the window starts splits none of its weekdays: each would be left without a day
  // type and the report would lose every weekday. Its weekdays are one 'weekday' then, as without a calendar.
  if (coveredUntil && coveredUntil < window.from) return { ...base, source, status: "unavailable", reason: "school calendar published until " + isoOf(coveredUntil), covered_until: coveredUntil };
  const inWindow = periods.filter((p) => p.end >= window.from && p.start <= window.to);
  return {
    ...base,
    status: status === "region_unknown" && chosen ? "ok" : status,
    ...(status === "region_unknown" ? { asked_region: region } : {}),
    region: chosen,
    region_source: chosenSource,
    source,
    covered_until: coveredUntil,
    ...(scores ? { region_scores: scores } : {}),
    periods: inWindow.slice(0, MAX_PERIODS_REPORTED).map((p) => ({ name: p.name, from: p.start, to: p.end, ...(p.assumed ? { assumed: true } : {}) })),
    _periods: inWindow,
    holidays: holidaySet(periods, { from: window.from, to: window.to }),
  };
};

const yearsOf = (window) => {
  const out = [];
  for (let y = +window.from.slice(0, 4); y <= +window.to.slice(0, 4) && out.length < 5; y++) out.push(y);
  return out;
};

/** The day type of each date; null for a weekday past the published school calendar (neither school nor holiday). */
const classifyDates = (dates, { school = null, country = null, weekend = ["sat", "sun"] } = {}) => {
  const years = dates.length ? yearsOf({ from: dates[0], to: dates[dates.length - 1] }) : [];
  const publicDays = publicHolidays(country, years);
  const split = Boolean(school && school.holidays && (school.status === "ok" || school.status === "region_unknown"));
  const out = new Map();
  for (const d of dates) {
    const dow = dowOf(d);
    if (dow === "sun" || publicDays.has(d)) out.set(d, "sunday_holiday");
    else if (dow === "sat" || weekend.includes(dow)) out.set(d, "saturday");
    else if (!split) out.set(d, "weekday");
    else if (school.holidays.has(d)) out.set(d, "holiday_weekday");
    else out.set(d, school.covered_until && d > school.covered_until ? null : "school_weekday");
  }
  return out;
};

module.exports = { schoolCalendarFor, classifyDates, countryOfFeed, publicHolidays, DAY_TYPE_ORDER, deps, _internals: { _cache, easterOf, frenchHolidays, inferRegion, periodsOf, holidaySet, dossierEntries, fetchEntries, dowOf, ymdOf, isoOf } };
