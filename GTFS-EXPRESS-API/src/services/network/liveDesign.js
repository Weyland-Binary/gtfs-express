/**
 * liveDesign — the design of a network that lives on after it was built.
 *
 * A network built in the Studio keeps its spec and report next to the feed
 * (_network_spec.json, _network_report.json). Once the feed is edited — in
 * the grid, the SQL console, the map or by the chat — the build's verdict no
 * longer describes it. This module re-measures the brief on the feed as it
 * is now:
 *
 *   loadDesign(sessionId)          → { spec, report, requirements } | null
 *   liveConformance(db, sessionId) → the brief's verdict on the current feed
 *                                    (cached per data version) | null
 *   designedIds(sessionId)         → { stops: Set, routes: Set } of the design
 *   designBlock(sessionId)         → a short context block for the chat
 *
 * The live check reads the session's tables and derives a spec from them
 * (the dominant pattern of each route, calendar.txt): the verdict is
 * marked `approximate` — exact for lines, termini, places served and caps,
 * close for frequencies when a route has many variants. Typical trips are
 * measured on the real timetable.
 */

"use strict";

const { getDataVersion } = require("../../middleware/readCache");
const { normalizeSpec } = require("./networkSpec");
const { loadStoredSpec, loadStoredReport } = require("./compiler");
const conformanceService = require("./conformanceService");

const TABLES = ["agency", "routes", "stops", "trips", "stop_times", "calendar", "calendar_dates", "frequencies"];
const MAX_STOP_TIMES = 600000;
const _cache = new Map(); // sessionId → { version, verdict }

const loadDesign = (sessionId) => {
  const stored = loadStoredSpec(sessionId);
  const report = loadStoredReport(sessionId);
  if (!stored && !report) return null;
  return { spec: stored?.spec || null, report: report || null, requirements: report?.requirements || null };
};

/** The session's GTFS tables as rows of strings (what the reverse compiler reads). */
const readTables = (db) => {
  const out = {};
  for (const t of TABLES) {
    try {
      const rows = db.prepare(`SELECT * FROM ${t}${t === "stop_times" ? ` LIMIT ${MAX_STOP_TIMES}` : ""}`).all();
      out[t] = rows.map((r) => {
        const o = {};
        for (const [k, v] of Object.entries(r)) o[k] = v == null ? "" : String(v);
        return o;
      });
    } catch {
      out[t] = [];
    }
  }
  return out;
};

/** The brief's verdict on the feed as it is now (null when there is no brief). */
const liveConformance = (db, sessionId) => {
  const design = loadDesign(sessionId);
  if (!design?.requirements || !db) return null;
  if (!conformanceService.clausesOf(design.requirements).length) return null;
  const version = getDataVersion(db);
  const cached = _cache.get(sessionId);
  if (cached && cached.version === version) return cached.verdict;
  const { specFromTables } = require("./catalogService");
  const { estimateOperations } = require("./operationsService");
  const tables = readTables(db);
  const derived = specFromTables(tables, { maxLines: 400 });
  // Keep the design's own weekend and costs: the feed does not carry them.
  const raw = { ...derived.spec, ...(design.spec?.weekend ? { weekend: design.spec.weekend } : {}), ...(design.spec?.operations ? { operations: design.spec.operations } : {}) };
  const spec = normalizeSpec(raw).spec;
  let operations = null;
  try {
    operations = estimateOperations(spec, null, {});
  } catch {
    operations = null;
  }
  const verdict = conformanceService.checkConformance(spec, design.requirements, { tables, operations, referenceStops: design.spec?.stops || null });
  const out = verdict ? { ...verdict, approximate: true, version } : null;
  _cache.set(sessionId, { version, verdict: out });
  if (_cache.size > 200) _cache.delete(_cache.keys().next().value);
  return out;
};

/** Stop and route ids that belong to the designed network. */
const designedIds = (sessionId) => {
  const spec = loadStoredSpec(sessionId)?.spec;
  if (!spec) return null;
  return { stops: new Set((spec.stops || []).map((s) => s.id)), routes: new Set((spec.lines || []).map((l) => l.id)) };
};

/** A short block for the chat: the network was designed on a brief; what it asked. */
const designBlock = (sessionId) => {
  const design = loadDesign(sessionId);
  if (!design) return "";
  const req = design.requirements || {};
  const c = design.report?.conformance?.summary;
  const lines = [
    "[Network design] This feed was designed in the Network Studio from a brief. Its lines and stops are deliberate choices: before a structural change (merging or renaming designed stops, removing trips, changing service) check the brief with get_network_design, and after it, check the brief still holds.",
  ];
  if (req.operator || req.area) lines.push(`Operator/area: ${[req.operator, req.area].filter(Boolean).join(" · ")}.`);
  if (req.objectives?.length) lines.push(`Objectives: ${req.objectives.slice(0, 6).join("; ")}.`);
  if (c) lines.push(`Brief at build: ${c.must.pass}/${c.must.total} required clause(s) met${c.must.fail ? `, ${c.must.fail} failing` : ""}.`);
  const unconfirmed = (req.assumptions || []).filter((a) => a.confidence !== "high").length;
  if (unconfirmed) lines.push(`${unconfirmed} assumption(s) were never confirmed by the user: ask before relying on them.`);
  return lines.join("\n");
};

module.exports = { loadDesign, liveConformance, designedIds, designBlock, readTables, _internals: { _cache } };
