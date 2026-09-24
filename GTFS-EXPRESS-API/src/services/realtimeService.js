/**
 * realtimeService — a GTFS-Realtime feed checked against the loaded
 * static feed.
 *
 *   POST /gtfs/realtime/validate   (X-Session-ID)
 *        { url }                        → fetch the protobuf (or JSON) feed
 *        body: application/x-protobuf   → the feed itself
 *        { feed: FeedMessage as JSON }  → the protobuf JSON mapping
 *
 * Decodes the FeedMessage (gtfs-realtime-bindings) and checks what a
 * journey planner would trip on: unknown trips, routes and stops; stop
 * time updates out of sequence or on stops the trip does not serve;
 * absurd delays; vehicles far outside the network or with stale or future
 * timestamps; alerts pointing nowhere or with empty text; a header older
 * than a few minutes; duplicate entity ids. The result mirrors the
 * Diagnostic: findings with a code, a severity, a count and samples.
 */

"use strict";

const { requireSession } = require("./edit/_editCore");
const { haversineMeters } = require("../utils/geoUtils");

const FETCH_TIMEOUT_MS = 20000;
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_SAMPLES = 8;
const STALE_HEADER_S = 5 * 60;
const STALE_VEHICLE_S = 15 * 60;
const FUTURE_S = 60;
const MAX_DELAY_S = 3 * 3600;
const MAX_SPEED_MPS = 60;
const OUTSIDE_MARGIN_M = 5000;

let bindings = null;
const getBindings = () => {
  if (!bindings) bindings = require("gtfs-realtime-bindings");
  return bindings;
};

const finding = (map, code, severity, message, sample) => {
  let f = map.get(code);
  if (!f) {
    f = { code, severity, message, count: 0, samples: [] };
    map.set(code, f);
  }
  f.count += 1;
  if (sample && f.samples.length < MAX_SAMPLES) f.samples.push(sample);
};

/** Decode a FeedMessage from protobuf bytes or from its JSON mapping. */
const decodeFeed = ({ buffer = null, json = null }) => {
  const { transit_realtime } = getBindings();
  if (buffer) {
    const msg = transit_realtime.FeedMessage.decode(buffer);
    return transit_realtime.FeedMessage.toObject(msg, { longs: Number, enums: String, defaults: false });
  }
  if (json && typeof json === "object") {
    // fromObject accepts the protobuf JSON mapping (enums as names or numbers).
    let msg;
    try {
      msg = transit_realtime.FeedMessage.fromObject(json);
    } catch (err) {
      throw Object.assign(new Error(`Invalid FeedMessage JSON: ${err.message}`), { status: 400, code: "INVALID_FEED" });
    }
    if (!msg.header && !Array.isArray(json.entity)) throw Object.assign(new Error("Invalid FeedMessage JSON: no header nor entity."), { status: 400, code: "INVALID_FEED" });
    return transit_realtime.FeedMessage.toObject(msg, { longs: Number, enums: String, defaults: false });
  }
  throw Object.assign(new Error("No feed to decode."), { status: 400, code: "INVALID_INPUT" });
};

/** What the static feed knows, loaded once per check. */
const staticIndex = (db) => {
  const trips = new Map();
  for (const t of db.prepare("SELECT trip_id, route_id, service_id FROM trips").iterate()) trips.set(t.trip_id, { route: t.route_id, service: t.service_id, stops: null });
  const routes = new Set(db.prepare("SELECT route_id FROM routes").all().map((r) => r.route_id));
  const stops = new Map();
  let minLat = 90;
  let maxLat = -90;
  let minLon = 180;
  let maxLon = -180;
  for (const s of db.prepare("SELECT stop_id, stop_lat, stop_lon FROM stops").iterate()) {
    const lat = Number(s.stop_lat);
    const lon = Number(s.stop_lon);
    stops.set(s.stop_id, Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
      minLon = Math.min(minLon, lon);
      maxLon = Math.max(maxLon, lon);
    }
  }
  const agencies = new Set(db.prepare("SELECT agency_id FROM agency").all().map((a) => a.agency_id));
  const stopsOfTrip = db.prepare("SELECT stop_id, CAST(stop_sequence AS INTEGER) AS seq FROM stop_times WHERE trip_id = ? ORDER BY seq");
  const tripStops = (tripId) => {
    const t = trips.get(tripId);
    if (!t) return null;
    if (!t.stops) t.stops = stopsOfTrip.all(tripId).map((r) => ({ stop: r.stop_id, seq: r.seq }));
    return t.stops;
  };
  return { trips, routes, stops, agencies, bbox: stops.size ? [minLat, minLon, maxLat, maxLon] : null, tripStops };
};

/** Check a decoded FeedMessage against the static index. */
const checkFeed = (feed, idx, { now = Math.floor(Date.now() / 1000) } = {}) => {
  const findings = new Map();
  const entities = Array.isArray(feed.entity) ? feed.entity : [];
  const summary = { entities: entities.length, trip_updates: 0, vehicle_positions: 0, alerts: 0, header_timestamp: feed.header?.timestamp ?? null, version: feed.header?.gtfsRealtimeVersion || feed.header?.gtfs_realtime_version || null };
  if (!feed.header) finding(findings, "missing_header", "error", "The feed has no header.");
  else {
    if (!summary.version) finding(findings, "missing_version", "warning", "header.gtfs_realtime_version is missing.");
    if (summary.header_timestamp != null) {
      const age = now - Number(summary.header_timestamp);
      if (age > STALE_HEADER_S) finding(findings, "stale_header", "warning", `The header timestamp is ${Math.round(age / 60)} min old.`, { age_s: age });
      if (age < -FUTURE_S) finding(findings, "future_header", "error", "The header timestamp is in the future.", { age_s: age });
    } else finding(findings, "missing_header_timestamp", "warning", "header.timestamp is missing.");
  }
  const seenIds = new Set();
  const inBox = (lat, lon) => {
    if (!idx.bbox) return true;
    const [s, w, n, e] = idx.bbox;
    const dLat = OUTSIDE_MARGIN_M / 111320;
    const dLon = OUTSIDE_MARGIN_M / (111320 * Math.max(0.2, Math.cos(((s + n) / 2) * (Math.PI / 180))));
    return lat >= s - dLat && lat <= n + dLat && lon >= w - dLon && lon <= e + dLon;
  };
  for (const e of entities) {
    const id = e.id;
    if (!id) finding(findings, "missing_entity_id", "error", "An entity has no id.");
    else if (seenIds.has(id)) finding(findings, "duplicate_entity_id", "error", "Entity ids are duplicated.", { id });
    seenIds.add(id);
    const tu = e.tripUpdate || e.trip_update;
    const vp = e.vehicle;
    const al = e.alert;
    if (!tu && !vp && !al) finding(findings, "empty_entity", "warning", "An entity carries no trip update, vehicle position or alert.", { id });
    if (tu) {
      summary.trip_updates += 1;
      const trip = tu.trip || {};
      const tripId = trip.tripId || trip.trip_id;
      const routeId = trip.routeId || trip.route_id;
      const rel = trip.scheduleRelationship || trip.schedule_relationship || "SCHEDULED";
      if (tripId && !idx.trips.has(tripId) && rel !== "ADDED" && rel !== "NEW") finding(findings, "unknown_trip", "error", "Trip updates reference trips missing from the static feed.", { id, trip_id: tripId });
      if (!tripId && !routeId) finding(findings, "trip_descriptor_empty", "error", "A trip update has neither trip_id nor route_id.", { id });
      if (routeId && !idx.routes.has(routeId)) finding(findings, "unknown_route", "error", "Trip updates reference routes missing from the static feed.", { id, route_id: routeId });
      if (tripId && routeId && idx.trips.has(tripId) && idx.trips.get(tripId).route !== routeId) finding(findings, "route_mismatch", "warning", "The trip update's route_id differs from the trip's route in the static feed.", { id, trip_id: tripId, route_id: routeId });
      const updates = tu.stopTimeUpdate || tu.stop_time_update || [];
      const staticStops = tripId && idx.trips.has(tripId) ? idx.tripStops(tripId) : null;
      let lastSeq = -1;
      let lastTime = -1;
      for (const u of updates) {
        const seq = u.stopSequence ?? u.stop_sequence;
        const sid = u.stopId || u.stop_id;
        if (seq != null) {
          if (seq <= lastSeq) finding(findings, "stop_sequence_order", "error", "stop_time_updates are not in increasing stop_sequence order.", { id, trip_id: tripId, stop_sequence: seq });
          lastSeq = seq;
        }
        if (sid && !idx.stops.has(sid)) finding(findings, "unknown_stop", "error", "Stop time updates reference stops missing from the static feed.", { id, stop_id: sid });
        else if (sid && staticStops && !staticStops.some((s) => s.stop && s.stop === sid)) finding(findings, "stop_not_on_trip", "error", "A stop time update names a stop the trip does not serve.", { id, trip_id: tripId, stop_id: sid });
        for (const key of ["arrival", "departure"]) {
          const ev = u[key];
          if (!ev) continue;
          if (ev.delay != null && Math.abs(Number(ev.delay)) > MAX_DELAY_S) finding(findings, "absurd_delay", "warning", `A ${key} delay exceeds ${MAX_DELAY_S / 3600} hours.`, { id, trip_id: tripId, delay: Number(ev.delay) });
          if (ev.time != null) {
            const tt = Number(ev.time);
            if (tt < lastTime) finding(findings, "time_order", "error", "Predicted times decrease along the trip.", { id, trip_id: tripId });
            lastTime = Math.max(lastTime, tt);
            if (tt < now - 24 * 3600 || tt > now + 24 * 3600) finding(findings, "time_out_of_day", "warning", "A predicted time is more than a day away from now.", { id, trip_id: tripId, time: tt });
          }
        }
      }
      if (rel === "SCHEDULED" && !updates.length && tu.delay == null) finding(findings, "trip_update_empty", "warning", "A scheduled trip update carries no stop time update nor delay.", { id, trip_id: tripId });
    }
    if (vp) {
      summary.vehicle_positions += 1;
      const trip = vp.trip || {};
      const tripId = trip.tripId || trip.trip_id;
      if (tripId && !idx.trips.has(tripId)) finding(findings, "unknown_trip", "error", "Vehicle positions reference trips missing from the static feed.", { id, trip_id: tripId });
      const pos = vp.position;
      if (!pos || pos.latitude == null || pos.longitude == null) finding(findings, "missing_position", "error", "A vehicle position has no coordinates.", { id });
      else {
        if (Math.abs(pos.latitude) > 90 || Math.abs(pos.longitude) > 180 || (pos.latitude === 0 && pos.longitude === 0)) finding(findings, "invalid_position", "error", "A vehicle position is out of range (or at 0,0).", { id, lat: pos.latitude, lon: pos.longitude });
        else if (!inBox(pos.latitude, pos.longitude)) finding(findings, "vehicle_outside_network", "warning", `A vehicle is more than ${OUTSIDE_MARGIN_M / 1000} km outside the network's stops.`, { id, lat: pos.latitude, lon: pos.longitude });
        if (pos.speed != null && pos.speed > MAX_SPEED_MPS) finding(findings, "absurd_speed", "warning", "A vehicle reports a speed above 216 km/h.", { id, speed: pos.speed });
      }
      if (vp.timestamp != null) {
        const age = now - Number(vp.timestamp);
        if (age > STALE_VEHICLE_S) finding(findings, "stale_vehicle", "warning", `A vehicle position is older than ${STALE_VEHICLE_S / 60} min.`, { id, age_s: age });
        if (age < -FUTURE_S) finding(findings, "future_vehicle", "error", "A vehicle timestamp is in the future.", { id, age_s: age });
      }
      const sid = vp.stopId || vp.stop_id;
      if (sid && !idx.stops.has(sid)) finding(findings, "unknown_stop", "error", "Vehicle positions reference stops missing from the static feed.", { id, stop_id: sid });
    }
    if (al) {
      summary.alerts += 1;
      const texts = (al.headerText || al.header_text)?.translation || [];
      if (!texts.length || !texts.some((x) => x.text && x.text.trim())) finding(findings, "alert_without_text", "error", "An alert has no header text.", { id });
      const informed = al.informedEntity || al.informed_entity || [];
      if (!informed.length) finding(findings, "alert_without_entity", "warning", "An alert informs no entity (network-wide?).", { id });
      for (const ie of informed) {
        if (ie.routeId && !idx.routes.has(ie.routeId)) finding(findings, "unknown_route", "error", "Alerts reference routes missing from the static feed.", { id, route_id: ie.routeId });
        if (ie.stopId && !idx.stops.has(ie.stopId)) finding(findings, "unknown_stop", "error", "Alerts reference stops missing from the static feed.", { id, stop_id: ie.stopId });
        const tid = ie.trip?.tripId || ie.trip?.trip_id;
        if (tid && !idx.trips.has(tid)) finding(findings, "unknown_trip", "error", "Alerts reference trips missing from the static feed.", { id, trip_id: tid });
        if (ie.agencyId && idx.agencies.size && !idx.agencies.has(ie.agencyId)) finding(findings, "unknown_agency", "warning", "Alerts reference an unknown agency_id.", { id, agency_id: ie.agencyId });
      }
      for (const p of al.activePeriod || al.active_period || []) if (p.start != null && p.end != null && Number(p.end) < Number(p.start)) finding(findings, "alert_period_inverted", "error", "An alert's active period ends before it starts.", { id });
    }
  }
  const list = [...findings.values()].sort((a, b) => (a.severity === "error" ? 0 : 1) - (b.severity === "error" ? 0 : 1) || b.count - a.count);
  const counts = { error: list.filter((f) => f.severity === "error").length, warning: list.filter((f) => f.severity === "warning").length };
  return { summary, counts, findings: list, ok: counts.error === 0 };
};

const fetchFeed = async (url, fetchImpl) => {
  if (!/^https?:\/\//i.test(String(url))) throw Object.assign(new Error("url must be http(s)."), { status: 400, code: "INVALID_INPUT" });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: ctl.signal, headers: { "User-Agent": "gtfs-express/1.0 (realtime check)", Accept: "application/x-protobuf, application/octet-stream, application/json;q=0.8" } });
    if (!res.ok) throw Object.assign(new Error(`Realtime feed: HTTP ${res.status}`), { status: 502, code: "FEED_UNAVAILABLE" });
    const ct = res.headers?.get?.("content-type") || "";
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw Object.assign(new Error("The realtime feed exceeds 20 MB."), { status: 413, code: "FEED_TOO_LARGE" });
    if (/json/i.test(ct) || buf[0] === 0x7b) return decodeFeed({ json: JSON.parse(buf.toString("utf8")) });
    return decodeFeed({ buffer: buf });
  } finally {
    clearTimeout(timer);
  }
};

// ── HTTP ───────────────────────────────────────────────────────────────────

const validateRealtime = async (req, res) => {
  const ctx = requireSession(req, res);
  if (!ctx) return;
  try {
    let feed;
    if (Buffer.isBuffer(req.body) && req.body.length) feed = decodeFeed({ buffer: req.body });
    else if (req.body && typeof req.body === "object" && req.body.feed) feed = decodeFeed({ json: req.body.feed });
    else if (req.body && typeof req.body.url === "string") feed = await fetchFeed(req.body.url.trim(), validateRealtime._fetch || fetch);
    else return res.status(400).json({ error: "INVALID_INPUT", message: "Send a protobuf body, { feed } as JSON, or { url }." });
    const result = checkFeed(feed, staticIndex(ctx.db));
    res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.code || "REALTIME_FAILED", message: err.message });
    res.status(400).json({ error: "INVALID_FEED", message: `Could not decode the realtime feed: ${err.message}` });
  }
};

module.exports = { decodeFeed, checkFeed, staticIndex, fetchFeed, validateRealtime };
