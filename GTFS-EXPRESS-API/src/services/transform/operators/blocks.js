/**
 * rebuild_blocks — "re-cut the vehicle schedules": after a timetable
 * change, the trips' block_id (which trips one vehicle runs) are rebuilt
 * with the fewest vehicles (transform/blocking.js: minimum path cover,
 * layover ≥ max(layover_min, layover_pct of the running time), dead
 * running at deadhead_kmh, at most max_deadhead_km between two trips).
 *
 * GTFS keeps one block_id per trip for all its dates, while vehicles are
 * scheduled per day type. The day timetables of the network are taken
 * largest first (the school weekday, then Wednesdays, Saturdays,
 * holidays…): each one's blocks are cut for its trips that no larger day
 * timetable placed yet, so every day's blocks stay feasible (a trip keeps
 * the block it got on the busiest day it runs). Frequency-based trips run
 * several vehicles and get no block_id.
 */

"use strict";

const R = require("../resolve");
const S = require("../scope");
const { minFleet } = require("../blocking");

const resolve = (model, p) => {
  const ambiguities = [];
  let routes = null;
  if (p.routes != null && p.routes !== "all" && !(Array.isArray(p.routes) && p.routes.length === 0)) {
    routes = [];
    for (const ref of Array.isArray(p.routes) ? p.routes : [p.routes]) {
      const r = R.route(model, ref);
      if (r.ambiguity) ambiguities.push({ param: "routes", ...r.ambiguity });
      else routes.push(r.value.id);
    }
  }
  const num = (name, dflt, max) => {
    if (p[name] == null || p[name] === "") return dflt;
    const v = R.positive(p[name], name, { max });
    if (v.ambiguity) {
      ambiguities.push({ param: name, ...v.ambiguity });
      return dflt;
    }
    return v.value;
  };
  const opts = {
    interline: p.interline == null ? true : p.interline === true || p.interline === "true",
    layover: { min_min: num("layover_min", 5, 120), pct: num("layover_pct", 12, 100) / 100 },
    deadheadKmh: num("deadhead_kmh", 25, 120),
    maxDeadheadKm: num("max_deadhead_km", 15, 200),
  };
  const prefix = p.prefix ? String(p.prefix).replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 20) : "BLK_";
  if (ambiguities.length) return { ambiguities, warnings: [] };
  const ids = [...model.trips.values()].filter((t) => !routes || routes.includes(t.route_id)).map((t) => t.id);
  if (!ids.length) return { ambiguities: [{ param: "routes", code: "no_trips", message: "These lines have no trips." }], warnings: [] };
  return { value: { routes, opts, prefix, ids }, ambiguities: [], warnings: [] };
};

const apply = (db, v, { model }) => {
  const warnings = [];
  const placed = new Map(); // trip id → block id
  let n = 0;
  let vehiclesMain = null;
  let deadheadMain = null;
  const groups = S.dayGroups(model, v.ids, null);
  for (const g of groups) {
    const date = g.dates[Math.floor(g.dates.length / 2)];
    const fleet = minFleet(model, date, { ...v.opts, routes: v.routes });
    if (vehiclesMain == null) {
      vehiclesMain = fleet.vehicles;
      deadheadMain = fleet.deadhead_km;
    }
    for (const chain of fleet.blocks) {
      const fresh = chain.filter((id) => !placed.has(id) && !model.frequencies.has(id));
      if (!fresh.length) continue;
      // Trips already placed keep their block; the others of this vehicle get one new id.
      const id = `${v.prefix}${String(++n).padStart(4, "0")}`;
      for (const t of fresh) placed.set(t, id);
    }
  }
  const upd = db.prepare("UPDATE trips SET block_id = ? WHERE trip_id = ?");
  let changed = 0;
  for (const [trip, block] of placed) {
    if ((model.trips.get(trip)?.block_id || null) !== block) changed += 1;
    upd.run(block, trip);
  }
  const freq = v.ids.filter((id) => model.frequencies.has(id));
  if (freq.length) {
    for (const id of freq) db.prepare("UPDATE trips SET block_id = NULL WHERE trip_id = ?").run(id);
    warnings.push(`${freq.length} frequency-based trip(s) run several vehicles: no block_id.`);
  }
  const before = new Set(v.ids.map((id) => model.trips.get(id)?.block_id).filter(Boolean)).size;
  return {
    summary: `Vehicle blocks rebuilt: ${vehiclesMain} vehicle(s) on the busiest day timetable (${deadheadMain} km of dead running), ${n} block(s) over ${groups.length} day timetable(s) (was ${before} block id(s)); ${changed} trip(s) changed block.`,
    warnings,
    noop: changed === 0 && !freq.some((id) => model.trips.get(id)?.block_id),
  };
};

module.exports = {
  type: "rebuild_blocks",
  title: "Rebuild the vehicle blocks with the fewest vehicles",
  category: "network",
  tables: ["trips"],
  description: "Re-cut the vehicle schedules (block_id) with the minimum fleet: layover, dead running and interlining rules; each day timetable of the network is cut, largest first.",
  params: [
    { name: "routes", type: "routes", required: false, description: "The lines (default: all)." },
    { name: "interline", type: "boolean", required: false, description: "Vehicles may change line (default true)." },
    { name: "layover_min", type: "number", required: false, description: "Minimum layover at the end of a trip, minutes (default 5)." },
    { name: "layover_pct", type: "number", required: false, description: "Minimum layover as a share of the running time, % (default 12)." },
    { name: "deadhead_kmh", type: "number", required: false, description: "Dead running speed (default 25 km/h)." },
    { name: "max_deadhead_km", type: "number", required: false, description: "Longest dead run between two trips (default 15 km)." },
    { name: "prefix", type: "string", required: false, description: "Prefix of the new block ids (default BLK_)." },
  ],
  example: { routes: "all", interline: true },
  resolve,
  apply,
};
