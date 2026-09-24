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
 *                                               existing network as a plan the
 *                                               studio can score and refine
 *
 * The catalog CSV is cached for a day. Downloads are capped in size and
 * rows; a feed larger than the studio's limits comes back truncated with a
 * warning rather than failing. Everything is injectable for tests.
 */

"use strict";

const path = require("path");
const os = require("os");
const fsp = require("fs/promises");
const crypto = require("crypto");
const unzipper = require("unzipper");
const config = require("../../config");
const { LIMITS } = require("./networkSpec");
const { parseCSV } = require("../csvUtils");

const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 60000;
const MAX_ZIP_BYTES = 80 * 1024 * 1024;
const MAX_ENTRY_BYTES = 600 * 1024 * 1024;
const MAX_FEEDS = 12;
const MAX_STOP_TIMES_ROWS = 2_000_000;
const MAX_DEPARTURES_PER_SERVICE = 400;
const NEEDED = new Set(["agency.txt", "routes.txt", "trips.txt", "stops.txt", "stop_times.txt", "calendar.txt", "calendar_dates.txt", "frequencies.txt"]);
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

/** Feeds covering the territory, most local first. */
const findFeeds = async (territory, { fetchImpl = null, force = false } = {}) => {
  const doFetch = fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (!doFetch) throw Object.assign(new Error("No fetch implementation."), { status: 500 });
  const rows = await loadCatalog(doFetch, { force });
  const { lat, lon, bbox } = territory.place;
  const hits = rows
    .filter((r) => contains(r.bbox, lat, lon) || intersects(r.bbox, bbox))
    .map((r) => ({ ...r, area_deg2: Math.round(bboxArea(r.bbox) * 1000) / 1000, covers_centre: contains(r.bbox, lat, lon) }))
    .sort((a, b) => Number(b.covers_centre) - Number(a.covers_centre) || a.area_deg2 - b.area_deg2)
    .slice(0, MAX_FEEDS);
  return hits;
};

/** Download a GTFS zip (bounded) and read the tables the reverse compiler needs. */
const downloadTables = async (url, { fetchImpl = null } = {}) => {
  const doFetch = fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (!doFetch) throw Object.assign(new Error("No fetch implementation."), { status: 500 });
  if (!/^https?:\/\//i.test(String(url))) throw Object.assign(new Error("url must be http(s)."), { status: 400, code: "INVALID_INPUT" });
  const res = await withTimeout(doFetch, url);
  if (!res.ok) throw Object.assign(new Error(`Feed download: HTTP ${res.status}`), { status: 502, code: "FEED_UNAVAILABLE" });
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_ZIP_BYTES) throw Object.assign(new Error(`The feed is larger than ${Math.round(MAX_ZIP_BYTES / 1e6)} MB.`), { status: 413, code: "FEED_TOO_LARGE" });
  const dir = path.join(os.tmpdir(), `gtfs-catalog-${crypto.randomUUID()}`);
  await fsp.mkdir(dir, { recursive: true });
  try {
    const zip = await unzipper.Open.buffer(buf);
    let total = 0;
    for (const entry of zip.files) {
      const name = path.basename(entry.path);
      if (entry.type !== "File" || !NEEDED.has(name)) continue;
      total += entry.uncompressedSize || 0;
      if (total > MAX_ENTRY_BYTES) throw Object.assign(new Error("The feed decompresses beyond the allowed size."), { status: 413, code: "FEED_TOO_LARGE" });
      await fsp.writeFile(path.join(dir, name), await entry.buffer());
    }
    const tables = {};
    for (const name of NEEDED) {
      const file = path.join(dir, name);
      try {
        await fsp.access(file);
      } catch {
        tables[name.replace(".txt", "")] = [];
        continue;
      }
      const rows = await parseCSV(file);
      tables[name.replace(".txt", "")] = name === "stop_times.txt" ? rows.slice(0, MAX_STOP_TIMES_ROWS) : rows;
      if (name === "stop_times.txt" && rows.length > MAX_STOP_TIMES_ROWS) tables._truncated = true;
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

/**
 * GTFS tables → Network Spec. Each route becomes a line; each direction
 * keeps its dominant stop sequence (the pattern most trips follow); each
 * (direction, service) keeps its departures from the first stop, explicit.
 */
const specFromTables = (tables, { maxLines = LIMITS.lines, agencyFallback = "Existing network" } = {}) => {
  const warnings = [];
  const agency = (tables.agency || [])[0] || {};
  const stopsById = new Map();
  for (const s of tables.stops || []) {
    if (s.location_type && s.location_type !== "0") continue;
    const lat = Number(s.stop_lat);
    const lon = Number(s.stop_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    stopsById.set(s.stop_id, { id: s.stop_id, name: s.stop_name || s.stop_id, lat, lon, code: s.stop_code || undefined });
  }
  // Calendars.
  const calendars = new Map();
  for (const c of tables.calendar || []) {
    const days = DAY_COLS.filter(([col]) => c[col] === "1").map(([, d]) => d);
    if (days.length) calendars.set(c.service_id, { id: c.service_id, days, start_date: c.start_date, end_date: c.end_date });
  }
  // stop_times grouped by trip (first departure + ordered stops).
  const byTrip = new Map();
  for (const st of tables.stop_times || []) {
    let t = byTrip.get(st.trip_id);
    if (!t) {
      t = [];
      byTrip.set(st.trip_id, t);
    }
    t.push({ seq: parseInt(st.stop_sequence, 10), stop: st.stop_id, dep: secOf(st.departure_time || st.arrival_time) });
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
  const routes = (tables.routes || []).slice();
  const tripsByRoute = new Map();
  for (const t of tables.trips || []) {
    if (!tripsByRoute.has(t.route_id)) tripsByRoute.set(t.route_id, []);
    tripsByRoute.get(t.route_id).push(t);
  }
  const usedStops = new Set();
  const lines = [];
  for (const r of routes) {
    if (lines.length >= maxLines) {
      warnings.push(`Only the first ${maxLines} routes were kept (studio limit).`);
      break;
    }
    const trips = tripsByRoute.get(r.route_id) || [];
    if (!trips.length) continue;
    const dirs = new Map(); // direction id → { patterns: Map(key → {stops, count}), services: Map(service → Set(dep)) }
    for (const t of trips) {
      const rows = byTrip.get(t.trip_id);
      if (!rows || rows.length < 2) continue;
      const dirId = t.direction_id === "1" ? "1" : "0";
      let d = dirs.get(dirId);
      if (!d) {
        d = { patterns: new Map(), services: new Map(), headsigns: new Map() };
        dirs.set(dirId, d);
      }
      const stops = rows.map((x) => x.stop).filter((id) => stopsById.has(id));
      if (stops.length < 2) continue;
      const key = stops.join("|");
      const p = d.patterns.get(key) || { stops, count: 0 };
      p.count += 1;
      d.patterns.set(key, p);
      if (t.trip_headsign) d.headsigns.set(t.trip_headsign, (d.headsigns.get(t.trip_headsign) || 0) + 1);
      const first = rows[0].dep;
      if (first == null) continue;
      if (!d.services.has(t.service_id)) d.services.set(t.service_id, new Set());
      const set = d.services.get(t.service_id);
      const fr = freqs.get(t.trip_id);
      if (fr) for (const f of fr) for (let x = f.start; x < f.end && set.size < MAX_DEPARTURES_PER_SERVICE; x += f.headway) set.add(x);
      else if (set.size < MAX_DEPARTURES_PER_SERVICE) set.add(first);
    }
    if (!dirs.size) continue;
    const directions = [];
    const services = [];
    for (const [dirId, d] of [...dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const best = [...d.patterns.values()].sort((a, b) => b.count - a.count)[0];
      const headsign = [...d.headsigns.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || stopsById.get(best.stops[best.stops.length - 1]).name;
      directions.push({ id: dirId, headsign, stops: best.stops.slice(0, LIMITS.stopsPerDirection) });
      best.stops.forEach((id) => usedStops.add(id));
      for (const [serviceId, deps] of d.services) {
        const cal = calendars.get(serviceId);
        if (!cal) continue;
        services.push({ calendar: { id: cal.id, days: cal.days, start_date: cal.start_date, end_date: cal.end_date }, direction: dirId, departures: [...deps].sort((a, b) => a - b).map(hhmm) });
      }
    }
    if (!services.length) {
      warnings.push(`Route ${r.route_short_name || r.route_id}: no calendar found for its trips; skipped.`);
      continue;
    }
    lines.push({
      id: r.route_id,
      short_name: r.route_short_name || r.route_long_name || r.route_id,
      long_name: r.route_long_name || undefined,
      mode: ROUTE_TYPE_MODE[parseInt(r.route_type, 10)] || "bus",
      color: /^[0-9A-Fa-f]{6}$/.test(r.route_color || "") ? r.route_color : undefined,
      directions,
      round_trip: false,
      services,
    });
  }
  const stops = [...usedStops].map((id) => stopsById.get(id));
  if (tables._truncated) warnings.push("stop_times was truncated: some departures are missing.");
  return {
    spec: {
      agency: { name: agency.agency_name || agencyFallback, url: agency.agency_url || "https://example.org", timezone: agency.agency_timezone || "UTC", lang: agency.agency_lang || undefined },
      stops,
      lines,
    },
    stats: { routes: routes.length, lines: lines.length, stops: stops.length, trips: (tables.trips || []).length },
    warnings,
  };
};

/** Download and reverse-compile a public feed. */
const importFeed = async (url, { fetchImpl = null, maxLines = LIMITS.lines } = {}) => {
  const tables = await downloadTables(url, { fetchImpl });
  return specFromTables(tables, { maxLines });
};

module.exports = { findFeeds, importFeed, specFromTables, downloadTables, loadCatalog, _internals: { parseCsvText, reset: () => { _catalog = null; } } };
