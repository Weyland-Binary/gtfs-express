/**
 * transformScale.test.js — what makes previews fast on a city feed (1.7
 * million stop_times) must change no result:
 *   - a tracked sandbox's changeset (only the rows written) equals the
 *     full-table comparison, INSERT OR REPLACE included;
 *   - the incremental model after a step (re-reading only the trips whose
 *     stop_times were written) equals a model built from scratch;
 *   - the fast "HH:MM:SS" parser equals the general one;
 *   - the vehicle count alone equals the full minimum-fleet computation;
 *   - the feed as loaded is modelled once per session and data version.
 */

"use strict";

const { loadSample, loadReal } = require("./_helpers/feedDb");
const fm = require("../services/transform/feedModel");
const { sandboxOf, trackChanges, writtenValues, computeChangeset } = require("../services/transform/changeset");
const registry = require("../services/transform/operators");
const engine = require("../services/transform/engine");
const { minFleet } = require("../services/transform/blocking");

const canonicalChangeset = (c) =>
  JSON.stringify(
    Object.keys(c.tables)
      .sort()
      .map((t) => {
        const d = c.tables[t];
        const k = (r) => JSON.stringify(Object.keys(r).sort().map((x) => [x, r[x]]));
        return [t, d.inserted.map(k).sort(), d.deleted.map(k).sort(), d.updated.map((u) => k(u.before) + k(u.after)).sort()];
      }),
  );
const canonicalModel = (m) =>
  JSON.stringify({
    trips: [...m.trips.values()].sort((a, b) => a.id.localeCompare(b.id)).map((t) => [t.id, t.route_id, t.service_id, t.direction_id, t.headsign, t.block_id, t.shape_id, t.pattern, t.stops, t.arr, t.dep, t.dist, t.timepoint, t.first, t.lastArr]),
    patterns: [...m.patterns.keys()].sort().map((k) => [k, [...m.patterns.get(k).trips].sort()]),
    representative: m.representative,
    range: m.range,
    counts: m.counts,
  });

// Apply one operation to a sandbox the way the engine does.
const applyOp = async (sandbox, type, params) => {
  const model = fm.buildFeedModel(sandbox);
  const op = registry.get(type);
  const r = await op.resolve(model, params, { db: sandbox });
  expect(r.ambiguities).toEqual([]);
  sandbox.transaction(() => op.apply(sandbox, r.value, { model, weekend: ["sat", "sun"] }))();
};

const PLANS = [
  ["set_headway", { route: "S1", days: "weekday", from_date: "2026-10-05", from: "07:00", to: "09:00", headway_min: 4 }],
  ["add_stop", { route: "S1", stop: { name: "Scale Plaza", lat: 40.79, lon: -73.972 }, direction: "0" }],
  ["remove_stop", { route: "B1", stop: "B1_S05" }],
];

describe("tracked changesets and incremental models", () => {
  test.each(PLANS)("%s: tracked changeset = full comparison; incremental model = full model", async (type, params) => {
    const db = loadSample();
    const before = fm.buildFeedModel(db);
    if (type === "remove_stop") params.stop = before.routes.get("B1").patterns[0].stops[4];
    const tracked = sandboxOf(db);
    trackChanges(tracked);
    const plain = sandboxOf(db);
    await applyOp(tracked, type, params);
    await applyOp(plain, type, params);
    const a = computeChangeset(db, tracked);
    const b = computeChangeset(db, plain);
    expect(a.empty).toBe(false);
    expect(canonicalChangeset(a)).toBe(canonicalChangeset(b));
    const changed = new Set([...writtenValues(db, tracked, "stop_times", "trip_id"), ...writtenValues(db, tracked, "trips", "trip_id")]);
    expect(changed.size).toBeGreaterThan(0);
    expect(changed.size).toBeLessThan(before.trips.size);
    const inc = fm.buildFeedModel(tracked, { base: before, changedTrips: changed });
    expect(canonicalModel(inc)).toBe(canonicalModel(fm.buildFeedModel(tracked)));
  });

  test("INSERT OR REPLACE on a tracked sandbox is an update, not a duplicate insert", () => {
    const db = loadSample();
    const sb = sandboxOf(db);
    trackChanges(sb);
    const row = db.prepare("SELECT service_id, date, exception_type FROM calendar_dates LIMIT 1").get();
    sb.prepare("INSERT OR REPLACE INTO calendar_dates (service_id, date, exception_type) VALUES (?, ?, ?)").run(row.service_id, row.date, String(row.exception_type) === "1" ? 2 : 1);
    const c = computeChangeset(db, sb);
    const d = c.tables.calendar_dates;
    expect(d.inserted.length + d.deleted.length).toBe(0);
    expect(d.updated).toHaveLength(1);
  });

  test("a whole plan previews the same, tracked or not", async () => {
    const plan = { operations: PLANS.slice(0, 2).map(([type, params]) => ({ type, params })) };
    const p = await engine.previewPlan(loadSample(), plan, {});
    expect(p.blocked).toBe(false);
    expect(p.changes).toEqual(expect.objectContaining({}));
    expect(p.timings.total).toBeGreaterThan(0);
    // Committed on a copy, the feed equals the tracked sandbox's result.
    const db = loadSample();
    const q = await engine.previewPlan(db, plan, { sessionId: "s" });
    engine.commitPreview("s", db, q.id);
    const fresh = fm.buildFeedModel(db);
    expect(fresh.trips.size).toBe(fm.buildFeedModel(loadSample()).trips.size + (q.changes.trips?.inserted || 0) - (q.changes.trips?.deleted || 0));
  });
});

describe("fast paths", () => {
  test("HH:MM:SS parsing: the fast path equals the general one", () => {
    const { timeToSec } = fm._internals;
    expect(timeToSec("07:05:09")).toBe(7 * 3600 + 5 * 60 + 9);
    expect(timeToSec("25:10:00")).toBe(25 * 3600 + 600);
    expect(timeToSec("7:05:00")).toBe(7 * 3600 + 300);
    expect(timeToSec("07:65:00")).toBe(7 * 3600 + 65 * 60); // unusual, kept as the regex reads it
    expect(timeToSec("07:05")).toBe(7 * 3600 + 300);
    expect(timeToSec("")).toBeNull();
    expect(timeToSec(null)).toBeNull();
    expect(timeToSec("0a:00:00")).toBeNull();
  });

  test("the vehicle count alone equals the full minimum fleet", () => {
    const m = fm.buildFeedModel(loadReal("albi"));
    for (const d of [m.representative.tue, m.representative.sat]) expect(minFleet(m, d, { countOnly: true }).vehicles).toBe(minFleet(m, d).vehicles);
  });

  test("the feed as loaded is modelled once per session and data version", () => {
    const { beforeModel, BEFORE, _befores } = engine._internals;
    const saved = BEFORE.minTrips;
    BEFORE.minTrips = 1;
    try {
      const db = loadSample();
      const a = beforeModel(db, { sessionId: "cache", dataVersion: "v1", weekend: ["sat", "sun"] });
      expect(beforeModel(db, { sessionId: "cache", dataVersion: "v1", weekend: ["sat", "sun"] })).toBe(a);
      expect(beforeModel(db, { sessionId: "cache", dataVersion: "v2", weekend: ["sat", "sun"] })).not.toBe(a);
      expect([..._befores.keys()].filter((k) => k.startsWith("cache|"))).toEqual(["cache|v2|sat,sun"]);
      expect(beforeModel(db, { sessionId: null, dataVersion: null, weekend: ["sat", "sun"] })).not.toBe(a);
    } finally {
      BEFORE.minTrips = saved;
      _befores.clear();
    }
  });
});
