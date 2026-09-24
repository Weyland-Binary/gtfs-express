/**
 * compiler — Network Spec → GTFS tables → a ready session.
 *
 *   compileSpec(spec, { router })   → { tables, stats, warnings, geometry }
 *   writeGtfsDir(tables, dir)       → CSV files
 *   createSessionFromSpec(spec, …)  → { sessionId, validationReport, … }
 *
 * The compiler is deterministic: the same spec and the same routing answers
 * give the same feed. Paths and distances come from the road router (or the
 * straight-line fallback), times from `timetable`, everything else from the
 * normalised spec. The spec is stored next to the feed (`_network_spec.json`)
 * so the studio can reopen it.
 */

"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { normalizeSpec, estimateSpec } = require("./networkSpec");
const { runningTimes, buildTrips, departuresOf, departuresOfSynced } = require("./timetable");
const { createRouter } = require("./roadRouter");
const { GTFS_UPLOAD_DIR, getActiveSessionsCount, MAX_SESSIONS, clearSessionCache } = require("../sessionManager");

const SPEC_FILE = "_network_spec.json";
const REPORT_FILE = "_network_report.json";
const KM = (m) => Math.round((m / 1000) * 1000) / 1000;
const DAY_COL = { mon: "monday", tue: "tuesday", wed: "wednesday", thu: "thursday", fri: "friday", sat: "saturday", sun: "sunday" };
const DAY_OF_WEEK = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const weekdayOf = (ymd) => DAY_OF_WEEK[new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8))).getUTCDay()];

// Drop consecutive identical points and cap the size of a shape.
const simplifyPoints = (points, max = 4000) => {
  const out = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.lat - p.lat) < 1e-7 && Math.abs(last.lon - p.lon) < 1e-7) continue;
    out.push(p);
  }
  if (out.length <= max) return out;
  const step = out.length / max;
  const sampled = [];
  for (let i = 0; i < max; i++) sampled.push(out[Math.floor(i * step)]);
  if (sampled[sampled.length - 1] !== out[out.length - 1]) sampled.push(out[out.length - 1]);
  return sampled;
};

const haversine = (a, b) => {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};

/**
 * Compile a NORMALISED spec (normalizeSpec(...).spec with ok === true).
 * `router` defaults to the configured road router; pass
 * createRouter({ mode: "straight" }) for an offline build.
 */
const compileSpec = async (spec, { router = null, signal = null, shapes = true, onProgress = null } = {}) => {
  const r = router || createRouter();
  const stopsById = new Map(spec.stops.map((s) => [s.id, s]));
  const warnings = [];
  const tables = {
    agency: [
      {
        agency_id: spec.agency.id,
        agency_name: spec.agency.name,
        agency_url: spec.agency.url,
        agency_timezone: spec.agency.timezone,
        agency_lang: spec.agency.lang || "",
        agency_phone: spec.agency.phone || "",
        agency_email: spec.agency.email || "",
      },
    ],
    stops: [],
    routes: [],
    trips: [],
    stop_times: [],
    calendar: [],
    calendar_dates: [],
    shapes: [],
    transfers: [],
    feed_info: [
      {
        feed_publisher_name: spec.feed.publisher,
        feed_publisher_url: spec.feed.publisher_url,
        feed_lang: spec.feed.lang,
        feed_start_date: spec.feed.start_date,
        feed_end_date: spec.feed.end_date,
        feed_version: spec.feed.version,
      },
    ],
  };
  const usedStops = new Set();
  const usedCalendars = new Set();
  const geometry = []; // per line/direction, for the studio's map
  const stats = { lines: [], routing_fallback_legs: 0, routed_legs: 0 };

  let done = 0;
  const total = spec.lines.reduce((n, l) => n + l.directions.length, 0);
  for (const [li, line] of spec.lines.entries()) {
    tables.routes.push({
      route_id: line.id,
      agency_id: spec.agency.id,
      route_short_name: line.short_name,
      route_long_name: line.long_name === line.short_name ? "" : line.long_name,
      route_desc: line.description || "",
      route_type: String(line.route_type),
      route_url: line.url || "",
      route_color: line.color,
      route_text_color: line.text_color,
      route_sort_order: String(li + 1),
    });
    const lineStat = { id: line.id, short_name: line.short_name, directions: [], trips: 0 };
    const dirData = new Map();
    for (const dir of line.directions) {
      if (signal && signal.aborted) throw Object.assign(new Error("Compilation cancelled."), { code: "ABORTED" });
      const pts = dir.stops.map((id) => stopsById.get(id)).map((s) => ({ lat: s.lat, lon: s.lon, id: s.id }));
      dir.stops.forEach((id) => usedStops.add(id));
      const routed = await r.route(pts, { signal });
      stats.routing_fallback_legs += routed.fallbacks || 0;
      stats.routed_legs += routed.legs.length - (routed.fallbacks || 0);
      if (routed.fallbacks) warnings.push({ code: "routing_fallback", lineId: line.id, directionId: dir.id, legs: routed.fallbacks, message: `Line ${line.short_name} direction ${dir.id}: ${routed.fallbacks} leg(s) drawn as straight lines (road routing unavailable).` });
      const legDist = routed.legs.map((l) => l.distanceM);
      const offsets = runningTimes(legDist, { speedKmh: line.speed_kmh, dwellS: line.dwell_s, legDurationsS: routed.legs.map((l) => l.durationS) });
      // shape_dist_traveled at each stop (km), cumulative over legs.
      const cum = [0];
      for (const d of legDist) cum.push(cum[cum.length - 1] + d);
      const shapeId = shapes ? `${line.id}_${dir.id}` : null;
      let shapePoints = [];
      if (shapes) {
        shapePoints = simplifyPoints(routed.points);
        let dist = 0;
        shapePoints.forEach((p, i) => {
          if (i > 0) dist += haversine(shapePoints[i - 1], p);
          tables.shapes.push({ shape_id: shapeId, shape_pt_lat: p.lat.toFixed(6), shape_pt_lon: p.lon.toFixed(6), shape_pt_sequence: String(i + 1), shape_dist_traveled: KM(dist).toFixed(3) });
        });
        // Stops' shape_dist must not exceed the shape's own length; scale when
        // the straight-line detour factor made the leg sum longer than the drawn path.
        const shapeLen = dist;
        const legSum = cum[cum.length - 1];
        if (legSum > 0 && shapeLen > 0 && legSum > shapeLen * 1.001) {
          const k = shapeLen / legSum;
          for (let i = 0; i < cum.length; i++) cum[i] *= k;
        }
      }
      dirData.set(dir.id, { dir, offsets, cum, shapeId });
      const runMin = Math.round(offsets[offsets.length - 1].arrival / 60);
      lineStat.directions.push({ id: dir.id, headsign: dir.headsign, stops: dir.stops.length, distance_km: KM(legDist.reduce((a, b) => a + b, 0)), running_min: runMin, fallback_legs: routed.fallbacks || 0 });
      geometry.push({ lineId: line.id, directionId: dir.id, color: line.color, points: simplifyPoints(routed.points, 400).map((p) => [Number(p.lat.toFixed(5)), Number(p.lon.toFixed(5))]) });
      done += 1;
      if (onProgress) onProgress({ done, total, lineId: line.id, directionId: dir.id });
    }
    // Trips.
    const counters = new Map();
    for (const svc of line.services) {
      usedCalendars.add(svc.calendar_id);
      const deps = departuresOf(svc);
      // Pulse: the service's own sync, else the network's, unless opted out.
      const sync = svc.sync === false ? null : svc.sync || spec.sync || null;
      for (const [dirId, data] of dirData) {
        if (svc.direction !== "both" && svc.direction !== dirId) continue;
        let departures = deps;
        const hubIndex = sync ? data.dir.stops.indexOf(sync.stop_id) : -1;
        if (hubIndex >= 0 && svc.periods.length) {
          departures = departuresOfSynced(svc, { hubOffsetS: data.offsets[hubIndex].arrival, minute: sync.minute });
          if (!stats.synced_directions) stats.synced_directions = 0;
          stats.synced_directions += 1;
        } else if (dirId === "1" && svc.direction === "both" && svc.reverse_offset_min != null) departures = deps.map((t) => t + Math.round(svc.reverse_offset_min * 60)).filter((t) => t >= 0);
        const prefix = `${line.id}_${svc.calendar_id}_${dirId}`;
        const start = (counters.get(prefix) || 0) + 1;
        const trips = buildTrips({ lineId: line.id, directionId: dirId, serviceId: svc.calendar_id, stopIds: data.dir.stops, offsets: data.offsets, departuresSec: departures, tripPrefix: prefix, startIndex: start });
        counters.set(prefix, start + trips.length - 1);
        for (const t of trips) {
          tables.trips.push({ route_id: line.id, service_id: svc.calendar_id, trip_id: t.trip_id, trip_headsign: data.dir.headsign, direction_id: dirId, shape_id: data.shapeId || "" });
          t.stop_times.forEach((st, i) => {
            tables.stop_times.push({ ...st, trip_id: t.trip_id, stop_sequence: String(st.stop_sequence), shape_dist_traveled: data.shapeId ? KM(data.cum[i]).toFixed(3) : "" });
          });
          lineStat.trips += 1;
        }
      }
    }
    stats.lines.push(lineStat);
  }

  for (const s of spec.stops) {
    if (!usedStops.has(s.id) && !spec.transfers.some((t) => t.from === s.id || t.to === s.id)) continue;
    tables.stops.push({ stop_id: s.id, stop_code: s.code || "", stop_name: s.name, stop_desc: s.address || "", stop_lat: String(s.lat), stop_lon: String(s.lon), location_type: "0", wheelchair_boarding: s.wheelchair || "" });
  }
  for (const cal of spec.calendars) {
    if (!usedCalendars.has(cal.id)) continue;
    const row = { service_id: cal.id };
    for (const d of Object.keys(DAY_COL)) row[DAY_COL[d]] = cal.days.includes(d) ? "1" : "0";
    row.start_date = cal.start_date;
    row.end_date = cal.end_date;
    tables.calendar.push(row);
  }
  // Holidays: services that would run are removed; the holiday service (if
  // it exists and is not already running that day) is added.
  const holidayCal = spec.holiday_service === "none" ? null : spec.calendars.find((c) => usedCalendars.has(c.id) && c.days.length === 1 && c.days[0] === (spec.holiday_service === "saturday" ? "sat" : "sun"));
  for (const d of spec.holidays) {
    const wd = weekdayOf(d);
    for (const cal of spec.calendars) {
      if (!usedCalendars.has(cal.id) || d < cal.start_date || d > cal.end_date) continue;
      const runs = cal.days.includes(wd);
      if (holidayCal && cal.id === holidayCal.id) {
        if (!runs) tables.calendar_dates.push({ service_id: cal.id, date: d, exception_type: "1" });
        continue;
      }
      if (runs) tables.calendar_dates.push({ service_id: cal.id, date: d, exception_type: "2" });
    }
  }
  for (const t of spec.transfers) {
    tables.transfers.push({ from_stop_id: t.from, to_stop_id: t.to, transfer_type: t.type, min_transfer_time: String(Math.round(t.min_minutes * 60)) });
  }
  const counts = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length]));
  return { tables, stats: { ...stats, counts }, warnings, geometry };
};

/**
 * Route every direction of a normalised spec and return distances, running
 * times and simplified polylines (map preview) — no tables, no session.
 */
const estimateGeometry = async (spec, { router = null, signal = null } = {}) => {
  const r = router || createRouter();
  const stopsById = new Map(spec.stops.map((s) => [s.id, s]));
  const lines = [];
  let fallbacks = 0;
  for (const line of spec.lines) {
    const out = { id: line.id, short_name: line.short_name, color: line.color, directions: [] };
    for (const dir of line.directions) {
      const pts = dir.stops.map((id) => stopsById.get(id)).filter((s) => s && s.lat != null);
      if (pts.length !== dir.stops.length || pts.length < 2) {
        out.directions.push({ id: dir.id, headsign: dir.headsign, stops: dir.stops.length, routable: false });
        continue;
      }
      const routed = await r.route(pts.map((s) => ({ lat: s.lat, lon: s.lon })), { signal });
      const offsets = runningTimes(routed.legs.map((l) => l.distanceM), { speedKmh: line.speed_kmh, dwellS: line.dwell_s, legDurationsS: routed.legs.map((l) => l.durationS) });
      fallbacks += routed.fallbacks || 0;
      out.directions.push({
        id: dir.id,
        headsign: dir.headsign,
        stops: dir.stops.length,
        routable: true,
        distance_km: Math.round(routed.distanceM / 100) / 10,
        running_min: Math.round(offsets[offsets.length - 1].arrival / 60),
        fallback_legs: routed.fallbacks || 0,
        points: simplifyPoints(routed.points, 400).map((p) => [Number(p.lat.toFixed(5)), Number(p.lon.toFixed(5))]),
      });
    }
    lines.push(out);
  }
  return { routing: r.mode, lines, fallback_legs: fallbacks };
};

// ── CSV ────────────────────────────────────────────────────────────────────

const COLUMNS = {
  agency: ["agency_id", "agency_name", "agency_url", "agency_timezone", "agency_lang", "agency_phone", "agency_email"],
  stops: ["stop_id", "stop_code", "stop_name", "stop_desc", "stop_lat", "stop_lon", "location_type", "wheelchair_boarding"],
  routes: ["route_id", "agency_id", "route_short_name", "route_long_name", "route_desc", "route_type", "route_url", "route_color", "route_text_color", "route_sort_order"],
  trips: ["route_id", "service_id", "trip_id", "trip_headsign", "direction_id", "shape_id"],
  stop_times: ["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence", "timepoint", "shape_dist_traveled"],
  calendar: ["service_id", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "start_date", "end_date"],
  calendar_dates: ["service_id", "date", "exception_type"],
  shapes: ["shape_id", "shape_pt_lat", "shape_pt_lon", "shape_pt_sequence", "shape_dist_traveled"],
  transfers: ["from_stop_id", "to_stop_id", "transfer_type", "min_transfer_time"],
  feed_info: ["feed_publisher_name", "feed_publisher_url", "feed_lang", "feed_start_date", "feed_end_date", "feed_version"],
};
const OPTIONAL_WHEN_EMPTY = new Set(["calendar_dates", "shapes", "transfers", "feed_info"]);

const csvCell = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const toCsv = (rows, columns) => {
  const lines = [columns.join(",")];
  for (const r of rows) lines.push(columns.map((c) => csvCell(r[c])).join(","));
  return `${lines.join("\n")}\n`;
};

const writeGtfsDir = async (tables, dir) => {
  await fsp.mkdir(dir, { recursive: true });
  const written = [];
  for (const [table, columns] of Object.entries(COLUMNS)) {
    const rows = tables[table] || [];
    if (rows.length === 0 && OPTIONAL_WHEN_EMPTY.has(table)) continue;
    await fsp.writeFile(path.join(dir, `${table}.txt`), toCsv(rows, columns), "utf8");
    written.push(`${table}.txt`);
  }
  return written;
};

// ── Session ────────────────────────────────────────────────────────────────

const validationSummary = (report) => {
  const counts = report?.counts || {};
  return { errors: counts.errors ?? (report?.valid === false ? 1 : 0), warnings: counts.warnings ?? 0, valid: report ? report.valid !== false : null };
};

/**
 * The network report: the design quality (evaluatePlan on the compiled
 * geometry and the territory), the GTFS validation summary and the semantic
 * audit of the built session, with the requirements the plan answered.
 * Every part fails soft: a missing dossier or a failing audit leaves null.
 */
const buildReport = ({ spec, compiled, ingested, sessionId, territoryPlace = null, requirements = null }) => {
  const design = require("./networkDesignService");
  const territoryService = require("./territoryService");
  const territory = territoryPlace ? territoryService.getCachedTerritory(territoryPlace) : null;
  const geometry = { lines: compiled.stats.lines.map((l) => ({ id: l.id, short_name: l.short_name, directions: l.directions.map((d) => ({ id: d.id, routable: true, distance_km: d.distance_km, running_min: d.running_min })) })) };
  let designReport = null;
  try {
    designReport = design.evaluatePlan(spec, { territory, geometry });
    if (territory) designReport = design.attachAccessibility(designReport, compiled.tables, spec, territory);
  } catch (err) {
    console.warn("network report: evaluatePlan failed:", err.message);
  }
  let audit = null;
  try {
    const { ensureDbHandle } = require("../db/connection");
    const { auditForSession } = require("../qualityAuditService");
    const db = ensureDbHandle(sessionId);
    if (db) {
      const a = auditForSession(db, sessionId);
      audit = { counts: a.counts, partial: a.partial, findings: a.findings.slice(0, 20).map((f) => ({ code: f.code, severity: f.severity, count: f.count, unit: f.unit, entityType: f.entityType, samples: (f.samples || []).slice(0, 3) })) };
    }
  } catch (err) {
    console.warn("network report: audit failed:", err.message);
  }
  return {
    design: designReport,
    validation: validationSummary(ingested?.validationReport),
    audit,
    territory: territory ? { place: territory.place.display_name, query: territory.place.query, population: territory.population?.value ?? null, sources: territory.sources } : null,
    requirements: requirements || null,
    counts: ingested?.counts || compiled.stats.counts,
    routing_fallback_legs: compiled.stats.routing_fallback_legs,
    savedAt: new Date().toISOString(),
  };
};

/**
 * Compile and ingest as a brand-new session (validated, migrated to SQLite,
 * ready for the app). Throws {status, message} on capacity or ingestion errors.
 */
const createSessionFromSpec = async (rawSpec, { router = null, routing = null, shapes = true, req = null, signal = null, onProgress = null, territoryPlace = null, requirements = null } = {}) => {
  const norm = normalizeSpec(rawSpec);
  if (!norm.ok) throw Object.assign(new Error("The network spec has blocking issues."), { status: 400, issues: norm.issues, blockers: norm.blockers });
  if (getActiveSessionsCount() >= MAX_SESSIONS) throw Object.assign(new Error(`Server at capacity (${MAX_SESSIONS} sessions). Please try again later.`), { status: 503 });
  const compiled = await compileSpec(norm.spec, { router: router || createRouter(routing ? { mode: routing } : {}), signal, shapes, onProgress });
  const sessionId = crypto.randomUUID();
  const uploadPath = path.join(GTFS_UPLOAD_DIR, sessionId);
  const { ingestPreparedDir } = require("../uploadService");
  try {
    await writeGtfsDir(compiled.tables, uploadPath);
    await fsp.writeFile(path.join(uploadPath, SPEC_FILE), JSON.stringify({ spec: norm.spec, savedAt: new Date().toISOString() }), "utf8");
    const ingested = await ingestPreparedDir({ sessionId, uploadPath, source: "network_studio", sourceName: norm.spec.agency.name, req });
    const report = buildReport({ spec: norm.spec, compiled, ingested, sessionId, territoryPlace, requirements });
    await fsp.writeFile(path.join(uploadPath, REPORT_FILE), JSON.stringify(report), "utf8").catch(() => {});
    return { sessionId, ...ingested, spec: norm.spec, issues: norm.issues, estimate: norm.estimate, stats: compiled.stats, warnings: compiled.warnings, geometry: compiled.geometry, report };
  } catch (err) {
    await fsp.rm(uploadPath, { recursive: true, force: true }).catch(() => {});
    clearSessionCache(sessionId);
    throw err;
  }
};

const loadStoredSpec = (sessionId) => {
  try {
    const raw = fs.readFileSync(path.join(GTFS_UPLOAD_DIR, sessionId, SPEC_FILE), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const saveStoredSpec = (sessionId, spec) => {
  const dir = path.join(GTFS_UPLOAD_DIR, sessionId);
  if (!fs.existsSync(dir)) return false;
  fs.writeFileSync(path.join(dir, SPEC_FILE), JSON.stringify({ spec, savedAt: new Date().toISOString() }), "utf8");
  return true;
};

const loadStoredReport = (sessionId) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(GTFS_UPLOAD_DIR, sessionId, REPORT_FILE), "utf8"));
  } catch {
    return null;
  }
};

module.exports = { compileSpec, estimateGeometry, writeGtfsDir, createSessionFromSpec, loadStoredSpec, saveStoredSpec, loadStoredReport, estimateSpec, COLUMNS, _internals: { toCsv, csvCell, simplifyPoints, weekdayOf, buildReport, validationSummary } };
