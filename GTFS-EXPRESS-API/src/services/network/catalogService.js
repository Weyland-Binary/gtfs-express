/**
 * catalogService — the network that already runs.
 *
 *   findFeeds(territory, { fetchImpl })       → the public GTFS feeds of the
 *                                               Mobility Database catalog whose
 *                                               box covers the territory
 *   importFeed(url, { fetchImpl })            → download the zip, read the
 *                                               tables (bounded), and turn them
 *                                               into a Network Spec:
 *                                               specFromTables(tables)
 *   specFromTables(tables, opts)              → lines (the dominant stop
 *                                               sequence of each route and
 *                                               direction), stops, calendars,
 *                                               explicit departures — the
 *                                               existing network as a
 *                                               SIMPLIFIED plan the studio can
 *                                               score and compare against,
 *                                               with what the simplification
 *                                               loses (`losses`, `warnings`)
 *
 * The simplified import is a BASELINE for a redesign, never a way to change
 * the network that runs: projecting it would replace the operator's real
 * timetables (every variant, exception and running time). The spec carries
 * `origin: { kind: "simplified_import", url, name, imported_at, losses }`
 * so the compile endpoint and the planner refuse to build it unasked; the
 * faithful path is feedSessionService.openFeedAsSession (the feed as it is,
 * for the Change Studio).
 *
 * The catalog CSV is cached for a day. Downloads are capped in size and
 * rows; a feed larger than the studio's limits comes back truncated with a
 * warning rather than failing. Everything is injectable for tests.
 */

"use strict";

const { safeFetch, assertPublicUrl } = require("../../utils/safeFetch");

const path = require("path");
const os = require("os");
const fsp = require("fs/promises");
const crypto = require("crypto");
const unzipper = require("unzipper");
const config = require("../../config");
const { LIMITS, MODES } = require("./networkSpec");
const { runningTimes } = require("./timetable");
const { haversineMeters } = require("../../utils/geoUtils");
// The compiler's straight-line fallback: crow-fly distance × this factor.
const { DETOUR_FACTOR } = require("./roadRouter")._internals;

const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 60000;
const MAX_ZIP_BYTES = 80 * 1024 * 1024;
const MAX_ENTRY_BYTES = 600 * 1024 * 1024;
const MAX_FEEDS = 12;
const MAX_STOP_TIMES_ROWS = 2_000_000;
const MAX_OTHER_ROWS = 500_000;

/** The rows of a CSV file, streamed, at most `cap` (then truncated: true). */
const readCsvCapped = (file, cap) =>
  new Promise((resolve, reject) => {
    const fs = require("fs");
    if (!fs.existsSync(file)) return resolve({ rows: [], truncated: false });
    const csv = require("csv-parser");
    const rows = [];
    let truncated = false;
    const src = fs.createReadStream(file);
    const parser = csv({ mapHeaders: ({ header }) => header.replace(/^\uFEFF/, "").trim() });
    parser.on("data", (r) => {
      if (rows.length < cap) rows.push(r);
      else if (!truncated) {
        truncated = true;
        src.destroy();
        resolve({ rows, truncated });
      }
    });
    parser.on("end", () => resolve({ rows, truncated }));
    parser.on("error", reject);
    src.on("error", (err) => (truncated ? null : reject(err)));
    src.pipe(parser);
  });
/**
 * shapes.txt as compact point lists (a Map shape_id → { seq, lat, lon }
 * number arrays), at most `cap` points; beyond, truncated: true and the
 * shapes are not used (a cut shape would give a wrong length).
 */
const MAX_SHAPE_POINTS = 2_000_000;
const readShapesCompact = (file, cap) =>
  new Promise((resolve, reject) => {
    const fs = require("fs");
    const shapes = new Map();
    if (!fs.existsSync(file)) return resolve({ shapes, points: 0, truncated: false });
    const csv = require("csv-parser");
    let points = 0;
    let done = false;
    const src = fs.createReadStream(file);
    const parser = csv({ mapHeaders: ({ header }) => header.replace(/^﻿/, "").trim() });
    const finish = (truncated) => {
      if (done) return;
      done = true;
      resolve({ shapes: truncated ? new Map() : shapes, points, truncated });
    };
    parser.on("data", (r) => {
      if (done) return;
      const lat = Number(r.shape_pt_lat);
      const lon = Number(r.shape_pt_lon);
      const seq = Number(r.shape_pt_sequence);
      if (!r.shape_id || !Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(seq)) return;
      if (points >= cap) {
        src.destroy();
        return finish(true);
      }
      let s = shapes.get(r.shape_id);
      if (!s) {
        s = { seq: [], lat: [], lon: [] };
        shapes.set(r.shape_id, s);
      }
      s.seq.push(seq);
      s.lat.push(lat);
      s.lon.push(lon);
      points += 1;
    });
    parser.on("end", () => finish(false));
    parser.on("error", (err) => (done ? null : reject(err)));
    src.on("error", (err) => (done ? null : reject(err)));
    src.pipe(parser);
  });
const MAX_DEPARTURES_PER_SERVICE = 400;
const NEEDED = new Set(["agency.txt", "routes.txt", "trips.txt", "stops.txt", "stop_times.txt", "calendar.txt", "calendar_dates.txt", "frequencies.txt", "shapes.txt"]);
const ROUTE_TYPE_MODE = { 0: "tram", 1: "metro", 2: "rail", 3: "bus", 4: "ferry", 5: "cable", 6: "gondola", 7: "funicular", 11: "trolleybus", 12: "monorail" };

let _catalog = null; // { at, rows }

const withTimeout = async (fetchImpl, url, init = {}, ms = FETCH_TIMEOUT_MS) => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetchImpl(url, { ...init, signal: ctl.signal, headers: { "User-Agent": "gtfs-express/1.0 (network studio)", ...(init.headers || {}) } });
  } finally {
    clearTimeout(timer);
  }
};

/** A small RFC 4180 parser: the catalog has quoted fields with commas and newlines. */
const parseCsvText = (text) => {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.replace(/^﻿/, "").trim());
  return rows.slice(1).filter((r) => r.length > 1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
};

const loadCatalog = async (fetchImpl, { force = false } = {}) => {
  if (_catalog && !force && Date.now() - _catalog.at < CATALOG_TTL_MS) return _catalog.rows;
  const res = await withTimeout(fetchImpl, config.MOBILITY_CATALOG_URL);
  if (!res.ok) throw Object.assign(new Error(`Catalog: HTTP ${res.status}`), { status: 502, code: "CATALOG_UNAVAILABLE" });
  const text = await res.text();
  const rows = parseCsvText(text)
    .filter((r) => (r.data_type || "").toLowerCase() === "gtfs" && !/deprecated|inactive/i.test(r.status || "") && !r["urls.authentication_type"]?.match(/^[12]$/))
    .map((r) => ({
      id: r.mdb_source_id,
      provider: r.provider || "",
      name: r.name || "",
      country: r["location.country_code"] || "",
      region: r["location.subdivision_name"] || "",
      municipality: r["location.municipality"] || "",
      url: r["urls.latest"] || r["urls.direct_download"] || "",
      direct: r["urls.direct_download"] || "",
      license: r["urls.license"] || "",
      bbox: [Number(r["location.bounding_box.minimum_latitude"]), Number(r["location.bounding_box.minimum_longitude"]), Number(r["location.bounding_box.maximum_latitude"]), Number(r["location.bounding_box.maximum_longitude"])],
      extracted_on: r["location.bounding_box.extracted_on"] || null,
    }))
    .filter((r) => r.url && r.bbox.every(Number.isFinite));
  _catalog = { at: Date.now(), rows };
  return rows;
};

const bboxArea = (b) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
const contains = (b, lat, lon) => lat >= b[0] && lat <= b[2] && lon >= b[1] && lon <= b[3];
const intersects = (a, b) => !(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]);
// The catalog's boxes are extracted automatically and some are wrong: a
// corner at (0, 0), inverted, or spanning a continent. Such a box "covers"
// every town and would bury the real local network.
const LOCAL_AREA_DEG2 = 2; // an urban or departmental network
const REGIONAL_AREA_DEG2 = 30; // a region
const MAX_AREA_DEG2 = 150; // beyond: continental or broken, unless named after the place
const degenerateBox = (b) => (b[0] === 0 && b[1] === 0) || (b[2] === 0 && b[3] === 0) || b[2] <= b[0] || b[3] <= b[1] || b[0] < -90 || b[2] > 90 || b[1] < -180 || b[3] > 180;
const scopeOf = (area) => (area <= LOCAL_AREA_DEG2 ? "local" : area <= REGIONAL_AREA_DEG2 ? "regional" : "national");
const fold = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Feeds covering the territory, most relevant first.
 *
 * France: the National Access Point (panCatalog: every published GTFS, the
 * area it officially covers, its validity, whether its stops serve the
 * place), then the Mobility Database feeds it does not already publish
 * (the database mirrors many access-point files, sometimes years old).
 * Elsewhere, or when the access point cannot be read: the Mobility
 * Database alone — the feeds named after the place (provider, name or
 * municipality), then those covering its centre, then the smallest areas;
 * only the territory's country, no broken boxes.
 *
 *   findFeedsDetailed(territory) → { feeds, sources: { pan, mdb }, codes }
 *   findFeeds(territory)         → feeds
 */
const MAX_ALL_FEEDS = 30;
// A Mobility Database entry copied from the French access point.
const mirrorsAccessPoint = (r) => /transport[.-]data[.-]gouv[.-]fr/i.test(`${r.license} ${r.direct} ${r.url}`);

const findFeedsDetailed = async (territory, { fetchImpl = null, force = false } = {}) => {
  const doFetch = fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (!doFetch) throw Object.assign(new Error("No fetch implementation."), { status: 500 });
  const countryCode = String(territory.place.country_code || "").toUpperCase();
  const sources = { pan: null, mdb: null };
  let pan = null;
  if (countryCode === "FR") {
    try {
      pan = await require("./panCatalog").findPanFeeds(territory.place, { fetchImpl: doFetch });
      sources.pan = { ok: true, count: pan.feeds.length };
    } catch (err) {
      sources.pan = { ok: false, error: err.message };
    }
  }
  let mdb = [];
  try {
    mdb = await mdbFeeds(territory, doFetch, { force });
    if (pan) mdb = mdb.filter((f) => !mirrorsAccessPoint(f));
    sources.mdb = { ok: true, count: mdb.length };
  } catch (err) {
    sources.mdb = { ok: false, error: err.message };
    if (!pan) throw err;
  }
  const feeds = [...(pan ? pan.feeds : []), ...mdb].slice(0, MAX_ALL_FEEDS);
  return { feeds, sources, codes: pan?.codes || null };
};

const findFeeds = async (territory, opts = {}) => (await findFeedsDetailed(territory, opts)).feeds;

// The Mobility Database entries covering the territory (see findFeedsDetailed).
const mdbFeeds = async (territory, doFetch, { force = false } = {}) => {
  const rows = await loadCatalog(doFetch, { force });
  const { lat, lon, bbox } = territory.place;
  const country = String(territory.place.country_code || "").toUpperCase();
  const placeName = fold(territory.place.name);
  const named = (r) => placeName.length >= 3 && ` ${fold(`${r.provider} ${r.name} ${r.municipality}`)} `.includes(` ${placeName} `);
  const hits = rows
    .filter((r) => !degenerateBox(r.bbox))
    .filter((r) => !country || !r.country || r.country.toUpperCase() === country)
    .filter((r) => contains(r.bbox, lat, lon) || intersects(r.bbox, bbox))
    .map((r) => {
      const area = bboxArea(r.bbox);
      return { ...r, source: "mdb", status: "unknown", snapshot: r.extracted_on ? String(r.extracted_on).slice(0, 10) : null, area_deg2: Math.round(area * 1000) / 1000, covers_centre: contains(r.bbox, lat, lon), named: named(r), scope: scopeOf(area) };
    })
    .filter((r) => r.area_deg2 <= MAX_AREA_DEG2 || r.named)
    .sort((a, b) => Number(b.named) - Number(a.named) || Number(b.covers_centre) - Number(a.covers_centre) || a.area_deg2 - b.area_deg2)
    .slice(0, MAX_FEEDS);
  return hits;
};

/** Download a GTFS zip (bounded) and read the tables the reverse compiler needs. */
// Test seam: a fetch that replaces the guarded download (tests only).
const transport = { fetchImpl: null };

const downloadTables = async (url, { fetchImpl = null } = {}) => {
  // The url comes from a user or from the model: public internet only.
  assertPublicUrl(url);
  const injected = fetchImpl || transport.fetchImpl;
  const res = injected ? await withTimeout(injected, url) : await safeFetch(url, { timeoutMs: FETCH_TIMEOUT_MS, deadlineMs: 3 * FETCH_TIMEOUT_MS, maxBytes: MAX_ZIP_BYTES });
  if (!res.ok) throw Object.assign(new Error(`Feed download: HTTP ${res.status}`), { status: 502, code: "FEED_UNAVAILABLE" });
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_ZIP_BYTES) throw Object.assign(new Error(`The feed is larger than ${Math.round(MAX_ZIP_BYTES / 1e6)} MB.`), { status: 413, code: "FEED_TOO_LARGE" });
  const dir = path.join(os.tmpdir(), `gtfs-catalog-${crypto.randomUUID()}`);
  await fsp.mkdir(dir, { recursive: true });
  try {
    const zip = await unzipper.Open.buffer(buf);
    // The bytes really decompressed are counted (a zip may declare any size).
    let total = 0;
    const tooLarge = () => Object.assign(new Error("The feed decompresses beyond the allowed size."), { status: 413, code: "FEED_TOO_LARGE" });
    for (const entry of zip.files) {
      const name = path.basename(entry.path);
      if (entry.type !== "File" || !NEEDED.has(name)) continue;
      await new Promise((resolve, reject) => {
        const out = require("fs").createWriteStream(path.join(dir, name));
        const src = entry.stream();
        src.on("data", (c) => {
          total += c.length;
          if (total > MAX_ENTRY_BYTES) src.destroy(tooLarge());
        });
        src.on("error", (err) => {
          out.destroy();
          reject(err);
        });
        out.on("error", reject);
        out.on("finish", resolve);
        src.pipe(out);
      });
    }
    // Rows are read as a stream and capped while reading, not after.
    const tables = {};
    for (const name of NEEDED) {
      const file = path.join(dir, name);
      // Shapes only give the lines' lengths: compact, and dropped whole beyond the cap.
      if (name === "shapes.txt") {
        const s = await readShapesCompact(file, MAX_SHAPE_POINTS);
        tables.shapes = s.shapes;
        if (s.truncated) tables._shapes_truncated = true;
        continue;
      }
      const cap = name === "stop_times.txt" ? MAX_STOP_TIMES_ROWS : MAX_OTHER_ROWS;
      const { rows, truncated } = await readCsvCapped(file, cap);
      tables[name.replace(".txt", "")] = rows;
      if (truncated) {
        if (name !== "stop_times.txt") throw Object.assign(new Error(`${name} has more than ${cap} rows.`), { status: 413, code: "FEED_TOO_LARGE" });
        tables._truncated = true;
      }
    }
    return tables;
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
};

const secOf = (t) => {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(t || "").trim());
  return m ? parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + (m[3] ? parseInt(m[3], 10) : 0) : null;
};
const hhmm = (s) => `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
const DAY_COLS = [["monday", "mon"], ["tuesday", "tue"], ["wednesday", "wed"], ["thursday", "thu"], ["friday", "fri"], ["saturday", "sat"], ["sunday", "sun"]];
const WEEK = DAY_COLS.map(([, d]) => d);
const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]; // Date#getUTCDay order
const DAY_MS = 86400000;
const DATE_RE = /^\d{8}$/;
const ymdMs = (d) => Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8));
const ymdOf = (ms) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");
const weekdayOf = (d) => DAY_KEYS[new Date(ymdMs(d)).getUTCDay()];
const daysBetween = (a, b) => Math.round((ymdMs(b) - ymdMs(a)) / DAY_MS);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

// ── Calendars: what each service really runs, as weekly periods ───────────

// A gap of more than a week without service starts a new period (school
// holidays, seasons); a service keeps at most MAX_PERIODS of them.
const PERIOD_GAP_DAYS = 8;
const MAX_PERIODS = 8;
// A calendar declared over more than three years is not walked day by day: kept as declared.
const MAX_SPAN_DAYS = 1100;
// The holiday rules the compiler knows (compiler.holidayDayType): the day type a holiday runs like.
const HOLIDAY_RULES = [["sunday", "sun"], ["none", null], ["saturday", "sat"]];

/**
 * The feed's service calendars as GTFS defines them: calendar.txt's
 * weekdays over its dates, a removal (calendar_dates type 2) or an
 * addition (type 1) overriding the date.
 */
const serviceCalendars = (tables) => {
  const base = new Map();
  for (const c of tables.calendar || []) {
    const days = DAY_COLS.filter(([col]) => c[col] === "1").map(([, d]) => d);
    base.set(c.service_id, { days, start: String(c.start_date || "").trim(), end: String(c.end_date || "").trim() });
  }
  const adds = new Map();
  const removes = new Map();
  const rows = [];
  for (const d of tables.calendar_dates || []) {
    const type = String(d.exception_type).trim();
    if (!DATE_RE.test(d.date || "") || (type !== "1" && type !== "2")) continue;
    const m = type === "1" ? adds : removes;
    if (!m.has(d.service_id)) m.set(d.service_id, new Set());
    m.get(d.service_id).add(d.date);
    rows.push({ service: d.service_id, date: d.date, type });
  }
  const valid = (b) => b && b.days.length && DATE_RE.test(b.start) && DATE_RE.test(b.end) && b.end >= b.start;
  const longRunning = (sid) => {
    const b = base.get(sid);
    return valid(b) && daysBetween(b.start, b.end) > MAX_SPAN_DAYS ? b : null;
  };
  const activeOn = (sid, d) => {
    if (adds.get(sid)?.has(d)) return true;
    if (removes.get(sid)?.has(d)) return false;
    const b = base.get(sid);
    return Boolean(valid(b) && d >= b.start && d <= b.end && b.days.includes(weekdayOf(d)));
  };
  const cache = new Map();
  /** The dates a service runs, sorted (null for a long-running calendar kept as declared). */
  const datesOf = (sid) => {
    if (cache.has(sid)) return cache.get(sid);
    let out = null;
    if (!longRunning(sid)) {
      const set = new Set(adds.get(sid) || []);
      const b = base.get(sid);
      if (valid(b)) for (let t = ymdMs(b.start); t <= ymdMs(b.end); t += DAY_MS) if (activeOn(sid, ymdOf(t))) set.add(ymdOf(t));
      out = [...set].filter((d) => activeOn(sid, d)).sort();
    }
    cache.set(sid, out);
    return out;
  };
  return { base, rows, activeOn, datesOf, longRunning, datesOnly: (sid) => !base.has(sid) };
};

/** The weekdays of a run of dates: each kept when the service runs on at least half of its occurrences (the fewest wrong dates). */
const weeklyDays = (dates) => {
  const count = new Map();
  for (const d of dates) count.set(weekdayOf(d), (count.get(weekdayOf(d)) || 0) + 1);
  const occurs = new Map();
  for (let t = ymdMs(dates[0]); t <= ymdMs(dates[dates.length - 1]); t += DAY_MS) {
    const w = DAY_KEYS[new Date(t).getUTCDay()];
    occurs.set(w, (occurs.get(w) || 0) + 1);
  }
  const days = WEEK.filter((w) => (count.get(w) || 0) >= Math.max(1, (occurs.get(w) || 0) / 2));
  return days.length ? days : [[...count.entries()].sort((a, b) => b[1] - a[1])[0][0]];
};

/** A service as the spec can say it: weekly periods { days, start, end }, split where it stops for more than a week. */
const periodsOf = (sc, sid, maxPeriods) => {
  const long = sc.longRunning(sid);
  if (long) return [{ days: long.days, start: long.start, end: long.end }];
  const dates = sc.datesOf(sid);
  if (!dates || !dates.length) return [];
  const runs = [];
  for (const d of dates) {
    const cur = runs[runs.length - 1];
    if (cur && daysBetween(cur[cur.length - 1], d) <= PERIOD_GAP_DAYS) cur.push(d);
    else runs.push([d]);
  }
  // Too many periods: the closest merge first (the shortest gaps).
  const gap = (i) => daysBetween(runs[i][runs[i].length - 1], runs[i + 1][0]);
  while (runs.length > maxPeriods) {
    let best = 0;
    for (let i = 1; i < runs.length - 1; i++) if (gap(i) < gap(best)) best = i;
    runs.splice(best, 2, [...runs[best], ...runs[best + 1]]);
  }
  return runs.map((r) => ({ days: weeklyDays(r), start: r[0], end: r[r.length - 1] }));
};

/** Whether the plan runs a service on a date: its period covering the date, holidays by the compiler's rule. */
const planRunsOn = (periods, d, holidaySet, holidayDay) => {
  const p = periods.find((x) => d >= x.start && d <= x.end);
  if (!p) return false;
  if (holidaySet && holidaySet.has(d)) return holidayDay ? p.days.includes(holidayDay) : false;
  return p.days.includes(weekdayOf(d));
};

/**
 * Public holidays the feed treats as holidays: a holiday is carried (spec
 * holidays + holiday_service) when the compiler's rule reproduces what the
 * services really run on it better than the weekly calendars alone — e.g.
 * (almost) every weekday service removed that day. The rule (like Sunday,
 * no service, like Saturday) is the one that reproduces the most.
 */
const carryHolidays = (sc, periodsBySid, holidays, span) => {
  const dates = [...new Set((holidays || []).map((h) => String((h && typeof h === "object" ? h.date : h) || "").replace(/-/g, "")).filter((d) => DATE_RE.test(d)))]
    .filter((d) => !span || (d >= span[0] && d <= span[1]))
    .sort();
  if (!dates.length || !periodsBySid.size) return { holidays: [], rule: null };
  let best = null;
  for (const [rule, day] of HOLIDAY_RULES) {
    let wrong = 0;
    const carried = [];
    for (const h of dates) {
      let plain = 0;
      let asHoliday = 0;
      const only = new Set([h]);
      for (const [sid, periods] of periodsBySid) {
        const truth = sc.activeOn(sid, h);
        if (planRunsOn(periods, h, null, null) !== truth) plain += 1;
        if (planRunsOn(periods, h, only, day) !== truth) asHoliday += 1;
      }
      if (asHoliday < plain) {
        carried.push(h);
        wrong += asHoliday;
      } else wrong += plain;
    }
    if (!best || wrong < best.wrong) best = { rule, wrong, holidays: carried };
  }
  return best.holidays.length ? { holidays: best.holidays, rule: best.rule } : { holidays: [], rule: null };
};

// ── Running times: the observed ones, as far as one speed per line allows ─

// Commercial speeds outside these bounds say the feed's times are wrong (0-minute trips…).
const MIN_PLAUSIBLE_KMH = 3;
const maxPlausibleKmh = (mode) => (["rail", "train", "metro", "subway", "monorail"].includes(mode) ? 320 : 130);

/** A shape as ordered [lat, lon] points, from the compact reader's Map or plain rows (tests). */
const shapeIndex = (tables) => {
  const src = tables.shapes;
  let grouped = null;
  const cache = new Map();
  return (id) => {
    if (!src || !id) return null;
    if (cache.has(id)) return cache.get(id);
    let pts = null;
    if (src instanceof Map) {
      const s = src.get(id);
      if (s) pts = s.seq.map((_, i) => i).sort((a, b) => s.seq[a] - s.seq[b]).map((i) => [s.lat[i], s.lon[i]]);
    } else if (Array.isArray(src)) {
      if (!grouped) {
        grouped = new Map();
        for (const r of src) {
          const lat = Number(r.shape_pt_lat);
          const lon = Number(r.shape_pt_lon);
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
          if (!grouped.has(r.shape_id)) grouped.set(r.shape_id, []);
          grouped.get(r.shape_id).push({ seq: Number(r.shape_pt_sequence), lat, lon });
        }
      }
      const rows = grouped.get(id);
      if (rows) pts = [...rows].sort((a, b) => a.seq - b.seq).map((r) => [r.lat, r.lon]);
    }
    cache.set(id, pts && pts.length >= 2 ? pts : null);
    return cache.get(id);
  };
};

/** Length (m) of a shape between the points nearest its first and last stops; null when it does not pass by them. */
const lengthAlongShape = (pts, first, last) => {
  if (!pts) return null;
  const n = pts.length;
  const cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + haversineMeters(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]));
  const nearest = (s, from, to) => {
    let at = from;
    let best = Infinity;
    for (let i = from; i < to; i++) {
      const d = haversineMeters(s.lat, s.lon, pts[i][0], pts[i][1]);
      if (d < best) {
        best = d;
        at = i;
      }
    }
    return { i: at, d: best };
  };
  // A loop starts and ends at the same place: its start in the first half, its end in the second.
  const loop = haversineMeters(first.lat, first.lon, last.lat, last.lon) < 300;
  const a = nearest(first, 0, loop ? Math.ceil(n / 2) : n);
  const b = nearest(last, loop ? Math.floor(n / 2) : a.i, n);
  if (a.d > 400 || b.d > 400) return null;
  const len = cum[b.i] - cum[a.i];
  return len > 0 ? len : null;
};

/**
 * The leg lengths the compiler will measure: straight lines × the detour
 * factor with the straight-line router; along the roads otherwise — the
 * operator's own shape when it has one (legs in proportion), the
 * straight-line estimate when it has none or it does not fit the stops.
 */
const legLengths = (stops, { routing, shape }) => {
  const crow = [];
  for (let i = 1; i < stops.length; i++) crow.push(haversineMeters(stops[i - 1].lat, stops[i - 1].lon, stops[i].lat, stops[i].lon));
  const crowSum = crow.reduce((a, b) => a + b, 0);
  const straight = crow.map((d) => d * DETOUR_FACTOR);
  if (routing !== "road" || !shape || crowSum <= 0) return { legs: straight, basis: "straight" };
  const along = lengthAlongShape(shape, stops[0], stops[stops.length - 1]);
  if (!along || along < 0.8 * crowSum || along > 3 * crowSum) return { legs: straight, basis: "straight" };
  return { legs: crow.map((d) => (d / crowSum) * along), basis: "shape" };
};

/**
 * One commercial speed (and dwell) for a line so that the compiler
 * reproduces the observed median running time of each kept direction:
 * each direction's own speed (length / median), the line takes the middle
 * of them (the smallest worst error: the spec has one speed per line), the
 * dwell is lowered where it would eat the moving time, then a few
 * corrections absorb the compiler's rounding and minimum leg times.
 * → { speed_kmh, dwell_s, per_direction: [{ direction, observed: [min, max] s, median, estimate s }] } | null
 */
const calibrateLine = (mode, dirs) => {
  const def = MODES[mode] || MODES.bus;
  const usable = dirs.filter((d) => d.durations.length && d.legs.length && d.legs.reduce((a, b) => a + b, 0) > 0);
  if (!usable.length) return null;
  for (const d of usable) d.median = median(d.durations);
  const ideal = usable.map((d) => (d.legs.reduce((a, b) => a + b, 0) / d.median) * 3.6);
  let speed = ideal.reduce((a, b) => a + b, 0) / ideal.length;
  if (!Number.isFinite(speed) || speed < MIN_PLAUSIBLE_KMH || speed > maxPlausibleKmh(mode)) return { implausible: true, speed_kmh: Math.round(speed * 10) / 10 };
  // The compiler takes the dwells out of the commercial time, never below 60 % of it: keep them within 35 %.
  const caps = usable.filter((d) => d.legs.length > 1).map((d) => Math.floor((0.35 * d.median) / (d.legs.length - 1)));
  const dwell = Math.max(0, Math.min(def.dwell_s, ...caps));
  const estimate = (d, v) => {
    const off = runningTimes(d.legs, { speedKmh: v, dwellS: dwell });
    return off[off.length - 1].arrival;
  };
  for (let k = 0; k < 6; k++) {
    const ratios = usable.map((d) => estimate(d, speed) / d.median);
    const mid = (Math.max(...ratios) + Math.min(...ratios)) / 2;
    if (Math.abs(mid - 1) < 0.005) break;
    speed = Math.min(maxPlausibleKmh(mode), Math.max(MIN_PLAUSIBLE_KMH, speed * mid));
  }
  speed = Math.round(speed * 10) / 10;
  return { speed_kmh: speed, dwell_s: dwell, per_direction: usable.map((d) => ({ direction: d.id, observed: [Math.min(...d.durations), Math.max(...d.durations)], median: d.median, estimate: estimate(d, speed) })) };
};

// ── Losses, in words ───────────────────────────────────────────────────────

const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

/** The human warnings of a simplified import (EN; the studio localizes from the numbers). */
const lossWarnings = (l, { holidays = [], rule = null, holidaysKnown = false } = {}) => {
  const out = ["Simplified baseline for comparison: one stop sequence per line and direction, one running time per line. Never project it to replace the real feed: open the feed itself to change the network that runs."];
  if (l.trips_on_other_pattern) out.push(`${l.trips_on_other_pattern} of ${l.trips_total} trips (${pct(l.trips_on_other_pattern, l.trips_total)} %) follow another stop sequence than their line's main one: here they run the main one (${l.patterns_total - l.patterns_kept} of ${l.patterns_total} stop sequences dropped).`);
  if (l.lines_kept < l.routes_total) out.push(`${l.routes_total - l.lines_kept} of ${l.routes_total} routes are not in the plan.`);
  if (holidays.length) out.push(`${holidays.length} public holiday(s) run ${rule === "none" ? "without service" : `like a ${rule}`}, as in the feed.`);
  if (l.calendar_exceptions_dropped) out.push(`${l.calendar_exceptions_dropped} of ${l.calendar_exceptions_total} calendar exceptions (calendar_dates) are not reproduced${holidaysKnown ? "" : " (the public holidays are unknown without the territory)"}.`);
  if (l.service_dates_mismatched) out.push(`${l.service_dates_mismatched} service-day(s) differ from the feed's calendars (a service running a date it does not, or the reverse).`);
  if (l.frequencies_expanded) out.push(`${l.frequencies_expanded} frequency-based trip(s) are expanded into explicit departures.`);
  if (l.shapes_dropped) out.push("The feed's shapes are not kept: the lines are re-routed when the plan is compiled.");
  if (l.running_time.per_line.length) out.push(`Running times: one per line, calibrated on the observed median; up to ${l.running_time.max_spread_min} min away from the observed trips.`);
  return out;
};

/**
 * GTFS tables → a SIMPLIFIED Network Spec, and what the simplification
 * loses. Each route becomes a line; each direction keeps its dominant stop
 * sequence (the pattern most trips follow) and every departure of the
 * direction runs it. Each service becomes the weekly periods it really
 * runs (calendar.txt with its exceptions, or its dates alone), public
 * holidays carried when the feed treats them so; each line's speed and
 * dwell reproduce the observed median running time of its kept patterns.
 *
 *   opts.holidays  the country's public holidays (YYYYMMDD or { date })
 *   opts.routing   "straight" | "road": how the compiler will measure the
 *                  legs (default: road when road routing is enabled)
 *   opts.origin    { url, name } of the feed
 *
 * → { spec (with origin), stats, warnings, losses }
 *   losses = { routes_total, lines_kept, patterns_total, patterns_kept,
 *     trips_total, trips_on_other_pattern, calendar_exceptions_total,
 *     calendar_exceptions_dropped, service_dates_mismatched,
 *     dates_only_services_approximated, frequencies_expanded,
 *     shapes_dropped, running_time: { per_line: [{ line, line_id,
 *     direction, observed_min: [min, max], observed_median_min,
 *     compiled_min_estimate, speed_kmh }], max_spread_min } }
 *   (service_dates_mismatched, line_id and observed_median_min complete
 *   the contract: the service-days that differ from the feed, whatever
 *   the cause, and what the speed was calibrated on.)
 */
const specFromTables = (tables, { maxLines = LIMITS.lines, agencyFallback = "Existing network", focus = null, holidays = null, routing = null, origin = null } = {}) => {
  const warnings = [];
  const basis = routing === "straight" || routing === "road" ? routing : config.NETWORK_ROUTING_ENABLED ? "road" : "straight";
  const agency = (tables.agency || [])[0] || {};
  const stopsById = new Map();
  for (const s of tables.stops || []) {
    if (s.location_type && s.location_type !== "0") continue;
    const lat = Number(s.stop_lat);
    const lon = Number(s.stop_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    stopsById.set(s.stop_id, { id: s.stop_id, name: s.stop_name || s.stop_id, lat, lon, code: s.stop_code || undefined });
  }
  const sc = serviceCalendars(tables);
  // stop_times grouped by trip (ordered stops, departure and arrival times).
  const byTrip = new Map();
  for (const st of tables.stop_times || []) {
    let t = byTrip.get(st.trip_id);
    if (!t) {
      t = [];
      byTrip.set(st.trip_id, t);
    }
    t.push({ seq: parseInt(st.stop_sequence, 10), stop: st.stop_id, dep: secOf(st.departure_time || st.arrival_time), arr: secOf(st.arrival_time || st.departure_time) });
  }
  for (const rows of byTrip.values()) rows.sort((a, b) => a.seq - b.seq);
  // Frequencies expand into departures.
  const freqs = new Map();
  for (const f of tables.frequencies || []) {
    const s = secOf(f.start_time);
    const e = secOf(f.end_time);
    const h = parseInt(f.headway_secs, 10);
    if (s == null || e == null || !(h > 0)) continue;
    if (!freqs.has(f.trip_id)) freqs.set(f.trip_id, []);
    freqs.get(f.trip_id).push({ start: s, end: e, headway: h });
  }
  // Routes → lines.
  const allRoutes = (tables.routes || []).slice();
  let routes = allRoutes;
  const tripsByRoute = new Map();
  for (const t of tables.trips || []) {
    if (!tripsByRoute.has(t.route_id)) tripsByRoute.set(t.route_id, []);
    tripsByRoute.get(t.route_id).push(t);
  }
  // A territory (focus: [S, W, N, E]): the routes with a stop in it, the
  // busiest first — a regional feed keeps its lines through the place, not
  // the first ones of its file. None serves it: the feed is kept whole.
  if (Array.isArray(focus) && focus.length === 4 && focus.every(Number.isFinite)) {
    const inside = new Set([...stopsById.values()].filter((s) => s.lat >= focus[0] && s.lat <= focus[2] && s.lon >= focus[1] && s.lon <= focus[3]).map((s) => s.id));
    const serves = (r) => (tripsByRoute.get(r.route_id) || []).some((t) => (byTrip.get(t.trip_id) || []).some((x) => inside.has(x.stop)));
    const serving = routes.filter(serves);
    if (serving.length) {
      if (serving.length < routes.length) warnings.push(`${routes.length - serving.length} route(s) of the feed do not serve the territory: left out.`);
      routes = serving.sort((a, b) => (tripsByRoute.get(b.route_id)?.length || 0) - (tripsByRoute.get(a.route_id)?.length || 0));
    }
  }
  const shapeOf = shapeIndex(tables);
  const losses = { routes_total: allRoutes.length, lines_kept: 0, patterns_total: 0, patterns_kept: 0, trips_total: (tables.trips || []).length, trips_on_other_pattern: 0, calendar_exceptions_total: 0, calendar_exceptions_dropped: 0, service_dates_mismatched: 0, dates_only_services_approximated: 0, frequencies_expanded: 0, shapes_dropped: Boolean(tables._shapes_truncated || (tables.shapes && (tables.shapes.size || tables.shapes.length))), running_time: { per_line: [], max_spread_min: 0 } };
  const usedStops = new Set();
  const built = []; // { line, dirs: [{ id, services: Map(service → Set(dep)) }] }
  for (const r of routes) {
    if (built.length >= maxLines) {
      warnings.push(`Only the first ${maxLines} routes were kept (studio limit).`);
      break;
    }
    const trips = tripsByRoute.get(r.route_id) || [];
    if (!trips.length) continue;
    const dirs = new Map(); // direction id → { patterns: Map(key → { stops, count, durations, shapes }), services: Map(service → Set(dep)), headsigns }
    let freqTrips = 0;
    for (const t of trips) {
      const rows = byTrip.get(t.trip_id);
      if (!rows || rows.length < 2) continue;
      const dirId = t.direction_id === "1" ? "1" : "0";
      let d = dirs.get(dirId);
      if (!d) {
        d = { patterns: new Map(), services: new Map(), headsigns: new Map() };
        dirs.set(dirId, d);
      }
      const known = rows.filter((x) => stopsById.has(x.stop));
      if (known.length < 2) continue;
      const key = known.map((x) => x.stop).join("|");
      const p = d.patterns.get(key) || { stops: known.map((x) => x.stop), count: 0, durations: [], shapes: new Map() };
      p.count += 1;
      // The running time of this trip over the part of the pattern a plan can keep.
      const end = known[Math.min(known.length, LIMITS.stopsPerDirection) - 1];
      if (known[0].dep != null && end.arr != null && end.arr > known[0].dep) p.durations.push(end.arr - known[0].dep);
      if (t.shape_id) p.shapes.set(t.shape_id, (p.shapes.get(t.shape_id) || 0) + 1);
      d.patterns.set(key, p);
      if (t.trip_headsign) d.headsigns.set(t.trip_headsign, (d.headsigns.get(t.trip_headsign) || 0) + 1);
      const first = rows[0].dep;
      if (first == null) continue;
      if (!d.services.has(t.service_id)) d.services.set(t.service_id, new Set());
      const set = d.services.get(t.service_id);
      const fr = freqs.get(t.trip_id);
      if (fr) {
        freqTrips += 1;
        for (const f of fr) for (let x = f.start; x < f.end && set.size < MAX_DEPARTURES_PER_SERVICE; x += f.headway) set.add(x);
      } else if (set.size < MAX_DEPARTURES_PER_SERVICE) set.add(first);
    }
    if (!dirs.size) continue;
    const directions = [];
    const calib = [];
    const dirServices = [];
    let onOther = 0;
    let patterns = 0;
    for (const [dirId, d] of [...dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (!d.patterns.size) continue;
      const ranked = [...d.patterns.values()].sort((a, b) => b.count - a.count);
      const best = ranked[0];
      patterns += ranked.length;
      onOther += ranked.slice(1).reduce((n, p) => n + p.count, 0);
      const headsign = [...d.headsigns.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || stopsById.get(best.stops[best.stops.length - 1]).name;
      const stops = best.stops.slice(0, LIMITS.stopsPerDirection);
      directions.push({ id: dirId, headsign, stops });
      stops.forEach((id) => usedStops.add(id));
      const shapeId = [...best.shapes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
      calib.push({ id: dirId, durations: best.durations, ...legLengths(stops.map((id) => stopsById.get(id)), { routing: basis, shape: shapeOf(shapeId) }) });
      dirServices.push({ id: dirId, services: d.services });
    }
    if (!directions.length) continue;
    const mode = ROUTE_TYPE_MODE[parseInt(r.route_type, 10)] || "bus";
    const line = {
      id: r.route_id,
      short_name: r.route_short_name || r.route_long_name || r.route_id,
      long_name: r.route_long_name || undefined,
      mode,
      color: /^[0-9A-Fa-f]{6}$/.test(r.route_color || "") ? r.route_color : undefined,
      directions,
      round_trip: false,
      services: [],
    };
    built.push({ line, dirs: dirServices, calib, stats: { onOther, patterns, freqTrips } });
  }

  // Services → weekly periods (a period per run of the service; one per
  // service when that would exceed the plan's trip limit).
  const kept = new Set(built.flatMap((b) => b.dirs.flatMap((d) => [...d.services.keys()])));
  const assign = (maxPeriods) => {
    const periodsBySid = new Map();
    for (const sid of kept) periodsBySid.set(sid, periodsOf(sc, sid, maxPeriods));
    const canonical = new Map(); // "days|start|end" → calendar
    const calendarsOf = (sid) =>
      periodsBySid.get(sid).map((p, i) => {
        const sig = `${p.days.join(",")}|${p.start}|${p.end}`;
        if (!canonical.has(sig)) canonical.set(sig, { id: i === 0 ? sid : `${sid}_P${i + 1}`, days: p.days, start_date: p.start, end_date: p.end });
        return canonical.get(sig);
      });
    let trips = 0;
    const servicesByLine = built.map((b) => {
      const services = [];
      for (const { id: dirId, services: bySid } of b.dirs) {
        const byCalendar = new Map(); // calendar → departures (services with the same calendar merge)
        for (const [sid, deps] of bySid) {
          for (const cal of calendarsOf(sid)) {
            if (!byCalendar.has(cal)) byCalendar.set(cal, new Set());
            const set = byCalendar.get(cal);
            for (const x of deps) if (set.size < MAX_DEPARTURES_PER_SERVICE) set.add(x);
          }
        }
        for (const [cal, deps] of byCalendar) {
          services.push({ calendar: { id: cal.id, days: cal.days, start_date: cal.start_date, end_date: cal.end_date }, direction: dirId, departures: [...deps].sort((a, b) => a - b).map(hhmm) });
          trips += deps.size;
        }
      }
      return services;
    });
    return { periodsBySid, servicesByLine, trips };
  };
  let plan = assign(MAX_PERIODS);
  if (plan.trips > LIMITS.trips * 0.9) {
    plan = assign(1);
    warnings.push("Each service is read as ONE weekly calendar over its dates: a calendar per period of service would exceed the plan's trip limit.");
  }
  const lines = [];
  built.forEach((b, i) => {
    if (!plan.servicesByLine[i].length) {
      warnings.push(`Route ${b.line.short_name}: its trips run on no date of the feed; skipped.`);
      return;
    }
    b.line.services = plan.servicesByLine[i];
    lines.push(b);
  });
  // Only the services of the kept lines count from here.
  const liveSids = new Set(lines.flatMap((b) => b.dirs.flatMap((d) => [...d.services.keys()])).filter((sid) => plan.periodsBySid.get(sid)?.length));
  const periodsBySid = new Map([...liveSids].map((sid) => [sid, plan.periodsBySid.get(sid)]));
  const stops = [...usedStops].map((id) => stopsById.get(id));
  if (tables._truncated) warnings.push("stop_times was truncated: some departures are missing.");
  // The plan keeps the validity of the feed it comes from (its calendars'
  // span), not today + one year: an expired feed stays visibly expired.
  const allPeriods = [...periodsBySid.values()].flat();
  const starts = allPeriods.map((p) => p.start).filter((d) => DATE_RE.test(d || "")).sort();
  const ends = allPeriods.map((p) => p.end).filter((d) => DATE_RE.test(d || "")).sort();
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  if (ends.length && ends[ends.length - 1] < today) warnings.push(`The feed expired on ${ends[ends.length - 1]}: its calendars are kept as they are.`);
  const span = starts.length && ends.length ? [starts[0], ends[ends.length - 1]] : null;

  // Public holidays the feed treats as such, and what the calendars lose.
  const hol = carryHolidays(sc, periodsBySid, holidays, span);
  const holidaySet = new Set(hol.holidays);
  const holidayDay = HOLIDAY_RULES.find(([r]) => r === hol.rule)?.[1] || null;
  const runs = (sid, d) => planRunsOn(periodsBySid.get(sid), d, holidaySet, holidayDay);
  for (const row of sc.rows) {
    if (!periodsBySid.has(row.service)) continue;
    losses.calendar_exceptions_total += 1;
    if ((row.type === "2") === runs(row.service, row.date)) losses.calendar_exceptions_dropped += 1;
  }
  for (const [sid, periods] of periodsBySid) {
    if (sc.datesOnly(sid)) losses.dates_only_services_approximated += 1;
    const actual = sc.datesOf(sid);
    if (!actual) continue; // long-running: its exceptions are counted above
    const truth = new Set(actual);
    let mismatched = actual.filter((d) => !runs(sid, d)).length;
    for (const p of periods) for (let t = ymdMs(p.start); t <= ymdMs(p.end); t += DAY_MS) if (runs(sid, ymdOf(t)) && !truth.has(ymdOf(t))) mismatched += 1;
    losses.service_dates_mismatched += mismatched;
  }
  if (losses.dates_only_services_approximated) warnings.push(`${losses.dates_only_services_approximated} service(s) defined by dates only (calendar_dates) were read as weekly calendars over their dates: one-off dates are approximated.`);

  // Running times: each line's speed and dwell from the observed ones.
  for (const b of lines) {
    losses.lines_kept += 1;
    losses.patterns_total += b.stats.patterns;
    losses.patterns_kept += b.line.directions.length;
    losses.trips_on_other_pattern += b.stats.onOther;
    losses.frequencies_expanded += b.stats.freqTrips;
    const c = calibrateLine(b.line.mode, b.calib);
    if (!c) continue;
    if (c.implausible) {
      warnings.push(`Line ${b.line.short_name}: the feed's running times give ${c.speed_kmh} km/h: implausible, the mode's usual speed is kept.`);
      continue;
    }
    b.line.speed_kmh = c.speed_kmh;
    b.line.dwell_s = c.dwell_s;
    // One speed per line cannot fit directions the feed runs at very different speeds: say so.
    if (c.per_direction.some((d) => Math.abs(d.estimate - d.median) > 0.1 * d.median)) {
      warnings.push(`Line ${b.line.short_name}: its directions run at different speeds in the feed (median ${c.per_direction.map((d) => `${Math.round(d.median / 60)} min`).join(" / ")}); with one speed per line the plan runs ${c.per_direction.map((d) => `${Math.round(d.estimate / 60)} min`).join(" / ")}.`);
    }
    for (const d of c.per_direction) {
      const entry = { line: b.line.short_name, line_id: b.line.id, direction: d.direction, observed_min: [Math.round(d.observed[0] / 60), Math.round(d.observed[1] / 60)], observed_median_min: Math.round(d.median / 60), compiled_min_estimate: Math.round(d.estimate / 60), speed_kmh: c.speed_kmh };
      losses.running_time.per_line.push(entry);
      losses.running_time.max_spread_min = Math.max(losses.running_time.max_spread_min, Math.round(Math.max(Math.abs(d.estimate - d.observed[0]), Math.abs(d.observed[1] - d.estimate)) / 60));
    }
  }
  const warningsOut = [...lossWarnings(losses, { holidays: hol.holidays, rule: hol.rule, holidaysKnown: Boolean((holidays || []).length) }), ...warnings];
  return {
    spec: {
      agency: { name: agency.agency_name || agencyFallback, url: agency.agency_url || "https://example.org", timezone: agency.agency_timezone || "UTC", lang: agency.agency_lang || undefined },
      ...(span ? { feed: { start_date: span[0], end_date: span[1] } } : {}),
      stops,
      lines: lines.map((b) => b.line),
      ...(hol.holidays.length ? { holidays: hol.holidays, holiday_service: hol.rule } : {}),
      origin: { kind: "simplified_import", url: origin?.url || null, name: origin?.name || agency.agency_name || null, imported_at: new Date().toISOString(), losses },
    },
    stats: { routes: routes.length, lines: lines.length, stops: stops.length, trips: (tables.trips || []).length },
    warnings: warningsOut,
    losses,
  };
};

/**
 * Download and reverse-compile a public feed into a simplified baseline
 * (focus: the territory's box, its lines first; holidays: the country's
 * public holidays; routing: how the compiler will measure the legs).
 */
const importFeed = async (url, { fetchImpl = null, maxLines = LIMITS.lines, focus = null, holidays = null, routing = null, name = null } = {}) => {
  const tables = await downloadTables(url, { fetchImpl });
  return specFromTables(tables, { maxLines, focus, holidays, routing, origin: { url, name } });
};

module.exports = { findFeeds, findFeedsDetailed, importFeed, specFromTables, downloadTables, loadCatalog, _internals: { parseCsvText, transport, reset: () => { _catalog = null; }, serviceCalendars, periodsOf, calibrateLine, lengthAlongShape, lossWarnings } };
