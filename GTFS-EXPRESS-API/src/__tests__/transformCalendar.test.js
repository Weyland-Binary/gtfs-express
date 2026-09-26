/**
 * transformCalendar.test.js — the calendar operators on the sample feed:
 * run_like (in place on services of the targeted lines alone, trips moved
 * off shared services, seasonal reference dates, idempotence), copy_day_service,
 * remove_day_service, suspend_service, apply_holiday_rules and extend_validity,
 * every question they ask, and what they must leave alone (other lines, other
 * dates, trip ids, stop_times, frequencies).
 */

"use strict";

const { loadSample } = require("./_helpers/feedDb");
const { buildFeedModel, departures } = require("../services/transform/feedModel");
const { previewPlan, commitPreview } = require("../services/transform/engine");
const { sandboxOf } = require("../services/transform/changeset");
const registry = require("../services/transform/operators");
const G = require("../services/transform/gtfsOps");
const S = require("../services/transform/scope");
const { _internals: fm } = require("../services/transform/feedModel");

const db = loadSample();

const plan = (ops, extra = {}) => ({ title: "calendar test", operations: ops.map(([type, params]) => ({ type, params })), ...extra });
const codes = (step) => step.ambiguities.map((a) => a.code).sort();
const tripsOn = (m, route, date) => [...m.trips.values()].filter((t) => t.route_id === route && m.runsOn(t.service_id, date)).length;
const deps = (m, route, date) => JSON.stringify([...departures(m, route, date).entries()].sort());
const commit = async (d, p) => {
  expect(p.blocked).toBe(false);
  expect(p.integrity).toEqual([]);
  commitPreview("t", d, p.id);
  return buildFeedModel(d);
};
const cdRow = (d, sid, date) => d.prepare("SELECT exception_type AS t FROM calendar_dates WHERE service_id = ? AND date = ?").get(sid, date)?.t ?? null;

describe("catalogue", () => {
  test("six calendar operators, each with params, an example and a description", () => {
    const cal = registry.catalogue().filter((o) => o.category === "calendar");
    expect(cal.map((o) => o.type).sort()).toEqual(["apply_holiday_rules", "copy_day_service", "extend_validity", "remove_day_service", "run_like", "suspend_service"]);
    for (const o of cal) {
      expect(o.params.length).toBeGreaterThan(0);
      expect(o.example).toBeTruthy();
      expect(o.description).toBeTruthy();
    }
  });
});

describe("run_like", () => {
  test("14 July on the Sunday timetable, all lines: one exception pair, no trip touched; asking again changes nothing", async () => {
    const p = await previewPlan(db, plan([["run_like", { routes: "all", like: "sunday", dates: ["2026-07-14"] }], ["run_like", { routes: "all", like: "Sunday timetable", dates: "14/07/2026" }]]));
    expect(p.steps.map((s) => s.status)).toEqual(["applied", "skipped"]);
    expect(p.steps[0].summary).toMatch(/^All lines run the Sunday timetable on 2026-07-14 \(2026-07-14: \d+ → \d+ trips\); service SUN, WKD edited \(2 calendar rows\)\.$/);
    expect(p.steps[1].summary).toMatch(/already run the Sunday timetable/);
    expect(p.changes).toEqual({ calendar_dates: { inserted: 2, deleted: 0, updated: 0 } });
    expect(p.integrity).toEqual([]);
    // Weekday trips running after midnight are lost on the night after the holiday.
    expect(p.steps[0].warnings.join("\n")).toMatch(/ran past midnight/);
    const service = p.diff.items.filter((i) => i.code.startsWith("service_"));
    expect(service.length).toBeGreaterThan(0);
    for (const i of service) expect(i.dates && i.dates.from === "20260714" && i.dates.to === "20260714").toBe(true);
  });

  test("one line on services shared with others: its trips move to services of their own, the other lines and dates keep their timetable", async () => {
    const d = loadSample();
    const m0 = buildFeedModel(d);
    // S1 and S2 share a vehicle block and a trip-to-trip transfer.
    const a = m0.trips.get("S1_WKD_0_001");
    const b = m0.trips.get("S2_WKD_0_001");
    d.prepare("UPDATE trips SET block_id = 'BLK1' WHERE trip_id IN ('S1_WKD_0_001', 'S2_WKD_0_001')").run();
    d.prepare("INSERT INTO transfers (from_stop_id, to_stop_id, from_trip_id, to_trip_id, transfer_type) VALUES (?, ?, ?, ?, 1)").run(a.stops.at(-1), b.stops[0], a.id, b.id);
    const p = await previewPlan(d, plan([["run_like", { route: "S1", like: "sunday", dates: ["2026-07-14"] }]]));
    const step = p.steps[0];
    expect(step.status).toBe("applied");
    expect(step.summary).toMatch(/^Line S1 runs the Sunday timetable on 2026-07-14 \(2026-07-14: 224 → 130 trips\); 354 trips moved to service /);
    // Only trips.service_id changes: same trip ids, no stop_times rewritten.
    expect(p.changes.trips).toEqual({ inserted: 0, deleted: 0, updated: 354 });
    expect(p.changes.stop_times).toBeUndefined();
    const w = step.warnings.join("\n");
    expect(w).toMatch(/1 vehicle block \(block_id, e\.g\. BLK1\) now mix/);
    expect(w).toMatch(/1 trip-to-trip transfer in transfers\.txt involve trips whose dates changed/);
    expect(w).toMatch(/10 trips no longer running .* past midnight/);
    const m1 = await commit(d, p);
    expect(deps(m1, "S1", "20260714")).toBe(deps(m0, "S1", "20260712"));
    expect(tripsOn(m1, "S1", "20260714")).toBe(130);
    for (const [r, date] of [["S2", "20260714"], ["B1", "20260714"], ["S1", "20260713"], ["S1", "20260715"], ["S1", "20260712"], ["S1", "20261126"]]) expect(deps(m1, r, date)).toBe(deps(m0, r, date));
    expect(m1.trips.has("S1_WKD_0_001")).toBe(true);
  });

  test("the reference is the nearest regular day: a July date gets the summer Sunday, an October one the winter Sunday", async () => {
    const d = loadSample();
    // S1 runs a reduced Sunday timetable in July-August (service S1S), its own winter one otherwise (S1W).
    const summer = ["20260705", "20260712", "20260719", "20260726", "20260802", "20260809", "20260816", "20260823", "20260830"];
    d.prepare("INSERT INTO calendar (service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date) VALUES ('S1W', 0, 0, 0, 0, 0, 0, 1, '20260401', '20270331'), ('S1S', 0, 0, 0, 0, 0, 0, 1, '20260705', '20260830')").run();
    const cd = d.prepare("INSERT INTO calendar_dates (service_id, date, exception_type) VALUES (?, ?, ?)");
    for (const x of summer) cd.run("S1W", x, 2);
    for (const x of ["20260704", "20261126", "20261225"]) cd.run("S1W", x, 1);
    d.prepare("UPDATE trips SET service_id = 'S1W' WHERE route_id = 'S1' AND service_id = 'SUN'").run();
    for (const id of ["S1_SUN_0_001", "S1_SUN_0_002", "S1_SUN_1_001", "S1_SUN_1_002"]) G.cloneTrip(d, id, { newId: `${id}_S`, serviceId: "S1S", shiftSec: 300 });
    const m0 = buildFeedModel(d);
    expect(tripsOn(m0, "S1", "20260712")).toBe(4);
    const p = await previewPlan(d, plan([["run_like", { routes: ["S1"], like: "sunday", dates: ["2026-07-14", "2026-10-13"] }]]));
    expect(p.steps[0].status).toBe("applied");
    // S1W and S1S serve S1 alone: edited in place; S1's weekday trips leave the shared WKD.
    expect(p.steps[0].summary).toMatch(/service S1S, S1W edited/);
    const m1 = await commit(d, p);
    expect(deps(m1, "S1", "20260714")).toBe(deps(m0, "S1", "20260712"));
    expect(deps(m1, "S1", "20261013")).toBe(deps(m0, "S1", "20261011"));
    expect(tripsOn(m1, "S1", "20261013")).toBe(130);
    expect(cdRow(d, "S1S", "20260714")).toBe(1);
    expect(cdRow(d, "S1W", "20261013")).toBe(1);
  });

  test("every missing or wrong parameter is a question, all of them at once", async () => {
    const p = await previewPlan(db, plan([
      ["run_like", { like: "holiday" }],
      ["run_like", { routes: "Z9", like: "sunday", dates: ["2026-07-14"] }],
      ["run_like", { routes: "S1", except_routes: "S1", like: "sunday", dates: ["2026-07-14"] }],
      ["run_like", { routes: "S1", like: "sunday", dates: ["2028-01-01"] }],
      ["run_like", { routes: "S1", dates: ["2026-07-14"] }],
      ["run_like", { routes: "S1", like: "none", dates: ["2026-02-31"], except: ["25/12"] }],
      ["run_like", { routes: "S1", like: "weekend", dates: ["2026-07-14"] }],
    ]));
    expect(p.steps.every((s) => s.status === "blocked")).toBe(true);
    expect(codes(p.steps[0])).toEqual(["like_invalid", "routes_missing", "scope_missing"]);
    expect(p.steps[0].ambiguities.find((a) => a.code === "like_invalid").options).toEqual(expect.arrayContaining(["weekday", "saturday", "sunday", "none"]));
    expect(codes(p.steps[1])).toEqual(["route_unknown"]);
    expect(codes(p.steps[2])).toEqual(["routes_empty"]);
    expect(codes(p.steps[3])).toEqual(["scope_empty"]);
    expect(p.steps[3].warnings.join("\n")).toMatch(/1 date outside the feed's validity .* ignored \(2028-01-01\)/);
    expect(codes(p.steps[4])).toEqual(["like_missing"]);
    // Malformed dates are questions, never dropped (the scope would silently grow).
    expect(codes(p.steps[5])).toEqual(["date_invalid", "date_invalid"]);
    // Two timetables named: which one?
    expect(codes(p.steps[6])).toEqual(["like_ambiguous"]);
    expect(p.steps[6].ambiguities[0].options).toEqual(["saturday", "sunday"]);
    expect(p.empty).toBe(true);
  });
});

describe("lines without a day type, weekday variants, copy_day_service", () => {
  // B1 without Sunday service; S1 with a Friday-only extra service.
  const sb = sandboxOf(db);
  G.deleteTrips(sb, sb.prepare("SELECT trip_id FROM trips WHERE route_id = 'B1' AND service_id = 'SUN'").all().map((r) => r.trip_id));
  sb.prepare("INSERT INTO calendar (service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date) VALUES ('FRI', 0, 0, 0, 0, 1, 0, 0, '20260401', '20270331')").run();
  G.cloneTrip(sb, "S1_WKD_0_001", { newId: "S1_FRI_0_001", serviceId: "FRI", shiftSec: 3600 });
  const m0 = buildFeedModel(sb);
  afterAll(() => sb.close());

  test("a named line with nothing to run that day is a question; for holidays it simply does not run; weekday variants ask which day", async () => {
    const p = await previewPlan(sb, plan([
      ["run_like", { routes: "B1", like: "sunday", dates: ["2026-07-14"] }],
      ["apply_holiday_rules", { dates: ["2026-09-07"] }],
      ["run_like", { routes: "S1", like: "weekday", dates: ["2026-07-04"] }],
      ["run_like", { routes: "S1", like: "fri", dates: ["2026-07-04"] }],
      ["copy_day_service", { routes: "S3", from_day: "saturday", to_days: "sunday", mode: "add", from_date: "2027-03-01" }],
      ["run_like", { routes: "F1", like: "none", dates: "2026-12-24, 2026-12-31" }],
      ["run_like", { routes: "S1", like: "saturday", days: "weekday", dates: ["2026-11-26", "2026-11-27"] }],
    ]));
    const [noSunday, holidays, variants, friday, add, none, weekdaysOnly] = p.steps;
    expect(codes(noSunday)).toEqual(["like_day_without_service"]);
    expect(noSunday.ambiguities[0].message).toMatch(/Line B1 has no Sunday trips to run \(on 2026-07-12, the nearest regular Sunday\)/);
    expect(noSunday.ambiguities[0].options).toEqual(["weekday", "saturday", "none"]);
    expect(holidays.status).toBe("applied");
    expect(holidays.warnings).toEqual(expect.arrayContaining(["Line B1 has no Sunday timetable: no service on these dates."]));
    expect(holidays.summary).toMatch(/^Holidays, 1 date in the feed: All lines run the Sunday timetable — 1 changed \(2026-09-07\)/);
    expect(codes(variants)).toEqual(["like_ambiguous"]);
    expect(variants.ambiguities[0].options).toEqual(["mon", "tue", "wed", "thu", "fri"]);
    expect(friday.status).toBe("applied");
    expect(friday.summary).toMatch(/^Line S1 runs the Friday timetable on 2026-07-04 \(2026-07-04: 310 → 225 trips\)/);
    expect(add.status).toBe("applied");
    expect(add.summary).toMatch(/^Line S3: the Saturday timetable added to Sundays on 2027-03-07, 2027-03-14, 2027-03-21, 2027-03-28 \(2027-03-07: 136 → 282 trips\); 146 trips moved to service SAT~/);
    expect(add.warnings.join("\n")).toMatch(/136 trips of these lines already ran on Sundays: kept alongside the copy \(mode add\)/);
    expect(none.summary).toMatch(/^Line F1: no service on 2026-12-24, 2026-12-31 \(2026-12-24: 100 → 0 trips\)/);
    // 26 November runs the Sunday services: it is not a weekday; the Friday is (with its extra trip).
    expect(weekdaysOnly.summary).toMatch(/^Line S1 runs the Saturday timetable on 2026-11-27 \(2026-11-27: 225 → 180 trips\)/);
    expect(p.integrity).toEqual([]);
  });

  test("copy_day_service: a weekday+Saturday line gets Sunday service at Saturday level from a date, holidays run as Sundays included", async () => {
    const p = await previewPlan(sb, plan([["copy_day_service", { routes: ["B1"], from_day: "saturday", to_days: "sunday", from_date: "2026-08-30" }]]));
    const step = p.steps[0];
    // 31 Sundays + 26 November (the network runs its Sunday services); 25 December is not a
    // Sunday here: the Friday-only service of this sandbox still runs that day.
    expect(step.summary).toMatch(/^Line B1: the Saturday timetable copied to Sundays on 32 dates from 2026-08-30 to 2027-03-28 \(incl\. 1 holiday run as Sundays\) \(2026-08-30: 0 → 146 trips\)/);
    expect(step.warnings.join("\n")).toMatch(/copied from the Saturday timetable: on Sundays traffic and the start of service often differ/);
    const m1 = await commit(sb, p);
    expect(deps(m1, "B1", "20260906")).toBe(deps(m0, "B1", "20260905"));
    expect(tripsOn(m1, "B1", "20261126")).toBe(146);
    expect(tripsOn(m1, "B1", "20261225")).toBe(0);
    expect(tripsOn(m1, "B1", "20260823")).toBe(0);
    for (const [r, date] of [["B1", "20260905"], ["B1", "20260907"], ["B2", "20260906"], ["S1", "20261126"]]) expect(deps(m1, r, date)).toBe(deps(m0, r, date));
  });

  test("copy_day_service questions", async () => {
    const p = await previewPlan(sb, plan([
      ["copy_day_service", { routes: "B1" }],
      ["copy_day_service", { routes: "B1", from_day: "none", to_days: "funday", mode: "twice" }],
      ["copy_day_service", { routes: "B1", from_day: "saturday", to_days: "sunday", dates: ["2026-09-07"] }],
    ]));
    expect(codes(p.steps[0])).toEqual(["from_day_missing", "to_days_missing"]);
    expect(codes(p.steps[1])).toEqual(["days_unknown", "from_day_invalid", "mode_invalid"]);
    expect(codes(p.steps[2])).toEqual(["scope_empty"]);
  });
});

describe("remove_day_service", () => {
  test("no Sunday service on B4 from September (shared service), none on N1 (its own service, frequencies), no Saturday on S3 (trips deleted): other days untouched, idempotent", async () => {
    const d = loadSample();
    const m0 = buildFeedModel(d);
    const a = m0.trips.get("S3_SAT_0_001");
    d.prepare("INSERT INTO transfers (from_stop_id, to_stop_id, from_trip_id, to_trip_id, transfer_type) VALUES (?, ?, 'S3_SAT_0_001', 'S1_SAT_0_001', 1)").run(a.stops[0], m0.trips.get("S1_SAT_0_001").stops[0]);
    const p = await previewPlan(d, plan([
      ["remove_day_service", { routes: "B4", days: "sunday", from_date: "2026-09-01" }],
      ["remove_day_service", { routes: "N1", days: "dimanche" }],
      ["remove_day_service", { routes: "N1", days: "sunday" }],
      ["remove_day_service", { routes: "S3", days: "saturday" }],
    ]));
    const [b4, n1, again, s3] = p.steps;
    expect(b4.summary).toMatch(/^Line B4: no more Sunday service on 32 dates from 2026-09-06 to 2027-03-28 \(2026-09-06: 92 → 0 trips\); 92 trips moved to service SUN~/);
    expect(b4.warnings.join("\n")).toMatch(/The Sunday timetable also ran on 2 other dates \(2026-11-26, 2026-12-25, e\.g\. holidays\)/);
    expect(b4.warnings.join("\n")).toMatch(/On 32 dates \d+ stops have no service at all/);
    expect(n1.summary).toMatch(/^Line N1: no more Sunday service on 52 dates from 2026-04-05 to 2027-03-28 \(2026-04-05: \d+ → 0 trips\); service NIT edited \(1 calendar row\)\.$/);
    expect(again.status).toBe("skipped");
    expect(s3.summary).toMatch(/^Line S3: no more Saturday service on 52 dates from 2026-04-04 to 2027-03-27 \(2026-04-04: 146 → 0 trips\); 146 trips deleted \(no date left\)\.$/);
    expect(s3.warnings.join("\n")).toMatch(/1 trip-to-trip transfer in transfers\.txt referenced deleted trips and was removed/);
    expect(p.changes.frequencies).toBeUndefined();
    expect(p.changes.stop_times.inserted + p.changes.stop_times.updated).toBe(0);
    expect(p.changes.trips.deleted).toBe(146);
    const m1 = await commit(d, p);
    // NIT loses Sundays through its weekly flag, not 52 exceptions.
    expect(d.prepare("SELECT sunday, monday FROM calendar WHERE service_id = 'NIT'").get()).toEqual({ sunday: 0, monday: 1 });
    expect(d.prepare("SELECT COUNT(*) AS n FROM calendar_dates WHERE service_id = 'NIT'").get().n).toBe(0);
    expect(d.prepare("SELECT COUNT(*) AS n FROM frequencies").get().n).toBe(4);
    expect(tripsOn(m1, "B4", "20260906")).toBe(0);
    expect(tripsOn(m1, "B4", "20261126")).toBe(0);
    expect(tripsOn(m1, "N1", "20260906")).toBe(0);
    expect(tripsOn(m1, "S3", "20260905")).toBe(0);
    expect(d.prepare("SELECT COUNT(*) AS n FROM transfers WHERE from_trip_id IS NOT NULL").get().n).toBe(0);
    for (const [r, date] of [["B4", "20260830"], ["B4", "20260907"], ["B4", "20260905"], ["S1", "20260906"], ["N1", "20260907"], ["N1", "20260905"], ["S3", "20260906"], ["S3", "20260907"], ["S1", "20260905"]]) expect(deps(m1, r, date)).toBe(deps(m0, r, date));
  });

  test("days are required", async () => {
    const p = await previewPlan(db, plan([["remove_day_service", { routes: "B4" }]]));
    expect(codes(p.steps[0])).toEqual(["days_missing"]);
  });
});

describe("suspend_service", () => {
  test("a line suspended over a period: summary with the replacement, stops left without service, other lines untouched", async () => {
    const p = await previewPlan(db, plan([["suspend_service", { routes: "F1", from_date: "2026-10-12", to_date: "2026-11-30", replacement: "shuttle buses Wall St - Dumbo" }]]));
    const step = p.steps[0];
    expect(step.summary).toMatch(/^Line F1 suspended on 50 dates from 2026-10-12 to 2026-11-30 \(2026-10-12: 100 → 0 trips\) — replacement: shuttle buses Wall St - Dumbo; 234 trips moved to service /);
    const w = step.warnings.join("\n");
    expect(w).toMatch(/On 50 dates 26 stops have no service at all/);
    expect(w).toMatch(/The replacement \(shuttle buses Wall St - Dumbo\) is not created by this step/);
    expect(p.integrity).toEqual([]);
    const routed = p.diff.items.filter((i) => i.route);
    expect(routed.length).toBeGreaterThan(0);
    for (const i of routed) {
      expect(i.route).toBe("F1");
      if (i.dates) expect(i.dates.from >= "20261012" && i.dates.to <= "20261130").toBe(true);
    }
  });

  test("until further notice (a service shortened in place), frequency-based trips, short notice", async () => {
    const d = loadSample();
    const today = fm.dateToYmd(new Date());
    const soon = fm.addDays(today, 3);
    const later = fm.addDays(today, 10);
    const shortNotice = soon >= "20260401" && later <= "20270331";
    const ops = [["suspend_service", { routes: "N1", from_date: "2027-01-04", to_date: "until_further_notice" }]];
    if (shortNotice) ops.push(["suspend_service", { routes: "B6", from_date: soon, to_date: later }]);
    const p = await previewPlan(d, plan(ops));
    expect(p.steps[0].summary).toMatch(/^Line N1 suspended on 87 dates from 2027-01-04 to 2027-03-31 .*no replacement stated; service NIT edited \(1 calendar row\)\.$/);
    expect(p.steps[0].warnings.join("\n")).toMatch(/until further notice: until the end of the feed \(2027-03-31\)/);
    if (shortNotice) expect(p.steps[1].warnings.join("\n")).toMatch(/within 7 days: .*GTFS-RT/);
    await commit(d, p);
    expect(d.prepare("SELECT start_date, end_date FROM calendar WHERE service_id = 'NIT'").get()).toEqual({ start_date: "20260401", end_date: "20270103" });
    expect(d.prepare("SELECT COUNT(*) AS n FROM calendar_dates WHERE service_id = 'NIT'").get().n).toBe(0);
    expect(d.prepare("SELECT COUNT(*) AS n FROM frequencies").get().n).toBe(4);
  });

  test("questions: dates, the end, the start, the lines, a line left without any service", async () => {
    const p = await previewPlan(db, plan([
      ["suspend_service", { routes: "F1" }],
      ["suspend_service", { routes: "F1", from_date: "2026-10-01" }],
      ["suspend_service", { routes: "F1", to_date: "2026-10-01" }],
      ["suspend_service", { from_date: "2026-10-01", to_date: "2026-10-31" }],
      ["suspend_service", { routes: "F1", from_date: "2026-04-01", to_date: "2027-03-31" }],
    ]));
    expect(p.steps.map(codes)).toEqual([["dates_missing"], ["to_date_missing"], ["from_date_missing"], ["routes_missing"], ["line_left_without_service"]]);
    expect(p.steps[1].ambiguities[0].options).toEqual(["until_further_notice"]);
  });
});

describe("apply_holiday_rules", () => {
  test("holidays on the Sunday timetable except the ferry, which does not run (a Saturday holiday included)", async () => {
    const d = loadSample();
    const m0 = buildFeedModel(d);
    const calendars = { public_holidays: { dates: ["2026-05-25", "2026-07-04", "2026-09-07", "2026-11-26", "2027-01-01", "2027-06-01"] } };
    const p = await previewPlan(d, plan([["apply_holiday_rules", { except_routes: ["F1"], except_rule: "none" }], ["apply_holiday_rules", { except_routes: ["F1"], except_rule: "none" }]], { calendars }));
    const step = p.steps[0];
    expect(step.summary).toMatch(/^Public holidays, 5 dates in the feed: All lines except F1 run the Sunday timetable; Line F1 does not run — 5 changed \(5 dates from 2026-05-25 to 2027-01-01\)/);
    expect(step.warnings.join("\n")).toMatch(/1 date outside the feed's validity .* ignored \(2027-06-01\)/);
    expect(p.steps[1].status).toBe("skipped");
    const m1 = await commit(d, p);
    // Services of every line but F1 get the classic exception pairs.
    expect(cdRow(d, "WKD", "20260907")).toBe(2);
    expect(cdRow(d, "SUN", "20260907")).toBe(1);
    expect(cdRow(d, "SAT", "20260704")).toBe(2);
    expect(deps(m1, "S1", "20260907")).toBe(deps(m0, "S1", "20260906"));
    expect(tripsOn(m1, "S1", "20260704")).toBe(130);
    for (const date of ["20260907", "20260704", "20261126"]) expect(tripsOn(m1, "F1", date)).toBe(0);
    for (const [r, date] of [["S1", "20260908"], ["F1", "20260908"], ["F1", "20260906"], ["N1", "20260907"], ["S1", "20261126"]]) expect(deps(m1, r, date)).toBe(deps(m0, r, date));
  });

  test("questions: no country for public holidays, an except_rule without lines", async () => {
    const p = await previewPlan(db, plan([["apply_holiday_rules", {}], ["apply_holiday_rules", { dates: ["2026-09-07"], except_rule: "none", rule: "fortnightly" }]]));
    expect(codes(p.steps[0])).toEqual(["calendar_country_missing"]);
    expect(codes(p.steps[1])).toEqual(["except_routes_missing", "rule_invalid"]);
  });
});

describe("extend_validity", () => {
  test("to a new end and an earlier start: services at the edge follow, a seasonal one does not, calendar_dates-only services repeat their week (and can be edited in place), new holidays on Sunday", async () => {
    const d = loadSample();
    const m = buildFeedModel(d);
    // NIT as calendar_dates only; a summer-only service.
    const nit = S.activeDates(m, "NIT");
    d.prepare("DELETE FROM calendar WHERE service_id = 'NIT'").run();
    const ins = d.prepare("INSERT INTO calendar_dates (service_id, date, exception_type) VALUES ('NIT', ?, 1)");
    for (const x of nit) ins.run(x);
    d.prepare("INSERT INTO calendar (service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date) VALUES ('SUMMER', 1, 1, 1, 1, 1, 1, 1, '20260601', '20260831')").run();
    G.cloneTrip(d, "F1_WKD_0_001", { newId: "F1_SUMMER_1", serviceId: "SUMMER" });
    const p = await previewPlan(d, plan([
      ["extend_validity", { end_date: "2027-06-30", holidays: "2027-05-31, 2026-12-25", holiday_rule: "sunday" }],
      ["extend_validity", { start_date: "2026-03-01" }],
      // A calendar_dates-only service suspended at the start of its dates: its rows there go.
      ["suspend_service", { routes: "N1", from_date: "2026-03-01", to_date: "2026-04-30" }],
    ]));
    const [end, start, suspend] = p.steps;
    expect(end.summary).toBe("Validity 2026-04-01 → 2027-03-31 extended to 2026-04-01 → 2027-06-30: 4 services extended, 91 calendar_dates rows written, feed_info dates updated; 1 new holiday on the Sunday timetable (2027-05-31).");
    const w = end.warnings.join("\n");
    expect(w).toMatch(/1 service without a calendar\.txt row: its weekly pattern was repeated on the new dates \(calendar_dates\): NIT \(every day\)/);
    expect(w).toMatch(/1 service ending before the feed's last date was not extended \(seasonal\): SUMMER \(last runs 2026-08-31\)/);
    expect(w).toMatch(/1 holiday outside the new dates left as they are \(2026-12-25\)/);
    expect(w).toMatch(/feed_version \(nyc-demo-2026-04-v2\) is unchanged/);
    expect(start.summary).toMatch(/^Validity 2026-04-01 → 2027-06-30 extended to 2026-03-01 → 2027-06-30: 4 services extended, 31 calendar_dates rows written/);
    expect(suspend.summary).toMatch(/^Line N1 suspended on 61 dates from 2026-03-01 to 2026-04-30 .*; service NIT edited \(61 calendar rows\)\.$/);
    expect(p.lines).toEqual(expect.arrayContaining(["Validity 20260401–20270331 → 20260301–20270630"]));
    const m1 = await commit(d, p);
    expect(d.prepare("SELECT start_date, end_date FROM calendar WHERE service_id = 'WKD'").get()).toEqual({ start_date: "20260301", end_date: "20270630" });
    expect(d.prepare("SELECT start_date, end_date FROM calendar WHERE service_id = 'SUMMER'").get()).toEqual({ start_date: "20260601", end_date: "20260831" });
    expect(d.prepare("SELECT feed_start_date AS s, feed_end_date AS e FROM feed_info").get()).toEqual({ s: "20260301", e: "20270630" });
    expect(cdRow(d, "NIT", "20270630")).toBe(1);
    expect(cdRow(d, "NIT", "20260301")).toBeNull();
    expect(cdRow(d, "NIT", "20260430")).toBeNull();
    expect(cdRow(d, "NIT", "20260501")).toBe(1);
    expect(tripsOn(m1, "N1", "20260315")).toBe(0);
    expect(deps(m1, "N1", "20260501")).toBe(deps(m, "N1", "20260501"));
    // The new holiday runs the Sunday timetable, the day after the weekday one; old exceptions stay where they were.
    expect(deps(m1, "S1", "20270531")).toBe(deps(m1, "S1", "20270530"));
    expect(tripsOn(m1, "S1", "20270601")).toBe(224);
    expect(tripsOn(m1, "S1", "20270402")).toBe(224);
    expect(tripsOn(m1, "S1", "20261225")).toBe(130);
    expect(tripsOn(m1, "F1", "20270704")).toBe(0);
  });

  test("the old period's one-off exceptions are not repeated (warned); extending to the current end is skipped", async () => {
    const p = await previewPlan(db, plan([["extend_validity", { end_date: "2027-06-30" }], ["extend_validity", { end_date: "2027-06-30" }]]));
    expect(p.steps[0].status).toBe("applied");
    expect(p.steps[0].warnings.join("\n")).toMatch(/The one-off exceptions of the current period \(3 dates: 2026-07-04, 2026-11-26, 2026-12-25\) are not repeated/);
    expect(p.steps[1].status).toBe("skipped");
    expect(p.changes.calendar).toEqual({ inserted: 0, deleted: 0, updated: 4 });
    expect(p.integrity).toEqual([]);
  });

  test("questions: no date, a shorter validity, a later start, too long, a rule without holidays, a bad date", async () => {
    const p = await previewPlan(db, plan([
      ["extend_validity", {}],
      ["extend_validity", { end_date: "2027-01-01" }],
      ["extend_validity", { end_date: "2027-06-30", start_date: "2026-05-01" }],
      ["extend_validity", { end_date: "2030-12-31" }],
      ["extend_validity", { end_date: "2027-06-30", holiday_rule: "sunday" }],
      ["extend_validity", { end_date: "soon" }],
    ]));
    expect(p.steps.map(codes)).toEqual([["end_date_missing"], ["end_date_before_current"], ["start_date_after_current"], ["validity_too_long"], ["holidays_missing"], ["date_invalid"]]);
  });
});

describe("what a scheduler and a validator check", () => {
  const { loadReal } = require("./_helpers/feedDb");
  const { applyOps } = require("../services/transform/changeset");
  const { _internals: engine } = require("../services/transform/engine");
  const dump = (d) => ["calendar", "calendar_dates", "trips", "stop_times", "frequencies", "transfers", "feed_info"].map((t) => d.prepare(`SELECT * FROM ${t}`).all().map((r) => JSON.stringify(r)).sort().join("\n")).join("\n--\n");
  const allDeps = (m, date) => JSON.stringify([...m.routes.keys()].sort().map((r) => [r, [...departures(m, r, date).entries()].sort()]));

  test("copy_day_service replaces the Sunday timetable wherever it ran: a holiday the network does not run as a plain Sunday gets the copy, never nothing", async () => {
    const d = loadSample();
    // A Friday-only extra service without the holiday exception: 25 December is not a plain Sunday any more.
    d.prepare("INSERT INTO calendar (service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date) VALUES ('FRI', 0, 0, 0, 0, 1, 0, 0, '20260401', '20270331')").run();
    G.cloneTrip(d, "S1_WKD_0_001", { newId: "S1_FRI_0_001", serviceId: "FRI", shiftSec: 3600 });
    const m0 = buildFeedModel(d);
    expect(tripsOn(m0, "S3", "20261225")).toBe(136);
    const p = await previewPlan(d, plan([
      ["copy_day_service", { routes: "S3", from_day: "saturday", to_days: "sunday" }],
      // from/to spanning the whole validity is every date, not a missing scope.
      ["run_like", { routes: "B1", like: "saturday", days: "sunday", from_date: "2026-01-01", to_date: "2027-12-31" }],
      ["copy_day_service", { routes: "S3", from_day: "saturday", to_days: "sunday" }],
    ]));
    const [copy, whole, again] = p.steps;
    expect(again.status).toBe("skipped");
    expect(copy.summary).toMatch(/^Line S3: the Saturday timetable copied to Sundays on 55 dates from 2026-04-05 to 2027-03-28 \(incl\. 2 holidays run as Sundays\)/);
    expect(whole.status).toBe("applied");
    const m1 = await commit(d, p);
    // 25 December: the Saturday level, as on 26 November and every Sunday — not 0 trips.
    for (const date of ["20261225", "20261126", "20261227"]) expect(deps(m1, "S3", date)).toBe(deps(m0, "S3", "20261226"));
    // The Saturday holiday (4 July: Saturday and Sunday services) keeps the Saturday timetable once.
    expect(deps(m1, "S3", "20260704")).toBe(deps(m0, "S3", "20260711"));
    for (const [r, date] of [["S3", "20261226"], ["S3", "20261224"], ["S1", "20261225"], ["S2", "20261227"]]) expect(deps(m1, r, date)).toBe(deps(m0, r, date));
  });

  test("a producer's 'daily minus exceptions' calendars (SNgo! Vernon): a closed day is one row, and extending the validity repeats the week each service really runs", async () => {
    const d = loadReal("vernon");
    const m0 = buildFeedModel(d);
    const p = await previewPlan(d, plan([["run_like", { routes: "all", like: "none", dates: ["2026-12-25"] }], ["extend_validity", { end_date: "2027-10-31" }]]));
    const [closed, extend] = p.steps;
    // Before: 294 rows (every weekly flag rewritten, 285 exceptions deleted) for one date.
    expect(closed.summary).toMatch(/^All lines: no service on 2026-12-25 \(2026-12-25: 16 → 0 trips\); service 2753:5-28-127 edited \(1 calendar row\)\.$/);
    expect(extend.summary).toMatch(/^Validity 2026-09-17 → 2027-08-31 extended to 2026-09-17 → 2027-10-31: 6 services extended, \d+ calendar_dates rows written/);
    const w = extend.warnings.join("\n");
    expect(w).toMatch(/6 services do not run the days calendar\.txt says: the new dates repeat the days they ran in the last 8 weeks.*2753:9-28-127 \(every day in calendar\.txt, Sat in practice\)/);
    expect(w).toMatch(/The one-off exceptions of the current period \(1 date: 2027-07-14\) are not repeated/);
    const m1 = await commit(d, p);
    expect(tripsOn(m1, null, "20261225")).toBe(0);
    for (const date of ["20261224", "20261226", "20261227", "20270830"]) expect(allDeps(m1, date)).toBe(allDeps(m0, date));
    // Before: 542 trips every day of the new dates (every summer service on every day).
    for (const [date, like] of [["20270906", "20270830"], ["20270904", "20270828"], ["20270905", "20270829"], ["20271027", "20270825"]]) expect(allDeps(m1, date)).toBe(allDeps(m0, like));
  });

  test("extend_validity: a calendar without weekday flags (its calendar_dates carry the dates) gets its new dates, a service ending days before the feed keeps its old dates off, a leftover service without trips is not the validity", async () => {
    const d = loadSample();
    // Before: "the feed already runs until 2027-12-31" (a question), and a longer end left April–December 2027 empty.
    d.prepare("INSERT INTO calendar (service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date) VALUES ('OLD', 1, 1, 1, 1, 1, 0, 0, '20260101', '20271231')").run();
    const m = buildFeedModel(d);
    const sat = S.activeDates(m, "SAT");
    d.prepare("UPDATE calendar SET saturday = 0 WHERE service_id = 'SAT'").run();
    const ins = d.prepare("INSERT INTO calendar_dates (service_id, date, exception_type) VALUES ('SAT', ?, 1)");
    for (const x of sat) ins.run(x);
    d.prepare("UPDATE calendar SET end_date = '20270326' WHERE service_id = 'WKD'").run();
    const m0 = buildFeedModel(d);
    const p = await previewPlan(d, plan([["extend_validity", { end_date: "2027-06-30" }]]));
    const step = p.steps[0];
    // 13 new Saturdays as type 1 rows (cheaper than a calendar change plus rows), 3 old weekdays kept off.
    expect(step.summary).toMatch(/^Validity 2026-04-01 → 2027-03-31 extended to 2026-04-01 → 2027-06-30: 4 services extended, 16 calendar_dates rows written/);
    expect(step.warnings.join("\n")).toMatch(/SAT \(no day in calendar\.txt, Sat in practice\)/);
    const m1 = await commit(d, p);
    // Before: "4 services extended" and no Saturday service after 31 March.
    expect(deps(m1, "S1", "20270410")).toBe(deps(m0, "S1", "20270327"));
    expect(deps(m1, "S1", "20270405")).toBe(deps(m0, "S1", "20270322"));
    for (const date of ["20270329", "20270330", "20270331", "20270326", "20270327"]) expect(allDeps(m1, date)).toBe(allDeps(m0, date));
    expect(d.prepare("SELECT end_date FROM calendar WHERE service_id = 'WKD'").get().end_date).toBe("20270630");
    expect(d.prepare("SELECT end_date FROM calendar WHERE service_id = 'SAT'").get().end_date).toBe("20270331");
  });

  test("a closure is never reopened by a day type (libéA Albi at Christmas); a season without Sunday service is not a closure", async () => {
    const a = loadReal("albi");
    const a0 = buildFeedModel(a);
    const p = await previewPlan(a, plan([["run_like", { routes: "E", like: "saturday", days: "weekday", from_date: "2026-12-19", to_date: "2027-01-03" }]]));
    const step = p.steps[0];
    // Before: E alone ran on 25 December and 1 January, the whole network being closed.
    expect(step.summary).toMatch(/^Line E runs the Saturday timetable on 8 dates from 2026-12-21 to 2026-12-31 /);
    expect(step.warnings.join("\n")).toMatch(/2 dates of these days without any service in the feed \(2026-12-25, 2027-01-01: a closure\) left as they are/);
    const a1 = await commit(a, p);
    expect(tripsOn(a1, "118", "20261225")).toBe(0);
    expect(tripsOn(a1, "118", "20270101")).toBe(0);
    expect(deps(a1, "118", "20261228")).toBe(deps(a0, "118", "20261226"));

    // Sunday service in summer only (and no night bus on Sundays): winter Sundays are a season, not closures.
    const d = loadSample();
    d.prepare("UPDATE calendar SET sunday = 0 WHERE service_id = 'NIT'").run();
    d.prepare("UPDATE calendar SET start_date = '20260701', end_date = '20260831' WHERE service_id = 'SUN'").run();
    const m0 = buildFeedModel(d);
    expect(tripsOn(m0, "B1", "20261101")).toBe(0);
    const q = await previewPlan(d, plan([["copy_day_service", { routes: "B1", from_day: "saturday", to_days: "sunday", from_date: "2026-10-01" }]]));
    expect(q.steps[0].status).toBe("applied");
    expect(q.steps[0].warnings.join("\n")).not.toMatch(/closure/);
    const m1 = await commit(d, q);
    expect(deps(m1, "B1", "20261101")).toBe(deps(m0, "B1", "20261031"));
  });

  test("no service on a date: the previous evening's trips running past midnight are named; asking again is skipped", async () => {
    const p = await previewPlan(db, plan([["run_like", { routes: "all", like: "none", dates: ["2026-10-13"] }], ["run_like", { routes: "all", like: "none", dates: ["2026-10-13"] }]]));
    const [none, again] = p.steps;
    expect(none.summary).toMatch(/^All lines: no service on 2026-10-13 \(2026-10-13: 1884 → 0 trips\); service NIT, WKD edited \(2 calendar rows\)\.$/);
    expect(none.warnings.join("\n")).toMatch(/51 trips of the day before still run after midnight on 2026-10-13 \(until 05:43\): in GTFS they belong to the previous date/);
    expect(again.status).toBe("skipped");
    expect(again.summary).toBe("All lines already have no service on 2026-10-13: nothing to change.");
    expect(p.changes).toEqual({ calendar_dates: { inserted: 2, deleted: 0, updated: 0 } });
  });

  test("determinism and undo: two previews write the same rows; the commit's undo restores every table", async () => {
    const d = loadSample();
    const ops = [
      ["run_like", { routes: "S1", like: "sunday", dates: ["2026-07-14"] }],
      ["remove_day_service", { routes: "B4", days: "sunday", from_date: "2026-09-01" }],
      ["suspend_service", { routes: "F1", from_date: "2026-10-12", to_date: "2026-11-30" }],
      ["apply_holiday_rules", { dates: ["2026-09-07", "2026-05-25"], except_routes: "F1", except_rule: "none" }],
      ["copy_day_service", { routes: "B2", from_day: "weekday", to_days: "saturday", from_date: "2027-01-01" }],
      ["extend_validity", { end_date: "2027-06-30", holidays: ["2027-05-31"] }],
    ];
    const p1 = await previewPlan(d, plan(ops), { sessionId: "t" });
    const p2 = await previewPlan(d, plan(ops), { sessionId: "t" });
    expect(p1.steps.map((s) => s.status)).toEqual(["applied", "applied", "applied", "applied", "applied", "applied"]);
    expect(p1.integrity).toEqual([]);
    const redo = (x) => JSON.stringify(engine._previews.get(x.id).redoOps);
    expect(redo(p1)).toBe(redo(p2));
    const before = dump(d);
    const undo = engine._previews.get(p1.id).undoOps;
    commitPreview("t", d, p1.id);
    expect(dump(d)).not.toBe(before);
    d.transaction(() => applyOps(d, undo))();
    expect(dump(d)).toBe(before);
  });
});

describe("run_like with like_date: a period's timetable", () => {
  const { loadReal } = require("./_helpers/feedDb");

  test("libéA Albi, summer 2027: the validity extended, weekdays on the school-holiday timetable as on 12 April (each weekday its own), 14 July off", async () => {
    const d = loadReal("albi");
    const m0 = buildFeedModel(d);
    const p = await previewPlan(d, plan([
      ["extend_validity", { end_date: "2027-08-31" }],
      // 19 April 2027 is a school Monday in this feed: its week is the school timetable, which the extended summer already runs.
      ["run_like", { routes: "all", like: "weekday", like_date: "2027-04-19", days: "weekday", from_date: "2027-07-05", to_date: "2027-08-31" }],
      ["run_like", { routes: "all", like: "weekday", like_date: "2027-04-12", days: "weekday", from_date: "2027-07-05", to_date: "2027-08-31" }],
      ["run_like", { routes: "all", like: "saturday", days: "saturday", from_date: "2027-07-05", to_date: "2027-08-31" }],
      ["run_like", { routes: "all", like: "none", dates: ["2027-07-14"] }],
      ["run_like", { routes: "all", like: "weekday", days: "weekday", from_date: "2027-07-05", to_date: "2027-08-31" }],
      ["run_like", { routes: "E", like_date: "2027-05-01", dates: ["2027-07-15"] }],
      ["run_like", { routes: "E", like_date: "2028-01-10", dates: ["2027-07-15"] }],
    ]));
    const [, schoolWeek, weekdays, saturdays, july14, noDate, closed, outside] = p.steps;
    expect(weekdays.summary).toMatch(/^All lines run the weekday timetable as on 2027-04-12 on 42 dates from 2027-07-05 to 2027-08-31 /);
    expect(weekdays.warnings).toEqual(expect.arrayContaining(["The timetable is taken from 5 dates from 2027-04-12 to 2027-04-16.", "Lines J, H have no weekday timetable as on 2027-04-12: no service on these dates."]));
    expect(saturdays.status).toBe("skipped");
    expect(july14.status).toBe("applied");
    // The week of the date, not the nearest Friday (16 April, the last holiday Friday).
    expect(schoolWeek.status).toBe("skipped");
    expect(schoolWeek.warnings).toContain("The timetable is taken from 5 dates from 2027-04-19 to 2027-04-23.");
    // Without a date, Albi's Wednesday differs: the question names like_date.
    expect(codes(noDate)).toEqual(["like_ambiguous"]);
    expect(noDate.ambiguities[0].message).toMatch(/Or give like_date/);
    expect(codes(closed)).toEqual(["like_date_without_service"]);
    expect(codes(outside)).toEqual(["like_date_outside_validity"]);
    // Commit the first four steps only.
    const q = await previewPlan(d, plan([
      ["extend_validity", { end_date: "2027-08-31" }],
      ["run_like", { routes: "all", like: "weekday", like_date: "2027-04-12", days: "weekday", from_date: "2027-07-05", to_date: "2027-08-31" }],
      ["run_like", { routes: "all", like: "none", dates: ["2027-07-14"] }],
    ]));
    const m1 = await commit(d, q);
    const hol = { mon: "20270412", tue: "20270413", wed: "20270414", thu: "20270415", fri: "20270416" };
    for (const date of ["20270705", "20270707", "20270709", "20270818", "20270831"]) {
      for (const r of ["112", "113", "114", "118", "116"]) expect(deps(m1, r, date)).toBe(deps(m0, r, hol[fm.dowOf(date)]));
      for (const r of ["124", "121"]) expect(tripsOn(m1, r, date)).toBe(0);
    }
    for (const r of ["112", "118"]) expect(deps(m1, r, "20270710")).toBe(deps(m0, r, "20270612"));
    expect(tripsOn(m1, "118", "20270714")).toBe(0);
    for (const date of ["20270702", "20270630", "20270703", "20270412"]) expect(deps(m1, "118", date)).toBe(deps(m0, "118", date));
    // The school services end with the school year again (the extension undone by the in-place writer, not 40 exceptions).
    expect(d.prepare("SELECT end_date FROM calendar WHERE service_id = '5'").get().end_date).toBe("20270702");
    expect(m1.range.end).toBe("20270831");
    expect(d.prepare("SELECT feed_end_date AS e FROM feed_info").get().e).toBe("20270831");
  }, 120000);
});
