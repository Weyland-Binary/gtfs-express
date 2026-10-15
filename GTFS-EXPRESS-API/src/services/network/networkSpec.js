/**
 * networkSpec — the Network Spec: what a transit network IS, before it is a
 * GTFS. It is the contract between the planner (a person or the assistant)
 * and the deterministic compiler.
 *
 *   {
 *     version: 1,
 *     agency:  { id?, name, url, timezone, lang?, phone?, email? },
 *     feed:    { start_date?, end_date?, publisher?, version?, lang? },   // YYYYMMDD
 *     stops:   [{ id?, name, lat?, lon?, address?, code?, wheelchair? }],
 *     lines:   [{
 *       id?, short_name, long_name?, mode?, color?, text_color?, description?,
 *       speed_kmh?, dwell_s?,
 *       speed_profile?: [{ from: "07:00", to: "09:00", speed_kmh: 16 }],  // commercial speed by time of day
 *       directions: [{ id?: "0"|"1", headsign?, stops: [stop id or name, …] }],
 *       round_trip?: true,                     // derive direction 1 by reversing direction 0
 *       variants?: [{ id, direction: "0"|"1", headsign?, stops: [stop id or name, …] }],
 *                                              // short-turns, branches, deviations
 *       services: [{
 *         calendar: "weekday" | "saturday" | "sunday" | "weekend" | "daily" | "monsat"
 *                   | { id?, days: ["mon", …], start_date?, end_date?, include_dates?, exclude_dates? }
 *                   | { period: "school_days" | "school_holidays", region?: "C", days: ["mon", …], start_date?, end_date? },
 *         direction?: "0" | "1" | "both",
 *         variant?: "<variant id>",            // runs that variant (its direction)
 *         periods?: [{ from: "06:00", to: "09:00", headway_min: 10 }],
 *         departures?: ["06:05", "06:35", …],
 *       }],
 *     }],
 *     running_time_profile?: [{ from: "07:00", to: "09:00", factor: 0.85 }],  // × the commercial
 *                                              // speed of the road modes (a line's speed_profile wins)
 *     holidays?: ["20261225", …], holiday_service?: "sunday" | "none",
 *     transfers?: [{ from, to, min_minutes?, type? }],
 *   }
 *
 * `normalizeSpec(raw, { territory? })` returns `{ spec, issues, blockers }`:
 * a normalised copy (ids, colours, modes, calendars, derived directions,
 * auto-created stops) plus every problem found. Issues of level "error"
 * stop the compilation; blockers are the errors a person (or a tool) must
 * resolve — typically stops without coordinates. The territory (optional)
 * is only read to check that a school calendar names its school zone where
 * the zones' holidays differ. `estimateSpec(spec)` counts what the compiled
 * feed would contain without any network access.
 *
 * School calendars stay symbolic here (SCH_C_MonFri, VAC_C_MonFri):
 * schoolCalendar.resolveCalendars turns them into explicit dates for the
 * compiler. `runsOnSpecCalendar(cal, ymd, spec?)` says whether a normalised
 * calendar runs on a date; `patternsOf(line)` lists a line's stop patterns
 * (main directions first, then its variants).
 */

"use strict";

const MODES = {
  bus: { route_type: 3, speed_kmh: 20, dwell_s: 20, color: "1E88E5" },
  coach: { route_type: 3, speed_kmh: 45, dwell_s: 30, color: "3949AB" },
  express: { route_type: 3, speed_kmh: 30, dwell_s: 20, color: "8E24AA" },
  shuttle: { route_type: 3, speed_kmh: 20, dwell_s: 20, color: "00897B" },
  trolleybus: { route_type: 11, speed_kmh: 18, dwell_s: 20, color: "F4511E" },
  tram: { route_type: 0, speed_kmh: 22, dwell_s: 25, color: "43A047" },
  metro: { route_type: 1, speed_kmh: 35, dwell_s: 30, color: "E53935" },
  subway: { route_type: 1, speed_kmh: 35, dwell_s: 30, color: "E53935" },
  rail: { route_type: 2, speed_kmh: 60, dwell_s: 45, color: "6D4C41" },
  train: { route_type: 2, speed_kmh: 60, dwell_s: 45, color: "6D4C41" },
  ferry: { route_type: 4, speed_kmh: 25, dwell_s: 120, color: "00ACC1" },
  cable: { route_type: 5, speed_kmh: 12, dwell_s: 30, color: "FB8C00" },
  gondola: { route_type: 6, speed_kmh: 18, dwell_s: 30, color: "FB8C00" },
  funicular: { route_type: 7, speed_kmh: 15, dwell_s: 30, color: "FB8C00" },
  monorail: { route_type: 12, speed_kmh: 30, dwell_s: 30, color: "5E35B1" },
};
const MODE_ALIASES = { autobus: "bus", car: "coach", tramway: "tram", metro: "metro", métro: "metro", subway: "subway", underground: "metro", ter: "rail", train: "rail", rer: "rail", navette: "shuttle", bateau: "ferry", ferry: "ferry", boat: "ferry", trolley: "trolleybus", téléphérique: "gondola", telepherique: "gondola", funiculaire: "funicular" };
const PALETTE = ["1E88E5", "E53935", "43A047", "FB8C00", "8E24AA", "00ACC1", "F4511E", "3949AB", "00897B", "C0CA33", "6D4C41", "D81B60"];
const NAMED_CALENDARS = {
  weekday: { id: "WKD", days: ["mon", "tue", "wed", "thu", "fri"] },
  weekdays: { id: "WKD", days: ["mon", "tue", "wed", "thu", "fri"] },
  monfri: { id: "WKD", days: ["mon", "tue", "wed", "thu", "fri"] },
  workdays: { id: "WKD", days: ["mon", "tue", "wed", "thu", "fri"] },
  saturday: { id: "SAT", days: ["sat"] },
  sunday: { id: "SUN", days: ["sun"] },
  weekend: { id: "WKE", days: ["sat", "sun"] },
  daily: { id: "DAILY", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] },
  everyday: { id: "DAILY", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] },
  monsat: { id: "MONSAT", days: ["mon", "tue", "wed", "thu", "fri", "sat"] },
};
const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_ALIASES = { monday: "mon", lundi: "mon", tuesday: "tue", mardi: "tue", wednesday: "wed", mercredi: "wed", thursday: "thu", jeudi: "thu", friday: "fri", vendredi: "fri", saturday: "sat", samedi: "sat", sunday: "sun", dimanche: "sun" };
const LIMITS = { lines: 80, stops: 3000, trips: 25000, directions: 2, stopsPerDirection: 150, variantsPerLine: 12, bands: 12, explicitDates: 400 };
// School calendars: the period and the prefix of their derived id.
const SCHOOL_PERIODS = { school_days: "SCH", school_holidays: "VAC" };
// The modes whose running time follows the road traffic: the network's
// running_time_profile applies to them (a tram or a train keeps its speed).
const ROAD_MODES = new Set(["bus", "coach", "express", "shuttle", "trolleybus"]);
// Time bands run within the service day, which may pass midnight (≤ 30:00).
const MAX_BAND_S = 30 * 3600;

const HEX_RE = /^[0-9A-Fa-f]{6}$/;
const DATE_RE = /^\d{8}$/;
const TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;
const TZ_RE = /^[A-Za-z_]+\/[A-Za-z_+\-0-9]+(\/[A-Za-z_+\-0-9]+)?$|^UTC$|^Etc\/[A-Za-z0-9+\-]+$/;
const VARIANT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$/;
const REGION_RE = /^[A-Z0-9][A-Z0-9 _-]{0,23}$/;

const str = (v) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());
const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
};
const timeToSec = (t) => {
  const m = TIME_RE.exec(str(t));
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mi = parseInt(m[2], 10);
  const s = m[3] ? parseInt(m[3], 10) : 0;
  if (mi > 59 || s > 59) return null;
  return h * 3600 + mi * 60 + s;
};
const secToTime = (v) => `${String(Math.floor(v / 3600)).padStart(2, "0")}:${String(Math.floor((v % 3600) / 60)).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`;
const slug = (s) =>
  str(s)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase()
    .slice(0, 40) || "X";
// A name as a person reads it: accents, case and punctuation apart, and a ligature written out (« Cœur d'O » is
// « COEUR D'O », as a feed writes it), so the measure finds the stops the engine's resolver finds.
const nameKey = (s) => str(s).replace(/œ/gi, "oe").replace(/æ/gi, "ae").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const todayYmd = () => {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
};
const addYearYmd = (ymd) => `${parseInt(ymd.slice(0, 4), 10) + 1}${ymd.slice(4)}`;
const luminance = (hex) => {
  const c = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const textColorFor = (hex) => (luminance(hex) > 0.4 ? "000000" : "FFFFFF");

const resolveMode = (raw) => {
  const k = str(raw).toLowerCase();
  if (!k) return "bus";
  if (MODES[k]) return k;
  if (MODE_ALIASES[k]) return MODE_ALIASES[k];
  return null;
};

const parseDays = (raw) => {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const d of raw) {
    const k = str(d).toLowerCase().slice(0, 3);
    const key = DAY_KEYS.includes(k) ? k : DAY_ALIASES[str(d).toLowerCase()];
    if (!key) return null;
    if (!out.includes(key)) out.push(key);
  }
  return out;
};

// ── Time bands, dates, regions ─────────────────────────────────────────────

const pad2 = (n) => String(n).padStart(2, "0");
/** Seconds → "HH:MM" ("HH:MM:SS" when the seconds matter). */
const hhmm = (sec) => `${pad2(Math.floor(sec / 3600))}:${pad2(Math.floor((sec % 3600) / 60))}${sec % 60 ? `:${pad2(sec % 60)}` : ""}`;

/** A YYYYMMDD string that is a real day. */
const isYmd = (d) => {
  if (!DATE_RE.test(d || "")) return false;
  const t = new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)));
  return t.getUTCFullYear() === +d.slice(0, 4) && t.getUTCMonth() === +d.slice(4, 6) - 1 && t.getUTCDate() === +d.slice(6, 8);
};
const DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
/** Day of the week of a YYYYMMDD date, timezone-independent ("mon"…). */
const weekdayOfYmd = (ymd) => DOW[new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8))).getUTCDay()];

/** Days as a short code for ids: a run of 3+ days reads first–last (MonFri), else every day (SatSun). */
const daysCode = (days) => {
  const idx = DAY_KEYS.map((d, i) => (days.includes(d) ? i : -1)).filter((i) => i >= 0);
  const cap = (i) => DAY_KEYS[i][0].toUpperCase() + DAY_KEYS[i].slice(1);
  const run = idx.length >= 3 && idx.every((v, i) => i === 0 || v === idx[i - 1] + 1);
  return run ? `${cap(idx[0])}${cap(idx[idx.length - 1])}` : idx.map(cap).join("");
};

/** "zone c", "Zone C" → "C"; other codes upper-cased as given ("FR-ZC", "BY"). */
const normRegion = (v) =>
  str(v)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .replace(/^(ZONE|ZONA)\s+/, "")
    .trim();
const parsePeriod = (v) => {
  const k = str(v).toLowerCase().replace(/[\s-]+/g, "_");
  return SCHOOL_PERIODS[k] ? k : null;
};

/**
 * Time bands [{ from, to, <valueKey> }] → sorted, validated, "HH:MM" bands;
 * undefined when absent or empty. Bands lie within 00:00–30:00 and do not
 * overlap; a departure outside every band keeps the base value.
 */
const parseBands = (raw, path, { valueKey, min, max, code, label }, err) => {
  if (raw == null) return undefined;
  if (!Array.isArray(raw)) {
    err("invalid_profile", path, `${label} must be a list of time bands ({ from, to, ${valueKey} }).`);
    return undefined;
  }
  if (raw.length > LIMITS.bands) err("too_many_bands", path, `At most ${LIMITS.bands} time bands.`);
  const out = [];
  raw.slice(0, LIMITS.bands).forEach((b, i) => {
    const bpath = `${path}[${i}]`;
    const from = timeToSec(b?.from ?? b?.start);
    const to = timeToSec(b?.to ?? b?.end);
    if (from == null || to == null) return err("invalid_time", bpath, "Band times must be HH:MM.");
    if (to <= from) return err("invalid_band", bpath, "A time band must end after it starts.");
    if (to > MAX_BAND_S) return err("invalid_band", bpath, "Time bands must lie within 00:00–30:00.");
    const v = num(b?.[valueKey]);
    if (v == null || v < min || v > max) return err(code, `${bpath}.${valueKey}`, `${valueKey} must be between ${min} and ${max}.`);
    out.push({ from, to, v });
  });
  out.sort((a, b) => a.from - b.from || a.to - b.to);
  for (let i = 1; i < out.length; i++) {
    if (out[i].from < out[i - 1].to) {
      err("overlapping_bands", path, `The time bands ${hhmm(out[i - 1].from)}–${hhmm(out[i - 1].to)} and ${hhmm(out[i].from)}–${hhmm(out[i].to)} overlap.`);
      return undefined;
    }
  }
  return out.length ? out.map((b) => ({ from: hhmm(b.from), to: hhmm(b.to), [valueKey]: b.v })) : undefined;
};

/**
 * Explicit dates of a calendar (include_dates / exclude_dates): sorted,
 * unique, real YYYYMMDD days (YYYY-MM-DD accepted) within [sd, ed]. null
 * when the list is invalid (reported through err).
 */
const parseDateList = (raw, path, sd, ed, { err, warn }) => {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    err("invalid_dates", path, "Must be a list of YYYYMMDD dates.");
    return null;
  }
  if (raw.length > LIMITS.explicitDates) {
    err("too_many_dates", path, `At most ${LIMITS.explicitDates} dates per list.`);
    return null;
  }
  const out = new Set();
  let outside = 0;
  for (const [i, v] of raw.entries()) {
    const d = str(v).replace(/-/g, "");
    if (!isYmd(d)) {
      err("invalid_dates", `${path}[${i}]`, `"${v}" is not a YYYYMMDD date.`);
      return null;
    }
    if (d < sd || d > ed) outside += 1;
    else out.add(d);
  }
  if (outside) warn("calendar_dates_outside", path, `${outside} date(s) outside the calendar's period (${sd}–${ed}) were ignored.`);
  return [...out].sort();
};

/**
 * The day type a public holiday runs like: "sunday" / "saturday" name the
 * local rest days — with a Fri–Sat weekend, "sunday" is the first rest day
 * (Friday) and "saturday" the last. null for "none".
 */
const holidayDayType = (spec) => {
  if (!spec || spec.holiday_service === "none") return null;
  const named = spec.holiday_service === "saturday" ? "sat" : "sun";
  const weekend = Array.isArray(spec.weekend) && spec.weekend.length ? spec.weekend : ["sat", "sun"];
  if (weekend.includes(named)) return named;
  return spec.holiday_service === "saturday" ? weekend[weekend.length - 1] : weekend[0];
};

// ── Patterns and calendars of a normalised spec ────────────────────────────

/**
 * The stop patterns of a line: its main directions first, then its
 * variants — [{ id, direction, stops, variant, headsign, derived? }]. A
 * main direction's id is its direction ("0"/"1"); a variant keeps its own.
 */
const patternsOf = (line) => [
  ...(Array.isArray(line?.directions) ? line.directions : [])
    .filter((d) => d && Array.isArray(d.stops))
    .map((d) => ({ id: str(d.id ?? "0") || "0", direction: str(d.id ?? "0") || "0", stops: d.stops, variant: false, headsign: d.headsign || "", ...(d.derived ? { derived: true } : {}) })),
  ...(Array.isArray(line?.variants) ? line.variants : [])
    .filter((v) => v && Array.isArray(v.stops))
    .map((v) => ({ id: str(v.id), direction: str(v.direction) === "1" ? "1" : "0", stops: v.stops, variant: true, headsign: v.headsign || "" })),
];

/** The patterns a service runs: its variant, else the main directions it names. */
const servicePatterns = (line, svc) => {
  const all = patternsOf(line);
  if (svc && svc.variant) return all.filter((p) => p.variant && p.id === svc.variant);
  const dir = svc && svc.direction ? svc.direction : "both";
  return all.filter((p) => !p.variant && (dir === "both" || dir === p.direction));
};

/** A calendar described by dates as well as days (school period, include/exclude dates). */
const isExplicitCalendar = (cal) => Boolean(cal && (cal.period || (cal.include_dates && cal.include_dates.length) || (cal.exclude_dates && cal.exclude_dates.length)));

const _dateSets = new WeakMap();
const dateSet = (list) => {
  if (!Array.isArray(list) || !list.length) return null;
  let s = _dateSets.get(list);
  if (!s) {
    s = new Set(list);
    _dateSets.set(list, s);
  }
  return s;
};

/**
 * Does a normalised calendar run on a date (YYYYMMDD or YYYY-MM-DD)?
 * Honours its period (start/end), its days, include_dates (added) and
 * exclude_dates (removed). With the spec, a public holiday (spec.holidays)
 * runs like the spec's holiday day type, as the compiler writes it.
 * A school calendar runs on the dates schoolCalendar resolved: the school
 * days are its days minus exclude_dates, the school holidays exactly its
 * include_dates. A school calendar not resolved yet answers null (unknown):
 * pass the spec returned by schoolCalendar.resolveCalendars (or compileSpec).
 * @returns {boolean|null}
 */
const runsOnSpecCalendar = (cal, ymd, spec = null) => {
  const d = str(ymd).replace(/-/g, "");
  if (!cal || !DATE_RE.test(d) || !Array.isArray(cal.days)) return false;
  if ((cal.start_date && d < cal.start_date) || (cal.end_date && d > cal.end_date)) return false;
  const include = dateSet(cal.include_dates);
  const exclude = dateSet(cal.exclude_dates);
  if (cal.period) {
    if (!cal.resolved) return null;
    // Public holidays are already in the resolved dates.
    if (cal.period === "school_holidays") return Boolean(include && include.has(d));
    if (include && include.has(d)) return true;
    if (exclude && exclude.has(d)) return false;
    return cal.days.includes(weekdayOfYmd(d));
  }
  if (include && include.has(d)) return true;
  if (exclude && exclude.has(d)) return false;
  if (spec && Array.isArray(spec.holidays) && spec.holidays.includes(d)) {
    const holidayDay = holidayDayType(spec);
    return holidayDay ? cal.days.includes(holidayDay) : false;
  }
  return cal.days.includes(weekdayOfYmd(d));
};

// ── Normalisation + validation ─────────────────────────────────────────────

const normalizeSpec = (raw, { territory = null } = {}) => {
  const issues = [];
  const err = (code, path, message, extra = {}) => issues.push({ level: "error", code, path, message, ...extra });
  const warn = (code, path, message, extra = {}) => issues.push({ level: "warning", code, path, message, ...extra });
  const input = raw && typeof raw === "object" ? raw : {};

  // Agency.
  const a = input.agency && typeof input.agency === "object" ? input.agency : {};
  const agency = {
    id: str(a.id || a.agency_id) || slug(a.name || a.agency_name || "AGENCY"),
    name: str(a.name || a.agency_name),
    url: str(a.url || a.agency_url),
    timezone: str(a.timezone || a.agency_timezone),
    lang: str(a.lang || a.agency_lang).toLowerCase() || undefined,
    phone: str(a.phone || a.agency_phone) || undefined,
    email: str(a.email || a.agency_email) || undefined,
  };
  if (!agency.name) err("agency_missing_field", "agency.name", "The agency needs a name.", { field: "name" });
  if (!agency.url) err("agency_missing_field", "agency.url", "The agency needs a URL (agency_url).", { field: "url" });
  else if (!/^https?:\/\//i.test(agency.url)) err("agency_invalid_url", "agency.url", "agency_url must start with http:// or https://.");
  if (!agency.timezone) err("agency_missing_field", "agency.timezone", "The agency needs an IANA timezone (e.g. Europe/Paris).", { field: "timezone" });
  else if (!TZ_RE.test(agency.timezone)) err("invalid_timezone", "agency.timezone", `"${agency.timezone}" is not an IANA timezone (e.g. Europe/Paris).`);

  // Feed dates.
  const f = input.feed && typeof input.feed === "object" ? input.feed : {};
  const start = str(f.start_date).replace(/-/g, "") || todayYmd();
  const end = str(f.end_date).replace(/-/g, "") || addYearYmd(start);
  if (!DATE_RE.test(start)) err("invalid_dates", "feed.start_date", "feed.start_date must be YYYYMMDD.");
  if (!DATE_RE.test(end)) err("invalid_dates", "feed.end_date", "feed.end_date must be YYYYMMDD.");
  if (DATE_RE.test(start) && DATE_RE.test(end) && end < start) err("invalid_dates", "feed.end_date", "feed.end_date is before feed.start_date.");
  const feed = {
    start_date: start,
    end_date: end,
    publisher: str(f.publisher) || agency.name,
    publisher_url: str(f.publisher_url) || agency.url,
    version: str(f.version) || `${start}-v1`,
    lang: str(f.lang).toLowerCase() || agency.lang || "en",
  };

  // Stops.
  const stops = [];
  const stopById = new Map();
  const stopByName = new Map();
  const usedIds = new Set();
  const addStop = (s, path, { auto = false } = {}) => {
    const name = str(s.name || s.stop_name);
    if (!name) {
      err("stop_missing_name", path, "A stop needs a name.");
      return null;
    }
    let id = str(s.id || s.stop_id) || slug(name);
    if (usedIds.has(id)) {
      if (str(s.id || s.stop_id)) err("duplicate_stop_id", path, `Stop id "${id}" is used twice.`);
      let n = 2;
      while (usedIds.has(`${id}_${n}`)) n += 1;
      id = `${id}_${n}`;
    }
    usedIds.add(id);
    const lat = num(s.lat ?? s.stop_lat);
    const lon = num(s.lon ?? s.stop_lon);
    if ((lat != null && (lat < -90 || lat > 90)) || (lon != null && (lon < -180 || lon > 180))) err("invalid_coordinates", path, `Stop "${name}" has coordinates out of range.`);
    const stop = {
      id,
      name,
      lat: lat != null && lon != null ? lat : null,
      lon: lat != null && lon != null ? lon : null,
      address: str(s.address) || undefined,
      code: str(s.code || s.stop_code) || undefined,
      wheelchair: s.wheelchair === true || s.wheelchair === 1 || s.wheelchair === "1" ? "1" : undefined,
      auto: auto || undefined,
    };
    stops.push(stop);
    stopById.set(id, stop);
    if (!stopByName.has(nameKey(name))) stopByName.set(nameKey(name), stop);
    return stop;
  };
  (Array.isArray(input.stops) ? input.stops : []).forEach((s, i) => s && typeof s === "object" && addStop(s, `stops[${i}]`));

  const resolveStopRef = (ref, path) => {
    if (ref && typeof ref === "object") {
      const byId = str(ref.id || ref.stop_id);
      if (byId && stopById.has(byId)) return stopById.get(byId);
      const byName = stopByName.get(nameKey(ref.name || ref.stop_name));
      if (byName) return byName;
      const created = addStop(ref, path, { auto: true });
      if (created) warn("stop_auto_created", path, `Stop "${created.name}" was created from the line definition.`, { stopId: created.id });
      return created;
    }
    const key = str(ref);
    if (!key) return null;
    if (stopById.has(key)) return stopById.get(key);
    if (stopByName.has(nameKey(key))) return stopByName.get(nameKey(key));
    const created = addStop({ name: key }, path, { auto: true });
    if (created) warn("stop_auto_created", path, `Stop "${created.name}" was created from the line definition; it needs coordinates.`, { stopId: created.id });
    return created;
  };

  // Calendars.
  const calendars = new Map(); // id -> { id, days, start_date, end_date, period?, region?, include_dates?, exclude_dates? }
  const calendarUse = new Map(); // id -> path of the first service using it
  const silent = { err: () => {}, warn: () => {} };
  /**
   * The date-related fields of a calendar object: a school period (and its
   * zone) or explicit include/exclude dates. null when invalid (reported
   * through `report`; the round-trip path passes a silent one and skips it).
   * The dates of a school calendar are derived (schoolCalendar), never given.
   */
  const calendarExtras = (c, path, sd, ed, report) => {
    let period = null;
    if (c.period != null && str(c.period)) {
      period = parsePeriod(c.period);
      if (!period) {
        report.err("invalid_calendar_period", `${path}.period`, 'period must be "school_days" (school term) or "school_holidays".');
        return null;
      }
    }
    if (!period) {
      if (c.region != null && str(c.region)) report.warn("calendar_region_ignored", `${path}.region`, "region applies to school calendars (period) only; it was ignored.");
      const include = parseDateList(c.include_dates, `${path}.include_dates`, sd, ed, report);
      const exclude = parseDateList(c.exclude_dates, `${path}.exclude_dates`, sd, ed, report);
      if (include === null || exclude === null) return null;
      const both = include.filter((d) => exclude.includes(d));
      if (both.length) {
        report.err("calendar_dates_conflict", path, `${both.join(", ")} both included and excluded.`);
        return null;
      }
      return { ...(include.length ? { include_dates: include } : {}), ...(exclude.length ? { exclude_dates: exclude } : {}) };
    }
    const region = normRegion(c.region ?? c.zone);
    if (region && !REGION_RE.test(region)) {
      report.err("invalid_school_region", `${path}.region`, `"${c.region}" is not a school region code (e.g. "C" for zone C in France, "BY" for Bavaria).`);
      return null;
    }
    // A resolved copy (compileSpec, resolveCalendars) coming back: its dates were derived.
    if (!c.resolved && ((Array.isArray(c.include_dates) && c.include_dates.length) || (Array.isArray(c.exclude_dates) && c.exclude_dates.length))) {
      report.warn("school_calendar_dates_ignored", path, "The dates of a school calendar come from the school holidays of its region; include_dates / exclude_dates were ignored (use a calendar with days and dates instead).");
    }
    return { period, ...(region ? { region } : {}) };
  };
  const sameExtras = (a, b) =>
    (a.period || null) === (b.period || null) && (a.region || null) === (b.region || null) && (a.include_dates || []).join() === (b.include_dates || []).join() && (a.exclude_dates || []).join() === (b.exclude_dates || []).join();
  // A normalised spec round-trips: its calendars[] are registered first so
  // services may refer to them by id (calendar_id).
  // The week follows local practice: spec.weekend (e.g. ["fri", "sat"]) makes
  // "weekday" the other five days and "weekend" these ones.
  const weekendDays = parseDays(input.weekend);
  const weekend = weekendDays && weekendDays.length && weekendDays.length < 7 ? weekendDays : ["sat", "sun"];
  const localDays = (named) => (named.id === "WKD" ? DAY_KEYS.filter((d) => !weekend.includes(d)) : named.id === "WKE" ? weekend : named.days);
  (Array.isArray(input.calendars) ? input.calendars : []).forEach((c) => {
    const id = c && str(c.id);
    let days = c && parseDays(c.days);
    if (!id || !days || !days.length) return;
    // The named local calendars follow the weekend as it is NOW (it may have
    // changed since the spec was normalised).
    if (id === "WKD" || id === "WKE") days = localDays({ id });
    const sd = str(c.start_date).replace(/-/g, "") || feed.start_date;
    const ed = str(c.end_date).replace(/-/g, "") || feed.end_date;
    if (!(DATE_RE.test(sd) && DATE_RE.test(ed) && sd <= ed)) return;
    const extras = calendarExtras(c, `calendars.${id}`, sd, ed, silent);
    if (extras) calendars.set(id, { id, days, start_date: sd, end_date: ed, ...extras });
  });
  const resolveCalendar = (raw, path) => {
    if (typeof raw === "string" || raw == null) {
      if (raw && calendars.has(str(raw))) return calendars.get(str(raw));
      const key = str(raw || "weekday").toLowerCase().replace(/[^a-z]/g, "");
      const named = NAMED_CALENDARS[key] || Object.values(NAMED_CALENDARS).find((c) => c.id.toLowerCase() === key);
      if (!named) {
        err("unknown_calendar", path, `Unknown calendar "${raw}" (use weekday, saturday, sunday, weekend, daily, monsat or {days:[…]}).`);
        return null;
      }
      if (!calendars.has(named.id)) calendars.set(named.id, { id: named.id, days: localDays(named), start_date: feed.start_date, end_date: feed.end_date });
      return calendars.get(named.id);
    }
    if (typeof raw !== "object") return null;
    const days = parseDays(raw.days) || (raw.name && NAMED_CALENDARS[str(raw.name).toLowerCase()] ? NAMED_CALENDARS[str(raw.name).toLowerCase()].days : null);
    if (!days || days.length === 0) {
      err("invalid_calendar_days", path, raw.period ? "A school calendar needs days: [\"mon\", …] (the days it runs within the period)." : "A custom calendar needs days: [\"mon\", …].");
      return null;
    }
    const sd = str(raw.start_date).replace(/-/g, "") || feed.start_date;
    const ed = str(raw.end_date).replace(/-/g, "") || feed.end_date;
    if (!DATE_RE.test(sd) || !DATE_RE.test(ed) || ed < sd) {
      err("invalid_dates", path, "Calendar dates must be YYYYMMDD with start ≤ end.");
      return null;
    }
    const extras = calendarExtras(raw, path, sd, ed, { err, warn });
    if (!extras) return null;
    const same = (c) => c.start_date === sd && c.end_date === ed && c.days.join() === days.join() && sameExtras(c, extras);
    let id;
    if (str(raw.id)) {
      id = slug(raw.id);
      const existing = calendars.get(id);
      if (existing && !same(existing)) {
        err("duplicate_calendar_id", path, `Calendar id "${id}" is used for two different calendars.`);
        return null;
      }
    } else {
      // Days + period: two periods with the same days never share an id.
      // A school calendar reads as its period, zone and days (SCH_C_MonFri).
      const range = sd === feed.start_date && ed === feed.end_date ? "" : `_${sd}`;
      const base = extras.period ? `${SCHOOL_PERIODS[extras.period]}${extras.region ? `_${slug(extras.region)}` : ""}_${daysCode(days)}${range}` : `${days.map((d) => d[0].toUpperCase() + d.slice(1)).join("")}${range}`;
      id = base;
      if (calendars.has(id) && !same(calendars.get(id))) id = `${base}_${ed}`;
      let n = 2;
      while (calendars.has(id) && !same(calendars.get(id))) id = `${base}_${ed}_${n++}`;
    }
    if (!calendars.has(id)) calendars.set(id, { id, days, start_date: sd, end_date: ed, ...extras });
    return calendars.get(id);
  };

  // Lines.
  const lines = [];
  const lineIds = new Set();
  const rawLines = Array.isArray(input.lines) ? input.lines : Array.isArray(input.routes) ? input.routes : [];
  if (rawLines.length === 0) err("no_lines", "lines", "The network needs at least one line.");
  if (rawLines.length > LIMITS.lines) err("too_many_lines", "lines", `At most ${LIMITS.lines} lines per network.`);
  rawLines.forEach((l, li) => {
    if (!l || typeof l !== "object") return;
    const path = `lines[${li}]`;
    const shortName = str(l.short_name || l.route_short_name || l.name || l.number);
    const longName = str(l.long_name || l.route_long_name);
    if (!shortName && !longName) {
      err("line_missing_name", path, "A line needs a short_name (e.g. 12) or a long_name.");
      return;
    }
    let id = str(l.id || l.route_id) || slug(shortName || longName);
    if (lineIds.has(id)) {
      if (str(l.id || l.route_id)) err("duplicate_line_id", path, `Line id "${id}" is used twice.`);
      let n = 2;
      while (lineIds.has(`${id}_${n}`)) n += 1;
      id = `${id}_${n}`;
    }
    lineIds.add(id);
    let mode = resolveMode(l.mode || l.type);
    if (!mode) {
      warn("mode_unknown", `${path}.mode`, `Unknown mode "${l.mode}", using bus.`);
      mode = "bus";
    }
    const modeDef = MODES[mode];
    let color = str(l.color || l.route_color).replace(/^#/, "").toUpperCase();
    if (color && !HEX_RE.test(color)) {
      warn("invalid_color", `${path}.color`, `"${l.color}" is not a 6-digit hex colour; a palette colour is used.`);
      color = "";
    }
    if (!color) color = PALETTE[li % PALETTE.length];
    let textColor = str(l.text_color || l.route_text_color).replace(/^#/, "").toUpperCase();
    if (!HEX_RE.test(textColor)) textColor = textColorFor(color);
    const speed = num(l.speed_kmh) || modeDef.speed_kmh;
    const dwell = num(l.dwell_s) ?? modeDef.dwell_s;
    if (speed <= 0 || speed > 400) err("invalid_speed", `${path}.speed_kmh`, "speed_kmh must be between 1 and 400.");
    // Running times by time of day: the line's commercial speed per band.
    const speedProfile = parseBands(l.speed_profile, `${path}.speed_profile`, { valueKey: "speed_kmh", min: 1, max: 150, code: "invalid_speed", label: "speed_profile" }, err);

    // Directions.
    let rawDirs = Array.isArray(l.directions) ? l.directions : Array.isArray(l.stops) ? [{ id: "0", stops: l.stops, headsign: l.headsign }] : [];
    // A return still marked `derived` (a normalised spec coming back) is the
    // mirror of the outbound: derive it again, so an edited outbound never
    // leaves a stale return behind. Editing the return itself drops the mark.
    if (rawDirs.length === 2 && rawDirs[1] && rawDirs[1].derived === true && l.round_trip !== false) rawDirs = [rawDirs[0]];
    const directions = [];
    rawDirs.slice(0, LIMITS.directions).forEach((d, di) => {
      if (!d || typeof d !== "object") return;
      const dpath = `${path}.directions[${di}]`;
      const refs = Array.isArray(d.stops) ? d.stops : [];
      if (refs.length > LIMITS.stopsPerDirection) err("too_many_stops", dpath, `At most ${LIMITS.stopsPerDirection} stops per direction.`);
      const resolved = [];
      refs.slice(0, LIMITS.stopsPerDirection).forEach((r, si) => {
        const s = resolveStopRef(r, `${dpath}.stops[${si}]`);
        if (s && resolved[resolved.length - 1] !== s.id) resolved.push(s.id);
      });
      if (resolved.length < 2) {
        err("direction_too_short", dpath, `Direction ${di} of line ${shortName || longName} needs at least two distinct stops.`, { line: shortName || longName || null, direction: di });
        return;
      }
      const dirId = str(d.id ?? d.direction_id) === "1" || di === 1 ? "1" : "0";
      directions.push({ id: dirId, headsign: str(d.headsign) || stopById.get(resolved[resolved.length - 1]).name, stops: resolved });
    });
    if (directions.length === 1 && l.round_trip !== false && rawDirs.length <= 1) {
      const d0 = directions[0];
      directions.push({ id: d0.id === "0" ? "1" : "0", headsign: stopById.get(d0.stops[0]).name, stops: [...d0.stops].reverse(), derived: true });
    }
    if (directions.length === 0) err("line_no_directions", path, `Line ${shortName || longName} has no usable direction.`, { line: shortName || longName || null });
    if (directions.length === 2 && directions[0].id === directions[1].id) directions[1].id = directions[0].id === "0" ? "1" : "0";

    // Variants: other stop patterns of the line in one direction — a
    // short-turn, a branch, a deviation. Each has its own id (not 0 or 1,
    // the main directions), at least two distinct stops, and is only run by
    // the services that name it.
    const variants = [];
    const rawVariants = l.variants == null ? [] : Array.isArray(l.variants) ? l.variants : null;
    if (!rawVariants) err("invalid_variants", `${path}.variants`, "variants must be a list of { id, direction, stops }.");
    else if (rawVariants.length > LIMITS.variantsPerLine) err("too_many_variants", `${path}.variants`, `At most ${LIMITS.variantsPerLine} variants per line.`);
    const givenVariantIds = new Set((rawVariants || []).map((v) => (v && typeof v === "object" ? str(v.id) : "")).filter(Boolean));
    (rawVariants || []).slice(0, LIMITS.variantsPerLine).forEach((v, vi) => {
      if (!v || typeof v !== "object") return;
      const vpath = `${path}.variants[${vi}]`;
      let vid = str(v.id);
      if (!vid) {
        let n = 1;
        while (givenVariantIds.has(`V${n}`) || variants.some((x) => x.id === `V${n}`)) n += 1;
        vid = `V${n}`;
      } else if (!VARIANT_ID_RE.test(vid)) return err("invalid_variant_id", `${vpath}.id`, `Variant id "${vid}" must be letters, digits, _ or - (≤ 24 characters).`);
      if (vid === "0" || vid === "1") return err("invalid_variant_id", `${vpath}.id`, `Variant ids "0" and "1" are the line's main directions: name the variant (e.g. "HOSP").`);
      if (variants.some((x) => x.id === vid)) return err("duplicate_variant_id", `${vpath}.id`, `Variant id "${vid}" is used twice on line ${shortName || longName}.`);
      const vdir = str(v.direction ?? v.direction_id);
      if (vdir !== "0" && vdir !== "1") return err("invalid_variant_direction", `${vpath}.direction`, `Variant "${vid}" needs direction "0" or "1" (the main direction it runs in).`);
      const refs = Array.isArray(v.stops) ? v.stops : [];
      if (refs.length > LIMITS.stopsPerDirection) err("too_many_stops", vpath, `At most ${LIMITS.stopsPerDirection} stops per variant.`);
      const resolved = [];
      refs.slice(0, LIMITS.stopsPerDirection).forEach((r, si) => {
        const s = resolveStopRef(r, `${vpath}.stops[${si}]`);
        if (s && resolved[resolved.length - 1] !== s.id) resolved.push(s.id);
      });
      if (new Set(resolved).size < 2) return err("variant_too_short", vpath, `Variant "${vid}" of line ${shortName || longName} needs at least two distinct stops.`);
      variants.push({ id: vid, direction: vdir, headsign: str(v.headsign) || stopById.get(resolved[resolved.length - 1]).name, stops: resolved });
    });

    // Services.
    const services = [];
    const rawServices = Array.isArray(l.services) ? l.services : Array.isArray(l.service) ? l.service : l.services && typeof l.services === "object" ? [l.services] : [];
    if (rawServices.length === 0) err("no_service", `${path}.services`, `Line ${shortName || longName} needs at least one service (calendar + headways or departures).`, { line: shortName || longName || null });
    rawServices.forEach((s, si) => {
      if (!s || typeof s !== "object") return;
      const spath = `${path}.services[${si}]`;
      const cal = resolveCalendar(s.calendar ?? s.calendar_id ?? (Array.isArray(s.days) ? { days: s.days } : undefined), `${spath}.calendar`);
      if (!cal) return;
      if (!calendarUse.has(cal.id)) calendarUse.set(cal.id, `${spath}.calendar`);
      const dir = str(s.direction ?? "both");
      let direction = dir === "0" || dir === "1" ? dir : "both";
      // A service on a variant runs that variant, in its direction.
      const variantRef = str(s.variant ?? s.variant_id);
      let variant = null;
      if (variantRef) {
        variant = variants.find((x) => x.id === variantRef) || null;
        if (!variant) return err("unknown_variant", `${spath}.variant`, `Line ${shortName || longName} has no variant "${variantRef}"${variants.length ? ` (its variants: ${variants.map((x) => x.id).join(", ")})` : ""}.`);
        const given = str(s.direction);
        if (given && given !== variant.direction) return err("variant_direction_conflict", `${spath}.direction`, `The service runs variant "${variant.id}" (direction ${variant.direction}) but says direction "${given}": leave direction out.`);
        direction = variant.direction;
      }
      const periods = [];
      (Array.isArray(s.periods) ? s.periods : Array.isArray(s.headways) ? s.headways : []).forEach((p, pi) => {
        const from = timeToSec(p?.from ?? p?.start);
        const to = timeToSec(p?.to ?? p?.end);
        const headway = num(p?.headway_min ?? p?.every_min ?? p?.headway);
        if (from == null || to == null) return err("invalid_time", `${spath}.periods[${pi}]`, "Period times must be HH:MM.");
        if (to <= from) return err("invalid_period", `${spath}.periods[${pi}]`, "A period must end after it starts.");
        if (!(headway >= 1 && headway <= 720)) return err("invalid_headway", `${spath}.periods[${pi}]`, "headway_min must be between 1 and 720.");
        periods.push({ from: secToTime(from), to: secToTime(to), headway_min: headway });
      });
      const departures = [];
      (Array.isArray(s.departures) ? s.departures : []).forEach((d, di) => {
        const sec = timeToSec(d);
        if (sec == null) return err("invalid_time", `${spath}.departures[${di}]`, `"${d}" is not a HH:MM time.`);
        departures.push(secToTime(sec));
      });
      if (periods.length === 0 && departures.length === 0) return err("no_service", spath, "A service needs periods (headways) or departures.");
      const svc = { calendar_id: cal.id, direction, ...(variant ? { variant: variant.id } : {}), periods, departures: [...new Set(departures)].sort(), reverse_offset_min: num(s.reverse_offset_min) ?? null };
      // The service's own pulse is parsed once every stop is known (below).
      if (s.sync !== undefined) Object.defineProperty(svc, "_rawSync", { value: { raw: s.sync, path: `${spath}.sync` }, enumerable: false });
      services.push(svc);
    });

    // A main direction no service runs (the derived return of a loop meant one way, a return left
    // without periods): the line would run one way only, and every clause measured both ways fails.
    if (services.length) {
      for (const d of directions) {
        if (services.some((s) => s.direction === "both" || s.direction === d.id)) continue;
        const name = shortName || longName;
        const loop = d.stops[0] === d.stops[d.stops.length - 1];
        warn("direction_unserved", `${path}.directions`, loop && d.derived ? `Line ${name}: no service runs the reverse of its loop (direction ${d.id}, derived). A loop served one way: set round_trip: false; both ways: give direction ${d.id} a service.` : `Line ${name}: no service runs direction ${d.id}: no trip will run that way. Give it a service, or set round_trip: false for a one-way line.`, { line: name, direction: d.id });
      }
    }

    lines.push({
      id,
      short_name: shortName || longName.slice(0, 12),
      long_name: longName || (directions.length ? `${stopById.get(directions[0].stops[0]).name} ↔ ${stopById.get(directions[0].stops[directions[0].stops.length - 1]).name}` : shortName),
      description: str(l.description || l.route_desc) || undefined,
      mode,
      route_type: modeDef.route_type,
      color,
      text_color: textColor,
      speed_kmh: speed,
      dwell_s: dwell,
      ...(speedProfile ? { speed_profile: speedProfile } : {}),
      url: str(l.url) || undefined,
      // A one-way line stays one-way when its normalised spec is normalised again (patch_spec, the
      // compiler, a saved spec reloaded): without the flag its single direction would get a derived return.
      ...(l.round_trip === false ? { round_trip: false } : {}),
      directions,
      ...(variants.length ? { variants } : {}),
      services,
    });
  });

  // Running times by time of day, network-wide: a factor on the commercial
  // speed of the road modes (a line's own speed_profile wins). Without a
  // profile the speed is the same all day.
  const runningTimeProfile = parseBands(input.running_time_profile, "running_time_profile", { valueKey: "factor", min: 0.3, max: 1.5, code: "invalid_factor", label: "running_time_profile" }, err);

  // Holidays, transfers.
  const holidays = [];
  (Array.isArray(input.holidays) ? input.holidays : []).forEach((h, i) => {
    const d = str(h).replace(/-/g, "");
    if (!DATE_RE.test(d)) return err("invalid_dates", `holidays[${i}]`, `"${h}" is not a YYYYMMDD date.`);
    if (!holidays.includes(d)) holidays.push(d);
  });
  const holidayService = ["sunday", "none", "saturday"].includes(str(input.holiday_service).toLowerCase()) ? str(input.holiday_service).toLowerCase() : "sunday";
  const transfers = [];
  (Array.isArray(input.transfers) ? input.transfers : []).forEach((t, i) => {
    const from = t && resolveStopRef(t.from, `transfers[${i}].from`);
    const to = t && resolveStopRef(t.to, `transfers[${i}].to`);
    if (!from || !to) return;
    const minutes = num(t.min_minutes);
    transfers.push({ from: from.id, to: to.id, min_minutes: minutes != null && minutes >= 0 ? minutes : 3, type: str(t.type) || "2" });
  });

  // Pulse timetable (optional): every headway service arrives at the hub at
  // the same minute past the hour (mod its headway), so lines meet there.
  //   sync: { stop, minute? }            network-wide default
  //   services[].sync: {…} | false       per-service override / opt-out
  let sync;
  const parseSync = (raw, path) => {
    if (raw === false) return false;
    if (!raw || typeof raw !== "object") return undefined;
    const key = str(raw.stop ?? raw.stop_id ?? raw.hub);
    const stop = stopById.get(key) || stopByName.get(nameKey(key)) || null;
    if (!stop) {
      err("invalid_sync", path, "sync.stop must name a stop of the network.");
      return undefined;
    }
    const minute = num(raw.minute) ?? 0;
    if (minute < 0 || minute > 59) {
      err("invalid_sync", `${path}.minute`, "sync.minute must be between 0 and 59.");
      return undefined;
    }
    return { stop_id: stop.id, minute: Math.round(minute) };
  };
  if (input.sync !== undefined) sync = parseSync(input.sync, "sync");
  lines.forEach((l) => {
    l.services.forEach((s) => {
      if (!s._rawSync) return;
      const parsed = parseSync(s._rawSync.raw, s._rawSync.path);
      if (parsed !== undefined) s.sync = parsed;
    });
  });

  // Operations (optional): what running the network costs, and the caps the
  // brief imposes. Kept as given; the operations estimate reads them.
  let operations;
  if (input.operations && typeof input.operations === "object") {
    const o = input.operations;
    const nonNeg = (v, path) => {
      const n = num(v);
      if (n != null && n < 0) err("invalid_operations", path, "Operations figures must be ≥ 0.");
      return n != null && n >= 0 ? n : undefined;
    };
    const pct = (v, path) => {
      const n = num(v);
      if (n != null && (n < 0 || n > 100)) err("invalid_operations", path, "A percentage must be between 0 and 100.");
      return n != null && n >= 0 && n <= 100 ? n : undefined;
    };
    const currency = str(o.currency).toUpperCase();
    let costPerKm;
    if (o.cost_per_km && typeof o.cost_per_km === "object") {
      costPerKm = {};
      for (const [k, v] of Object.entries(o.cost_per_km)) {
        const n = nonNeg(v, `operations.cost_per_km.${k}`);
        if (n != null) costPerKm[k] = n;
      }
    } else costPerKm = nonNeg(o.cost_per_km, "operations.cost_per_km");
    operations = {
      currency: /^[A-Z]{3}$/.test(currency) ? currency : undefined,
      cost_per_km: costPerKm,
      cost_per_hour: nonNeg(o.cost_per_hour, "operations.cost_per_hour"),
      // A vehicle's yearly cost (depreciation, insurance) when the €/km ratio leaves it out.
      cost_per_vehicle_year: nonNeg(o.cost_per_vehicle_year, "operations.cost_per_vehicle_year"),
      // Empty running (depot ↔ termini) as a share of the commercial kilometres.
      deadhead_pct: pct(o.deadhead_pct, "operations.deadhead_pct"),
      // Vehicles kept in reserve (maintenance, breakdowns) as a share of the peak fleet.
      reserve_pct: pct(o.reserve_pct, "operations.reserve_pct"),
      // The contract's commercial kilometres per year, compared with the estimate.
      commercial_km_contract: nonNeg(o.commercial_km_contract, "operations.commercial_km_contract"),
      layover_min: nonNeg(o.layover_min, "operations.layover_min"),
      max_vehicles: nonNeg(o.max_vehicles, "operations.max_vehicles"),
      max_cost_year: nonNeg(o.max_cost_year, "operations.max_cost_year"),
    };
    for (const k of Object.keys(operations)) if (operations[k] === undefined) delete operations[k];
  }

  // Coordinates: the blockers.
  const unresolved = stops.filter((s) => s.lat == null);
  for (const s of unresolved) err("stop_needs_coordinates", `stops.${s.id}`, `Stop "${s.name}" has no coordinates.`, { stopId: s.id, stopName: s.name, address: s.address || null });
  if (stops.length > LIMITS.stops) err("too_many_stops", "stops", `At most ${LIMITS.stops} stops per network.`);
  const served = new Set(lines.flatMap((l) => patternsOf(l).flatMap((p) => p.stops)));
  const unused = stops.filter((s) => !served.has(s.id));
  for (const s of unused) warn("stop_unused", `stops.${s.id}`, `Stop "${s.name}" is not served by any line.`, { stopId: s.id, stopName: s.name });

  // School calendars: where the zones' holidays differ, the zone is part of
  // the calendar. The territory (when given) says whether they differ; the
  // dates themselves are resolved at build time (schoolCalendar).
  const schoolCalendars = [...calendars.values()].filter((c) => c.period && calendarUse.has(c.id));
  if (schoolCalendars.length) {
    const school = territory ? require("./schoolCalendar") : null;
    const country = territory?.place?.country_code || null;
    const known = school ? school.schoolRegions(territory) : [];
    const regional = school ? school.isRegional(territory) : false;
    const noData = Boolean(territory) && !(Array.isArray(territory.school_holidays) && territory.school_holidays.length);
    for (const c of schoolCalendars) {
      const at = calendarUse.get(c.id);
      if (noData) warn("school_holidays_unavailable", at, `The territory has no school holidays${country ? ` for ${country}` : ""}: the build fetches them (OpenHolidays) or fails; a calendar with days and dates (include_dates/exclude_dates) avoids it.`, { calendarId: c.id });
      if (!c.region) {
        if (!territory) warn("school_region_unknown", at, `School calendar ${c.id} has no region: set it (the school zone, e.g. "C") where school holidays differ by region; it is checked at build time.`, { calendarId: c.id });
        else if (regional) err("school_region_needed", at, `School holidays differ by region${country ? ` in ${country}` : ""}: set the calendar's region (${known.join(", ")}).`, { calendarId: c.id, regions: known });
      } else if (regional && !school.regionKnown(territory, c.region)) err("unknown_school_region", at, `No school region "${c.region}" in the territory's school holidays (${known.join(", ")}).`, { calendarId: c.id, regions: known });
    }
  }

  const spec = {
    version: 1,
    agency,
    feed,
    stops,
    lines,
    calendars: [...calendars.values()],
    holidays,
    holiday_service: holidayService,
    transfers,
    ...(runningTimeProfile ? { running_time_profile: runningTimeProfile } : {}),
    ...(weekend.join() !== "sat,sun" ? { weekend } : {}),
    ...(sync ? { sync } : {}),
    ...(operations ? { operations } : {}),
    // Where the spec comes from (e.g. { kind: "simplified_import", … }): kept as given.
    ...(input.origin && typeof input.origin === "object" && typeof input.origin.kind === "string" ? { origin: input.origin } : {}),
  };
  const estimate = estimateSpec(spec);
  if (estimate.trips > LIMITS.trips) err("too_many_trips", "lines", `The network would have ${estimate.trips} trips; the limit is ${LIMITS.trips}. Reduce the periods or headways.`);
  const blockers = issues.filter((i) => i.level === "error");
  return { spec, issues, blockers, estimate, ok: blockers.length === 0 };
};

// ── Estimate (no network) ──────────────────────────────────────────────────

const departuresOf = (service) => {
  const times = new Set(service.departures.map(timeToSec));
  for (const p of service.periods) {
    const from = timeToSec(p.from);
    const to = timeToSec(p.to);
    const step = Math.round(p.headway_min * 60);
    for (let t = from; t <= to; t += step) times.add(t);
  }
  return [...times].filter((t) => t != null).sort((a, b) => a - b);
};

const estimateSpec = (spec) => {
  let trips = 0;
  let stopTimes = 0;
  const perLine = [];
  for (const line of spec.lines || []) {
    let lineTrips = 0;
    let lineStopTimes = 0;
    for (const svc of line.services || []) {
      const deps = departuresOf(svc).length;
      // Each pattern the service runs: its main directions, or its variant.
      for (const p of servicePatterns(line, svc)) {
        lineTrips += deps;
        lineStopTimes += deps * p.stops.length;
      }
    }
    trips += lineTrips;
    stopTimes += lineStopTimes;
    const nVariants = (line.variants || []).length;
    perLine.push({ id: line.id, short_name: line.short_name, trips: lineTrips, stops: new Set(patternsOf(line).flatMap((p) => p.stops)).size, directions: (line.directions || []).length, ...(nVariants ? { variants: nVariants } : {}) });
  }
  return {
    lines: (spec.lines || []).length,
    stops: (spec.stops || []).length,
    stops_without_coordinates: (spec.stops || []).filter((s) => s.lat == null).length,
    calendars: (spec.calendars || []).length,
    trips,
    stop_times: stopTimes,
    per_line: perLine,
  };
};

/** Fill coordinates of stops from a map { stopId: {lat, lon} }. Returns the count applied. */
const applyCoordinates = (spec, coords) => {
  let n = 0;
  for (const s of spec.stops || []) {
    const c = coords && coords[s.id];
    if (c && Number.isFinite(c.lat) && Number.isFinite(c.lon)) {
      s.lat = c.lat;
      s.lon = c.lon;
      n += 1;
    }
  }
  return n;
};

module.exports = {
  normalizeSpec,
  estimateSpec,
  applyCoordinates,
  departuresOf,
  patternsOf,
  servicePatterns,
  runsOnSpecCalendar,
  isExplicitCalendar,
  holidayDayType,
  MODES,
  NAMED_CALENDARS,
  LIMITS,
  ROAD_MODES,
  SCHOOL_PERIODS,
  _internals: { timeToSec, secToTime, slug, nameKey, textColorFor, resolveMode, parseDays, hhmm, isYmd, weekdayOfYmd, daysCode, normRegion, parseBands },
};
