/**
 * transformQuality.test.js — the network quality report on real feeds and
 * its before → after comparison in a preview: tiers from the midday
 * headway, the French urban criteria, connectivity, and a plan that makes
 * a line frequent resolving its findings.
 */

"use strict";

const { loadReal, loadSample } = require("./_helpers/feedDb");
const { buildFeedModel } = require("../services/transform/feedModel");
const { feedQuality, compareQuality } = require("../services/transform/feedQuality");
const { previewPlan } = require("../services/transform/engine");

describe("feedQuality", () => {
  test("Albi: tiers, urban criteria, one connected network, no frequent service", () => {
    const q = feedQuality(buildFeedModel(loadReal("albi")));
    const byLabel = Object.fromEntries(q.lines.map((l) => [l.label, l]));
    expect(byLabel.B.tier).toBe("structuring");
    expect(byLabel.C.tier).toBe("complementary");
    expect(byLabel.A.tier).toBe("coverage");
    expect(q.network.urban_criteria.urban).toBe(true);
    expect(q.network.urban_criteria.mean_spacing_m).toBeLessThanOrEqual(500);
    expect(q.network.connectivity.components).toBe(1);
    expect(q.network.frequent_stops).toBe(0);
    expect(q.dimensions.map((d) => d.id)).toEqual(["frequency", "span", "spacing", "speed", "legibility", "network"]);
    expect(q.grade).toMatch(/^[A-D]$/);
    // The sample's frequent metro lines score better than Albi's town network.
    const s = feedQuality(buildFeedModel(loadSample()));
    expect(s.score).toBeGreaterThan(q.score);
    expect(s.network.frequent_share).toBeGreaterThan(0.5);
  });

  test("Vernon: low frequencies and a line isolated from the others are found", () => {
    const q = feedQuality(buildFeedModel(loadReal("vernon")));
    const codes = q.dimensions.flatMap((d) => d.findings).map((f) => f.code);
    expect(codes).toEqual(expect.arrayContaining(["base_headway_over_60", "isolated_lines"]));
    expect(q.network.urban_criteria.urban).toBe(false);
  });

  test("a feed compared with itself: nothing added or resolved", () => {
    const q = feedQuality(buildFeedModel(loadReal("albi")));
    const c = compareQuality(q, q);
    expect(c.added).toEqual([]);
    expect(c.resolved).toEqual([]);
    expect(c.score.before).toBe(c.score.after);
  });
});

describe("quality in a preview", () => {
  test("making line B every 10 minutes all day resolves its structuring-tier findings", async () => {
    const db = loadReal("albi");
    const p = await previewPlan(db, { operations: [{ type: "set_headway", params: { route: "B", days: "weekday", from: "06:30", to: "19:30", headway_min: 10, patterns: "main" } }] });
    expect(p.blocked).toBe(false);
    expect(p.quality.score.after).toBeGreaterThanOrEqual(p.quality.score.before);
    const freq = p.quality.dimensions.find((d) => d.id === "frequency");
    expect(freq.after).toBeGreaterThanOrEqual(freq.before);
    expect(p.quality.resolved.some((f) => f.code === "peak_headway_tier" && f.label === "B")).toBe(true);
  });
});

describe("consumer checks (beyond the validator)", () => {
  const { feedChecks, newChecks, _internals } = require("../services/transform/feedChecks");

  test("real problems of the Vernon feed are found; the sample is clean", () => {
    const v = loadReal("vernon");
    const codes = Object.fromEntries(feedChecks(v, buildFeedModel(v)).map((c) => [c.code, c.count]));
    expect(codes.stop_far_from_shape).toBeGreaterThan(0);
    expect(codes.duplicate_trips).toBeGreaterThan(0);
    expect(codes.low_contrast).toBeGreaterThan(0);
    const s = loadSample();
    expect(feedChecks(s, buildFeedModel(s))).toEqual([]);
    expect(_internals.contrast("FFFFFF", "000000")).toBeCloseTo(21, 0);
  });

  test("a preview lists what the plan makes worse, not what was already there", async () => {
    const db = loadReal("vernon");
    const p = await previewPlan(db, { operations: [{ type: "remove_stop", params: { route: [...buildFeedModel(db).routes.values()].find((r) => r.short_name === "1").id, stop: [...buildFeedModel(db).patterns.values()].find((x) => x.route_id.includes("Line:21:"))?.stops[3] } }] });
    expect(Array.isArray(p.checks)).toBe(true);
    expect(p.checks.find((c) => c.code === "low_contrast")).toBeUndefined();
    expect(newChecks([{ code: "x", count: 2 }], [{ code: "x", count: 3 }, { code: "y", count: 1 }]).map((c) => c.code)).toEqual(["x", "y"]);
  });
});
