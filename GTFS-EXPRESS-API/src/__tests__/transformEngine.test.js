/**
 * transformEngine.test.js — the transformation engine on the sample feed:
 * lossless model, changeset round trip (redo then undo gives back the same
 * tables), set_headway with its edge cases (days shared with other days,
 * blocked parameters), semantic diff, conformance measured on a real feed.
 */

"use strict";

const { loadSample } = require("./_helpers/feedDb");
const { buildFeedModel, departures, routeStats } = require("../services/transform/feedModel");
const { sandboxOf, computeChangeset, toOps, applyOps } = require("../services/transform/changeset");
const { semanticDiff } = require("../services/transform/semanticDiff");
const { checkFeedConformance } = require("../services/transform/feedView");
const { previewPlan, commitPreview, integrityOf } = require("../services/transform/engine");
const G = require("../services/transform/gtfsOps");

const dump = (db, t) => db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2, 3`).all();

describe("feedModel", () => {
  const db = loadSample();
  const model = buildFeedModel(db);

  test("reads every trip with its pattern and a representative date per weekday", () => {
    expect(model.trips.size).toBe(db.prepare("SELECT COUNT(*) AS n FROM trips").get().n);
    for (const d of ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]) expect(model.representative[d]).toMatch(/^\d{8}$/);
    const t = model.trips.values().next().value;
    expect(t.stops.length).toBeGreaterThan(1);
    expect(model.patterns.get(t.pattern).trips).toContain(t.id);
  });

  test("a Sunday service with holiday dates is still a Sunday service", () => {
    expect([...G.serviceDows(model, "SUN")]).toEqual(["sun"]);
    expect([...G.serviceDows(model, "WKD")].sort()).toEqual(["fri", "mon", "thu", "tue", "wed"]);
  });

  test("departures and route stats on a weekday", () => {
    const date = model.representative.tue;
    const deps = departures(model, "S1", date);
    expect(deps.size).toBeGreaterThan(0);
    const stats = routeStats(model, "S1", date);
    expect(stats.trips).toBeGreaterThan(0);
    expect(stats.vehicles_peak).toBeGreaterThan(0);
    const dir = Object.values(stats.directions)[0];
    expect(dir.headways.am_peak).toBeGreaterThan(0);
  });
});

describe("changeset", () => {
  test("redo then undo gives back identical tables", () => {
    const db = loadSample();
    const before = { trips: dump(db, "trips"), stop_times: dump(db, "stop_times"), calendar: dump(db, "calendar") };
    const sb = sandboxOf(db);
    const model = buildFeedModel(sb);
    const tid = [...model.trips.values()].find((t) => t.route_id === "S1").id;
    G.isolateDays(sb, model, [tid], ["mon"]);
    G.cloneTrip(sb, tid, { shiftSec: 600 });
    sb.prepare("UPDATE stops SET stop_name = stop_name || ' (x)' WHERE stop_id = (SELECT stop_id FROM stops LIMIT 1)").run();
    const cs = computeChangeset(db, sb, ["trips", "stop_times", "calendar", "calendar_dates", "stops", "frequencies"]);
    expect(cs.empty).toBe(false);
    const { redoOps, undoOps } = toOps(cs);
    db.transaction(() => applyOps(db, redoOps))();
    expect(computeChangeset(db, sb, ["trips", "stop_times", "calendar", "calendar_dates", "stops"]).empty).toBe(true);
    db.transaction(() => applyOps(db, undoOps))();
    expect(dump(db, "trips")).toEqual(before.trips);
    expect(dump(db, "stop_times")).toEqual(before.stop_times);
    expect(dump(db, "calendar")).toEqual(before.calendar);
    sb.close();
  });
});

describe("set_headway", () => {
  const plan = (params, extra = {}) => ({ title: "test", operations: [{ type: "set_headway", params }], ...extra });

  test("weekday morning every 6 min: only weekday trips in the window change", async () => {
    const db = loadSample();
    const m0 = buildFeedModel(db);
    const satBefore = routeStats(m0, "S1", m0.representative.sat);
    const p = await previewPlan(db, plan({ route: "S1", days: "weekday", from: "07:00", to: "09:00", headway_min: 6 }, { requirements: { clauses: [{ id: "c1", kind: "headway_max", params: { line: "S1", day: "weekday", from: "07:00", to: "09:00", minutes: 6 } }] } }));
    expect(p.blocked).toBe(false);
    expect(p.steps[0].status).toBe("applied");
    expect(p.integrity).toEqual([]);
    expect(Object.keys(p.changes)).toEqual(expect.arrayContaining(["trips", "stop_times"]));
    expect(p.changes.calendar).toBeUndefined();
    expect(p.lines.join("\n")).toMatch(/S1 · weekday · am_peak · dir \d+: every \d+ → 6 min/);
    // The clause the plan answers goes from fail to pass.
    expect(p.conformance.before.results.find((c) => c.id === "c1").status).toBe("fail");
    expect(p.conformance.after.results.find((c) => c.id === "c1").status).toBe("pass");
    // Saturday and Sunday untouched.
    expect(p.diff.routes.find((r) => r.id === "S1")?.status).toBe("changed");
    expect(p.diff.items.filter((i) => i.day === "saturday" || i.day === "sunday")).toEqual([]);
    expect(satBefore.trips).toBeGreaterThan(0);
  });

  test("saturday only on a service shared with other days splits it and leaves the other days alone", async () => {
    const db = loadSample();
    const sb = sandboxOf(db);
    // Make S2 weekday trips also run on saturday: one service for mon..sat.
    sb.prepare("INSERT INTO calendar SELECT 'MS', 1,1,1,1,1,1,0, start_date, end_date FROM calendar WHERE service_id = 'WKD'").run();
    sb.prepare("UPDATE trips SET service_id = 'MS' WHERE route_id = 'S2' AND service_id = 'WKD'").run();
    const m0 = buildFeedModel(sb);
    const tueBefore = routeStats(m0, "S2", m0.representative.tue);
    const p = await previewPlan(sb, plan({ route: "S2", days: "saturday", from: "10:00", to: "12:00", headway_min: 30 }));
    expect(p.blocked).toBe(false);
    expect(p.changes.calendar?.inserted).toBeGreaterThan(0);
    expect(p.diff.items.filter((i) => i.day === "weekday")).toEqual([]);
    expect(p.diff.items.some((i) => i.day === "saturday")).toBe(true);
    expect(tueBefore.trips).toBeGreaterThan(0);
    sb.close();
  });

  test("missing or unknown parameters block the step with a question, and nothing is stored", async () => {
    const db = loadSample();
    const p = await previewPlan(db, { operations: [
      { id: "a", type: "set_headway", params: { route: "Z9", days: "weekday", from: "07:00", to: "09:00", headway_min: 6 } },
      { id: "b", type: "set_headway", params: { route: "S1", days: "weekday", from: "07:00", to: "09:00" } },
      { id: "c", type: "set_headway", params: { route: "S1", days: "someday", from: "09:00", to: "07:00", headway_min: 6 } },
      { id: "d", type: "teleport", params: {} },
    ] });
    expect(p.blocked).toBe(true);
    expect(p.id).toBeNull();
    expect(p.steps.map((s) => s.status)).toEqual(["blocked", "blocked", "blocked", "failed"]);
    expect(p.steps[0].ambiguities[0].code).toBe("route_unknown");
    expect(p.steps[1].ambiguities.map((a) => a.code)).toContain("headway_min_missing");
    expect(p.steps[2].ambiguities.map((a) => a.code)).toEqual(expect.arrayContaining(["days_unknown", "window_inverted"]));
    expect(p.steps[3].error).toMatch(/Unknown operation/);
  });

  test("a plan mixing a blocked step and an applied one cannot be committed", async () => {
    const db = loadSample();
    const p = await previewPlan(db, { operations: [
      { type: "set_headway", params: { route: "S1", days: "weekday", from: "07:00", to: "09:00", headway_min: 6 } },
      { type: "set_headway", params: { route: "S1", days: "weekday" } },
    ] }, { sessionId: "s" });
    expect(p.blocked).toBe(true);
    expect(p.id).toBeTruthy();
    expect(() => commitPreview("s", db, p.id)).toThrow(expect.objectContaining({ code: "PLAN_BLOCKED" }));
  });

  test("commit is one undoable edit, stale previews are refused", async () => {
    const db = loadSample();
    const n0 = db.prepare("SELECT COUNT(*) AS n FROM trips").get().n;
    const p = await previewPlan(db, plan({ route: "S1", days: "weekday", from: "07:00", to: "09:00", headway_min: 6 }), { sessionId: "s", dataVersion: "v1" });
    expect(() => commitPreview("s", db, p.id, { dataVersion: "v2" })).toThrow(expect.objectContaining({ code: "PREVIEW_STALE" }));
    expect(() => commitPreview("other", db, p.id, { dataVersion: "v1" })).toThrow(expect.objectContaining({ code: "PREVIEW_NOT_FOUND" }));
    const out = commitPreview("s", db, p.id, { dataVersion: "v1" });
    expect(out.editId).toBeTruthy();
    const n1 = db.prepare("SELECT COUNT(*) AS n FROM trips").get().n;
    expect(n1).not.toBe(n0);
    const log = db.prepare("SELECT * FROM _edit_log ORDER BY id DESC LIMIT 1").get();
    expect(log.entity).toBe("transform");
    expect(integrityOf(db)).toEqual([]);
    expect(() => commitPreview("s", db, p.id, { dataVersion: "v1" })).toThrow(expect.objectContaining({ code: "PREVIEW_NOT_FOUND" }));
  });

  test("frequency-based trips get their window split", async () => {
    const db = loadSample();
    const m0 = buildFeedModel(db);
    const [tid, windows] = [...m0.frequencies.entries()][0];
    const t = m0.trips.get(tid);
    const w = windows[0];
    const mid = w.start + Math.floor((w.end - w.start) / 2);
    const hhmm = (s) => `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
    const days = [...G.serviceDows(m0, t.service_id)];
    const route = m0.routes.get(t.route_id);
    const p = await previewPlan(db, plan({ route: route.short_name || route.id, days, direction: t.direction_id, from: hhmm(w.start), to: hhmm(mid), headway_min: 7 }));
    expect(p.blocked).toBe(false);
    expect(p.changes.frequencies).toBeTruthy();
  });
});

describe("semanticDiff and feed conformance", () => {
  test("renaming and moving a stop is reported as such", () => {
    const db = loadSample();
    const before = buildFeedModel(db);
    const sb = sandboxOf(db);
    const s = sb.prepare("SELECT stop_id, stop_lat FROM stops WHERE location_type IS NULL OR location_type = 0 LIMIT 1").get();
    sb.prepare("UPDATE stops SET stop_name = 'Renamed', stop_lat = stop_lat + 0.001 WHERE stop_id = ?").run(s.stop_id);
    const d = semanticDiff(before, buildFeedModel(sb));
    expect(d.stops.renamed.map((x) => x.id)).toContain(s.stop_id);
    expect(d.stops.moved.map((x) => x.id)).toContain(s.stop_id);
    sb.close();
  });

  test("an identical feed has an empty diff", () => {
    const db = loadSample();
    const m = buildFeedModel(db);
    expect(semanticDiff(m, buildFeedModel(db)).empty).toBe(true);
  });

  test("the conformance checker measures a real feed", () => {
    const db = loadSample();
    const r = checkFeedConformance(db, { clauses: [
      { id: "h", kind: "headway_max", params: { line: "S1", day: "weekday", from: "07:00", to: "09:00", minutes: 60 } },
      { id: "s", kind: "span", params: { line: "S1", day: "weekday", first_before: "06:00", last_after: "20:00" } },
      { id: "d", kind: "days", params: { line: "S1", days: ["mon", "sat", "sun"] } },
      { id: "x", kind: "line_exists", params: { line: "Q42" } },
    ] });
    const by = Object.fromEntries(r.results.map((c) => [c.id, c.status]));
    expect(by.h).toBe("pass");
    expect(["pass", "fail"]).toContain(by.s);
    expect(by.d).toBe("pass");
    expect(by.x).toBe("fail");
  });
});
