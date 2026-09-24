/**
 * qualityAuditService — the semantic quality audit ("Diagnostic").
 *
 * The MobilityData validator checks the GTFS specification; this audit
 * checks whether the data makes sense for passengers and operators:
 * buses travelling at 180 km/h between two stops, stops duplicated a few
 * metres apart, the same stop spelled three ways, shapes that run far
 * from the stops they serve, services that never run or expired, routes
 * without trips, colours nobody can read…
 *
 * Every check is deterministic, bounded (row and sample caps) and
 * isolated (a failing check never hides the others). The result feeds the
 * Diagnostic panel of the app and the assistant's run_quality_audit tool,
 * which turns findings into explanations and fix proposals.
 *
 * Result shape:
 *   {
 *     generatedAt, durationMs, partial,
 *     counts: { warning, info },
 *     findings: [{ code, severity: "warning"|"info", count, unit,
 *                  entityType, fix: "sql"|"studio"|"manual"|"review",
 *                  samples: [{ id, label, detail, routeId? }], meta? }]
 *   }
 */

"use strict";

const { haversineMeters, pointToPolylineDistance } = require("../utils/geoUtils");
const { validateSessionId } = require("./sessionManager");
const { ensureDbHandle } = require("./db/connection");
const { getDataVersion } = require("../middleware/readCache");

const MAX_SAMPLES = 10;
const MAX_STOP_TIMES_ROWS = 1_500_000;
const MAX_SHAPES_CHECKED = 400;
const SPEED_LIMIT_KMH = { 0: 80, 1: 110, 2: 320, 3: 100, 4: 60, 5: 40, 6: 40, 7: 40, 11: 100, 12: 110 };
const DEFAULT_SPEED_LIMIT_KMH = 150;
const DUPLICATE_STOP_M = 8;
const ZERO_TRAVEL_MIN_M = 500;
const LONG_DWELL_S = 1800;
const SHAPE_FAR_M = 300;
const FEED_ENDS_SOON_DAYS = 14;

const parseTime = (t) => {
  if (typeof t !== "string" || !/^\d{1,3}:\d{2}:\d{2}$/.test(t)) return null;
  const [h, m, s] = t.split(":").map((p) => parseInt(p, 10));
  return h * 3600 + m * 60 + s;
};

const num = (v) => {
  if (v === null || v === undefined || v === "") return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

const todayYmd = () => {
  const d = new Date();
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
};

const addDaysYmd = (days) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
};

const normalizeName = (name) =>
  String(name || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// WCAG relative luminance of a 6-digit hex colour.
const luminance = (hex) => {
  const h = String(hex || "").replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  const c = [0, 2, 4].map((i) => {
    const v = parseInt(h.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrastRatio = (a, b) => {
  const la = luminance(a);
  const lb = luminance(b);
  if (la == null || lb == null) return null;
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
};

const finding = (code, severity, opts) => ({
  code,
  severity,
  count: 0,
  unit: "items",
  entityType: null,
  fix: "review",
  samples: [],
  ...opts,
});

// ── Checks ────────────────────────────────────────────────────────────────

// One pass over stop_times (ordered by trip, sequence): speeds, zero travel
// over long distances, long dwells, trips with a single stop.
const checkStopTimes = (db, out) => {
  const stops = new Map();
  for (const s of db.prepare("SELECT stop_id, stop_name, stop_lat, stop_lon FROM stops").iterate()) {
    const lat = num(s.stop_lat);
    const lon = num(s.stop_lon);
    if (Number.isFinite(lat) && Number.isFinite(lon)) stops.set(s.stop_id, { lat, lon, name: s.stop_name || s.stop_id });
  }
  const routeTypeByTrip = new Map();
  for (const r of db.prepare("SELECT t.trip_id, r.route_type, t.route_id FROM trips t LEFT JOIN routes r ON r.route_id = t.route_id").iterate()) {
    routeTypeByTrip.set(r.trip_id, { type: String(r.route_type ?? ""), routeId: r.route_id });
  }

  const speed = finding("unrealistic_speed", "warning", { unit: "trips", entityType: "trip", fix: "review" });
  const zero = finding("zero_travel_time", "info", { unit: "trips", entityType: "trip", fix: "review" });
  const dwell = finding("long_dwell", "info", { unit: "stop_times", entityType: "trip", fix: "review" });
  const short = finding("trip_single_stop", "warning", { unit: "trips", entityType: "trip", fix: "sql" });
  const speedTrips = new Set();
  const zeroTrips = new Set();
  let maxSpeed = 0;

  let rows = 0;
  let partial = false;
  let prev = null;
  let stopsInTrip = 0;
  const finishTrip = (tripId) => {
    if (tripId && stopsInTrip < 2) {
      short.count += 1;
      if (short.samples.length < MAX_SAMPLES) short.samples.push({ id: tripId, label: tripId, detail: `${stopsInTrip} stop_time(s)` });
    }
  };
  const stmt = db.prepare(
    "SELECT trip_id, stop_id, stop_sequence, arrival_time, departure_time FROM stop_times ORDER BY trip_id, CAST(stop_sequence AS INTEGER)",
  );
  for (const row of stmt.iterate()) {
    rows += 1;
    if (rows > MAX_STOP_TIMES_ROWS) {
      partial = true;
      break;
    }
    if (!prev || prev.trip_id !== row.trip_id) {
      finishTrip(prev ? prev.trip_id : null);
      stopsInTrip = 0;
    }
    stopsInTrip += 1;
    const arr = parseTime(row.arrival_time);
    const dep = parseTime(row.departure_time);
    // Long dwell (not at the ends: terminus layovers are legitimate).
    if (prev && prev.trip_id === row.trip_id && arr != null && dep != null && dep - arr > LONG_DWELL_S) {
      dwell.count += 1;
      if (dwell.samples.length < MAX_SAMPLES) {
        const s = stops.get(row.stop_id);
        dwell.samples.push({
          id: row.trip_id,
          label: `${row.trip_id} · ${s ? s.name : row.stop_id}`,
          detail: `${Math.round((dep - arr) / 60)} min at stop ${row.stop_id}`,
        });
      }
    }
    if (prev && prev.trip_id === row.trip_id) {
      const a = stops.get(prev.stop_id);
      const b = stops.get(row.stop_id);
      const t0 = parseTime(prev.departure_time) ?? parseTime(prev.arrival_time);
      if (a && b && t0 != null && arr != null) {
        const dist = haversineMeters(a.lat, a.lon, b.lat, b.lon);
        const dt = arr - t0;
        if (dt > 0) {
          const kmh = (dist / dt) * 3.6;
          const info = routeTypeByTrip.get(row.trip_id);
          const limit = (info && SPEED_LIMIT_KMH[info.type]) || DEFAULT_SPEED_LIMIT_KMH;
          if (kmh > limit && dist > 200) {
            if (!speedTrips.has(row.trip_id)) {
              speedTrips.add(row.trip_id);
              speed.count += 1;
              if (speed.samples.length < MAX_SAMPLES) {
                speed.samples.push({
                  id: row.trip_id,
                  routeId: info ? info.routeId : null,
                  label: `${row.trip_id} · ${a.name} → ${b.name}`,
                  detail: `${Math.round(kmh)} km/h (${Math.round(dist)} m in ${dt} s, limit ${limit} km/h)`,
                });
              }
            }
            if (kmh > maxSpeed) maxSpeed = kmh;
          }
        } else if (dt === 0 && dist > ZERO_TRAVEL_MIN_M && !zeroTrips.has(row.trip_id)) {
          zeroTrips.add(row.trip_id);
          zero.count += 1;
          if (zero.samples.length < MAX_SAMPLES) {
            zero.samples.push({
              id: row.trip_id,
              label: `${row.trip_id} · ${a.name} → ${b.name}`,
              detail: `${Math.round(dist)} m with the same time ${row.arrival_time}`,
            });
          }
        }
      }
    }
    prev = row;
  }
  if (!partial) finishTrip(prev ? prev.trip_id : null);
  if (speed.count) speed.meta = { max_kmh: Math.round(maxSpeed) };
  for (const f of [speed, zero, dwell, short]) if (f.count > 0) out.push(f);
  return partial;
};

// Stops within a few metres of each other (same physical place entered twice).
// Severity: warning when a pair shares the same (normalised) name — the
// same stop entered twice; info otherwise (per-direction stops of a demo
// feed, or two poles on one kerb, may legitimately share coordinates).
// Platforms of one station (same parent_station) are never duplicates.
const checkDuplicateStops = (db, out) => {
  const f = finding("duplicate_stops", "info", { unit: "pairs", entityType: "stop", fix: "review" });
  let sameName = 0;
  const buckets = new Map();
  const cell = (lat, lon) => `${Math.floor(lat * 10000)}:${Math.floor(lon * 10000)}`;
  const all = [];
  for (const s of db
    .prepare("SELECT stop_id, stop_name, stop_lat, stop_lon, parent_station FROM stops WHERE location_type IS NULL OR location_type = '' OR location_type = '0'")
    .iterate()) {
    const lat = num(s.stop_lat);
    const lon = num(s.stop_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const rec = { id: s.stop_id, name: s.stop_name || "", lat, lon, parent: s.parent_station || "", key: normalizeName(s.stop_name) };
    all.push(rec);
    const key = cell(lat, lon);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(rec);
  }
  const seen = new Set();
  for (const a of all) {
    const bl = Math.floor(a.lat * 10000);
    const bo = Math.floor(a.lon * 10000);
    for (let dl = -1; dl <= 1; dl++) {
      for (let dn = -1; dn <= 1; dn++) {
        const list = buckets.get(`${bl + dl}:${bo + dn}`);
        if (!list) continue;
        for (const b of list) {
          if (b.id <= a.id) continue;
          const pair = `${a.id}|${b.id}`;
          if (seen.has(pair)) continue;
          if (a.parent && a.parent === b.parent) continue;
          const dist = haversineMeters(a.lat, a.lon, b.lat, b.lon);
          if (dist <= DUPLICATE_STOP_M) {
            seen.add(pair);
            f.count += 1;
            const same = a.key && a.key === b.key;
            if (same) sameName += 1;
            const sample = {
              id: a.id,
              label: `${a.name || a.id} ↔ ${b.name || b.id}`,
              detail: `${a.id} and ${b.id}, ${Math.round(dist)} m apart${same ? ", same name" : ""}`,
              otherId: b.id,
            };
            // Same-name pairs first in the samples.
            if (same) f.samples.unshift(sample);
            else f.samples.push(sample);
            if (f.samples.length > MAX_SAMPLES) f.samples.length = MAX_SAMPLES;
          }
        }
      }
    }
  }
  if (sameName > 0) {
    f.severity = "warning";
    f.meta = { same_name_pairs: sameName };
  }
  if (f.count > 0) out.push(f);
};

// The same stop name spelled differently (case, accents, punctuation).
const checkStopNames = (db, out) => {
  const inconsistent = finding("inconsistent_stop_names", "info", { unit: "names", entityType: "stop", fix: "sql" });
  const upper = finding("stop_name_uppercase", "info", { unit: "stops", entityType: "stop", fix: "sql" });
  const groups = new Map();
  for (const s of db.prepare("SELECT stop_id, stop_name FROM stops WHERE stop_name IS NOT NULL AND stop_name != ''").iterate()) {
    const key = normalizeName(s.stop_name);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, new Map());
    const variants = groups.get(key);
    if (!variants.has(s.stop_name)) variants.set(s.stop_name, s.stop_id);
    const letters = String(s.stop_name).replace(/[^A-Za-zÀ-ÿ]/g, "");
    if (letters.length >= 5 && letters === letters.toUpperCase() && letters !== letters.toLowerCase()) {
      upper.count += 1;
      if (upper.samples.length < MAX_SAMPLES) upper.samples.push({ id: s.stop_id, label: s.stop_name, detail: s.stop_id });
    }
  }
  for (const variants of groups.values()) {
    if (variants.size < 2) continue;
    inconsistent.count += 1;
    if (inconsistent.samples.length < MAX_SAMPLES) {
      const [first] = variants.entries();
      inconsistent.samples.push({
        id: first[1],
        label: [...variants.keys()].slice(0, 3).join("  |  "),
        detail: [...variants.values()].slice(0, 3).join(", "),
      });
    }
  }
  if (inconsistent.count > 0) out.push(inconsistent);
  if (upper.count > 0) out.push(upper);
};

// Shapes that run far from the stops of the trips using them.
const checkShapeFit = (db, out) => {
  const f = finding("stop_far_from_shape", "warning", { unit: "shapes", entityType: "shape", fix: "studio" });
  const shapes = db
    .prepare(
      `SELECT shape_id, COUNT(*) AS n FROM shapes GROUP BY shape_id ORDER BY shape_id LIMIT ${MAX_SHAPES_CHECKED + 1}`,
    )
    .all();
  const truncated = shapes.length > MAX_SHAPES_CHECKED;
  const ptsStmt = db.prepare(
    "SELECT shape_pt_lat AS lat, shape_pt_lon AS lon FROM shapes WHERE shape_id = ? ORDER BY CAST(shape_pt_sequence AS INTEGER)",
  );
  const tripStmt = db.prepare(
    `SELECT t.trip_id, t.route_id, COUNT(st.stop_id) AS n FROM trips t JOIN stop_times st ON st.trip_id = t.trip_id
      WHERE t.shape_id = ? GROUP BY t.trip_id ORDER BY n DESC LIMIT 1`,
  );
  const stopsStmt = db.prepare(
    `SELECT s.stop_id, s.stop_name, s.stop_lat, s.stop_lon FROM stop_times st JOIN stops s ON s.stop_id = st.stop_id
      WHERE st.trip_id = ? ORDER BY CAST(st.stop_sequence AS INTEGER)`,
  );
  for (const sh of shapes.slice(0, MAX_SHAPES_CHECKED)) {
    const rep = tripStmt.get(sh.shape_id);
    if (!rep) continue;
    const pts = ptsStmt
      .all(sh.shape_id)
      .map((p) => ({ lat: num(p.lat), lon: num(p.lon) }))
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
    if (pts.length < 2) continue;
    let far = 0;
    let worst = null;
    for (const s of stopsStmt.all(rep.trip_id)) {
      const lat = num(s.stop_lat);
      const lon = num(s.stop_lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const d = pointToPolylineDistance(lat, lon, pts);
      if (d > SHAPE_FAR_M) {
        far += 1;
        if (!worst || d > worst.d) worst = { d, name: s.stop_name || s.stop_id };
      }
    }
    if (far > 0) {
      f.count += 1;
      if (f.samples.length < MAX_SAMPLES) {
        f.samples.push({
          id: sh.shape_id,
          routeId: rep.route_id,
          label: `${sh.shape_id} (route ${rep.route_id})`,
          detail: `${far} stop(s) more than ${SHAPE_FAR_M} m away, worst: ${worst.name} at ${Math.round(worst.d)} m`,
        });
      }
    }
  }
  if (truncated) f.meta = { checked: MAX_SHAPES_CHECKED, truncated: true };
  if (f.count > 0) out.push(f);
};

// Calendars: never-running services, expired feed, feed ending soon.
const checkCalendars = (db, out) => {
  const today = todayYmd();
  const soon = addDaysYmd(FEED_ENDS_SOON_DAYS);
  const never = finding("service_never_runs", "warning", { unit: "services", entityType: "calendar", fix: "review" });
  const rows = db
    .prepare(
      `SELECT c.service_id, c.start_date, c.end_date,
              (COALESCE(c.monday,0)+COALESCE(c.tuesday,0)+COALESCE(c.wednesday,0)+COALESCE(c.thursday,0)+COALESCE(c.friday,0)+COALESCE(c.saturday,0)+COALESCE(c.sunday,0)) AS days,
              (SELECT COUNT(*) FROM calendar_dates d WHERE d.service_id = c.service_id AND d.exception_type = '1') AS added,
              (SELECT COUNT(*) FROM trips t WHERE t.service_id = c.service_id) AS trips
         FROM calendar c`,
    )
    .all();
  let maxEnd = null;
  for (const r of rows) {
    if (Number(r.days) === 0 && Number(r.added) === 0) {
      never.count += 1;
      if (never.samples.length < MAX_SAMPLES) never.samples.push({ id: r.service_id, label: r.service_id, detail: `${r.trips} trip(s), no active day` });
    }
    if (r.end_date && (!maxEnd || r.end_date > maxEnd)) maxEnd = r.end_date;
  }
  const maxDate = db.prepare("SELECT MAX(date) AS d FROM calendar_dates WHERE exception_type = '1'").get()?.d;
  if (maxDate && (!maxEnd || maxDate > maxEnd)) maxEnd = maxDate;
  if (never.count > 0) out.push(never);
  if (maxEnd) {
    if (maxEnd < today) {
      out.push(finding("feed_expired", "warning", { unit: "feed", entityType: "calendar", fix: "sql", count: 1, meta: { end_date: maxEnd }, samples: [{ id: null, label: maxEnd, detail: `Last service day ${maxEnd} is in the past` }] }));
    } else if (maxEnd <= soon) {
      out.push(finding("feed_ends_soon", "info", { unit: "feed", entityType: "calendar", fix: "sql", count: 1, meta: { end_date: maxEnd }, samples: [{ id: null, label: maxEnd, detail: `Last service day ${maxEnd}` }] }));
    }
  }
  const expiredServices = db
    .prepare(
      `SELECT c.service_id, c.end_date, (SELECT COUNT(*) FROM trips t WHERE t.service_id = c.service_id) AS trips
         FROM calendar c WHERE c.end_date < ? AND NOT EXISTS (SELECT 1 FROM calendar_dates d WHERE d.service_id = c.service_id AND d.exception_type = '1' AND d.date >= ?)`,
    )
    .all(today, today);
  if (expiredServices.length > 0 && !(maxEnd && maxEnd < today)) {
    const f = finding("service_expired", "info", { unit: "services", entityType: "calendar", fix: "review" });
    f.count = expiredServices.length;
    f.samples = expiredServices.slice(0, MAX_SAMPLES).map((r) => ({ id: r.service_id, label: r.service_id, detail: `ended ${r.end_date}, ${r.trips} trip(s)` }));
    out.push(f);
  }
};

// Unused / dangling objects.
const checkUnused = (db, out) => {
  const routes = db
    .prepare("SELECT r.route_id, r.route_short_name, r.route_long_name FROM routes r WHERE NOT EXISTS (SELECT 1 FROM trips t WHERE t.route_id = r.route_id)")
    .all();
  if (routes.length) {
    const f = finding("route_without_trips", "warning", { unit: "routes", entityType: "route", fix: "sql" });
    f.count = routes.length;
    f.samples = routes.slice(0, MAX_SAMPLES).map((r) => ({ id: r.route_id, label: r.route_short_name || r.route_id, detail: r.route_long_name || "" }));
    out.push(f);
  }
  const stops = db
    .prepare(
      `SELECT s.stop_id, s.stop_name FROM stops s
        WHERE (s.location_type IS NULL OR s.location_type = '' OR s.location_type = '0')
          AND NOT EXISTS (SELECT 1 FROM stop_times st WHERE st.stop_id = s.stop_id)
        LIMIT 5000`,
    )
    .all();
  if (stops.length) {
    const f = finding("stop_unused", "info", { unit: "stops", entityType: "stop", fix: "sql" });
    f.count = stops.length;
    f.samples = stops.slice(0, MAX_SAMPLES).map((s) => ({ id: s.stop_id, label: s.stop_name || s.stop_id, detail: s.stop_id }));
    if (stops.length >= 5000) f.meta = { truncated: true };
    out.push(f);
  }
  const noShape = db.prepare("SELECT COUNT(*) AS n FROM trips WHERE shape_id IS NULL OR shape_id = ''").get()?.n || 0;
  const hasAnyShape = db.prepare("SELECT 1 FROM shapes LIMIT 1").get();
  if (noShape > 0) {
    const routes2 = db
      .prepare(
        "SELECT route_id, COUNT(*) AS n FROM trips WHERE shape_id IS NULL OR shape_id = '' GROUP BY route_id ORDER BY n DESC LIMIT ?",
      )
      .all(MAX_SAMPLES);
    const f = finding("trips_without_shape", hasAnyShape ? "warning" : "info", { unit: "trips", entityType: "route", fix: "studio" });
    f.count = noShape;
    f.samples = routes2.map((r) => ({ id: r.route_id, routeId: r.route_id, label: `route ${r.route_id}`, detail: `${r.n} trip(s) without shape` }));
    out.push(f);
  }
};

// Route colours a passenger cannot read.
const checkColours = (db, out) => {
  const f = finding("low_color_contrast", "info", { unit: "routes", entityType: "route", fix: "sql" });
  for (const r of db
    .prepare("SELECT route_id, route_short_name, route_color, route_text_color FROM routes WHERE route_color IS NOT NULL AND route_color != ''")
    .iterate()) {
    const text = r.route_text_color && r.route_text_color !== "" ? r.route_text_color : "000000";
    const ratio = contrastRatio(r.route_color, text);
    if (ratio != null && ratio < 3) {
      f.count += 1;
      if (f.samples.length < MAX_SAMPLES) {
        f.samples.push({ id: r.route_id, label: r.route_short_name || r.route_id, detail: `#${r.route_color} on #${text}: contrast ${ratio.toFixed(1)}:1` });
      }
    }
  }
  if (f.count > 0) out.push(f);
};

const CHECKS = [checkStopTimes, checkDuplicateStops, checkStopNames, checkShapeFit, checkCalendars, checkUnused, checkColours];

const runQualityAudit = (db) => {
  const started = Date.now();
  const findings = [];
  let partial = false;
  const failed = [];
  for (const check of CHECKS) {
    try {
      const r = check(db, findings);
      if (r === true) partial = true;
    } catch (err) {
      failed.push({ check: check.name, error: err.message });
    }
  }
  const order = { warning: 0, info: 1 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || b.count - a.count);
  const counts = { warning: 0, info: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return {
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    partial,
    failed,
    counts,
    findings,
  };
};

// Memoised per session and data version: the audit is only recomputed
// after an edit.
const _cache = new Map();
const auditForSession = (db, sessionId) => {
  const version = getDataVersion(db);
  const cached = _cache.get(sessionId);
  if (cached && cached.version === version) return cached.result;
  const result = runQualityAudit(db);
  _cache.set(sessionId, { version, result });
  return result;
};

/** GET /gtfs/quality_audit — the Diagnostic of the loaded feed. */
const getQualityAudit = (req, res) => {
  const sessionId = req.headers["x-session-id"];
  if (!sessionId || !validateSessionId(sessionId)) {
    return res.status(400).json({ error: "Session ID invalide ou manquant." });
  }
  const db = ensureDbHandle(sessionId);
  if (!db) {
    return res.status(404).json({ error: "No feed loaded for this session. Upload a GTFS file first." });
  }
  try {
    res.json(auditForSession(db, sessionId));
  } catch (err) {
    console.error("getQualityAudit error:", err);
    res.status(500).json({ error: "Quality audit failed." });
  }
};

module.exports = {
  runQualityAudit,
  auditForSession,
  getQualityAudit,
  _internals: { normalizeName, contrastRatio, parseTime },
};
