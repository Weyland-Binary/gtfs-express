/**
 * smartEditService.js — multi-row operations the assistant can plan and the
 * user applies in one click ("talk-to-edit"):
 *
 *   • insertStopInPattern  — add a stop to every trip of a route/direction
 *                            between two existing stops, times interpolated
 *                            from the real distances.
 *   • mergeStops           — fold duplicate stops into a survivor: every
 *                            reference (stop_times, transfers, pathways,
 *                            children, areas…) is re-pointed, the duplicates
 *                            deleted, optional fields back-filled.
 *   • renameStopsBatch     — rename many stops at once (name harmonisation).
 *   • extendCalendar       — push the end_date of services (and feed_info).
 *
 * Every operation exposes a pure `plan*(db, body)` (used by the chat tools
 * and by `dry_run`) and an Express handler that applies the plan in ONE
 * transaction with ONE `_edit_log` entry (undo + redo ops), then re-syncs the
 * in-memory CSV cache.
 */

"use strict";

const {
  requireEditMode,
  logEdit,
  syncCacheEntry,
  syncCacheStopTimes,
  respondWithValidation,
  isValidGtfsTime,
  DATE_YYYYMMDD,
} = require("./_editCore");
const { haversineMeters, pointToPolylineDistance } = require("../../utils/geoUtils");

const MAX_PATTERN_TRIPS = 500;
const MAX_MERGE_DUPLICATES = 50;
const MAX_RENAMES = 500;
const MAX_EXTEND_SERVICES = 500;
const SHAPE_REVIEW_M = 50;
const DEFAULT_SPEED_MPS = 6; // ~22 km/h, used when a segment has no usable time

const timeToSec = (t) => {
  if (t === null || t === undefined || t === "" || !isValidGtfsTime(String(t))) return null;
  const [h, m, s] = String(t).split(":").map((p) => parseInt(p, 10));
  return h * 3600 + m * 60 + s;
};
const secToTime = (total) => {
  const v = Math.max(0, Math.round(total));
  const h = Math.floor(v / 3600);
  const m = Math.floor((v % 3600) / 60);
  const s = v % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};
const num = (v) => {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v) => (typeof v === "string" ? v.trim() : "");
const idList = (v, max) => {
  if (!Array.isArray(v)) return [];
  const out = [];
  const seen = new Set();
  for (const x of v) {
    const s = str(x);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length > max) break;
  }
  return out;
};

// ═════════════════════════════════════════════════════════════════════════════
// 1. Insert a stop in a pattern
// ═════════════════════════════════════════════════════════════════════════════

const selectTrips = (db, body, max) => {
  const tripIds = idList(body.trip_ids, max);
  if (tripIds.length > 0) {
    const exists = db.prepare("SELECT trip_id, route_id, direction_id, shape_id FROM trips WHERE trip_id = ?");
    const rows = [];
    const missing = [];
    for (const id of tripIds) {
      const r = exists.get(id);
      if (r) rows.push(r);
      else missing.push(id);
    }
    return { rows, missing };
  }
  const routeId = str(body.route_id);
  if (!routeId) return { rows: [], missing: [], error: "Give trip_ids or a route_id." };
  const where = ["route_id = ?"];
  const args = [routeId];
  if (body.direction_id !== undefined && body.direction_id !== null && body.direction_id !== "") {
    where.push("direction_id = ?");
    args.push(String(body.direction_id));
  }
  if (str(body.service_id)) {
    where.push("service_id = ?");
    args.push(str(body.service_id));
  }
  const rows = db
    .prepare(`SELECT trip_id, route_id, direction_id, shape_id FROM trips WHERE ${where.join(" AND ")} ORDER BY trip_id LIMIT ${max + 1}`)
    .all(...args);
  return { rows, missing: [] };
};

/**
 * Plan the insertion of `stop_id` in the selected trips, after `after_stop_id`
 * and/or before `before_stop_id` (when both are given they must be
 * consecutive in the trip). Times are interpolated between the neighbours
 * pro rata of the straight-line distances; at the ends of a trip the speed of
 * the adjacent segment is reused. Trips already serving the stop, or not
 * serving the anchor, are skipped and counted.
 */
const planStopInsertion = (db, body) => {
  const stopId = str(body.stop_id);
  if (!stopId) return { ok: false, status: 400, error: "stop_id is required." };
  const stop = db.prepare("SELECT stop_id, stop_name, stop_lat, stop_lon FROM stops WHERE stop_id = ?").get(stopId);
  if (!stop) return { ok: false, status: 404, error: `Stop not found: ${stopId}` };
  const afterId = str(body.after_stop_id);
  const beforeId = str(body.before_stop_id);
  if (!afterId && !beforeId) return { ok: false, status: 400, error: "after_stop_id or before_stop_id is required." };
  if (afterId === stopId || beforeId === stopId) return { ok: false, status: 400, error: "The anchor stop cannot be the inserted stop." };
  const stopRow = db.prepare("SELECT stop_id FROM stops WHERE stop_id = ?");
  for (const anchor of [afterId, beforeId]) {
    if (anchor && !stopRow.get(anchor)) return { ok: false, status: 404, error: `Stop not found: ${anchor}` };
  }
  const sel = selectTrips(db, body, MAX_PATTERN_TRIPS);
  if (sel.error) return { ok: false, status: 400, error: sel.error };
  if (sel.missing.length) return { ok: false, status: 404, error: `Trip not found: ${sel.missing.slice(0, 5).join(", ")}` };
  if (sel.rows.length === 0) return { ok: false, status: 404, error: "No trip matches the selection." };
  if (sel.rows.length > MAX_PATTERN_TRIPS) return { ok: false, status: 400, error: `Too many trips (limit ${MAX_PATTERN_TRIPS}); narrow the selection.` };

  const coords = new Map();
  const coordOf = (id) => {
    if (!coords.has(id)) {
      const r = db.prepare("SELECT stop_lat, stop_lon FROM stops WHERE stop_id = ?").get(id);
      const lat = r ? num(r.stop_lat) : null;
      const lon = r ? num(r.stop_lon) : null;
      coords.set(id, lat != null && lon != null ? { lat, lon } : null);
    }
    return coords.get(id);
  };
  const dist = (a, b) => {
    const ca = coordOf(a);
    const cb = coordOf(b);
    return ca && cb ? haversineMeters(ca.lat, ca.lon, cb.lat, cb.lon) : null;
  };
  const stStmt = db.prepare(
    "SELECT stop_id, stop_sequence, arrival_time, departure_time, shape_dist_traveled, stop_headsign, pickup_type, drop_off_type, timepoint FROM stop_times WHERE trip_id = ? ORDER BY CAST(stop_sequence AS INTEGER)",
  );

  const plans = [];
  const skipped = { already_present: 0, no_anchor: 0, not_consecutive: 0 };
  for (const trip of sel.rows) {
    const rows = stStmt.all(trip.trip_id);
    if (rows.some((r) => r.stop_id === stopId)) {
      skipped.already_present += 1;
      continue;
    }
    let prevIdx = -1;
    let nextIdx = -1;
    if (afterId) {
      prevIdx = rows.findIndex((r) => r.stop_id === afterId);
      if (prevIdx < 0) {
        skipped.no_anchor += 1;
        continue;
      }
      if (beforeId) {
        nextIdx = rows.findIndex((r, i) => i > prevIdx && r.stop_id === beforeId);
        if (nextIdx !== prevIdx + 1) {
          skipped[nextIdx < 0 ? "no_anchor" : "not_consecutive"] += 1;
          continue;
        }
      } else {
        nextIdx = prevIdx + 1 < rows.length ? prevIdx + 1 : -1;
      }
    } else {
      nextIdx = rows.findIndex((r) => r.stop_id === beforeId);
      if (nextIdx < 0) {
        skipped.no_anchor += 1;
        continue;
      }
      prevIdx = nextIdx - 1;
    }
    const prev = prevIdx >= 0 ? rows[prevIdx] : null;
    const next = nextIdx >= 0 ? rows[nextIdx] : null;
    // Times.
    const tPrev = prev ? (timeToSec(prev.departure_time) ?? timeToSec(prev.arrival_time)) : null;
    const tNext = next ? (timeToSec(next.arrival_time) ?? timeToSec(next.departure_time)) : null;
    const dA = prev ? dist(prev.stop_id, stopId) : null;
    const dB = next ? dist(stopId, next.stop_id) : null;
    let t = null;
    let ratio = null;
    if (prev && next) {
      ratio = dA != null && dB != null && dA + dB > 0 ? dA / (dA + dB) : 0.5;
      if (tPrev != null && tNext != null) t = tPrev + (tNext - tPrev) * ratio;
    } else if (prev && tPrev != null) {
      // Append: reuse the speed of the segment before `prev`.
      const before = prevIdx > 0 ? rows[prevIdx - 1] : null;
      const dSeg = before ? dist(before.stop_id, prev.stop_id) : null;
      const tSeg = before ? (timeToSec(prev.arrival_time) ?? tPrev) - (timeToSec(before.departure_time) ?? timeToSec(before.arrival_time) ?? 0) : null;
      const speed = dSeg && tSeg > 0 ? dSeg / tSeg : DEFAULT_SPEED_MPS;
      t = tPrev + (dA != null ? dA / speed : 60);
    } else if (next && tNext != null) {
      const after = nextIdx + 1 < rows.length ? rows[nextIdx + 1] : null;
      const dSeg = after ? dist(next.stop_id, after.stop_id) : null;
      const tSeg = after ? (timeToSec(after.arrival_time) ?? 0) - (timeToSec(next.departure_time) ?? tNext) : null;
      const speed = dSeg && tSeg > 0 ? dSeg / tSeg : DEFAULT_SPEED_MPS;
      t = tNext - (dB != null ? dB / speed : 60);
    }
    const time = t != null ? secToTime(t) : null;
    // shape_dist_traveled: interpolate when both neighbours carry it.
    let sdt = null;
    const sPrev = prev ? num(prev.shape_dist_traveled) : null;
    const sNext = next ? num(next.shape_dist_traveled) : null;
    if (sPrev != null && sNext != null && ratio != null) sdt = Math.round((sPrev + (sNext - sPrev) * ratio) * 1000) / 1000;
    // Sequence: use the gap when there is one, renumber otherwise.
    const prevSeq = prev ? Number(prev.stop_sequence) : null;
    const nextSeq = next ? Number(next.stop_sequence) : null;
    let seq;
    let renumberFrom = null;
    if (prev && next) {
      if (nextSeq - prevSeq > 1) seq = Math.floor((prevSeq + nextSeq) / 2);
      else {
        seq = nextSeq;
        renumberFrom = nextSeq;
      }
    } else if (prev) {
      seq = prevSeq + 1;
    } else {
      seq = nextSeq;
      renumberFrom = nextSeq;
    }
    plans.push({
      trip_id: trip.trip_id,
      shape_id: trip.shape_id || null,
      stop_sequence: seq,
      renumber_from: renumberFrom,
      arrival_time: time,
      departure_time: time,
      shape_dist_traveled: sdt,
      stop_headsign: prev ? prev.stop_headsign : next ? next.stop_headsign : null,
      after: prev ? prev.stop_id : null,
      before: next ? next.stop_id : null,
      distance_m: dA != null || dB != null ? Math.round((dA || 0) + (dB || 0)) : null,
    });
  }
  if (plans.length === 0) {
    return {
      ok: false,
      status: 409,
      error:
        skipped.already_present > 0 && skipped.no_anchor === 0
          ? "Every selected trip already serves this stop."
          : "No selected trip serves the anchor stop(s) in that order.",
      skipped,
    };
  }
  // Shapes: flag the ones running far from the new stop (the Shape Studio
  // re-fits them; we never guess a road geometry here).
  const shapesToReview = [];
  const c = coordOf(stopId);
  if (c) {
    const shapeIds = [...new Set(plans.map((p) => p.shape_id).filter(Boolean))].slice(0, 50);
    const pts = db.prepare("SELECT shape_pt_lat AS lat, shape_pt_lon AS lon FROM shapes WHERE shape_id = ? ORDER BY CAST(shape_pt_sequence AS INTEGER)");
    for (const sid of shapeIds) {
      const points = pts.all(sid).map((p) => ({ lat: num(p.lat), lon: num(p.lon) })).filter((p) => p.lat != null && p.lon != null);
      if (points.length < 2) continue;
      const d = pointToPolylineDistance(c.lat, c.lon, points);
      if (Number.isFinite(d) && d > SHAPE_REVIEW_M) shapesToReview.push({ shape_id: sid, distance_m: Math.round(d) });
    }
  }
  const routeId = str(body.route_id) || sel.rows[0].route_id;
  return {
    ok: true,
    stop: { stop_id: stop.stop_id, stop_name: stop.stop_name },
    route_id: routeId,
    direction_id: body.direction_id != null && body.direction_id !== "" ? String(body.direction_id) : null,
    after_stop_id: afterId || null,
    before_stop_id: beforeId || null,
    trips: plans,
    skipped,
    shapes_to_review: shapesToReview,
  };
};

const ST_INSERT_FIELDS = ["trip_id", "stop_id", "stop_sequence", "arrival_time", "departure_time", "stop_headsign", "shape_dist_traveled", "timepoint"];

const insertStopInPattern = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const body = req.body || {};
    const plan = planStopInsertion(db, body);
    if (!plan.ok) return res.status(plan.status).json({ error: plan.error, skipped: plan.skipped });
    const summary = {
      stop: plan.stop,
      route_id: plan.route_id,
      direction_id: plan.direction_id,
      after_stop_id: plan.after_stop_id,
      before_stop_id: plan.before_stop_id,
      trips: plan.trips.map((t) => ({ trip_id: t.trip_id, stop_sequence: t.stop_sequence, arrival_time: t.arrival_time, after: t.after, before: t.before })),
      skipped: plan.skipped,
      shapes_to_review: plan.shapes_to_review,
    };
    if (body.dry_run) return res.json({ dry_run: true, ...summary });

    const undoOps = [];
    const redoOps = [];
    const insertSql = `INSERT INTO stop_times (${ST_INSERT_FIELDS.join(", ")}) VALUES (${ST_INSERT_FIELDS.map(() => "?").join(", ")})`;
    for (const t of plan.trips) {
      if (t.renumber_from != null) {
        redoOps.push({ sql: "UPDATE stop_times SET stop_sequence = -stop_sequence WHERE trip_id = ? AND stop_sequence >= ?", params: [t.trip_id, t.renumber_from] });
        redoOps.push({ sql: "UPDATE stop_times SET stop_sequence = (-stop_sequence) + 1 WHERE trip_id = ? AND stop_sequence < 0", params: [t.trip_id] });
      }
      redoOps.push({
        sql: insertSql,
        params: [t.trip_id, plan.stop.stop_id, t.stop_sequence, t.arrival_time, t.departure_time, t.stop_headsign, t.shape_dist_traveled, t.arrival_time ? "0" : null],
      });
      undoOps.push({ sql: "DELETE FROM stop_times WHERE trip_id = ? AND stop_sequence = ? AND stop_id = ?", params: [t.trip_id, t.stop_sequence, plan.stop.stop_id] });
      if (t.renumber_from != null) {
        undoOps.push({ sql: "UPDATE stop_times SET stop_sequence = -stop_sequence WHERE trip_id = ? AND stop_sequence > ?", params: [t.trip_id, t.renumber_from] });
        undoOps.push({ sql: "UPDATE stop_times SET stop_sequence = (-stop_sequence) - 1 WHERE trip_id = ? AND stop_sequence < 0", params: [t.trip_id] });
      }
    }
    let undoEntryId = null;
    const tx = db.transaction(() => {
      undoEntryId = logEdit(db, {
        entity: "trip",
        entityId: plan.trips.map((t) => t.trip_id).join(","),
        action: "stop_times_batch",
        description: `Inserted stop ${plan.stop.stop_id} in ${plan.trips.length} trip(s) of route ${plan.route_id}${plan.after_stop_id ? ` after ${plan.after_stop_id}` : ""}${plan.before_stop_id ? ` before ${plan.before_stop_id}` : ""}`,
        undoOps,
        redoOps,
      });
      for (const op of redoOps) db.prepare(op.sql).run(op.params);
    });
    tx.immediate();
    for (const t of plan.trips) syncCacheStopTimes(sessionId, db, t.trip_id);
    await respondWithValidation(res, sessionId, "trip", plan.trips[0].trip_id, { ...summary, inserted: plan.trips.length, undoEntryId }, { status: 201 });
  } catch (err) {
    console.error("insertStopInPattern error:", err);
    res.status(500).json({ error: err.message });
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// 2. Merge stops
// ═════════════════════════════════════════════════════════════════════════════

// Every column referencing stops.stop_id, with how a clash is resolved.
const STOP_REFS = [
  { table: "stop_times", col: "stop_id" },
  { table: "stops", col: "parent_station" },
  { table: "transfers", col: "from_stop_id" },
  { table: "transfers", col: "to_stop_id" },
  { table: "pathways", col: "from_stop_id" },
  { table: "pathways", col: "to_stop_id" },
  { table: "stop_areas", col: "stop_id", unique: ["area_id"] },
  { table: "location_group_stops", col: "stop_id", unique: ["location_group_id"] },
  { table: "fare_leg_join_rules", col: "from_stop_id" },
  { table: "fare_leg_join_rules", col: "to_stop_id" },
];
const FILLABLE_STOP_FIELDS = ["stop_code", "stop_desc", "zone_id", "stop_url", "wheelchair_boarding", "platform_code", "level_id", "tts_stop_name", "stop_timezone"];

const tableExists = (db, table) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));

const planStopMerge = (db, body) => {
  const survivorId = str(body.survivor_id);
  if (!survivorId) return { ok: false, status: 400, error: "survivor_id is required." };
  const dups = idList(body.duplicate_ids, MAX_MERGE_DUPLICATES).filter((d) => d !== survivorId);
  if (dups.length === 0) return { ok: false, status: 400, error: "duplicate_ids must list at least one other stop." };
  if (dups.length > MAX_MERGE_DUPLICATES) return { ok: false, status: 400, error: `Too many duplicates (limit ${MAX_MERGE_DUPLICATES}).` };
  const stopStmt = db.prepare("SELECT * FROM stops WHERE stop_id = ?");
  const survivor = stopStmt.get(survivorId);
  if (!survivor) return { ok: false, status: 404, error: `Stop not found: ${survivorId}` };
  const dupRows = [];
  for (const id of dups) {
    const r = stopStmt.get(id);
    if (!r) return { ok: false, status: 404, error: `Stop not found: ${id}` };
    dupRows.push(r);
  }
  const dupSet = new Set(dups);
  const ph = dups.map(() => "?").join(",");
  const refs = [];
  const byTable = {};
  for (const ref of STOP_REFS) {
    if (!tableExists(db, ref.table)) continue;
    const rows = db.prepare(`SELECT rowid AS _rid, * FROM ${ref.table} WHERE ${ref.col} IN (${ph})`).all(...dups);
    for (const row of rows) {
      let action = "repoint";
      if (ref.unique) {
        const clash = db
          .prepare(`SELECT 1 FROM ${ref.table} WHERE ${ref.col} = ? AND ${ref.unique.map((c) => `${c} = ?`).join(" AND ")}`)
          .get(survivorId, ...ref.unique.map((c) => row[c]));
        if (clash) action = "delete";
      }
      refs.push({ table: ref.table, col: ref.col, rowid: row._rid, old: row[ref.col], action, row });
      byTable[ref.table] = (byTable[ref.table] || 0) + 1;
    }
  }
  // Trips that would end up serving the survivor twice.
  const tripsWithBoth = db
    .prepare(
      `SELECT COUNT(DISTINCT a.trip_id) AS n FROM stop_times a JOIN stop_times b ON a.trip_id = b.trip_id
        WHERE a.stop_id = ? AND b.stop_id IN (${ph})`,
    )
    .get(survivorId, ...dups).n;
  // Survivor's own parent can be one of the duplicates.
  let survivorParent;
  if (survivor.parent_station && dupSet.has(survivor.parent_station)) {
    const p = dupRows.find((d) => d.stop_id === survivor.parent_station);
    survivorParent = p && p.parent_station && !dupSet.has(p.parent_station) ? p.parent_station : null;
  }
  // Optional fields back-filled from the duplicates.
  const filled = {};
  if (body.fill_missing !== false) {
    for (const f of FILLABLE_STOP_FIELDS) {
      if (survivor[f] !== null && survivor[f] !== undefined && survivor[f] !== "") continue;
      const donor = dupRows.find((d) => d[f] !== null && d[f] !== undefined && d[f] !== "");
      if (donor) filled[f] = donor[f];
    }
  }
  const distances = dupRows.map((d) => {
    const a = [num(survivor.stop_lat), num(survivor.stop_lon)];
    const b = [num(d.stop_lat), num(d.stop_lon)];
    return a[0] != null && a[1] != null && b[0] != null && b[1] != null ? Math.round(haversineMeters(a[0], a[1], b[0], b[1])) : null;
  });
  return {
    ok: true,
    survivor: { stop_id: survivor.stop_id, stop_name: survivor.stop_name, row: survivor },
    duplicates: dupRows.map((d, i) => ({
      stop_id: d.stop_id,
      stop_name: d.stop_name,
      distance_m: distances[i],
      stop_times: refs.filter((r) => r.table === "stop_times" && r.old === d.stop_id).length,
    })),
    refs,
    by_table: byTable,
    trips_with_both: tripsWithBoth,
    survivor_parent: survivorParent,
    filled,
    dupRows,
  };
};

const mergeStops = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const body = req.body || {};
    const plan = planStopMerge(db, body);
    if (!plan.ok) return res.status(plan.status).json({ error: plan.error });
    const summary = {
      survivor: { stop_id: plan.survivor.stop_id, stop_name: plan.survivor.stop_name },
      duplicates: plan.duplicates,
      by_table: plan.by_table,
      trips_with_both: plan.trips_with_both,
      filled: plan.filled,
    };
    if (body.dry_run) return res.json({ dry_run: true, ...summary });

    const survivorId = plan.survivor.stop_id;
    const redoOps = [];
    const undoOps = [];
    // Undo starts by restoring the deleted stops (children FKs are SET NULL,
    // so the rows must exist again before references are pointed back).
    for (const d of plan.dupRows) {
      const cols = Object.keys(d);
      undoOps.push({ sql: `INSERT INTO stops (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, params: cols.map((c) => d[c]) });
    }
    for (const r of plan.refs) {
      if (r.action === "delete") {
        const cols = Object.keys(r.row).filter((c) => c !== "_rid");
        redoOps.push({ sql: `DELETE FROM ${r.table} WHERE rowid = ?`, params: [r.rowid] });
        undoOps.push({ sql: `INSERT INTO ${r.table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, params: cols.map((c) => r.row[c]) });
      } else {
        redoOps.push({ sql: `UPDATE ${r.table} SET ${r.col} = ? WHERE rowid = ?`, params: [survivorId, r.rowid] });
        undoOps.push({ sql: `UPDATE ${r.table} SET ${r.col} = ? WHERE rowid = ?`, params: [r.old, r.rowid] });
      }
    }
    const survivorSets = [];
    const survivorVals = [];
    const survivorOld = [];
    if (plan.survivor_parent !== undefined) {
      survivorSets.push("parent_station = ?");
      survivorVals.push(plan.survivor_parent);
      survivorOld.push(plan.survivor.row.parent_station);
    }
    for (const [f, v] of Object.entries(plan.filled)) {
      survivorSets.push(`${f} = ?`);
      survivorVals.push(v);
      survivorOld.push(plan.survivor.row[f]);
    }
    if (survivorSets.length) {
      redoOps.push({ sql: `UPDATE stops SET ${survivorSets.join(", ")} WHERE stop_id = ?`, params: [...survivorVals, survivorId] });
      undoOps.push({ sql: `UPDATE stops SET ${survivorSets.join(", ")} WHERE stop_id = ?`, params: [...survivorOld, survivorId] });
    }
    for (const d of plan.dupRows) redoOps.push({ sql: "DELETE FROM stops WHERE stop_id = ?", params: [d.stop_id] });

    const dupIds = plan.dupRows.map((d) => d.stop_id);
    let undoEntryId = null;
    const tx = db.transaction(() => {
      undoEntryId = logEdit(db, {
        entity: "stop",
        entityId: [survivorId, ...dupIds].join(","),
        action: "merge",
        description: `Merged ${dupIds.length} stop(s) (${dupIds.join(", ")}) into ${survivorId}${plan.survivor.stop_name ? ` (${plan.survivor.stop_name})` : ""}: ${Object.entries(plan.by_table).map(([t, n]) => `${n} ${t}`).join(", ") || "no reference"}`,
        undoOps,
        redoOps,
      });
      for (const op of redoOps) db.prepare(op.sql).run(op.params);
    });
    tx.immediate();

    syncCacheEntry(sessionId, db, "stop", survivorId);
    for (const id of dupIds) syncCacheEntry(sessionId, db, "stop", id);
    const touched = Object.keys(plan.by_table).filter((t) => t !== "stops");
    if (touched.length) {
      const { resyncCacheForTables } = require("./sqlConsoleService");
      resyncCacheForTables(sessionId, db, touched);
    }
    await respondWithValidation(res, sessionId, "stop", survivorId, { ...summary, merged: dupIds.length, undoEntryId });
  } catch (err) {
    console.error("mergeStops error:", err);
    res.status(500).json({ error: err.message });
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// 3. Rename stops in batch
// ═════════════════════════════════════════════════════════════════════════════

const planStopRenames = (db, body) => {
  const input = Array.isArray(body.renames) ? body.renames : [];
  if (input.length === 0) return { ok: false, status: 400, error: "renames must be a non-empty array of {stop_id, stop_name}." };
  if (input.length > MAX_RENAMES) return { ok: false, status: 400, error: `Too many renames (limit ${MAX_RENAMES}).` };
  const stmt = db.prepare("SELECT stop_id, stop_name FROM stops WHERE stop_id = ?");
  const renames = [];
  const seen = new Set();
  let unchanged = 0;
  for (const r of input) {
    const id = str(r && r.stop_id);
    const name = typeof (r && r.stop_name) === "string" ? r.stop_name.replace(/\s+/g, " ").trim() : "";
    if (!id) return { ok: false, status: 400, error: "Every rename needs a stop_id." };
    if (!name) return { ok: false, status: 400, error: `Empty stop_name for ${id}.` };
    if (seen.has(id)) continue;
    seen.add(id);
    const row = stmt.get(id);
    if (!row) return { ok: false, status: 404, error: `Stop not found: ${id}` };
    if ((row.stop_name || "") === name) {
      unchanged += 1;
      continue;
    }
    renames.push({ stop_id: id, old_name: row.stop_name || "", stop_name: name });
  }
  if (renames.length === 0) return { ok: false, status: 409, error: "Nothing to rename: every stop already has that name." };
  return { ok: true, renames, unchanged };
};

const renameStopsBatch = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const body = req.body || {};
    const plan = planStopRenames(db, body);
    if (!plan.ok) return res.status(plan.status).json({ error: plan.error });
    if (body.dry_run) return res.json({ dry_run: true, renames: plan.renames, unchanged: plan.unchanged });
    const redoOps = plan.renames.map((r) => ({ sql: "UPDATE stops SET stop_name = ? WHERE stop_id = ?", params: [r.stop_name, r.stop_id] }));
    const undoOps = plan.renames.map((r) => ({ sql: "UPDATE stops SET stop_name = ? WHERE stop_id = ?", params: [r.old_name || null, r.stop_id] }));
    let undoEntryId = null;
    const tx = db.transaction(() => {
      undoEntryId = logEdit(db, {
        entity: "stop",
        entityId: plan.renames.map((r) => r.stop_id).join(","),
        action: "bulk_update",
        description: `Renamed ${plan.renames.length} stop(s): ${plan.renames.slice(0, 3).map((r) => `${r.old_name} → ${r.stop_name}`).join("; ")}${plan.renames.length > 3 ? "; …" : ""}`,
        undoOps,
        redoOps,
      });
      for (const op of redoOps) db.prepare(op.sql).run(op.params);
    });
    tx.immediate();
    for (const r of plan.renames) syncCacheEntry(sessionId, db, "stop", r.stop_id);
    await respondWithValidation(res, sessionId, "stop", plan.renames[0].stop_id, { renamed: plan.renames.length, renames: plan.renames, unchanged: plan.unchanged, undoEntryId });
  } catch (err) {
    console.error("renameStopsBatch error:", err);
    res.status(500).json({ error: err.message });
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// 4. Extend calendars
// ═════════════════════════════════════════════════════════════════════════════

const planCalendarExtension = (db, body) => {
  const endDate = str(body.end_date);
  if (!DATE_YYYYMMDD.test(endDate)) return { ok: false, status: 400, error: "end_date must be YYYYMMDD." };
  const ids = idList(body.service_ids, MAX_EXTEND_SERVICES);
  let rows;
  if (ids.length > 0) {
    const stmt = db.prepare("SELECT service_id, start_date, end_date FROM calendar WHERE service_id = ?");
    rows = [];
    for (const id of ids) {
      const r = stmt.get(id);
      if (!r) return { ok: false, status: 404, error: `Service not found in calendar: ${id}` };
      rows.push(r);
    }
  } else {
    rows = db.prepare(`SELECT service_id, start_date, end_date FROM calendar WHERE end_date IS NULL OR end_date < ? ORDER BY service_id LIMIT ${MAX_EXTEND_SERVICES + 1}`).all(endDate);
  }
  if (rows.length > MAX_EXTEND_SERVICES) return { ok: false, status: 400, error: `Too many services (limit ${MAX_EXTEND_SERVICES}).` };
  const tripsStmt = db.prepare("SELECT COUNT(*) AS n FROM trips WHERE service_id = ?");
  const excStmt = db.prepare("SELECT COUNT(*) AS n FROM calendar_dates WHERE service_id = ? AND date > ? AND date <= ?");
  const services = [];
  let unchanged = 0;
  for (const r of rows) {
    if (r.start_date && r.start_date > endDate) return { ok: false, status: 400, error: `end_date ${endDate} is before the start_date of ${r.service_id} (${r.start_date}).` };
    if (r.end_date && r.end_date >= endDate) {
      unchanged += 1;
      continue;
    }
    services.push({
      service_id: r.service_id,
      old_end_date: r.end_date || null,
      end_date: endDate,
      trips: tripsStmt.get(r.service_id).n,
      exceptions_in_window: r.end_date ? excStmt.get(r.service_id, r.end_date, endDate).n : 0,
    });
  }
  if (services.length === 0) return { ok: false, status: 409, error: "Nothing to extend: every selected service already ends on or after that date." };
  let feedInfo = null;
  if (body.update_feed_info !== false && tableExists(db, "feed_info")) {
    const fi = db.prepare("SELECT rowid AS _rid, feed_end_date FROM feed_info LIMIT 1").get();
    if (fi && fi.feed_end_date && fi.feed_end_date < endDate) feedInfo = { rowid: fi._rid, old: fi.feed_end_date, new: endDate };
  }
  return { ok: true, end_date: endDate, services, unchanged, feed_info: feedInfo };
};

const extendCalendar = async (req, res) => {
  try {
    const ctx = requireEditMode(req, res);
    if (!ctx) return;
    const { sessionId, db } = ctx;
    const body = req.body || {};
    const plan = planCalendarExtension(db, body);
    if (!plan.ok) return res.status(plan.status).json({ error: plan.error });
    const summary = {
      end_date: plan.end_date,
      services: plan.services,
      unchanged: plan.unchanged,
      feed_info: plan.feed_info ? { old_end_date: plan.feed_info.old, end_date: plan.feed_info.new } : null,
    };
    if (body.dry_run) return res.json({ dry_run: true, ...summary });
    const redoOps = plan.services.map((s) => ({ sql: "UPDATE calendar SET end_date = ? WHERE service_id = ?", params: [s.end_date, s.service_id] }));
    const undoOps = plan.services.map((s) => ({ sql: "UPDATE calendar SET end_date = ? WHERE service_id = ?", params: [s.old_end_date, s.service_id] }));
    if (plan.feed_info) {
      redoOps.push({ sql: "UPDATE feed_info SET feed_end_date = ? WHERE rowid = ?", params: [plan.feed_info.new, plan.feed_info.rowid] });
      undoOps.push({ sql: "UPDATE feed_info SET feed_end_date = ? WHERE rowid = ?", params: [plan.feed_info.old, plan.feed_info.rowid] });
    }
    let undoEntryId = null;
    const tx = db.transaction(() => {
      undoEntryId = logEdit(db, {
        entity: "calendar",
        entityId: plan.services.map((s) => s.service_id).join(","),
        action: "bulk_update",
        description: `Extended ${plan.services.length} service(s) to ${plan.end_date}${plan.feed_info ? " (feed_info updated)" : ""}`,
        undoOps,
        redoOps,
      });
      for (const op of redoOps) db.prepare(op.sql).run(op.params);
    });
    tx.immediate();
    for (const s of plan.services) syncCacheEntry(sessionId, db, "calendar", s.service_id);
    if (plan.feed_info) {
      const { resyncCacheForTables } = require("./sqlConsoleService");
      resyncCacheForTables(sessionId, db, ["feed_info"]);
    }
    await respondWithValidation(res, sessionId, "calendar", plan.services[0].service_id, { ...summary, extended: plan.services.length, undoEntryId });
  } catch (err) {
    console.error("extendCalendar error:", err);
    res.status(500).json({ error: err.message });
  }
};

module.exports = {
  insertStopInPattern,
  mergeStops,
  renameStopsBatch,
  extendCalendar,
  planStopInsertion,
  planStopMerge,
  planStopRenames,
  planCalendarExtension,
};
