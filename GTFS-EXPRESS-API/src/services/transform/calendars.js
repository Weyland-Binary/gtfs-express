/**
 * calendars — named periods a brief talks about, as sets of service dates.
 *
 *   "pendant les vacances scolaires (zone A)", "school days only",
 *   "public holidays", "l'été", or a period the plan defines itself.
 *
 * Sources, in order:
 *   1. the plan's own `calendars`: { name: { from, to } | { dates: [...] } | { ranges: [{ from, to }] } }
 *      — what the user or the brief states always wins;
 *   2. public holidays of the feed's country (Nager.Date);
 *   3. school holidays of the country, by region/zone (OpenHolidays API).
 * A period that cannot be established (no country, no zone for a regional
 * calendar, the service unreachable) is an ambiguity: the user gives the
 * dates, nothing is guessed.
 *
 *   named(name, { calendars, country, region, from, to, fetchImpl }) →
 *     { dates: Set<YYYYMMDD>, label, source } | { ambiguity }
 */

"use strict";

const { _internals: fm } = require("./feedModel");

const TTL_MS = 24 * 3600 * 1000;
const _cache = new Map();

/** YYYY-MM-DD, YYYYMMDD (an ISO time part allowed) or DD/MM/YYYY → YYYYMMDD; null for anything else or a day that does not exist. */
const parseDate = (v) => {
  const s = String(v ?? "").trim();
  let y;
  let mo;
  let d;
  let m = /^(\d{4})-?(\d{2})-?(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(s);
  if (m) [y, mo, d] = [m[1], m[2], m[3]];
  else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) [y, mo, d] = [m[3], m[2].padStart(2, "0"), m[1].padStart(2, "0")];
  else return null;
  const t = new Date(Date.UTC(+y, +mo - 1, +d));
  if (t.getUTCFullYear() !== +y || t.getUTCMonth() !== +mo - 1 || t.getUTCDate() !== +d) return null;
  return `${y}${mo}${d}`;
};

const rangeDates = (from, to) => {
  const out = [];
  if (!from || !to || to < from) return out;
  for (let d = from, i = 0; d <= to && i < 1200; d = fm.addDays(d, 1), i++) out.push(d);
  return out;
};

const ALIASES = {
  public_holidays: ["public_holidays", "holidays", "jours_feries", "feries", "bank_holidays", "dimanches_et_feries_only"],
  school_holidays: ["school_holidays", "vacances", "vacances_scolaires", "petites_vacances", "holidays_school"],
  school_days: ["school_days", "school_term", "periode_scolaire", "jours_scolaires", "school_period", "school"],
};
const canonical = (name) => {
  const k = String(name || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  for (const [c, list] of Object.entries(ALIASES)) if (list.includes(k)) return c;
  return k;
};

const cached = async (key, fn) => {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = await fn();
  _cache.set(key, { at: Date.now(), value });
  return value;
};

const years = (from, to) => {
  const a = parseInt(String(from).slice(0, 4), 10);
  const b = parseInt(String(to).slice(0, 4), 10);
  const out = [];
  for (let y = a; y <= b && out.length < 4; y++) out.push(y);
  return out;
};

const publicHolidays = async (country, from, to, fetchImpl) => {
  const { _internals: T } = require("../network/territoryService");
  const list = await cached(`ph:${country}:${from.slice(0, 4)}:${to.slice(0, 4)}`, () => T.fetchHolidays(country, years(from, to), fetchImpl));
  return list.map((h) => h.date).filter((d) => d >= from && d <= to);
};

const schoolHolidays = async (country, from, to, fetchImpl) => {
  const { _internals: T } = require("../network/territoryService");
  return cached(`sh:${country}:${from}:${to}`, () => T.fetchSchoolHolidays(country, `${from.slice(0, 4)}-${from.slice(4, 6)}-${from.slice(6)}`, `${to.slice(0, 4)}-${to.slice(4, 6)}-${to.slice(6)}`, fetchImpl));
};

const regionMatches = (regions, region) => {
  const r = String(region || "").toLowerCase().replace(/^zone\s*/, "").trim();
  return regions.some((x) => {
    const v = String(x).toLowerCase();
    return v === r || v.endsWith(`-${r}`) || v.endsWith(` ${r}`) || v.replace(/^.*[-_ ]/, "") === r;
  });
};

const amb = (code, message, options = null) => ({ ambiguity: { code, message, ...(options && options.length ? { options: options.slice(0, 12) } : {}) } });

/**
 * The dates of a named period within [from, to] (the feed's validity).
 */
const named = async (name, { calendars = null, country = null, region = null, from, to, fetchImpl = null } = {}) => {
  const raw = String(name || "").trim();
  // 1. The plan's own definitions.
  if (calendars && typeof calendars === "object") {
    const def = calendars[raw] || calendars[canonical(raw)];
    if (def) {
      const dates = new Set();
      for (const d of Array.isArray(def.dates) ? def.dates : []) {
        const y = parseDate(d);
        if (y) dates.add(y);
      }
      const ranges = Array.isArray(def.ranges) ? def.ranges : def.from || def.to ? [def] : [];
      for (const r of ranges) rangeDates(parseDate(r.from), parseDate(r.to)).forEach((d) => dates.add(d));
      if (!dates.size) return amb("calendar_empty", `The period "${raw}" defined in the plan has no dates.`);
      return { dates, label: raw, source: "plan" };
    }
  }
  const kind = canonical(raw);
  if (!["public_holidays", "school_holidays", "school_days"].includes(kind)) {
    return amb("calendar_unknown", `"${raw}" is not a known period: give its dates (from, to) in the plan's calendars.`, ["public_holidays", "school_holidays", "school_days"]);
  }
  if (!country) return amb("calendar_country_missing", `Which country's ${kind.replace("_", " ")}? The feed has no country: set it, or give the dates.`);
  const doFetch = fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (!doFetch) return amb("calendar_unavailable", `The ${kind.replace("_", " ")} cannot be fetched here: give the dates.`);
  try {
    if (kind === "public_holidays") {
      const dates = new Set(await publicHolidays(country, from, to, doFetch));
      if (!dates.size) return amb("calendar_unavailable", `No public holidays found for ${country}: give the dates.`);
      return { dates, label: `public holidays (${country})`, source: "nager" };
    }
    const periods = await schoolHolidays(country, from, to, doFetch);
    if (!periods.length) return amb("calendar_unavailable", `No school holidays found for ${country}: give the dates.`);
    const regional = periods.some((p) => !p.nationwide);
    let use = periods;
    if (regional) {
      const all = [...new Set(periods.filter((p) => !p.nationwide).flatMap((p) => p.regions))].sort();
      if (!region) return amb("calendar_region_missing", `School holidays differ by region in ${country}: which one?`, all);
      use = periods.filter((p) => p.nationwide || regionMatches(p.regions, region));
      if (use.every((p) => p.nationwide) && periods.some((p) => !p.nationwide)) return amb("calendar_region_unknown", `No school region "${region}" in ${country}.`, all);
    }
    const holidays = new Set();
    for (const p of use) rangeDates(p.start > from ? p.start : from, p.end < to ? p.end : to).forEach((d) => holidays.add(d));
    if (kind === "school_holidays") return { dates: holidays, label: `school holidays${region ? ` (${region})` : ""}`, source: "openholidays" };
    // School days: every date of the validity outside school holidays and public holidays.
    let ph = new Set();
    try {
      ph = new Set(await publicHolidays(country, from, to, doFetch));
    } catch {
      /* school days without holidays removed: flagged by the caller's warning */
    }
    const dates = new Set(rangeDates(from, to).filter((d) => !holidays.has(d) && !ph.has(d)));
    return { dates, label: `school days${region ? ` (${region})` : ""}`, source: "openholidays" };
  } catch (err) {
    return amb("calendar_unavailable", `The ${kind.replace("_", " ")} could not be fetched (${err.message}): give the dates.`);
  }
};

module.exports = { named, parseDate, rangeDates, canonical, _internals: { _cache, regionMatches } };
