/**
 * measure — one yardstick for any feed, whether it was uploaded, designed
 * from scratch in the Network Studio or changed by a plan: the network's
 * quality on the planners' scale (feedQuality), the fewest vehicles that
 * run its busiest weekday (blocking.minFleet, line by line and with
 * interlining) and what big consumers would reject (feedChecks).
 *
 *   measureFeed(db, { model }) → {
 *     ...feedQuality(model),                     // score, grade, dimensions, lines, network
 *     fleet: { date, vehicles, vehicles_line_by_line, deadhead_km, by_route } | null,
 *     checks: [{ code, count, examples }],
 *   }
 *   compactMeasure(m) → the same without per-line details (for stored reports)
 */

"use strict";

const { buildFeedModel } = require("./feedModel");
const { feedQuality } = require("./feedQuality");
const { minFleet } = require("./blocking");
const { feedChecks } = require("./feedChecks");

/** The weekday with the most trips among the representative dates. */
const busiestWeekday = (model) => {
  let best = null;
  for (const dow of ["tue", "wed", "thu", "mon", "fri"]) {
    const d = model.representative?.[dow];
    if (!d) continue;
    let n = 0;
    for (const t of model.trips.values()) if (model.runsOn(t.service_id, d)) n += 1;
    if (!best || n > best.n) best = { date: d, n };
  }
  return best?.date || null;
};

const measureFeed = (db, { model = null } = {}) => {
  const m = model || buildFeedModel(db);
  const quality = feedQuality(m);
  let fleet = null;
  const date = busiestWeekday(m);
  if (date) {
    const net = minFleet(m, date);
    const own = minFleet(m, date, { interline: false });
    fleet = { date, vehicles: net.vehicles, vehicles_line_by_line: own.vehicles, deadhead_km: net.deadhead_km, by_route: own.by_route };
  }
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
    fleet: x.fleet ? { date: x.fleet.date, vehicles: x.fleet.vehicles, vehicles_line_by_line: x.fleet.vehicles_line_by_line, deadhead_km: x.fleet.deadhead_km } : null,
    checks: (x.checks || []).map((c) => ({ code: c.code, count: c.count })),
  };

module.exports = { measureFeed, compactMeasure, _internals: { busiestWeekday } };
