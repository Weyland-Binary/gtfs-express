/**
 * compiler — Network Spec → GTFS tables → a ready session.
 *
 *   compileSpec(spec, { router, territory?, territoryPlace?, fetchImpl? })
 *                                   → { tables, stats, warnings, geometry, calendars, spec }
 *   estimateGeometry(spec, { router }) → routed lengths, running times (per time band), polylines
 *   writeGtfsDir(tables, dir)       → CSV files
 *   createSessionFromSpec(spec, …)  → { sessionId, validationReport, … }
 *   dryRunSpec(spec, …)             → { dry_run, validation, verdict, coherence, counts } —
 *                                     the build without its session: compiled,
 *                                     measured and validated in a temporary
 *                                     folder, nothing kept (the Checks step);
 *                                     a validator's refusal still carries the
 *                                     design's coherence report (details.coherence)
 *
 * The compiler is deterministic: the same spec and the same routing answers
 * give the same feed. Paths and distances come from the road router (or the
 * straight-line fallback), times from `timetable`, everything else from the
 * normalised spec. Every stop pattern is routed and timed on its own: the
 * main directions (shape <line>_<0|1>) and the variants (shape
 * <line>_<variant>, trips <line>_<calendar>_<variant>_<n>). With speed bands
 * each trip runs at the speed of its departure's band. School calendars get
 * their dates first (schoolCalendar, from the territory's dossier or
 * OpenHolidays; `calendars` reports them and `spec` is the spec compiled,
 * with those dates): a calendar with dates is written in its smaller exact
 * form — the week in calendar.txt with the removed and added days in
 * calendar_dates.txt, or no weekday at all with every running day added —
 * and one that never runs is left out with its services. A school calendar
 * whose dates cannot be established stops the build (400, blockers).
 * The spec is stored next to the feed (`_network_spec.json`) so the studio
 * can reopen it.
 *
 * A build is a DELIVERY, gated before and after the write:
 *   - the brief, re-derived server-side (measureCompiled on the compiled
 *     timetable, from the requirements the request carries): a must clause
 *     failing or not measurable refuses 409 CLAUSES_FAILING / CLAUSES_UNKNOWN
 *     { clauses, unacknowledged } unless a NAMED acknowledgement covers every
 *     such clause (acknowledgement.parse → { by: { name }, clauses }) — nothing
 *     is written before this gate (G4);
 *   - the canonical validator, run by the ingest on the feed as written: a
 *     validator that is missing or crashed refuses 503 VALIDATOR_UNAVAILABLE /
 *     VALIDATOR_FAILED, a creation with errors refuses 409 VALIDATION_ERRORS —
 *     the session folder and its SQLite handle are removed (G1).
 * The build's PROOF (deliveryProof: the verdict, the validator's record —
 * engine, version, errors, warnings, rules —, the contract it ran under and
 * every open item with who accepted it, names included) is written next to
 * the session (`_delivery_proof.json`) before the build answers; a version
 * frozen from the session carries it (workspace versions.proof) and the
 * package's manifest prints it.
 * The stored report (`_network_report.json`) then carries `gate`: the
 * engine's verdict (verdictOf, with the coverage of the brief and the
 * contract's status), the validation summary, the validator's record, the
 * acknowledgement record (who accepted which clauses, when) and the proof's
 * id, and `build_id`:
 * a random public handle of this build, the one GET
 * /network/:buildId/export.zip asks for next to the session header (a
 * built and validated network downloads without edit mode) — the session id
 * is a credential and never travels in a URL.
 */

"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { normalizeSpec, estimateSpec, patternsOf, servicePatterns, runsOnSpecCalendar, isExplicitCalendar, holidayDayType: specHolidayDayType, _internals: specInternals } = require("./networkSpec");
const { runningTimes, buildTrips, departuresOf, departuresOfSynced, speedBandsOf, bandIndexAt } = require("./timetable");
const { createRouter } = require("./roadRouter");
const { resolveCalendars } = require("./schoolCalendar");
const { GTFS_UPLOAD_DIR, getActiveSessionsCount, sessionCapFor, clearSessionCache } = require("../sessionManager");
const { refusal } = require("../refusal");
const validatorGate = require("../validatorGate");
const acknowledgement = require("../acknowledgement");
const { verdictOf } = require("../verdict");

const { hhmm, weekdayOfYmd } = specInternals;
const SPEC_FILE = "_network_spec.json";
const REPORT_FILE = "_network_report.json";
const KM = (m) => Math.round((m / 1000) * 1000) / 1000;
const DAY_COL = { mon: "monday", tue: "tuesday", wed: "wednesday", thu: "thursday", fri: "friday", sat: "saturday", sun: "sunday" };
const MAX_CALENDAR_DAYS = 1200;
const MAX_SUSPICIOUS_LEGS = 50;

/** The day type a public holiday runs like (networkSpec.holidayDayType). */
const holidayDayType = (spec) => specHolidayDayType(spec);

const weekdayOf = (ymd) => weekdayOfYmd(ymd);

const addDay = (ymd) => {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8) + 1));
  return d.toISOString().slice(0, 10).replace(/-/g, "");
};
const datesBetween = (from, to) => {
  const out = [];
  for (let d = from, i = 0; d <= to && i < MAX_CALENDAR_DAYS; d = addDay(d), i++) out.push(d);
  return out;
};

/**
 * A calendar with dates as GTFS rows, in the smaller exact form: its week
 * in calendar.txt plus the removed/added days, or no weekday at all and
 * every running day added (a school-holiday service). Both keep calendar
 * dates within the period and never leave a service without a day.
 */
const datedCalendarRows = (cal, activeDates, from, to) => {
  const active = new Set(activeDates);
  const weekly = datesBetween(from, to).filter((d) => cal.days.includes(weekdayOf(d)));
  const weeklySet = new Set(weekly);
  const removed = weekly.filter((d) => !active.has(d));
  const added = activeDates.filter((d) => !weeklySet.has(d));
  const byWeek = removed.length + added.length <= activeDates.length;
  const row = { service_id: cal.id };
  for (const d of Object.keys(DAY_COL)) row[DAY_COL[d]] = byWeek && cal.days.includes(d) ? "1" : "0";
  row.start_date = from;
  row.end_date = to;
  const exceptions = byWeek
    ? [...removed.map((date) => ({ date, exception_type: "2" })), ...added.map((date) => ({ date, exception_type: "1" }))].sort((a, b) => a.date.localeCompare(b.date))
    : activeDates.map((date) => ({ date, exception_type: "1" }));
  return { row, exceptions: exceptions.map((e) => ({ service_id: cal.id, ...e })), form: byWeek ? "week" : "dates" };
};

/**
 * The legs the router found suspicious (roadRouter: routed over twice
 * the straight distance — a U-turn or a one-way detour), named by their
 * stops. Read defensively: a router may answer no `suspicious`.
 */
const suspiciousLegs = (routed, stopIds, stopsById) =>
  (Array.isArray(routed?.suspicious) ? routed.suspicious : [])
    .filter((s) => s && Number.isInteger(s.index) && s.index >= 0 && s.index + 1 < stopIds.length)
    .slice(0, MAX_SUSPICIOUS_LEGS)
    .map((s) => {
      const a = stopsById.get(stopIds[s.index]);
      const b = stopsById.get(stopIds[s.index + 1]);
      const straight = Number(s.straight_m) || 0;
      const routedM = Number(s.routed_m) || 0;
      const ratio = Number.isFinite(Number(s.ratio)) ? Number(s.ratio) : straight > 0 ? routedM / straight : null;
      return { index: s.index, from: a?.name || null, to: b?.name || null, from_stop_id: a?.id || null, to_stop_id: b?.id || null, straight_m: Math.round(straight), routed_m: Math.round(routedM), ratio: ratio == null ? null : Math.round(ratio * 100) / 100 };
    });

const patternLabel = (line, p) => `Line ${line.short_name} ${p.variant ? `variant ${p.id}` : `direction ${p.id}`}`;
const suspiciousWarning = (line, p, legs) => {
  const w = legs[0];
  const example = `${w.from} → ${w.to}, ${(w.routed_m / 1000).toFixed(1)} km for ${(w.straight_m / 1000).toFixed(1)} km straight${w.ratio ? ` (×${w.ratio})` : ""}`;
  return { code: "routing_suspicious", lineId: line.id, directionId: p.direction, ...(p.variant ? { variantId: p.id } : {}), legs, message: `${patternLabel(line, p)}: ${legs.length} leg(s) routed over twice the straight distance (e.g. ${example}): a U-turn or a one-way detour is likely; check the path on the map.` };
};

/** Running time (min) of a pattern in each speed band. */
const minutesByBand = (bands, offsetsFor) =>
  bands.map((b, bi) => {
    const o = offsetsFor(bi);
    return { from: hhmm(b.from), to: hhmm(b.to), speed_kmh: Math.round(b.speed_kmh * 10) / 10, running_min: Math.round(o[o.length - 1].arrival / 60) };
  });

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
 * createRouter({ mode: "straight" }) for an offline build. School
 * calendars take their dates from `territory` (or the cached dossier of
 * `territoryPlace`), else from OpenHolidays for `country` (`fetchImpl`).
 */
const compileSpec = async (normalized, { router = null, signal = null, shapes = true, onProgress = null, territory = null, territoryPlace = null, fetchImpl = null, country = null } = {}) => {
  const r = router || createRouter();
  // School calendars → dates. A calendar whose dates cannot be established
  // stops the build with its reason: never an approximation.
  const dossier = territory || (territoryPlace ? require("./territoryService").getCachedTerritory(territoryPlace) : null);
  const resolution = await resolveCalendars(normalized, { territory: dossier, fetchImpl, country });
  if (resolution.errors.length) {
    throw Object.assign(new Error(`School calendars cannot be resolved: ${resolution.errors.map((e) => e.message).join(" ")}`), { status: 400, code: "SCHOOL_CALENDAR_UNRESOLVED", issues: [...resolution.errors, ...resolution.warnings], blockers: resolution.errors });
  }
  const spec = resolution.spec;
  const stopsById = new Map(spec.stops.map((s) => [s.id, s]));
  const warnings = resolution.warnings.map((w) => ({ code: w.code, calendarId: w.calendarId, message: w.message, ...(w.from ? { from: w.from, to: w.to } : {}) }));
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
  const geometry = []; // per line/direction (and variant), for the studio's map
  const stats = { lines: [], routing_fallback_legs: 0, routed_legs: 0 };

  // Calendars with dates (school periods, include/exclude): their running
  // days within the feed's validity, first — one that never runs is left
  // out with its services (GTFS has no service without a day).
  const serviceCalendars = new Set(spec.lines.flatMap((l) => l.services.map((s) => s.calendar_id)));
  const dated = new Map(); // calendar id → { from, to, dates }
  const neverActive = new Set();
  for (const cal of spec.calendars) {
    if (!serviceCalendars.has(cal.id) || !isExplicitCalendar(cal)) continue;
    const from = cal.start_date > spec.feed.start_date ? cal.start_date : spec.feed.start_date;
    const to = cal.end_date < spec.feed.end_date ? cal.end_date : spec.feed.end_date;
    const dates = from <= to ? datesBetween(from, to).filter((d) => runsOnSpecCalendar(cal, d, spec) === true) : [];
    if (dates.length) dated.set(cal.id, { from, to, dates });
    else {
      neverActive.add(cal.id);
      warnings.push({ code: "calendar_never_active", calendarId: cal.id, message: `Calendar ${cal.id} runs on no day between ${from} and ${to}: its services are left out.` });
    }
  }

  let done = 0;
  const total = spec.lines.reduce((n, l) => n + patternsOf(l).length, 0);
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
    const lineStat = { id: line.id, short_name: line.short_name, directions: [], ...((line.variants || []).length ? { variants: [] } : {}), trips: 0 };
    const bands = speedBandsOf(line, spec);
    const patternData = new Map(); // "d:<dir>" | "v:<variant>" → routed pattern
    const keyOf = (p) => `${p.variant ? "v" : "d"}:${p.id}`;
    for (const p of patternsOf(line)) {
      if (signal && signal.aborted) throw Object.assign(new Error("Compilation cancelled."), { code: "ABORTED" });
      const pts = p.stops.map((id) => stopsById.get(id)).map((s) => ({ lat: s.lat, lon: s.lon, id: s.id }));
      p.stops.forEach((id) => usedStops.add(id));
      const routed = await r.route(pts, { signal });
      stats.routing_fallback_legs += routed.fallbacks || 0;
      stats.routed_legs += routed.legs.length - (routed.fallbacks || 0);
      if (routed.fallbacks) warnings.push({ code: "routing_fallback", lineId: line.id, directionId: p.direction, ...(p.variant ? { variantId: p.id } : {}), legs: routed.fallbacks, message: `${patternLabel(line, p)}: ${routed.fallbacks} leg(s) drawn as straight lines (road routing unavailable).` });
      const suspicious = suspiciousLegs(routed, p.stops, stopsById);
      if (suspicious.length) warnings.push(suspiciousWarning(line, p, suspicious));
      const legDist = routed.legs.map((l) => l.distanceM);
      const legDur = routed.legs.map((l) => l.durationS);
      // Running times per speed band (-1: the line's base speed), computed once per band.
      const byBand = new Map();
      const offsetsFor = (bi) => {
        if (!byBand.has(bi)) byBand.set(bi, runningTimes(legDist, { speedKmh: bi < 0 ? line.speed_kmh : bands[bi].speed_kmh, dwellS: line.dwell_s, legDurationsS: legDur }));
        return byBand.get(bi);
      };
      const offsets = offsetsFor(-1);
      // shape_dist_traveled at each stop (km), cumulative over legs.
      const cum = [0];
      for (const d of legDist) cum.push(cum[cum.length - 1] + d);
      const shapeId = shapes ? `${line.id}_${p.id}` : null;
      let shapePoints = [];
      if (shapes) {
        shapePoints = simplifyPoints(routed.points);
        let dist = 0;
        shapePoints.forEach((pt, i) => {
          if (i > 0) dist += haversine(shapePoints[i - 1], pt);
          tables.shapes.push({ shape_id: shapeId, shape_pt_lat: pt.lat.toFixed(6), shape_pt_lon: pt.lon.toFixed(6), shape_pt_sequence: String(i + 1), shape_dist_traveled: KM(dist).toFixed(3) });
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
      patternData.set(keyOf(p), { pattern: p, offsets, offsetsFor, cum, shapeId });
      const runMin = Math.round(offsets[offsets.length - 1].arrival / 60);
      const stat = { id: p.id, headsign: p.headsign, stops: p.stops.length, distance_km: KM(legDist.reduce((a, b) => a + b, 0)), running_min: runMin, ...(bands.length ? { running_min_by_band: minutesByBand(bands, offsetsFor) } : {}), fallback_legs: routed.fallbacks || 0, suspicious_legs: suspicious };
      if (p.variant) lineStat.variants.push({ ...stat, direction: p.direction });
      else lineStat.directions.push(stat);
      geometry.push({ lineId: line.id, directionId: p.direction, ...(p.variant ? { variantId: p.id } : {}), color: line.color, points: simplifyPoints(routed.points, 400).map((pt) => [Number(pt.lat.toFixed(5)), Number(pt.lon.toFixed(5))]) });
      done += 1;
      if (onProgress) onProgress({ done, total, lineId: line.id, directionId: p.direction, ...(p.variant ? { variantId: p.id } : {}) });
    }
    // Trips: each service runs its variant, or the main directions it names.
    const counters = new Map();
    for (const svc of line.services) {
      if (neverActive.has(svc.calendar_id)) continue;
      usedCalendars.add(svc.calendar_id);
      const deps = departuresOf(svc);
      // Pulse: the service's own sync, else the network's, unless opted out.
      const sync = svc.sync === false ? null : svc.sync || spec.sync || null;
      for (const p of servicePatterns(line, svc)) {
        const data = patternData.get(keyOf(p));
        if (!data) continue;
        const dirId = p.direction;
        let departures = deps;
        const hubIndex = sync ? p.stops.indexOf(sync.stop_id) : -1;
        if (hubIndex >= 0 && svc.periods.length) {
          // The hub arrival keeps the pulse in every speed band.
          departures = departuresOfSynced(svc, { hubOffsetS: data.offsets[hubIndex].arrival, minute: sync.minute, bands, hubOffsetFor: (bi) => data.offsetsFor(bi)[hubIndex].arrival });
          if (!stats.synced_directions) stats.synced_directions = 0;
          stats.synced_directions += 1;
        } else if (!p.variant && dirId === "1" && svc.direction === "both" && svc.reverse_offset_min != null) departures = deps.map((t) => t + Math.round(svc.reverse_offset_min * 60)).filter((t) => t >= 0);
        const prefix = p.variant ? `${line.id}_${svc.calendar_id}_${p.id}` : `${line.id}_${svc.calendar_id}_${dirId}`;
        const start = (counters.get(prefix) || 0) + 1;
        const trips = buildTrips({ lineId: line.id, directionId: dirId, serviceId: svc.calendar_id, stopIds: p.stops, offsets: data.offsets, departuresSec: departures, tripPrefix: prefix, startIndex: start, offsetsAt: bands.length ? (dep) => data.offsetsFor(bandIndexAt(bands, dep)) : null });
        counters.set(prefix, start + trips.length - 1);
        for (const t of trips) {
          tables.trips.push({ route_id: line.id, service_id: svc.calendar_id, trip_id: t.trip_id, trip_headsign: p.headsign, direction_id: dirId, shape_id: data.shapeId || "" });
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
  const datedExceptions = [];
  const calendarForms = {};
  for (const cal of spec.calendars) {
    if (!usedCalendars.has(cal.id)) continue;
    if (dated.has(cal.id)) {
      const { from, to, dates } = dated.get(cal.id);
      const { row, exceptions, form } = datedCalendarRows(cal, dates, from, to);
      tables.calendar.push(row);
      datedExceptions.push(...exceptions);
      calendarForms[cal.id] = { form, days: dates.length, exceptions: exceptions.length };
      continue;
    }
    const row = { service_id: cal.id };
    for (const d of Object.keys(DAY_COL)) row[DAY_COL[d]] = cal.days.includes(d) ? "1" : "0";
    row.start_date = cal.start_date;
    row.end_date = cal.end_date;
    tables.calendar.push(row);
  }
  // Holidays run like the holiday day type ("sunday" by default): every
  // calendar that runs on that day type runs on the holiday, every other one
  // is removed. A "daily" or "weekend" calendar therefore keeps running, and
  // "none" removes everything. A calendar with dates has them already.
  const holidayDay = holidayDayType(spec);
  for (const d of spec.holidays) {
    const wd = weekdayOf(d);
    for (const cal of spec.calendars) {
      if (!usedCalendars.has(cal.id) || dated.has(cal.id) || d < cal.start_date || d > cal.end_date) continue;
      const runs = cal.days.includes(wd);
      const shouldRun = holidayDay ? cal.days.includes(holidayDay) : false;
      if (runs && !shouldRun) tables.calendar_dates.push({ service_id: cal.id, date: d, exception_type: "2" });
      else if (!runs && shouldRun) tables.calendar_dates.push({ service_id: cal.id, date: d, exception_type: "1" });
    }
  }
  tables.calendar_dates.push(...datedExceptions);
  for (const t of spec.transfers) {
    tables.transfers.push({ from_stop_id: t.from, to_stop_id: t.to, transfer_type: t.type, min_transfer_time: String(Math.round(t.min_minutes * 60)) });
  }
  const counts = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length]));
  const calendars = resolution.calendars.map((c) => ({ ...c, ...(calendarForms[c.id] ? { gtfs: calendarForms[c.id] } : {}) }));
  return { tables, stats: { ...stats, counts, ...(Object.keys(calendarForms).length ? { dated_calendars: calendarForms } : {}) }, warnings, geometry, calendars, spec };
};

/**
 * Route every direction and variant of a normalised spec and return
 * distances, running times (per speed band when the line has bands) and
 * simplified polylines (map preview) — no tables, no session. Variants come
 * in `lines[].variants` (only on lines that have some); legs the router
 * found suspicious in `suspicious_legs`.
 */
const estimateGeometry = async (spec, { router = null, signal = null } = {}) => {
  const r = router || createRouter();
  const stopsById = new Map(spec.stops.map((s) => [s.id, s]));
  const lines = [];
  let fallbacks = 0;
  for (const line of spec.lines) {
    const out = { id: line.id, short_name: line.short_name, color: line.color, directions: [] };
    const bands = speedBandsOf(line, spec);
    for (const p of patternsOf(line)) {
      const put = (entry) => {
        if (!p.variant) out.directions.push(entry);
        else (out.variants || (out.variants = [])).push({ ...entry, direction: p.direction });
      };
      const pts = p.stops.map((id) => stopsById.get(id)).filter((s) => s && s.lat != null);
      if (pts.length !== p.stops.length || pts.length < 2) {
        put({ id: p.id, headsign: p.headsign, stops: p.stops.length, routable: false });
        continue;
      }
      const routed = await r.route(pts.map((s) => ({ lat: s.lat, lon: s.lon })), { signal });
      const legDist = routed.legs.map((l) => l.distanceM);
      const legDur = routed.legs.map((l) => l.durationS);
      const byBand = new Map();
      const offsetsFor = (bi) => {
        if (!byBand.has(bi)) byBand.set(bi, runningTimes(legDist, { speedKmh: bi < 0 ? line.speed_kmh : bands[bi].speed_kmh, dwellS: line.dwell_s, legDurationsS: legDur }));
        return byBand.get(bi);
      };
      const offsets = offsetsFor(-1);
      fallbacks += routed.fallbacks || 0;
      put({
        id: p.id,
        headsign: p.headsign,
        stops: p.stops.length,
        routable: true,
        distance_km: Math.round(routed.distanceM / 100) / 10,
        running_min: Math.round(offsets[offsets.length - 1].arrival / 60),
        ...(bands.length ? { running_min_by_band: minutesByBand(bands, offsetsFor) } : {}),
        fallback_legs: routed.fallbacks || 0,
        suspicious_legs: suspiciousLegs(routed, p.stops, stopsById),
        points: simplifyPoints(routed.points, 400).map((pt) => [Number(pt.lat.toFixed(5)), Number(pt.lon.toFixed(5))]),
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
  if (!report || report.unverified) return { errors: null, warnings: null, valid: null, unverified: true };
  return { errors: counts.errors ?? (report.valid === false ? 1 : 0), warnings: counts.warnings ?? 0, valid: report.valid !== false };
};

/** The compile stats as the evaluator's geometry: directions and variants with their lengths and times. */
const geometryOfStats = (stats) => ({
  lines: stats.lines.map((l) => {
    const part = (d) => ({ id: d.id, routable: true, distance_km: d.distance_km, running_min: d.running_min, ...(d.running_min_by_band ? { running_min_by_band: d.running_min_by_band } : {}) });
    return { id: l.id, short_name: l.short_name, directions: l.directions.map(part), ...(l.variants ? { variants: l.variants.map((v) => ({ ...part(v), direction: v.direction })) } : {}) };
  }),
});

/**
 * The data sources a report credits: only those that answered. Overpass
 * (OpenStreetMap) is dropped when no OpenStreetMap data came back.
 */
const answeredSources = (territory) => {
  const osm = (territory.existing_stops || []).length || (territory.existing_lines || []).length || (territory.pois?.items || []).length || (territory.population_grid?.cells || []).length || (territory.works?.items || []).length;
  return (territory.sources || []).filter((src) => src && (src.id !== "overpass" || osm));
};

/**
 * The compiled network measured before anything is written: the design
 * quality (evaluatePlan on the compiled geometry and the territory) and the
 * brief's conformance, checked on the timetable actually built. The design
 * fails soft (a missing dossier leaves null); the conformance is the gate's
 * input and is NOT swallowed: a checker that throws is a refusal, never a
 * plan delivered as if it met the brief.
 *   → { designReport, conformance }
 */
const measureCompiled = ({ spec: givenSpec, compiled, territory = null, requirements = null }) => {
  const design = require("./networkDesignService");
  const judge = require("../judge");
  // The spec as compiled: its school calendars carry their dates.
  const spec = compiled.spec || givenSpec;
  const geometry = geometryOfStats(compiled.stats);
  let designReport = null;
  try {
    designReport = design.evaluatePlan(spec, { territory, geometry });
    if (territory) designReport = design.attachAccessibility(designReport, compiled.tables, spec, territory);
  } catch (err) {
    console.warn("network report: evaluatePlan failed:", err.message);
  }
  const conformance = judge.checkConformance(spec, requirements, { tables: compiled.tables, operations: designReport?.operations || null, territory });
  if (designReport) designReport = judge.liftGenericFindings(designReport, requirements, spec);
  return { designReport, conformance };
};

/**
 * The clause gate of a build (G4): every must clause the compiled timetable
 * fails or cannot measure needs the named acknowledgement to cover it, else
 * 409 CLAUSES_FAILING (one fails) / CLAUSES_UNKNOWN (none fails, some cannot
 * be measured) { clauses, unacknowledged }. Returns the acknowledgement
 * record (null when every must clause is met).
 */
const assertClausesAcknowledged = (conformance, ack, extraItems = []) => {
  const items = acknowledgement.mustItems(conformance);
  const unack = items.filter((c) => !ack?.clauses?.has(c.id));
  if (unack.length) {
    const code = unack.some((c) => c.status === "fail") ? "CLAUSES_FAILING" : "CLAUSES_UNKNOWN";
    throw refusal(409, code, `${unack.length} requirement(s) of the brief are not met or cannot be measured: acknowledge them by name to build anyway.`, { clauses: items, unacknowledged: unack.map((c) => c.id) });
  }
  // What the caller's gates had the person accept besides the clauses (an assumed contract): in the same record.
  return acknowledgement.recordOf(ack, [...items, ...(Array.isArray(extraItems) ? extraItems : [])], "compile");
};

/**
 * The network report stored with the session: the design quality and the
 * brief's verdict (measureCompiled), the GTFS validation summary, the
 * semantic audit and the measure of the built feed, the requirements the
 * plan answered, and the build's `gate` (the engine's verdict — with the
 * coverage of the brief by the contract and the contract's status —, the
 * validation, the validator's record, the acknowledgement record, and the
 * id of the build's proof). The report is published with a share: its gate
 * names nobody beyond the acknowledgement (shareService removes that one);
 * a document's acknowledgement is said `acknowledged: true` here, its name
 * stays in the proof (deliveryProof, `_delivery_proof.json`). The audit and
 * the measure fail soft (null).
 */
// The verdict as the report keeps it: an unread document's acknowledgement without its name (the proof keeps it).
const anonymousVerdict = (verdict) => {
  if (!verdict?.coverage?.unread) return verdict;
  return { ...verdict, coverage: { ...verdict.coverage, unread: verdict.coverage.unread.map(({ acknowledged_by, ...u }) => ({ ...u, ...(acknowledged_by ? { acknowledged: true } : {}) })) } };
};
const buildReport = ({ compiled, ingested, sessionId, territory = null, requirements = null, designReport = null, conformance = null, acknowledgement: record = null, buildId = null, coverage = null, contract = null, proofId = null }) => {
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
  // The built feed measured like any other (uploaded or changed by a plan):
  // quality on the planners' scale, minimum fleet, consumer checks.
  let built = null;
  try {
    const { ensureDbHandle } = require("../db/connection");
    const db = ensureDbHandle(sessionId);
    if (db) {
      const { measureFeed, compactMeasure } = require("../transform/measure");
      built = compactMeasure(measureFeed(db));
    }
  } catch (err) {
    console.warn("network report: measure failed:", err.message);
  }
  const validation = validationSummary(ingested?.validationReport);
  return {
    build_id: buildId,
    design: designReport,
    built,
    validation,
    audit,
    territory: territory ? { place: territory.place.display_name, query: territory.place.query, population: territory.population?.value ?? null, sources: answeredSources(territory), warnings: Array.isArray(territory.warnings) ? territory.warnings.slice(0, 20) : [] } : null,
    requirements: requirements || null,
    conformance,
    // The delivery record: the engine's verdict (deliverable on its own only
    // when every must clause is met — else it was delivered under the
    // acknowledgement; with the coverage of the brief and the contract's
    // status), the validator's answer on the feed as written and its record
    // (engine, version, rules), who acknowledged what, and the build's proof.
    gate: {
      conformance: anonymousVerdict(verdictOf(conformance, { readiness: { ready: acknowledgement.mustItems(conformance).length === 0 }, coverage, contract })),
      validation: { status: "valid", errors: validation.errors ?? 0, warnings: validation.warnings ?? 0, engine: ingested?.validationReport?.engine || null },
      validator: validatorGate.recordOf(ingested?.validationReport),
      acknowledgement: record || null,
      proof_id: proofId,
    },
    counts: ingested?.counts || compiled.stats.counts,
    routing_fallback_legs: compiled.stats.routing_fallback_legs,
    ...(compiled.calendars && compiled.calendars.length ? { calendars: compiled.calendars } : {}),
    savedAt: new Date().toISOString(),
  };
};

/**
 * Compile and ingest as a brand-new session (validated, migrated to SQLite,
 * ready for the app). `requirements` is the brief the build is measured
 * against; `acknowledge` the parsed named acknowledgement
 * (acknowledgement.parse) covering the must clauses the plan does not meet;
 * `contract` and `coverage` the ready contract the caller checked
 * (networkController: 409 CONTRACT_REQUIRED otherwise) and the coverage of
 * the brief by it, recorded in the verdict and the proof.
 * Throws the typed refusals of the gates ({ status, code, details }: 409
 * CLAUSES_FAILING / CLAUSES_UNKNOWN before any write; 503 VALIDATOR_* and
 * 409 VALIDATION_ERRORS inside the ingest, before it writes anything durable
 * — no baseline, no upload statistic, no upload event — the session
 * removed), plus
 * { status: 400, issues } for a blocking spec and { status: 503 } at
 * capacity. Nothing of a refused build survives: folder, SQLite handle,
 * caches and the ingest's validation baseline are dropped.
 */
const createSessionFromSpec = async (rawSpec, { router = null, routing = null, shapes = true, req = null, signal = null, onProgress = null, territoryPlace = null, requirements = null, acknowledge = null, fetchImpl = null, extraItems = [], contract = null, coverage = null } = {}) => {
  // The territory (when cached) checks the school zones and dates the school calendars.
  const territory = territoryPlace ? require("./territoryService").getCachedTerritory(territoryPlace) : null;
  const norm = normalizeSpec(rawSpec, { territory });
  if (!norm.ok) throw Object.assign(new Error("The network spec has blocking issues."), { status: 400, issues: norm.issues, blockers: norm.blockers });
  const cap = sessionCapFor(req);
  if (getActiveSessionsCount() >= cap) throw Object.assign(new Error(`Server at capacity (${cap} sessions). Please try again later.`), { status: 503 });
  const compiled = await compileSpec(norm.spec, { router: router || createRouter(routing ? { mode: routing } : {}), signal, shapes, onProgress, territory, fetchImpl });
  // The brief, re-derived on the compiled timetable BEFORE any write: a must
  // clause not met needs a named acknowledgement, or the build is refused.
  const { designReport, conformance } = measureCompiled({ spec: norm.spec, compiled, territory, requirements });
  const record = assertClausesAcknowledged(conformance, acknowledge, extraItems);
  const sessionId = crypto.randomUUID();
  const uploadPath = path.join(GTFS_UPLOAD_DIR, sessionId);
  const { ingestPreparedDir } = require("../uploadService");
  try {
    await writeGtfsDir(compiled.tables, uploadPath);
    // The stored spec stays symbolic: its school calendars get their dates again at the next build.
    await fsp.writeFile(path.join(uploadPath, SPEC_FILE), JSON.stringify({ spec: norm.spec, savedAt: new Date().toISOString() }), "utf8");
    // The territory's country gives the validator its national rules.
    const territoryCountry = territory?.place?.country_code || null;
    // The validator's answer on the feed as written: a validator that did not
    // run proves nothing (the ingest's { unverified, engineError } report reads
    // VALIDATOR_FAILED for a crash, VALIDATOR_UNAVAILABLE for a missing JAR),
    // and a creation carries no error at all. Asserted INSIDE the ingest,
    // before it writes anything durable (baseline, session meta, upload
    // statistics, upload event), and again on what it returns.
    const assertReport = (r) => {
      validatorGate.assertVerified(r);
      validatorGate.assertCreationValid(r);
    };
    const ingested = await ingestPreparedDir({ sessionId, uploadPath, source: "network_studio", sourceName: norm.spec.agency.name, req, countryCode: territoryCountry, assertReport });
    assertReport(ingested.validationReport);
    const buildId = newBuildId();
    // The build's proof (deliveryProof): the verdict, the validator's record, the contract, who accepted what — names
    // included — written next to the session BEFORE the build is answered: a build that cannot record it is removed.
    const deliveryProof = require("../deliveryProof");
    const proof = deliveryProof.proofOf({ scope: "compile", build_id: buildId, verdict: verdictOf(conformance, { readiness: { ready: acknowledgement.mustItems(conformance).length === 0 }, coverage, contract }), validator: validatorGate.recordOf(ingested.validationReport), contract, results: conformance?.results || null, coverage, records: record ? [record] : [] });
    deliveryProof.appendSessionProof(sessionId, proof);
    const report = buildReport({ compiled, ingested, sessionId, territory, requirements, designReport, conformance, acknowledgement: record, buildId, coverage, contract, proofId: proof.id });
    await fsp.writeFile(path.join(uploadPath, REPORT_FILE), JSON.stringify(report), "utf8").catch(() => {});
    // The telemetry of the acknowledgement (its id and a keyed hash of the name; the record itself lives in the report).
    acknowledgement.record({ record, session: sessionId, req });
    return { sessionId, ...ingested, spec: norm.spec, issues: norm.issues, estimate: norm.estimate, stats: compiled.stats, warnings: compiled.warnings, geometry: compiled.geometry, calendars: compiled.calendars, report, acknowledgement: record, proof };
  } catch (err) {
    // Nothing of a refused build survives: the SQLite handle the ingest opened
    // (closed before the folder goes, for the platforms that lock it), the
    // folder, the caches and the validation baseline (clearSessionCache).
    try {
      require("../db/connection").closeEditDb(sessionId, { removeFile: true });
    } catch {
      /* never opened */
    }
    await fsp.rm(uploadPath, { recursive: true, force: true }).catch(() => {});
    clearSessionCache(sessionId);
    throw err;
  }
};

/** A build's public handle: 16 hex characters, unguessable, never the session id. */
const newBuildId = () => crypto.randomBytes(8).toString("hex");
const BUILD_ID_RE = /^[a-f0-9]{16}$/;

/**
 * The build without its session — the Checks step's "compilation à blanc":
 * the spec is normalised, compiled, measured against the brief (the engine's
 * verdict, as the build would record it) and written to a temporary folder the canonical validator reads, then the
 * folder is removed. Nothing durable is written: no session, no baseline, no
 * upload statistic, no acknowledgement record — so nothing is delivered and
 * no gate of the build is spent. The validator's answer is read by
 * validatorGate like every other: a validator that is missing or crashed
 * refuses 503 VALIDATOR_UNAVAILABLE / VALIDATOR_FAILED (a dry run never says
 * "valid" without a verified report); errors are REPORTED (by rule), not
 * refused — the build itself refuses them (409 VALIDATION_ERRORS). The
 * design's coherence report is read from the compiled tables whatever the
 * validator answers: a 503 VALIDATOR_* carries it in its details (the body's
 * `coherence`), since the report never needs the validator.
 * Throws { status: 400, issues } for a blocking spec, like the build.
 */
const dryRunSpec = async (rawSpec, { router = null, routing = null, shapes = true, signal = null, territoryPlace = null, requirements = null, fetchImpl = null, coverage = null, contract = null } = {}) => {
  const territory = territoryPlace ? require("./territoryService").getCachedTerritory(territoryPlace) : null;
  const norm = normalizeSpec(rawSpec, { territory });
  if (!norm.ok) throw Object.assign(new Error("The network spec has blocking issues."), { status: 400, issues: norm.issues, blockers: norm.blockers });
  const compiled = await compileSpec(norm.spec, { router: router || createRouter(routing ? { mode: routing } : {}), signal, shapes, territory, fetchImpl });
  const { conformance } = measureCompiled({ spec: norm.spec, compiled, territory, requirements });
  // The design's coherence report, read from the compiled tables while the validator runs; never a reason to fail the checks.
  const coherence = require("../coherence/coherenceService")
    .designReport(compiled.tables, { spec: norm.spec, territory, requirements })
    .catch((err) => ({ error: String(err.message || err) }));
  const dir = await fsp.mkdtemp(path.join(require("os").tmpdir(), "network-dry-run-"));
  try {
    await writeGtfsDir(compiled.tables, dir);
    let report;
    try {
      report = await validatorGate.validateDir(dir, territory?.place?.country_code || null);
    } catch (err) {
      // The report does not need the validator: a refusal of the validator (503 VALIDATOR_*) still carries it.
      if (err && err.status && err.code) err.details = { ...(err.details || {}), coherence: await coherence };
      throw err;
    }
    return {
      dry_run: true,
      validation: { ...validatorGate.summaryOf(report), by_rule: validatorGate.byRule(report) },
      verdict: verdictOf(conformance, { readiness: { ready: acknowledgement.mustItems(conformance).length === 0 }, coverage, contract }),
      coherence: await coherence,
      counts: compiled.stats.counts,
      checked_at: new Date().toISOString(),
    };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
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

module.exports = { compileSpec, estimateGeometry, writeGtfsDir, createSessionFromSpec, dryRunSpec, BUILD_ID_RE, loadStoredSpec, saveStoredSpec, loadStoredReport, estimateSpec, COLUMNS, _internals: { toCsv, csvCell, simplifyPoints, weekdayOf, holidayDayType, measureCompiled, assertClausesAcknowledged, buildReport, validationSummary, datedCalendarRows, suspiciousLegs, geometryOfStats, answeredSources } };
