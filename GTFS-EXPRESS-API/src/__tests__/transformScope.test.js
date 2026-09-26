/**
 * transformScope.test.js — WHEN a change applies: day types (holidays run
 * as their service's day type), effective dates, date ranges, named
 * periods from the plan, and service ids that do not multiply.
 */

"use strict";

const { loadSample } = require("./_helpers/feedDb");
const { buildFeedModel } = require("../services/transform/feedModel");
const { previewPlan } = require("../services/transform/engine");
const { sandboxOf } = require("../services/transform/changeset");
const S = require("../services/transform/scope");
const calendars = require("../services/transform/calendars");

const db = loadSample();
const model = buildFeedModel(db);
const sunAdded = [...model.services.get("SUN").added][0];

describe("day types", () => {
  test("a date added to the Sunday service counts as a Sunday, whatever its weekday", () => {
    expect(sunAdded).toBeTruthy();
    expect(S.dayTypeOf(model, "SUN", sunAdded)).toBe("sun");
    expect(S.inScope({ dows: ["mon", "tue", "wed", "thu", "fri"] }, sunAdded, model, "SUN")).toBe(false);
    expect(S.inScope({ dows: ["sun"] }, sunAdded, model, "SUN")).toBe(true);
  });

  test("weekday scope does not reach the Sunday service", () => {
    const trips = S.tripsInScope(model, { routeId: "S1" }, { dows: ["mon", "tue", "wed", "thu", "fri"] });
    expect(trips.some((t) => t.service_id === "SUN")).toBe(false);
    expect(trips.some((t) => t.service_id === "WKD")).toBe(true);
  });
});

describe("resolveScope", () => {
  test("dates are parsed in several formats, inverted and out-of-validity periods are questions", async () => {
    const ok = await S.resolveScope(model, { days: "weekday", from_date: "2026-09-01", to_date: "15/10/2026" });
    expect(ok.ambiguities).toEqual([]);
    expect(ok.value.from).toBe("20260901");
    expect(ok.value.to).toBe("20261015");
    const bad = await S.resolveScope(model, { from_date: "2026-10-01", to_date: "2026-09-01" });
    expect(bad.ambiguities[0].code).toBe("dates_inverted");
    const late = await S.resolveScope(model, { from_date: "2099-01-01" });
    expect(late.ambiguities[0].code).toBe("after_validity");
    const wrong = await S.resolveScope(model, { from_date: "1st of May" });
    expect(wrong.ambiguities[0].code).toBe("date_invalid");
  });

  test("a named period comes from the plan; an unknown one or one needing a zone is a question", async () => {
    const plan = { vacances_ete: { from: "2026-07-06", to: "2026-08-31" } };
    const ok = await S.resolveScope(model, { period: "vacances_ete" }, { calendars: plan });
    expect(ok.value.dates.size).toBe(57);
    const unknown = await S.resolveScope(model, { period: "carnival" }, {});
    expect(unknown.ambiguities[0].code).toBe("calendar_unknown");
    const noCountry = await S.resolveScope(model, { period: "school_holidays" }, {});
    expect(noCountry.ambiguities[0].code).toBe("calendar_country_missing");
  });

  test("school holidays by zone, fetched once, and a missing zone is asked", async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(String(url));
      const rows = String(url).includes("SchoolHolidays")
        ? [
            { startDate: "2026-10-17", endDate: "2026-11-01", name: [{ language: "FR", text: "Toussaint" }], nationwide: true, subdivisions: [] },
            { startDate: "2027-02-06", endDate: "2027-02-21", name: [{ language: "FR", text: "Hiver" }], nationwide: false, subdivisions: [{ shortName: "FR-A" }] },
            { startDate: "2027-02-13", endDate: "2027-02-28", name: [{ language: "FR", text: "Hiver" }], nationwide: false, subdivisions: [{ shortName: "FR-B" }] },
          ]
        : [{ date: "2026-11-11", localName: "Armistice", name: "Armistice Day", global: true }];
      return { ok: true, json: async () => rows };
    };
    calendars._internals._cache.clear();
    const noZone = await calendars.named("vacances scolaires", { country: "FR", from: "20260901", to: "20270630", fetchImpl });
    expect(noZone.ambiguity.code).toBe("calendar_region_missing");
    expect(noZone.ambiguity.options).toEqual(["FR-A", "FR-B"]);
    const a = await calendars.named("school_holidays", { country: "FR", region: "A", from: "20260901", to: "20270630", fetchImpl });
    expect(a.dates.has("20261020")).toBe(true);
    expect(a.dates.has("20270210")).toBe(true);
    expect(a.dates.has("20270225")).toBe(false);
    const days = await calendars.named("période scolaire", { country: "FR", region: "zone A", from: "20260901", to: "20270630", fetchImpl });
    expect(days.dates.has("20261020")).toBe(false);
    expect(days.dates.has("20261111")).toBe(false);
    expect(days.dates.has("20261112")).toBe(true);
    const before = calls.length;
    await calendars.named("school_holidays", { country: "FR", region: "B", from: "20260901", to: "20270630", fetchImpl });
    expect(calls.length).toBe(before);
  });
});

describe("isolateScope and services", () => {
  test("a change from a date on: the old service ends the day before, the new one starts that day", () => {
    const sb = sandboxOf(db);
    const m = buildFeedModel(sb);
    const trips = S.tripsInScope(m, { routeId: "S1" }, { dows: ["mon", "tue", "wed", "thu", "fri"] }).filter((t) => t.service_id === "WKD").slice(0, 3).map((t) => t.id);
    const mid = S.activeDates(m, "WKD")[40];
    const out = S.isolateScope(sb, m, trips, { dows: null, from: mid, to: null });
    expect(out).toEqual(trips);
    const m2 = buildFeedModel(sb);
    const svcIn = m2.trips.get(trips[0]).service_id;
    expect(svcIn).not.toBe("WKD");
    expect(S.activeDates(m2, svcIn)[0]).toBe(mid);
    const copy = [...m2.trips.values()].find((t) => t.id.startsWith(`${trips[0]}~`));
    expect(S.activeDates(m2, copy.service_id).at(-1) < mid).toBe(true);
    // Together they run exactly the dates the trip ran.
    expect([...S.activeDates(m2, copy.service_id), ...S.activeDates(m2, svcIn)]).toEqual(S.activeDates(m, "WKD"));
    sb.close();
  });

  test("two operations on the same period share one new service, not two", async () => {
    const p = await previewPlan(db, {
      calendars: { travaux: { from: "2026-09-07", to: "2026-10-30" } },
      operations: [
        { type: "set_headway", params: { route: "S1", days: "weekday", period: "travaux", from: "07:00", to: "09:00", headway_min: 12 } },
        { type: "set_headway", params: { route: "S2", days: "weekday", period: "travaux", from: "07:00", to: "09:00", headway_min: 12 } },
      ],
    });
    expect(p.blocked).toBe(false);
    const cal = p.changes.calendar || { inserted: 0 };
    expect(cal.inserted).toBeLessThanOrEqual(2);
    expect(p.integrity).toEqual([]);
    // The diff says when: weekdays of the works period only.
    const hw = p.diff.items.filter((i) => i.code === "service_headway");
    expect(hw.length).toBeGreaterThan(0);
    for (const i of hw) {
      expect(i.day).toBe("weekday");
      expect(i.dates.from >= "20260907" && i.dates.to <= "20261030").toBe(true);
    }
    expect(p.lines.join("\n")).toMatch(/S1 · weekday \(20260907→20261030, \d+ days\) · am_peak · dir 0: every \d+ → 12 min/);
  });
});

describe("strict dates and services that stay what their id says", () => {
  test("parseDate takes a whole date that exists, nothing less", () => {
    expect(calendars.parseDate("2026-07-14")).toBe("20260714");
    expect(calendars.parseDate("2026-07-14T00:00:00Z")).toBe("20260714");
    expect(calendars.parseDate("14/07/2026")).toBe("20260714");
    expect(calendars.parseDate("2026-02-31")).toBeNull();
    expect(calendars.parseDate("2026-07-14,2026-08-15")).toBeNull();
    expect(calendars.parseDate("25/12")).toBeNull();
  });

  test("dates and except as a string are read, a bad date is asked, never dropped", async () => {
    const one = await S.resolveScope(model, { dates: "2026-10-13" }, {});
    expect([...one.value.dates]).toEqual(["20261013"]);
    expect(S.isAll(one.value)).toBe(false);
    const two = await S.resolveScope(model, { dates: "2026-10-13, 2026-10-14" }, {});
    expect([...two.value.dates]).toEqual(["20261013", "20261014"]);
    const named = await S.resolveScope(model, { dates: "vacances" }, {});
    expect(named.ambiguities.map((a) => a.code)).toEqual(["date_invalid"]);
    const bad = await S.resolveScope(model, { except: ["25/12", "2026-12-24"] }, {});
    expect(bad.ambiguities.map((a) => [a.param, a.code])).toEqual([["except", "date_invalid"]]);
    const ex = await S.resolveScope(model, { except: "2026-12-24" }, {});
    expect([...ex.value.except]).toEqual(["20261224"]);
  });

  test("serviceForDates does not reuse an id an earlier step changed", () => {
    const d = sandboxOf(db);
    const m = buildFeedModel(d);
    const dates = S.activeDates(m, "WKD").filter((x) => x >= "20261001");
    const id = S.serviceForDates(d, m, "WKD", dates);
    d.prepare("INSERT OR REPLACE INTO calendar_dates (service_id, date, exception_type) VALUES (?, ?, 2)").run(id, dates[3]);
    const again = S.serviceForDates(d, m, "WKD", dates);
    expect(again).not.toBe(id);
    expect(S.activeDates(buildFeedModel(d), again)).toEqual(dates);
    // Unchanged, it is reused.
    expect(S.serviceForDates(d, buildFeedModel(d), "WKD", dates)).toBe(again);
  });

  test("regular dates of a weekday the base does not run become weekly days; a one-off stays an exception", () => {
    const d = sandboxOf(db);
    const m = buildFeedModel(d);
    // The Saturday service also running every Sunday of October: those Sundays are Sundays.
    const sundays = S.activeDates(m, "SUN").filter((x) => x >= "20261001" && x <= "20261031" && S.dayTypeOf(m, "SUN", x) === "sun");
    const sats = S.activeDates(m, "SAT").filter((x) => x >= "20261001" && x <= "20261031");
    const id = S.serviceForDates(d, m, "SAT", [...sats, ...sundays].sort());
    const m2 = buildFeedModel(d);
    expect(sundays.every((x) => S.dayTypeOf(m2, id, x) === "sun")).toBe(true);
    expect(sats.every((x) => S.dayTypeOf(m2, id, x) === "sat")).toBe(true);
    // One Thursday added to the Saturdays is a Saturday-timetable day, not a weekly Thursday.
    const thu = "20261015";
    const id2 = S.serviceForDates(d, m2, "SAT", [...sats, thu].sort());
    const m3 = buildFeedModel(d);
    expect(S.dayTypeOf(m3, id2, thu)).toBe("sat");
    expect(d.prepare("SELECT thursday FROM calendar WHERE service_id = ?").get(id2).thursday).toBe(0);
  });

  test("the copy isolateScope keeps for the other dates keeps the trip's timed transfers", () => {
    const d = sandboxOf(db);
    const m = buildFeedModel(d);
    const tid = [...m.trips.values()].find((t) => t.service_id === "WKD").id;
    const stop = m.trips.get(tid).stops[1];
    d.prepare("INSERT INTO transfers (from_stop_id, to_stop_id, from_trip_id, transfer_type) VALUES (?, ?, ?, 1)").run(stop, stop, tid);
    S.isolateScope(d, m, [tid], { dows: null, from: "20261001", to: null, dates: null, except: null });
    const rows = d.prepare("SELECT from_trip_id FROM transfers WHERE from_trip_id LIKE ?").all(`${tid}%`).map((r) => r.from_trip_id).sort();
    expect(rows.length).toBe(2);
    expect(rows[0]).toBe(tid);
  });

  test("a new stop and new stop_times rows store enums as integers, not 0.0", async () => {
    const d = sandboxOf(db);
    const p = await previewPlan(d, { operations: [{ type: "add_stop", params: { route: "S1", stop: { name: "Enum Plaza", lat: 40.79, lon: -73.972 }, direction: "0" } }] });
    expect(p.blocked).toBe(false);
    const { commitPreview } = require("../services/transform/engine");
    commitPreview("t", d, p.id);
    expect(d.prepare("SELECT COUNT(*) AS n FROM stops WHERE location_type LIKE '%.%' OR wheelchair_boarding LIKE '%.%'").get().n).toBe(0);
    expect(d.prepare("SELECT COUNT(*) AS n FROM stop_times WHERE timepoint LIKE '%.%' OR pickup_type LIKE '%.%' OR drop_off_type LIKE '%.%'").get().n).toBe(0);
    expect(d.prepare("SELECT location_type FROM stops WHERE stop_name = 'Enum Plaza'").get().location_type).toBe("0");
  });
});

describe("the validity is where trips run", () => {
  test("a leftover calendar without trips does not widen the model's range", () => {
    const d = sandboxOf(db);
    const r0 = buildFeedModel(d).range;
    d.prepare("INSERT INTO calendar (service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date) VALUES ('OLD', 1, 1, 1, 1, 1, 0, 0, '20200101', '20301231')").run();
    expect(buildFeedModel(d).range).toEqual(r0);
  });
});
