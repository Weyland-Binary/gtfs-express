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
