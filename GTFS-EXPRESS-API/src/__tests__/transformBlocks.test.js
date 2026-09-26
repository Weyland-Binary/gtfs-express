/**
 * transformBlocks.test.js — the fewest vehicles that run a day's trips
 * (minimum path cover, Hopcroft–Karp) and rebuild_blocks, which re-cuts
 * the trips' block_id with it: on a tiny network whose answer is known, on
 * the real Vernon and Albi feeds (no block overlaps after the rebuild, as
 * many blocks on the busiest day as vehicles, deterministic), and on the
 * sample's frequency-based trips (no block_id).
 */

"use strict";

const { loadReal, loadSample } = require("./_helpers/feedDb");
const { buildFeedModel } = require("../services/transform/feedModel");
const { minFleet, _internals } = require("../services/transform/blocking");
const { previewPlan, commitPreview } = require("../services/transform/engine");
const { feedChecks } = require("../services/transform/feedChecks");
const S = require("../services/transform/scope");

const commit = (d, p) => {
  expect(p.blocked).toBe(false);
  expect(p.integrity).toEqual([]);
  commitPreview("t", d, p.id);
  return buildFeedModel(d);
};
const blockIdsOn = (m, date) => new Set([...m.trips.values()].filter((t) => t.block_id && m.runsOn(t.service_id, date)).map((t) => t.block_id));
const busiestDate = (m) => {
  const groups = S.dayGroups(m, [...m.trips.keys()], null);
  const g = groups[0];
  return g.dates[Math.floor(g.dates.length / 2)];
};

describe("maxMatching", () => {
  test("a known bipartite graph: maximum matching of 3", () => {
    // 0→{0,1}, 1→{0}, 2→{1,2}, 3→{} : 3 edges matched at most.
    const m = _internals.maxMatching([[0, 1], [0], [1, 2], []], 4);
    expect([...m].filter((x) => x !== -1).length).toBe(3);
    expect(new Set([...m].filter((x) => x !== -1)).size).toBe(3);
  });
});

describe("minFleet", () => {
  // Two stops 100 m apart, two lines: a vehicle turning back at the terminus can run the next trip.
  const tiny = () => {
    const stops = new Map([
      ["A", { id: "A", lat: 45.0, lon: 5.0 }],
      ["B", { id: "B", lat: 45.05, lon: 5.0 }],
    ]);
    const trip = (id, route, from, to, dep, arr) => ({ id, route_id: route, service_id: "WK", stops: [from, to], first: dep, lastArr: arr });
    const h = (x) => Math.round(x * 3600);
    const trips = new Map(
      [
        trip("1", "L1", "A", "B", h(7), h(7.5)),
        trip("2", "L1", "B", "A", h(7.6), h(8.1)), // 6 min layover ≥ max(5, 12 % of 30) = 5 → same vehicle
        trip("3", "L2", "A", "B", h(8.2), h(8.7)), // after 2 at A, but another line
        trip("4", "L1", "A", "B", h(7.52), h(8)), // overlaps 1 → a second vehicle
      ].map((t) => [t.id, t]),
    );
    return { stops, trips, frequencies: new Map(), runsOn: () => true };
  };

  test("the known minimum, interlining or not", () => {
    const m = tiny();
    const all = minFleet(m, "20250101");
    expect(all.trips).toBe(4);
    expect(all.vehicles).toBe(2);
    expect(all.blocks.flat().sort()).toEqual(["1", "2", "3", "4"]);
    const own = minFleet(m, "20250101", { interline: false });
    expect(own.vehicles).toBe(3); // L2's trip needs its own vehicle
    expect(own.vehicles).toBeGreaterThanOrEqual(all.vehicles);
  });

  test("a longer layover rule costs a vehicle", () => {
    const m = tiny();
    expect(minFleet(m, "20250101", { layover: { min_min: 20 } }).vehicles).toBeGreaterThan(minFleet(m, "20250101").vehicles);
  });

  test("real feeds: interlining never needs more vehicles, the blocks cover every run once", () => {
    for (const name of ["vernon", "albi"]) {
      const m = buildFeedModel(loadReal(name));
      const date = busiestDate(m);
      const a = minFleet(m, date);
      const b = minFleet(m, date, { interline: false });
      expect(a.vehicles).toBeGreaterThan(0);
      expect(b.vehicles).toBeGreaterThanOrEqual(a.vehicles);
      expect(a.blocks.flat().length).toBe(a.trips);
      expect(new Set(a.blocks.flat()).size).toBe(a.trips);
    }
  });
});

describe("rebuild_blocks", () => {
  test.each(["vernon", "albi"])("%s: blocks with the fewest vehicles, no overlap, deterministic", async (name) => {
    const db = loadReal(name);
    const m0 = buildFeedModel(db);
    const date = busiestDate(m0);
    const fleet = minFleet(m0, date);
    const p = await previewPlan(db, { operations: [{ type: "rebuild_blocks", params: {} }] });
    expect(p.steps[0].status).toBe("applied");
    expect(p.steps[0].summary).toMatch(/Vehicle blocks rebuilt/);
    const m1 = commit(db, p);
    expect(feedChecks(db, m1).find((c) => c.code === "block_overlap")).toBeUndefined();
    expect(blockIdsOn(m1, date).size).toBe(fleet.vehicles);
    // Every trip of the network has a block.
    expect([...m1.trips.values()].every((t) => t.block_id && t.block_id.startsWith("BLK_"))).toBe(true);
    // The same plan on the same feed gives the same blocks; on the rebuilt feed, nothing to do.
    const db2 = loadReal(name);
    commit(db2, await previewPlan(db2, { operations: [{ type: "rebuild_blocks", params: {} }] }));
    const ids = (d) => JSON.stringify(d.prepare("SELECT trip_id, block_id FROM trips ORDER BY trip_id").all());
    expect(ids(db2)).toBe(ids(db));
    const again = await previewPlan(db, { operations: [{ type: "rebuild_blocks", params: {} }] });
    expect(again.steps[0].status).toBe("skipped");
  });

  test("one line only, other lines untouched; bad parameters are asked", async () => {
    const db = loadReal("albi");
    const before = db.prepare("SELECT trip_id, block_id FROM trips WHERE route_id <> '114' ORDER BY trip_id").all();
    const p = await previewPlan(db, { operations: [{ type: "rebuild_blocks", params: { routes: ["B"], interline: false, prefix: "B-" } }] });
    const m1 = commit(db, p);
    expect([...m1.trips.values()].filter((t) => t.route_id === "114").every((t) => t.block_id.startsWith("B-"))).toBe(true);
    expect(db.prepare("SELECT trip_id, block_id FROM trips WHERE route_id <> '114' ORDER BY trip_id").all()).toEqual(before);
    const bad = await previewPlan(db, { operations: [{ type: "rebuild_blocks", params: { routes: ["nope"], layover_min: -3 } }] });
    expect(bad.blocked).toBe(true);
    expect(bad.steps[0].ambiguities.map((a) => a.param).sort()).toEqual(["layover_min", "routes"]);
  });

  test("frequency-based trips get no block_id", async () => {
    const db = loadSample();
    const m0 = buildFeedModel(db);
    const p = await previewPlan(db, { operations: [{ type: "rebuild_blocks", params: {} }] });
    const m1 = commit(db, p);
    for (const id of m0.frequencies.keys()) expect(m1.trips.get(id).block_id).toBeNull();
    expect(p.steps[0].warnings.join(" ")).toMatch(/frequency-based/);
    expect(feedChecks(db, m1).find((c) => c.code === "block_overlap")).toBeUndefined();
  });
});
