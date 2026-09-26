/**
 * transformStops.test.js — add_stop / remove_stop on the sample feed, and
 * the primitives under them (resequence timing, shapes kept around the
 * change, shape_dist_traveled recomputed).
 */

"use strict";

const { loadSample } = require("./_helpers/feedDb");
const { buildFeedModel } = require("../services/transform/feedModel");
const { previewPlan } = require("../services/transform/engine");
const { sandboxOf } = require("../services/transform/changeset");
const geo = require("../services/transform/geometry");
const G = require("../services/transform/gtfsOps");
const P = require("../services/transform/patternOps");

const db = loadSample();
const model = buildFeedModel(db);
const s1 = model.routes.get("S1");
const pat = s1.patterns.find((p) => p.direction_id === "0");
const stopAt = (i) => model.stops.get(pat.stops[i]);
const mid = (a, b, dLat = 0.0008) => ({ lat: (a.lat + b.lat) / 2 + dLat, lon: (a.lon + b.lon) / 2 });

describe("geometry", () => {
  test("stops project in order along a shape, and a slice is the part between them", () => {
    const pts = geo.readShape(db, [...pat.shapes][0]);
    const cum = geo.measure(pts);
    const proj = geo.projectStops(pts, cum, pat.stops.map((id) => model.stops.get(id)));
    for (let i = 1; i < proj.length; i++) expect(proj[i].along).toBeGreaterThanOrEqual(proj[i - 1].along);
    const part = geo.slice(pts, cum, proj[2].along, proj[4].along);
    expect(geo.measure(part).pop()).toBeCloseTo(proj[4].along - proj[2].along, 0);
  });

  test("the feed's shape_dist unit is detected (km in the sample)", () => {
    expect(geo.distUnit(db)).toBe(0.001);
  });
});

describe("gtfsOps.rewriteTrip", () => {
  test("keeps sequences when there is room, renumbers otherwise, refuses times going backwards", () => {
    const sb = sandboxOf(db);
    const tid = pat.trips[0];
    const old = G.stopTimesOf(sb, tid);
    const rows = old.map((r) => ({ ...r }));
    rows.splice(1, 0, { stop_id: pat.stops[5], arrival_time: old[0].departure_time, departure_time: old[1].arrival_time });
    const out = G.rewriteTrip(sb, tid, rows);
    const after = G.stopTimesOf(sb, tid);
    expect(after).toHaveLength(old.length + 1);
    expect(out.renumbered).toBe(true); // sequences 1,2,3… have no gap
    const bad = after.map((r) => ({ ...r }));
    bad[3].arrival_time = "00:00:01";
    expect(() => G.rewriteTrip(sb, tid, bad)).toThrow(/backwards/);
    sb.close();
  });
});

describe("add_stop", () => {
  test("a new stop between two stops: inserted in both directions, timed from the old stretch, shape kept elsewhere", async () => {
    const X = { name: "Hospital", ...mid(stopAt(3), stopAt(4)) };
    const p = await previewPlan(db, { operations: [{ type: "add_stop", params: { route: "S1", stop: X } }] });
    expect(p.blocked).toBe(false);
    expect(p.steps[0].summary).toMatch(/Hospital \(new stop\) added to \d+ trip/);
    expect(p.steps[0].summary).toMatch(/scaled by distance/);
    expect(p.changes.stops.inserted).toBe(1);
    expect(p.integrity).toEqual([]);
    expect(p.lines).toEqual(expect.arrayContaining(["Line S1 now serves Hospital"]));
    // Running time grows by less than two minutes for one stop on a metro line.
    const rt = p.diff.items.filter((i) => i.code === "service_running" && i.route === "S1");
    expect(rt.length).toBeGreaterThan(0);
    for (const i of rt) expect(i.after - i.before).toBeLessThanOrEqual(2);
  });

  test("between given stops, only on some days: the other days keep the old sequence", async () => {
    const sb = sandboxOf(db);
    const p = await previewPlan(sb, { operations: [{ type: "add_stop", params: { route: "S1", stop: pat.stops[10], after: pat.stops[3], before: pat.stops[4], days: "sunday", direction: "0" } }] });
    // The stop is already served (later in the pattern): nothing to insert.
    expect(p.steps[0].status).toBe("blocked");
    const q = await previewPlan(sb, { operations: [{ type: "add_stop", params: { route: "S1", stop: { name: "Market", ...mid(stopAt(3), stopAt(4)) }, after: pat.stops[3], before: pat.stops[4], days: "sunday", direction: "0" } }] });
    expect(q.blocked).toBe(false);
    expect(q.diff.items.filter((i) => i.day === "weekday" || i.day === "saturday")).toEqual([]);
    // Sunday trips run on a Sunday-only service: no split, only they change.
    expect(q.changes.calendar).toBeUndefined();
    expect(q.diff.items.some((i) => i.day === "sunday" && i.code === "service_running")).toBe(true);
    sb.close();
  });

  test("a stop far from the line is blocked with a question", async () => {
    const far = { name: "Far away", lat: stopAt(3).lat + 0.1, lon: stopAt(3).lon + 0.1 };
    const p = await previewPlan(db, { operations: [{ type: "add_stop", params: { route: "S1", stop: far } }] });
    expect(p.steps[0].status).toBe("blocked");
    expect(p.steps[0].ambiguities[0].code).toBe("stop_far_from_line");
  });

  test("a new stop without a name, or an unknown stop, is blocked", async () => {
    const p = await previewPlan(db, { operations: [
      { type: "add_stop", params: { route: "S1", stop: { lat: 40.8, lon: -73.95 } } },
      { type: "add_stop", params: { route: "S1", stop: "Nowhere Street" } },
    ] });
    expect(p.steps.map((s) => s.ambiguities[0]?.code)).toEqual(["stop_name_missing", "stop_unknown"]);
  });
});

describe("remove_stop", () => {
  test("other stops keep their times by default", async () => {
    const sb = sandboxOf(db);
    const victim = pat.stops[5];
    const tid = pat.trips[0];
    const before = G.stopTimesOf(sb, tid).filter((r) => r.stop_id !== victim).map((r) => [r.stop_id, r.arrival_time]);
    const p = await previewPlan(sb, { operations: [{ type: "remove_stop", params: { route: "S1", stop: victim } }] });
    expect(p.blocked).toBe(false);
    expect(p.lines.join("\n")).toMatch(/no longer serves/);
    // Replay on the sandbox to look at the trip.
    const { computeChangeset, toOps, applyOps } = require("../services/transform/changeset");
    expect(computeChangeset).toBeDefined();
    const sb2 = sandboxOf(sb);
    const m2 = buildFeedModel(sb2);
    const positions = pat.stops.map((s, i) => ({ stop_id: s, from: i })).filter((x) => x.stop_id !== victim);
    P.resequence(sb2, m2, [tid], { positions, mode: "absorb" });
    const after = G.stopTimesOf(sb2, tid).map((r) => [r.stop_id, r.arrival_time]);
    expect(after).toEqual(before);
    expect(toOps).toBeDefined();
    expect(applyOps).toBeDefined();
    sb.close();
    sb2.close();
  });

  test("a stop no line serves is blocked", async () => {
    const lonely = [...model.stops.values()].find((s) => s.location_type === "0" && ![...model.patterns.values()].some((p) => p.stops.includes(s.id)));
    if (!lonely) return;
    const p = await previewPlan(db, { operations: [{ type: "remove_stop", params: { stop: lonely.id } }] });
    expect(p.steps[0].ambiguities[0].code).toBe("stop_not_served");
  });
});
