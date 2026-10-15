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
 *   named(name, { calendars, country, region, from, to, fetchImpl, lang }) →
 *     { dates: Set<YYYYMMDD>, label, source } | { ambiguity }
 *   (label and question in `lang`, i18n.js; English by default)
 */

"use strict";

const { _internals: fm } = require("./feedModel");
const { tr } = require("./i18n");

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

// The dates from `from` to `to`, `max` at most (a calendar valid until 2099 is read on its first 1200 days).
const rangeDates = (from, to, max = 1200) => {
  const out = [];
  if (!from || !to || to < from) return out;
  for (let d = from, i = 0; d <= to && i < max; d = fm.addDays(d, 1), i++) out.push(d);
  return out;
};
// A period written as dates, read on the feed's validity [lo, hi] when it overlaps it (only those dates are ever
// read) — whole, a century at most, never cut at 1200 days in silence (« du 01/01/2024 au 31/12/2027 » over a feed
// of one year is that year, every day of it); as written otherwise (its dates then fall outside the feed, which the
// scope says where they are used).
const MAX_RANGE_DAYS = 36600;
const withinFeed = (a, b, lo, hi) => (lo && hi && a <= hi && b >= lo ? rangeDates(a < lo ? lo : a, b > hi ? hi : b, MAX_RANGE_DAYS) : rangeDates(a, b, MAX_RANGE_DAYS));

const ALIASES = {
  public_holidays: ["public_holidays", "holidays", "jours_feries", "feries", "bank_holidays", "dimanches_et_feries_only"],
  school_holidays: ["school_holidays", "vacances", "vacances_scolaires", "petites_vacances", "holidays_school"],
  school_days: ["school_days", "school_term", "periode_scolaire", "jours_scolaires", "school_period", "school"],
};
// A period written as its dates — « du 1er septembre au 16 octobre 2026 », « 01/09/2026 – 16/10/2026 »,
// « 2026-09-01 → 2026-10-16 » — as { from, to } (YYYYMMDD), or null: what a person types for a period the plan has no
// name for. A first date without its year takes the second's (the year before when its month comes later). A bound
// that is no day of the calendar (« du 31/02/2027 au 15/03/2027 ») makes no period: null, and the period is asked,
// never a shifted set of dates.
const MONTHS = { janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12, january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
const dayOfText = (txt) => {
  const s = String(txt || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return { y: +m[1], mo: +m[2], d: +m[3] };
  m = /^(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?$/.exec(s);
  if (m) return { y: m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : null, mo: +m[2], d: +m[1] };
  m = /^(\d{1,2})(?:er|st|nd|rd|th)?\s+([a-z]+)(?:\s+(\d{4}))?$/.exec(s);
  if (m && MONTHS[m[2]]) return { y: m[3] ? +m[3] : null, mo: MONTHS[m[2]], d: +m[1] };
  return null;
};
const rangeOfText = (raw) => {
  const s = String(raw || "").trim();
  const m = /^(?:du\s+|from\s+)?(.+?)\s*(?:\bau\b|\bto\b|–|—|->|→|\s-\s)\s*(.+)$/i.exec(s);
  if (!m) return null;
  const a = dayOfText(m[1]);
  const b = dayOfText(m[2]);
  if (!a || !b || !b.y) return null;
  if (!a.y) a.y = a.mo > b.mo ? b.y - 1 : b.y;
  // Each bound through the one date check (parseDate): a 31 February is no date, in this reading as in every other.
  const ymd = (x) => parseDate(`${x.y}-${String(x.mo).padStart(2, "0")}-${String(x.d).padStart(2, "0")}`);
  const from = ymd(a);
  const to = ymd(b);
  return from && to && to >= from ? { from, to } : null;
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

// A region as people write it ("C", "zone C", "Académie de Toulouse", "FR-ZC")
// against the subdivision codes OpenHolidays answers (France: "ZC" for zone C,
// plus the régions of each zone): the Network Studio's school calendars and
// the Change Studio's periods share one notion of a school zone.
const regionMatches = (regions, region, country = null) => {
  const { regionCandidates, codeOf } = require("../network/schoolCalendar")._internals;
  const cc = country ? String(country).toUpperCase() : null;
  const cands = regionCandidates(region, cc);
  if (regions.some((x) => cands.has(codeOf(x, cc)))) return true;
  const r = String(region || "").toLowerCase().replace(/^zone\s*/, "").trim();
  return regions.some((x) => {
    const v = String(x).toLowerCase();
    return v === r || v.endsWith(`-${r}`) || v.endsWith(` ${r}`) || v.replace(/^.*[-_ ]/, "") === r;
  });
};
// The regions to offer in a question, as people name them (France: A, B, C).
const regionOptions = (periods, country) => {
  const { schoolRegions } = require("../network/schoolCalendar")._internals;
  const named = schoolRegions({ place: { country_code: country }, school_holidays: periods });
  return named.length ? named : [...new Set(periods.filter((p) => !p.nationwide).flatMap((p) => p.regions))].sort();
};

const dmy = (d) => `${d.slice(6, 8)}/${d.slice(4, 6)}/${d.slice(0, 4)}`;
const amb = (code, message, options = null) => ({ ambiguity: { code, message, ...(options && options.length ? { options: options.slice(0, 12) } : {}) } });
// The countries a question offers (the calendar services answer for many more: plan.country takes any ISO code).
const COUNTRY_CHOICES = ["fr", "be", "ch", "lu", "de", "es", "it", "gb", "nl", "pt", "ca", "us"];
const countryName = (code, lang) => {
  try {
    return new Intl.DisplayNames([String(lang || "en").slice(0, 2)], { type: "region" }).of(String(code).toUpperCase()) || String(code).toUpperCase();
  } catch {
    return String(code).toUpperCase();
  }
};

const KIND_WORDS = { public_holidays: "calendars.kind_public_holidays", school_holidays: "calendars.kind_school_holidays", school_days: "calendars.kind_school_days" };

/**
 * The dates of a named period within [from, to] (the feed's validity).
 */
const named = async (name, { calendars = null, country = null, region = null, from, to, fetchImpl = null, lang } = {}) => {
  const raw = String(name || "").trim();
  // 1. The plan's own definitions.
  if (calendars && typeof calendars === "object") {
    const def = calendars[raw] || calendars[canonical(raw)];
    if (def) {
      const dates = new Set();
      for (const d of Array.isArray(def.dates) ? def.dates : []) {
        const y = parseDate(d);
        if (!y) return amb("date_invalid", tr(lang, "calendars.period_date_invalid", { name: raw, value: String(d) }));
        dates.add(y);
      }
      const ranges = Array.isArray(def.ranges) ? def.ranges : def.from || def.to ? [def] : [];
      for (const r of ranges) {
        const a = parseDate(r.from);
        const b = parseDate(r.to);
        if (!a || !b) return amb("date_invalid", !a ? tr(lang, "calendars.range_start_invalid", { name: raw, value: String(r.from) }) : tr(lang, "calendars.range_end_invalid", { name: raw, value: String(r.to) }));
        if (b < a) return amb("dates_inverted", tr(lang, "calendars.range_inverted", { name: raw, end: b, start: a }));
        withinFeed(a, b, from, to).forEach((d) => dates.add(d));
      }
      if (!dates.size) return amb("calendar_empty", tr(lang, "calendars.period_empty", { name: raw }));
      return { dates, label: raw, source: "plan" };
    }
  }
  // A period written as its dates: those dates (never a name to look up).
  const written = rangeOfText(raw);
  if (written) return { dates: new Set(withinFeed(written.from, written.to, from, to)), label: raw, source: "text" };
  const kind = canonical(raw);
  if (!["public_holidays", "school_holidays", "school_days"].includes(kind)) {
    return amb("calendar_unknown", tr(lang, "calendars.period_unknown", { name: raw }), ["public_holidays", "school_holidays", "school_days"]);
  }
  const what = tr(lang, KIND_WORDS[kind]);
  // Asked with countries to choose from (their code the answer, their name the label): never a free field whose
  // words would be cut into a code.
  if (!country) {
    const asked = amb("calendar_country_missing", tr(lang, "calendars.country_missing", { kind: what }), COUNTRY_CHOICES);
    return { ambiguity: { ...asked.ambiguity, labels: Object.fromEntries(COUNTRY_CHOICES.map((c) => [c, countryName(c, lang)])) } };
  }
  // The unit tests never reach the holiday services unscripted (NODE_ENV=test): they pass their fetch — as
  // feedView.resolvePublicHolidays and coherence/dayTypes do.
  const doFetch = fetchImpl || (process.env.NODE_ENV !== "test" && typeof fetch === "function" ? fetch : null);
  if (!doFetch) return amb("calendar_unavailable", tr(lang, "calendars.cannot_fetch", { kind: what }));
  try {
    if (kind === "public_holidays") {
      const dates = new Set(await publicHolidays(country, from, to, doFetch));
      if (!dates.size) return amb("calendar_unavailable", tr(lang, "calendars.no_public_holidays", { country: String(country) }));
      return { dates, label: tr(lang, "calendars.label_public_holidays", { country: String(country) }), source: "nager" };
    }
    const periods = await schoolHolidays(country, from, to, doFetch);
    if (!periods.length) return amb("calendar_unavailable", tr(lang, "calendars.no_school_holidays", { country: String(country) }));
    const regional = periods.some((p) => !p.nationwide);
    let use = periods;
    if (regional) {
      const all = regionOptions(periods, country);
      if (!region) return amb("calendar_region_missing", tr(lang, "calendars.region_missing", { country: String(country) }), all);
      use = periods.filter((p) => p.nationwide || regionMatches(p.regions, region, country));
      if (use.every((p) => p.nationwide) && periods.some((p) => !p.nationwide)) return amb("calendar_region_unknown", tr(lang, "calendars.region_unknown", { region: String(region), country: String(country) }), all);
    }
    // An « end of classes » marker (a single day: France publishes the next school year's start with the next
    // calendar — 2027 is « Fin des cours » on 3 July and nothing after it) opens summer holidays whose end is not
    // published: the Network Studio's rule (network/schoolCalendar), until the next known period, at most
    // SUMMER_ASSUMED_MAX_DAYS — read as one day, « pas pendant les vacances scolaires » would leave the whole summer
    // running. Said wherever its dates decide something, and so is a period read past what is published.
    const SC = require("../network/schoolCalendar")._internals;
    const assumed = [];
    const markers = use.filter((p) => p.start === p.end && SC.END_OF_CLASSES_RE.test(String(p.name || "")));
    for (const m of markers) {
      const later = use.filter((p) => p.start > m.end).map((p) => p.start).sort();
      if (later.length && later[0] <= SC.addDays(m.end, 7)) continue; // the summer holidays are listed
      const cap = SC.addDays(m.end, SC.SUMMER_ASSUMED_MAX_DAYS);
      assumed.push({ start: SC.addDays(m.end, 1), end: later.length ? [SC.addDays(later[0], -1), cap].sort()[0] : cap });
    }
    // The marker's own day is the last day of classes — a school day, as the published periods read it (they start the
    // day after it: a validated oracle keeps the Saturday classes end out of the holidays).
    const holidays = new Set();
    for (const p of [...use.filter((x) => !markers.includes(x)), ...assumed]) rangeDates(p.start > from ? p.start : from, p.end < to ? p.end : to).forEach((d) => holidays.add(d));
    const warnings = [];
    for (const a of assumed.filter((x) => x.start <= to && x.end >= from)) warnings.push(tr(lang, "calendars.summer_assumed", { start: dmy(a.start > from ? a.start : from), end: dmy(a.end < to ? a.end : to) }));
    const knownUntil = [...use, ...assumed].map((p) => p.end).sort().pop();
    // Past what is published: no period of the region for longer than two terms' gaps (school holidays come at least
    // every ten weeks) — the dates after its last known one cannot be read.
    if (knownUntil && knownUntil < to && SC.addDays(knownUntil, 70) < to) warnings.push(tr(lang, "calendars.not_published", { until: dmy(knownUntil) }));
    const warning = warnings.length ? warnings.join(" ") : null;
    if (kind === "school_holidays") return { dates: holidays, label: region ? tr(lang, "calendars.label_school_holidays_region", { region: String(region) }) : tr(lang, "calendars.label_school_holidays"), source: "openholidays", ...(warning ? { warning } : {}) };
    // School days: every date of the validity outside school holidays and public holidays.
    let ph = new Set();
    try {
      ph = new Set(await publicHolidays(country, from, to, doFetch));
    } catch {
      /* school days without holidays removed: flagged by the caller's warning */
    }
    const dates = new Set(rangeDates(from, to).filter((d) => !holidays.has(d) && !ph.has(d)));
    return { dates, label: region ? tr(lang, "calendars.label_school_days_region", { region: String(region) }) : tr(lang, "calendars.label_school_days"), source: "openholidays", ...(warning ? { warning } : {}) };
  } catch (err) {
    return amb("calendar_unavailable", tr(lang, "calendars.fetch_failed", { kind: what, error: String(err.message) }));
  }
};

module.exports = { named, parseDate, rangeDates, canonical, _internals: { _cache, regionMatches } };
