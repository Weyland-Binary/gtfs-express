/**
 * transformReal.test.js — the engine on REAL feeds (fixtures/real): libéA
 * Albi (several services per weekday: all year + school days + Wednesdays,
 * three periods, holidays by removed dates; stops on both sides of a road)
 * and SNgo Vernon (real vehicle blocks). What a sample feed cannot show.
 */

"use strict";

const { loadReal } = require("./_helpers/feedDb");
const { buildFeedModel, routeStats, departures } = require("../services/transform/feedModel");
const { previewPlan, commitPreview } = require("../services/transform/engine");
const S = require("../services/transform/scope");
const { impactOf } = require("../services/transform/impact");

const weekdaysOf = (m) => ["mon", "tue", "wed", "thu", "fri"];

describe("libéA Albi — a line's frequency on a real school-year feed", () => {
  test("every weekday timetable of line A is rebuilt (school days, Wednesdays, September, holidays); Saturdays untouched", async () => {
    const db = loadReal("albi");
    const before = buildFeedModel(db);
    const p = await previewPlan(db, { operations: [{ type: "set_headway", params: { route: "A", days: "weekday", from: "07:00", to: "09:00", headway_min: 10 } }] }, { sessionId: "t" });
    expect(p.blocked).toBe(false);
    expect(p.integrity).toEqual([]);
    expect(p.steps[0].warnings.join(" ")).toMatch(/series built, one per day timetable/);
    commitPreview("t", db, p.id);
    const after = buildFeedModel(db);
    // On EVERY weekday of the validity with service, line A leaves every ≤ 10 min between 7 and 9 (dir 0 at the origin).
    const aTrips = [...after.trips.values()].filter((t) => t.route_id === "113");
    const dates = new Set();
    for (const t of aTrips) for (const d of S.activeDates(after, t.service_id)) if (weekdaysOf().includes(S.dayTypeOf(after, t.service_id, d))) dates.add(d);
    expect(dates.size).toBeGreaterThan(150);
    for (const d of [...dates].filter((_, i) => i % 7 === 0)) {
      for (const dir of ["0", "1"]) {
        const deps = (departures(after, "113", d).get(dir) || []).filter((x) => x >= 7 * 3600 && x < 9 * 3600);
        // The series starts at the first departure the line had in the window (kept), then every 10 min.
        expect(deps.length).toBeGreaterThanOrEqual(9);
        for (let i = 1; i < deps.length; i++) expect(deps[i] - deps[i - 1]).toBeLessThanOrEqual(600);
      }
    }
    // Saturdays: exactly as before.
    const sat = before.representative.sat;
    expect(routeStats(after, "113", sat)).toEqual(routeStats(before, "113", sat));
    // Other lines untouched on a weekday.
    const tue = before.representative.tue;
    expect(routeStats(after, "112", tue)).toEqual(routeStats(before, "112", tue));
  });

  test("a stop named for both sides of the road is one place: removed from both directions", async () => {
    const db = loadReal("albi");
    const p = await previewPlan(db, { operations: [{ type: "remove_stop", params: { route: "C", stop: "Parking Mézard" } }] });
    // Parking Mézard is a terminus of C: the neighbouring stop becomes the terminus (warned).
    expect(p.steps[0].status).toBe("applied");
    expect(p.steps[0].warnings.join(" ")).toMatch(/terminus/);
    expect(p.lines.join("\n")).toMatch(/no longer serves Parking Mézard/);
    expect(p.integrity).toEqual([]);
  });

  test("the impact counts the real year: km, hours, fleet, and flags a major change", async () => {
    const db = loadReal("albi");
    const before = buildFeedModel(db);
    const p = await previewPlan(db, { operations: [{ type: "set_headway", params: { route: "A", days: "weekday", from: "07:00", to: "09:00", headway_min: 10 } }] });
    const imp = p.impact;
    expect(imp.window).toEqual({ from: "20260831", to: "20270703", days: 307 });
    expect(imp.totals.km.before).toBeGreaterThan(500000);
    expect(imp.totals.km.delta).toBeGreaterThan(0);
    expect(imp.totals.fleet.after).toBeGreaterThan(imp.totals.fleet.before);
    expect(imp.flags.map((f) => f.code)).toEqual(expect.arrayContaining(["route_km_25", "revenue_hours_25"]));
    expect(imp.routes[0].label).toBe("A");
    // A feed compared with itself: nothing moves, nothing flagged.
    const same = impactOf(before, before);
    expect(same.totals.km.delta).toBe(0);
    expect(same.flags).toEqual([]);
    expect(same.routes).toEqual([]);
  });
});

describe("SNgo Vernon — real vehicle blocks", () => {
  test("a frequency change on a line with blocks says the vehicle schedules must be re-cut", async () => {
    const db = loadReal("vernon");
    const m = buildFeedModel(db);
    const route = [...m.routes.values()].find((r) => r.short_name === "1");
    const p = await previewPlan(db, { operations: [{ type: "set_headway", params: { route: route.id, days: "weekday", from: "07:00", to: "09:00", headway_min: 15, patterns: "main" } }] });
    expect(p.blocked).toBe(false);
    expect(p.integrity).toEqual([]);
    expect(p.steps[0].warnings.join(" ")).toMatch(/vehicle blocks/);
  });
});

describe("libéA Albi — a stop on both sides of the street", () => {
  const R = require("../services/transform/resolve");
  const { resolveSelection } = require("../services/transform/selection");
  const m = buildFeedModel(loadReal("albi"));

  test("the direction picks the side the line serves; both directions take the two sides", () => {
    // Najac: 21225 (towards Parking Mézard, direction 0), 21928 (arrivals, direction 1).
    expect(R.stop(m, "Najac", { routeId: "114" }).ambiguity.code).toBe("stop_ambiguous");
    expect(R.stop(m, "Najac", { routeId: "114", direction: "0" }).value.id).toBe("21225");
    expect(R.stop(m, "Najac", { routeId: "114", direction: "1" }).value.id).toBe("21928");
    const one = resolveSelection(m, { at_stop: "Najac", times: ["07:30"] }, { routeId: "114", direction: "0" });
    expect(one.ambiguities).toEqual([]);
    const trips = one.value.trips.map((id) => m.trips.get(id));
    expect(trips.length).toBeGreaterThan(0);
    expect(trips.every((t) => t.direction_id === "0" && t.first === 7.5 * 3600)).toBe(true);
    const both = resolveSelection(m, { at_stop: "Najac", from: "07:00", to: "08:00" }, { routeId: "114", direction: "both" });
    expect(both.ambiguities).toEqual([]);
    expect(new Set(both.value.trips.map((id) => m.trips.get(id).direction_id))).toEqual(new Set(["0", "1"]));
  });
});
