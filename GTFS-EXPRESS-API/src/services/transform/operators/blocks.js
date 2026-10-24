/**
 * rebuild_blocks: re-cuts the trips' block_id with the fewest vehicles (transform/blocking.js). The blocks are
 * theoretical (no depot runs, duties or breaks), so a feed's own blocks, the operator's real schedules, are replaced
 * only when asked. GTFS keeps one block_id per trip for all its dates: day timetables are cut largest first and a trip
 * keeps the block of the busiest day it runs, so every day stays feasible. Frequency-based trips get no block_id.
 */

"use strict";

const R = require("../resolve");
const S = require("../scope");
const { minFleet } = require("../blocking");
const { tr } = require("../i18n");

const THEORETICAL = "no depot, no duties, simplified layovers";

// params.replace → "replace" | "keep" | null (not said).
const replaceMode = (v) => {
  if (v === true) return "replace";
  if (v === false) return "keep";
  const s = String(v ?? "").trim().toLowerCase();
  if (["replace", "true", "yes", "remplacer"].includes(s)) return "replace";
  if (["keep", "false", "no", "garder", "conserver"].includes(s)) return "keep";
  return null;
};

const resolve = (model, p, ctx) => {
  const lang = ctx?.lang;
  const ambiguities = [];
  let routes = null;
  if (p.routes != null && p.routes !== "all" && !(Array.isArray(p.routes) && p.routes.length === 0)) {
    routes = [];
    for (const ref of Array.isArray(p.routes) ? p.routes : [p.routes]) {
      const r = R.route(model, ref, { lang });
      if (r.ambiguity) ambiguities.push({ param: "routes", ...r.ambiguity });
      else routes.push(r.value.id);
    }
  }
  const num = (name, dflt, max) => {
    if (p[name] == null || p[name] === "") return dflt;
    const v = R.positive(p[name], name, { max, lang });
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
  if (!ids.length) return { ambiguities: [{ param: "routes", code: "no_trips", message: tr(lang, "rebuild_blocks.no_trips") }], warnings: [] };
  // The operator's own blocks are real vehicle schedules: never replaced unasked.
  const blocked = ids.filter((id) => model.trips.get(id)?.block_id);
  const mode = replaceMode(p.replace);
  if (blocked.length && !mode) {
    const blockIds = new Set(blocked.map((id) => model.trips.get(id).block_id)).size;
    const free = ids.length - blocked.length;
    return {
      ambiguities: [
        {
          param: "replace",
          code: "replace_blocks",
          message: tr(lang, free ? "rebuild_blocks.replace_question" : "rebuild_blocks.replace_question_all", { blocked: blocked.length, trips: ids.length, blocks: blockIds, theoretical: tr(lang, "rebuild_blocks.theoretical"), free }),
          options: ["keep", "replace"],
        },
      ],
      warnings: [],
    };
  }
  return { value: { routes, opts, prefix, ids, keep: blocked.length > 0 && mode === "keep" }, ambiguities: [], warnings: [] };
};

const apply = (db, v, { model, lang } = {}) => {
  const warnings = [];
  const theoretical = tr(lang, "rebuild_blocks.theoretical");
  // Keep: the operator's blocks stay; only the trips without one are cut, among themselves.
  const targets = v.keep ? v.ids.filter((id) => !model.trips.get(id)?.block_id) : v.ids;
  if (!targets.length) return { summary: tr(lang, "rebuild_blocks.all_kept"), warnings, noop: true };
  const view = v.keep ? { ...model, trips: new Map(targets.map((id) => [id, model.trips.get(id)])) } : model;
  const placed = new Map();
  // Block ids other trips keep (lines not rebuilt, the operator's kept blocks, an earlier rebuild) are never reused.
  const rebuilt = new Set(targets);
  const held = new Set([...model.trips.values()].filter((t) => t.block_id && !rebuilt.has(t.id)).map((t) => t.block_id));
  let n = 0;
  const nextId = () => {
    let id;
    do id = `${v.prefix}${String(++n).padStart(4, "0")}`;
    while (held.has(id));
    return id;
  };
  let vehiclesMain = null;
  let deadheadMain = null;
  let mainDate = null;
  const groups = S.dayGroups(view, targets, null);
  for (const g of groups) {
    const date = g.dates[Math.floor(g.dates.length / 2)];
    const fleet = minFleet(view, date, { ...v.opts, routes: v.routes });
    if (vehiclesMain == null) {
      vehiclesMain = fleet.vehicles;
      deadheadMain = fleet.deadhead_km;
      mainDate = date;
    }
    for (const chain of fleet.blocks) {
      const fresh = chain.filter((id) => !placed.has(id) && !model.frequencies.has(id));
      if (!fresh.length) continue;
      // Trips placed on a busier day keep their block.
      const id = nextId();
      for (const t of fresh) placed.set(t, id);
    }
  }
  const upd = db.prepare("UPDATE trips SET block_id = ? WHERE trip_id = ?");
  let changed = 0;
  for (const [trip, block] of placed) {
    if ((model.trips.get(trip)?.block_id || null) !== block) changed += 1;
    upd.run(block, trip);
  }
  const freq = targets.filter((id) => model.frequencies.has(id));
  if (freq.length) {
    for (const id of freq) db.prepare("UPDATE trips SET block_id = NULL WHERE trip_id = ?").run(id);
    warnings.push(tr(lang, "rebuild_blocks.frequency_trips", { count: freq.length }));
  }
  const made = new Set(placed.values()).size;
  const noop = changed === 0 && !freq.some((id) => model.trips.get(id)?.block_id);
  if (v.keep) {
    return {
      summary: tr(lang, "rebuild_blocks.summary_keep", { theoretical, trips: targets.length, vehicles: vehiclesMain ?? 0, deadhead: deadheadMain ?? 0, blocks: made, held: held.size }),
      warnings,
      noop,
    };
  }
  const onMain = mainDate ? targets.map((id) => model.trips.get(id)).filter((t) => t && model.runsOn(t.service_id, mainDate) && !model.frequencies.has(t.id)) : [];
  const vehiclesBefore = new Set(onMain.filter((t) => t.block_id).map((t) => t.block_id)).size;
  const unblocked = onMain.filter((t) => !t.block_id).length;
  const beforeText = vehiclesBefore ? tr(lang, unblocked ? "rebuild_blocks.before_unblocked" : "rebuild_blocks.before", { vehicles: vehiclesBefore, unblocked }) : "";
  const blockIdsBefore = new Set(targets.map((id) => model.trips.get(id)?.block_id).filter(Boolean)).size;
  if (blockIdsBefore) warnings.push(tr(lang, "rebuild_blocks.replaced", { blocks: blockIdsBefore, theoretical }));
  return {
    summary: tr(lang, "rebuild_blocks.summary", { theoretical, vehicles: vehiclesMain ?? 0, deadhead: deadheadMain ?? 0, before: beforeText, blocks: made, timetables: groups.length, was: blockIdsBefore, changed }),
    warnings,
    noop,
  };
};

module.exports = {
  type: "rebuild_blocks",
  title: "Rebuild the vehicle blocks with the fewest vehicles (theoretical)",
  category: "network",
  tables: ["trips"],
  description: `Re-cut the vehicle schedules (block_id) with the minimum fleet: THEORETICAL blocks (${THEORETICAL}) from layover, dead running and interlining rules; each day timetable of the network is cut, largest first. When the trips already run in the operator's blocks (its real vehicle schedules), the step asks whether to replace them or keep them (replace).`,
  params: [
    { name: "routes", type: "routes", required: false, description: "The lines (default: all)." },
    { name: "replace", type: "enum", enum: ["keep", "replace"], required: false, description: "When some trips already run in the operator's blocks: \"replace\" re-cuts them all; \"keep\" keeps them and gives theoretical blocks only to the trips without one. Asked when missing." },
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
