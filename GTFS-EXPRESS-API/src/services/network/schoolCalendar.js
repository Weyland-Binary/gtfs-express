/**
 * schoolCalendar — school periods as service dates.
 *
 * A service may follow the school year rather than the week alone:
 *
 *   calendar: { period: "school_days" | "school_holidays", region?: "C", days: ["mon", …] }
 *
 * normalizeSpec keeps such a calendar symbolic (SCH_C_MonFri, VAC_C_MonFri);
 * this module gives it its dates within its own period of validity:
 *   • school_days      — the calendar's days outside the region's school
 *                        holidays and outside public holidays (no school):
 *                        written as exclude_dates;
 *   • school_holidays  — the calendar's days inside the region's school
 *                        holidays: written as include_dates. A public holiday
 *                        of the spec runs like the spec's holiday day type,
 *                        as every other calendar of the network.
 *
 *   resolveCalendars(spec, { territory, fetchImpl, country })
 *     → Promise<{ spec, calendars, warnings, errors }>   (dossier, else OpenHolidays)
 *   resolveCalendarsSync(spec, { territory })            (the dossier only, no network)
 *   schoolRegions(territory) · isRegional(territory) · regionKnown(territory, region)
 *
 * `spec` is a copy whose school calendars carry their dates and `resolved`;
 * `calendars` reports, per calendar, the source, the holiday periods used
 * and the number of active days; `errors` (level "error", same shape as the
 * spec's issues) name the calendars whose dates cannot be established.
 *
 * Sources: the territory dossier's school_holidays (OpenHolidays, fetched
 * with the dossier for this year and the next), else the OpenHolidays API
 * for the calendars' own period (config.OPENHOLIDAYS_URL; injectable fetch).
 * Nothing is approximated silently: no data, no region where the regions'
 * holidays differ, or a period beyond what is published are errors that
 * say what to give. The one inference — the summer holidays that follow an
 * "end of classes" marker while the next school year is not published yet —
 * comes back as a warning with its dates.
 *
 * Regions are OpenHolidays subdivision codes (France: the zones ZA/ZB/ZC and
 * the régions; Germany: the Länder…). A French zone may be given as "A",
 * "zone A", "ZA" or "FR-ZA", or through a région or an académie: the table
 * below maps them onto the zones, which also makes the match robust to the
 * région codes OpenHolidays leaves out of some periods (Occitanie is missing
 * from the 2027 winter holidays of zone C).
 */

"use strict";

const config = require("../../config");
const { runsOnSpecCalendar, holidayDayType, _internals } = require("./networkSpec");

const { weekdayOfYmd } = _internals;

const TIMEOUT_MS = 15000;
const MAX_WINDOW_DAYS = 1095; // the longest range OpenHolidays answers in one request
const LOOKAHEAD_DAYS = 200; // fetched beyond a calendar's end: shows whether the school year is published through it
const LOOKBEHIND_DAYS = 31;
const MAX_DAYS = 1200; // bound of every date loop
// After an "end of classes" marker (France publishes the start of the next
// school year with the next calendar), the summer holidays are assumed to
// run to the calendar's end, at most this long after the marker.
const SUMMER_ASSUMED_MAX_DAYS = 60;
const END_OF_CLASSES_RE = /fin des cours|end of (the )?(school )?(year|classes|term)|last day of school|schuljahresende|letzter schultag|fin del? curso|fine (delle )?lezioni|einde (van het )?schooljaar/i;
const MAX_PERIODS_REPORTED = 40;

// France: the régions wholly in each school zone (zones since 2016).
const FR_ZONE_REGIONS = { ZA: ["AR", "BF", "NA"], ZB: ["BT", "CV", "GE", "HF", "NO", "PC", "PL"], ZC: ["IF", "OC"] };
// France: the régions by their names (letters only, no accents) — as a geocoder writes a place (« Tours,
// Indre-et-Loire, Centre-Val de Loire, … ») — onto the OpenHolidays codes above.
const FR_REGION_NAMES = { AUVERGNERHONEALPES: "AR", BOURGOGNEFRANCHECOMTE: "BF", NOUVELLEAQUITAINE: "NA", BRETAGNE: "BT", CENTREVALDELOIRE: "CV", GRANDEST: "GE", HAUTSDEFRANCE: "HF", NORMANDIE: "NO", PROVENCEALPESCOTEDAZUR: "PC", PAYSDELALOIRE: "PL", ILEDEFRANCE: "IF", OCCITANIE: "OC" };
// France: the académies of each zone (letters only, no accents).
const FR_ZONE_ACADEMIES = {
  ZA: ["BESANCON", "BORDEAUX", "CLERMONTFERRAND", "DIJON", "GRENOBLE", "LIMOGES", "LYON", "POITIERS"],
  ZB: ["AIXMARSEILLE", "AMIENS", "LILLE", "NANCYMETZ", "NANTES", "NICE", "NORMANDIE", "ORLEANSTOURS", "REIMS", "RENNES", "STRASBOURG"],
  ZC: ["CRETEIL", "MONTPELLIER", "PARIS", "TOULOUSE", "VERSAILLES"],
};

const str = (v) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

// ── Dates ──────────────────────────────────────────────────────────────────

/** "2026-10-18", "20261018" or an ISO time → "20261018"; null otherwise. */
const toYmd = (v) => {
  const s = str(v).slice(0, 10).replace(/-/g, "");
  return /^\d{8}$/.test(s) ? s : null;
};
const dateOf = (ymd) => new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)));
const addDays = (ymd, n) => {
  const d = dateOf(ymd);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
};
const isoOf = (ymd) => `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
const daysBetween = (a, b) => Math.round((dateOf(b) - dateOf(a)) / 86400000);
const eachDate = (from, to) => {
  const out = [];
  for (let d = from, i = 0; d <= to && i < MAX_DAYS; d = addDays(d, 1), i++) out.push(d);
  return out;
};
const minOf = (list) => list.reduce((m, v) => (m == null || v < m ? v : m), null);
const maxOf = (list) => list.reduce((m, v) => (m == null || v > m ? v : m), null);

// ── Regions ────────────────────────────────────────────────────────────────

/** Upper case, no accents, "zone c" → "C", spaces → "-" (region codes). */
const canon = (v) =>
  str(v)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[\s_]+/g, " ")
    .replace(/^(ZONE|ZONA)\s+/, "")
    .replace(/^ACADEMIE\s+(DE\s+|D')?/, "")
    .trim();
const codeOf = (v, country) => {
  let c = canon(v).replace(/\s+/g, "-");
  if (country && c.startsWith(`${country}-`)) c = c.slice(country.length + 1);
  return c;
};

/**
 * The subdivision codes that stand for a region: itself, without its
 * country prefix, its parent (ZC-TO → ZC) and, in France, its zone and the
 * régions of that zone.
 */
const regionCandidates = (region, country = null) => {
  const out = new Set();
  const r = canon(region);
  if (!r) return out;
  const code = codeOf(r, country);
  out.add(code);
  // Without a known country, "FR-ZC" may still carry one.
  if (!country && /^[A-Z]{2}-[A-Z0-9]/.test(code)) out.add(code.slice(3));
  for (const c of [...out]) if (c.includes("-")) out.add(c.split("-")[0]);
  if (country === "FR") {
    const letters = r.replace(/[^A-Z]/g, "");
    if (/^[ABC]$/.test(code)) out.add(`Z${code}`);
    for (const [zone, list] of Object.entries(FR_ZONE_ACADEMIES)) if (list.includes(letters)) out.add(zone);
    if (FR_REGION_NAMES[letters]) out.add(FR_REGION_NAMES[letters]);
    for (const [zone, regions] of Object.entries(FR_ZONE_REGIONS)) if (regions.some((x) => out.has(x))) out.add(zone);
    for (const [zone, regions] of Object.entries(FR_ZONE_REGIONS)) if (out.has(zone)) regions.forEach((x) => out.add(x));
  }
  return out;
};

/** Periods of the region (and nationwide ones), from normalised entries. */
const matchEntries = (entries, region, country) => {
  const cands = region ? regionCandidates(region, country) : new Set();
  return entries.filter((e) => e.nationwide || (region && e.regions.some((x) => cands.has(codeOf(x, country)))));
};

/** Normalised school holiday entries of a dossier: { start, end, name, regions, nationwide }. */
const entriesOf = (list) =>
  (Array.isArray(list) ? list : [])
    .map((h) => ({ start: toYmd(h?.start), end: toYmd(h?.end), name: str(h?.name), regions: (Array.isArray(h?.regions) ? h.regions : []).map(str).filter(Boolean), nationwide: h?.nationwide === true || !(Array.isArray(h?.regions) && h.regions.length) }))
    .filter((e) => e.start && e.end && e.end >= e.start);

/** The school regions a territory's holidays distinguish (France: its zones as A, B, C). */
const schoolRegions = (territory) => {
  const country = str(territory?.place?.country_code).toUpperCase() || null;
  const codes = [...new Set(entriesOf(territory?.school_holidays).filter((e) => !e.nationwide).flatMap((e) => e.regions.map((x) => codeOf(x, country))))];
  if (country !== "FR") return codes.sort();
  const zoneRegions = new Set(Object.values(FR_ZONE_REGIONS).flat());
  const zones = codes.filter((c) => /^Z[ABC]$/.test(c)).map((c) => c.slice(1));
  const others = codes.filter((c) => !/^Z[ABC]$/.test(c) && !zoneRegions.has(c));
  // A dossier whose zone codes were cut off still names the zones' régions.
  for (const [zone, regions] of Object.entries(FR_ZONE_REGIONS)) if (!zones.includes(zone.slice(1)) && regions.some((x) => codes.includes(x))) zones.push(zone.slice(1));
  return [...zones.sort(), ...others.sort()];
};
const isRegional = (territory) => entriesOf(territory?.school_holidays).some((e) => !e.nationwide);
const regionKnown = (territory, region) => {
  const country = str(territory?.place?.country_code).toUpperCase() || null;
  return matchEntries(entriesOf(territory?.school_holidays), region, country).some((e) => !e.nationwide);
};

// ── Data sources ───────────────────────────────────────────────────────────

/**
 * The dossier's school holidays and public holidays. Its window is the one
 * territoryService.buildTerritory fetches: 1 January of the dossier's year
 * to 31 December of the next.
 */
const dossierData = (territory) => {
  if (!territory || !Array.isArray(territory.school_holidays)) return null;
  const entries = entriesOf(territory.school_holidays);
  const year = parseInt(str(territory.generatedAt).slice(0, 4), 10);
  const window = Number.isFinite(year) ? [`${year}0101`, `${year + 1}1231`] : entries.length ? [minOf(entries.map((e) => e.start)), maxOf(entries.map((e) => e.end))] : null;
  const publicEntries = (Array.isArray(territory.holidays) ? territory.holidays : []).map((h) => toYmd(h?.date)).filter(Boolean).map((d) => ({ start: d, end: d, name: "", regions: [], nationwide: true }));
  return { source: "territory", country: str(territory.place?.country_code).toUpperCase() || null, entries, publicEntries, window };
};

const fetchJson = async (fetchImpl, url) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers: { Accept: "application/json", "User-Agent": "gtfs-express/1.0 (network studio)" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
};

const parseOpenHolidays = (rows, country) =>
  (Array.isArray(rows) ? rows : []).map((h) => {
    const name = Array.isArray(h?.name) ? h.name.find((n) => n.language === country)?.text || h.name[0]?.text || "" : str(h?.name);
    const subs = Array.isArray(h?.subdivisions) ? h.subdivisions : [];
    return { start: toYmd(h?.startDate), end: toYmd(h?.endDate), name, regions: subs.map((s) => s.shortName || s.code).filter(Boolean), nationwide: h?.nationwide === true || !subs.length };
  }).filter((e) => e.start && e.end && e.end >= e.start);

/** School and public holidays of a country from OpenHolidays for [from, to] (in windows of ≤ 1095 days). */
const fetchOpenHolidays = async ({ country, from, to, fetchImpl }) => {
  const base = str(config.OPENHOLIDAYS_URL).replace(/\/$/, "");
  const entries = [];
  const publicEntries = [];
  for (let a = from, n = 0; a <= to && n < 4; a = addDays(a, MAX_WINDOW_DAYS), n++) {
    const b = [addDays(a, MAX_WINDOW_DAYS - 1), to].sort()[0];
    const q = `countryIsoCode=${encodeURIComponent(country)}&validFrom=${isoOf(a)}&validTo=${isoOf(b)}`;
    const [school, pub] = await Promise.all([fetchJson(fetchImpl, `${base}/SchoolHolidays?${q}`), fetchJson(fetchImpl, `${base}/PublicHolidays?${q}`)]);
    entries.push(...parseOpenHolidays(school, country));
    publicEntries.push(...parseOpenHolidays(pub, country));
  }
  const unique = (list) => [...new Map(list.map((e) => [`${e.start}|${e.end}|${e.name}|${e.regions.join(",")}`, e])).values()];
  return { source: "openholidays", country, entries: unique(entries), publicEntries: unique(publicEntries), window: [from, to] };
};

// ── Resolution ─────────────────────────────────────────────────────────────

const covers = (data, cal) => Boolean(data && data.entries.length && data.window && cal.start_date >= data.window[0] && cal.end_date <= data.window[1]);

const issue = (level, code, cal, message, extra = {}) => ({ level, code, path: `calendars.${cal.id}`, message, calendarId: cal.id, ...extra });

/**
 * The dates of one school calendar from one data source:
 * { cal (resolved) | null, report, warnings, errors }.
 */
const resolveOne = (cal, spec, data, { fetchError = null } = {}) => {
  const errors = [];
  const warnings = [];
  const zone = cal.region ? ` (region ${cal.region})` : "";
  const fail = (code, message, extra) => {
    errors.push(issue("error", code, cal, message, extra));
    return { cal: null, report: null, warnings, errors };
  };
  const s = cal.start_date;
  const e = cal.end_date;
  if (!data || !data.entries.length) {
    return fail("school_holidays_unavailable", `No school holidays are known for ${data?.country || "this country"}${fetchError ? ` (OpenHolidays: ${fetchError})` : ""}: calendar ${cal.id} cannot follow the school year. Give its dates instead (a calendar with days and include_dates / exclude_dates).`);
  }
  if (!covers(data, cal)) {
    return fail("school_holidays_not_covered", `The school holidays at hand cover ${data.window ? `${data.window[0]}–${data.window[1]}` : "no period"}, not calendar ${cal.id} (${s}–${e})${fetchError ? `; OpenHolidays could not be reached (${fetchError})` : ""}.`);
  }
  const country = data.country;
  const regional = data.entries.some((x) => !x.nationwide);
  const regions = schoolRegions({ place: { country_code: country }, school_holidays: data.entries });
  if (regional && !cal.region) return fail("school_region_needed", `School holidays differ by region in ${country || "this country"}: calendar ${cal.id} needs its region (${regions.join(", ")}).`, { regions });
  const matched = matchEntries(data.entries, cal.region, country);
  if (cal.region && regional && !matched.some((x) => !x.nationwide)) return fail("unknown_school_region", `No school region "${cal.region}" in the school holidays of ${country || "this country"} (${regions.join(", ")}).`, { regions });

  // The region's periods; an "end of classes" marker (a single day) opens
  // summer holidays whose end — the next school year's start — may not be
  // published: they are assumed to run until the next known period, at
  // most SUMMER_ASSUMED_MAX_DAYS, unless the data lists them already.
  const periods = [...new Map(matched.map((m) => [`${m.start}|${m.end}`, { start: m.start, end: m.end, name: m.name }])).values()].sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
  const assumed = [];
  for (const m of periods.filter((p) => p.start === p.end && END_OF_CLASSES_RE.test(p.name))) {
    const later = periods.filter((p) => p.start > m.end).map((p) => p.start).sort();
    if (later.length && later[0] <= addDays(m.end, 7)) continue; // the summer holidays are listed
    const cap = addDays(m.end, SUMMER_ASSUMED_MAX_DAYS);
    assumed.push({ start: addDays(m.end, 1), end: later.length ? [addDays(later[0], -1), cap].sort()[0] : cap, name: "summer holidays (assumed)", assumed: true, after: m.end });
  }
  periods.push(...assumed);
  // What is published: up to the end of the region's last known period.
  const knownUntil = maxOf(periods.map((p) => p.end));
  if (!knownUntil || e > knownUntil) {
    return fail("school_holidays_not_published", `The school holidays${zone} are published up to ${knownUntil || "no date"}: calendar ${cal.id} runs to ${e}. End it (or the feed) by then, or give its dates.`, { published_until: knownUntil });
  }
  for (const a of assumed) {
    if (a.end < s || a.start > e) continue;
    const to = a.end < e ? a.end : e;
    warnings.push(issue("warning", "school_summer_assumed", cal, `Calendar ${cal.id}: the school year ends on ${a.after} and the start of the next one is not published: the summer holidays are assumed to run from ${a.start} to ${to}.`, { from: a.start, to }));
  }

  // Dates.
  const holidays = new Set();
  for (const p of periods) for (const d of eachDate(p.start > s ? p.start : s, p.end < e ? p.end : e)) holidays.add(d);
  const specHolidays = new Set((spec.holidays || []).filter((d) => d >= s && d <= e));
  const publicHolidays = new Set(specHolidays);
  for (const p of matchEntries(data.publicEntries || [], cal.region, country)) for (const d of eachDate(p.start > s ? p.start : s, p.end < e ? p.end : e)) publicHolidays.add(d);
  const days = new Set(cal.days);
  const holidayDay = holidayDayType(spec);
  let resolved;
  if (cal.period === "school_days") {
    // No school on a school holiday nor on a public holiday.
    const exclude = eachDate(s, e).filter((d) => days.has(weekdayOfYmd(d)) && (holidays.has(d) || publicHolidays.has(d)));
    resolved = { ...cal, exclude_dates: exclude };
  } else {
    // A public holiday of the spec runs like its holiday day type, as every calendar does.
    const include = [...holidays].sort().filter((d) => (specHolidays.has(d) ? Boolean(holidayDay) && days.has(holidayDay) : days.has(weekdayOfYmd(d))));
    resolved = { ...cal, include_dates: include };
  }
  delete resolved[cal.period === "school_days" ? "include_dates" : "exclude_dates"];
  resolved.resolved = { source: data.source, region: cal.region || null };
  const active = eachDate(s, e).filter((d) => runsOnSpecCalendar(resolved, d, spec) === true).length;
  if (!active) warnings.push(issue("warning", "school_calendar_empty", cal, `Calendar ${cal.id} has no day to run between ${s} and ${e}: its services are left out.`));
  const inRange = periods.filter((p) => p.end >= s && p.start <= e);
  const report = {
    id: cal.id,
    period: cal.period,
    region: cal.region || null,
    source: data.source,
    from: s,
    to: e,
    holiday_periods: inRange.slice(0, MAX_PERIODS_REPORTED).map((p) => ({ name: p.name, start: p.start, end: p.end, ...(p.assumed ? { assumed: true } : {}) })),
    ...(cal.period === "school_days" ? { excluded_dates: resolved.exclude_dates.length } : { included_dates: resolved.include_dates.length }),
    public_holidays: [...publicHolidays].length,
    active_days: active,
    published_until: knownUntil,
  };
  return { cal: resolved, report, warnings, errors };
};

/** The school calendars a service runs on (an unused one needs no dates). */
const usedSchoolCalendars = (spec) => {
  const used = new Set((spec?.lines || []).flatMap((l) => (l.services || []).map((s) => s.calendar_id)));
  return (spec?.calendars || []).filter((c) => c && c.period && used.has(c.id));
};

/** Resolve every used school calendar of a spec with the first data source that covers it. */
const resolveWith = (spec, sources, opts = {}) => {
  const out = { spec, calendars: [], warnings: [], errors: [] };
  const cals = new Set(usedSchoolCalendars(spec));
  if (!cals.size) return out;
  const next = [];
  for (const c of spec.calendars) {
    if (!cals.has(c)) {
      next.push(c);
      continue;
    }
    const data = sources.find((d) => covers(d, c)) || sources.find(Boolean) || null;
    const r = resolveOne(c, spec, data, opts);
    out.warnings.push(...r.warnings);
    out.errors.push(...r.errors);
    if (r.report) out.calendars.push(r.report);
    next.push(r.cal || c);
  }
  out.spec = { ...spec, calendars: next };
  return out;
};

/** The school calendars of a spec resolved from the territory's dossier alone (no network). */
const resolveCalendarsSync = (spec, { territory = null } = {}) => resolveWith(spec, [dossierData(territory)].filter(Boolean));

/**
 * The school calendars of a spec resolved: the dossier when it covers
 * them, else OpenHolidays for their period (country from the territory or
 * `country`). A spec without school calendars comes back unchanged.
 */
const resolveCalendars = async (spec, { territory = null, fetchImpl = null, country = null } = {}) => {
  const cals = usedSchoolCalendars(spec);
  if (!cals.length) return { spec, calendars: [], warnings: [], errors: [] };
  const dossier = dossierData(territory);
  const sources = dossier ? [dossier] : [];
  let fetchError = null;
  const ctry = str(dossier?.country || country).toUpperCase() || null;
  if (!cals.every((c) => covers(dossier, c))) {
    const doFetch = fetchImpl || (typeof fetch === "function" ? fetch : null);
    if (!ctry) fetchError = "the country is unknown (no territory)";
    else if (!doFetch) fetchError = "no fetch implementation";
    else {
      const from = addDays(minOf(cals.map((c) => c.start_date)), -LOOKBEHIND_DAYS);
      const to = addDays(maxOf(cals.map((c) => c.end_date)), LOOKAHEAD_DAYS);
      try {
        // Fetched for the calendars' own period: preferred over a dossier that does not cover them.
        sources.unshift(await fetchOpenHolidays({ country: ctry, from, to, fetchImpl: doFetch }));
      } catch (err) {
        fetchError = err.name === "AbortError" ? "timeout" : err.message;
      }
    }
  }
  if (!sources.length) sources.push({ source: "none", country: ctry, entries: [], publicEntries: [], window: null });
  return resolveWith(spec, sources, { fetchError });
};

module.exports = {
  resolveCalendars,
  resolveCalendarsSync,
  schoolRegions,
  isRegional,
  regionKnown,
  _internals: { FR_REGION_NAMES, regionCandidates, codeOf, schoolRegions, matchEntries, entriesOf, dossierData, fetchOpenHolidays, parseOpenHolidays, resolveOne, usedSchoolCalendars, addDays, toYmd, daysBetween, eachDate, FR_ZONE_REGIONS, SUMMER_ASSUMED_MAX_DAYS, END_OF_CLASSES_RE },
};
