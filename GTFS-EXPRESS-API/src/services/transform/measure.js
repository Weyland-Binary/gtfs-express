/**
 * measure — one yardstick for any feed, whether it was uploaded, designed
 * from scratch in the Network Studio or changed by a plan: the network's
 * quality on the planners' scale (feedQuality), THE fleet (impact.peakFleet:
 * vehicles at the peak of the busiest weekday, each line with its own
 * vehicles — the figure the impact and the fleet_max clause show too) with
 * the interlined minimum as a secondary figure, and what big consumers
 * would reject (feedChecks).
 *
 *   measureFeed(db, { model }) → {
 *     ...feedQuality(model),                     // score, grade, dimensions, lines, network
 *     fleet: { date, vehicles, fleet_min_interlined, deadhead_km, by_route, definition,
 *              vehicles_line_by_line (= vehicles, the former name) } | null,
 *     checks: [{ code, count, examples }],
 *   }
 *   compactMeasure(m) → the same without per-line details (for stored reports)
 */

"use strict";

const { buildFeedModel } = require("./feedModel");
const { feedQuality } = require("./feedQuality");
const { feedChecks } = require("./feedChecks");

/** The day the fleet is measured on (impact.fleetDate: the representative weekday with the most runs). */
const busiestWeekday = (model) => require("./impact").fleetDate(model);

const measureFeed = (db, { model = null } = {}) => {
  const m = model || buildFeedModel(db);
  const quality = feedQuality(m);
  let fleet = null;
  const f = require("./impact").peakFleet(m, { interlined: true });
  if (f.date) fleet = { date: f.date, vehicles: f.vehicles, fleet_min_interlined: f.fleet_min_interlined, vehicles_line_by_line: f.vehicles, deadhead_km: f.deadhead_km, by_route: f.by_route, definition: f.definition };
  let checks = [];
  try {
    checks = feedChecks(db, m);
  } catch (err) {
    checks = [{ code: "error", count: 0, examples: [err.message] }];
  }
  return { ...quality, fleet, checks };
};

const compactMeasure = (x) =>
  x && {
    score: x.score,
    grade: x.grade,
    dimensions: (x.dimensions || []).map((d) => ({ id: d.id, score: d.score, findings: (d.findings || []).length })),
    lines: (x.lines || []).map((l) => {
      const v = Object.values(l.scores || {}).filter(Number.isFinite);
      return { id: l.id, label: l.label, tier: l.tier, score: v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null };
    }),
    network: x.network ? { frequent_stops: x.network.frequent_stops, frequent_share: x.network.frequent_share, connectivity: x.network.connectivity } : null,
    fleet: x.fleet ? { date: x.fleet.date, vehicles: x.fleet.vehicles, fleet_min_interlined: x.fleet.fleet_min_interlined, vehicles_line_by_line: x.fleet.vehicles_line_by_line, deadhead_km: x.fleet.deadhead_km } : null,
    checks: (x.checks || []).map((c) => ({ code: c.code, count: c.count })),
  };

module.exports = { measureFeed, compactMeasure, _internals: { busiestWeekday } };
