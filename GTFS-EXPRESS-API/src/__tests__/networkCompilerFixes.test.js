/**
 * networkCompilerFixes.test.js — regressions of the compiler and the spec
 * normalisation that betrayed the brief without saying so: holidays with
 * no service, two school periods merged into one calendar, a pulse set on
 * the wrong service, a stale return after the outbound was edited, and
 * running times that counted the dwells twice.
 */

"use strict";

const { normalizeSpec } = require("../services/network/networkSpec");
const { compileSpec, _internals } = require("../services/network/compiler");
const { createRouter } = require("../services/network/roadRouter");
const { runningTimes } = require("../services/network/timetable");
const { estimateOperations } = require("../services/network/operationsService");

const base = (over = {}) => ({
  agency: { name: "Test", url: "https://example.org", timezone: "Europe/Paris" },
  feed: { start_date: "20260901", end_date: "20270831" },
  stops: [
    { id: "A", name: "A", lat: 47.4, lon: 0.69 },
    { id: "B", name: "B", lat: 47.41, lon: 0.7 },
    { id: "C", name: "C", lat: 47.42, lon: 0.71 },
  ],
  lines: [],
  ...over,
});
const line = (services, extra = {}) => ({ short_name: "1", directions: [{ stops: ["A", "B", "C"] }], services, ...extra });
const compile = async (raw) => {
  const norm = normalizeSpec(raw);
  expect(norm.blockers).toEqual([]);
  return compileSpec(norm.spec, { router: createRouter({ mode: "straight" }), shapes: false });
};
const exceptionsOn = (tables, date) => tables.calendar_dates.filter((r) => r.date === date).map((r) => `${r.service_id}:${r.exception_type}`).sort();

describe("public holidays run like the holiday day type", () => {
  const PERIOD = [{ from: "08:00", to: "10:00", headway_min: 60 }];
  // 2026-12-25 is a Friday, 2026-12-26 a Saturday.
  test("weekday + weekend calendars: the weekday one stops, the weekend one runs", async () => {
    const { tables } = await compile(base({ lines: [line([{ calendar: "weekday", periods: PERIOD }, { calendar: "weekend", periods: PERIOD }])], holidays: ["20261225"] }));
    expect(exceptionsOn(tables, "20261225")).toEqual(["WKD:2", "WKE:1"]);
  });

  test("a daily calendar keeps running on a holiday", async () => {
    const { tables } = await compile(base({ lines: [line([{ calendar: "daily", periods: PERIOD }])], holidays: ["20261225"] }));
    expect(exceptionsOn(tables, "20261225")).toEqual([]);
  });

  test("weekday + saturday + sunday: the sunday service replaces the others", async () => {
    const { tables } = await compile(base({ lines: [line([{ calendar: "weekday", periods: PERIOD }, { calendar: "saturday", periods: PERIOD }, { calendar: "sunday", periods: PERIOD }])], holidays: ["20261225", "20261226"] }));
    expect(exceptionsOn(tables, "20261225")).toEqual(["SUN:1", "WKD:2"]);
    expect(exceptionsOn(tables, "20261226")).toEqual(["SAT:2", "SUN:1"]);
  });

  test("holiday_service none removes every service", async () => {
    const { tables } = await compile(base({ lines: [line([{ calendar: "daily", periods: PERIOD }])], holidays: ["20261225"], holiday_service: "none" }));
    expect(exceptionsOn(tables, "20261225")).toEqual(["DAILY:2"]);
  });

  test("a Fri–Sat weekend: 'sunday' means the first rest day", () => {
    expect(_internals.holidayDayType({ holiday_service: "sunday", weekend: ["fri", "sat"] })).toBe("fri");
    expect(_internals.holidayDayType({ holiday_service: "saturday", weekend: ["fri", "sat"] })).toBe("sat");
    expect(_internals.holidayDayType({ holiday_service: "sunday" })).toBe("sun");
    expect(_internals.holidayDayType({ holiday_service: "none" })).toBeNull();
  });
});

describe("calendars", () => {
  test("two periods with the same days and start date stay two calendars", () => {
    const { spec, blockers } = normalizeSpec(base({
      lines: [line([
        { calendar: { days: ["mon", "tue"], start_date: "20260901", end_date: "20261016" }, departures: ["07:30"] },
        { calendar: { days: ["mon", "tue"], start_date: "20260901", end_date: "20270703" }, departures: ["08:30"] },
      ])],
    }));
    expect(blockers).toEqual([]);
    const ids = spec.lines[0].services.map((s) => s.calendar_id);
    expect(new Set(ids).size).toBe(2);
    const cal = (id) => spec.calendars.find((c) => c.id === id);
    expect(cal(ids[0]).end_date).toBe("20261016");
    expect(cal(ids[1]).end_date).toBe("20270703");
  });

  test("an explicit calendar id used for two different calendars is an error", () => {
    const { blockers } = normalizeSpec(base({
      lines: [line([
        { calendar: { id: "SCOL", days: ["mon"] }, departures: ["07:30"] },
        { calendar: { id: "SCOL", days: ["tue"] }, departures: ["07:30"] },
      ])],
    }));
    expect(blockers.map((b) => b.code)).toContain("duplicate_calendar_id");
  });

  test("a normalised spec round-trips to the same calendars", () => {
    const first = normalizeSpec(base({ lines: [line([{ calendar: { days: ["mon"], start_date: "20260901", end_date: "20261016" }, departures: ["07:30"] }])] }));
    const again = normalizeSpec(first.spec);
    expect(again.spec.calendars).toEqual(first.spec.calendars);
    expect(again.spec.lines[0].services).toEqual(first.spec.lines[0].services);
  });
});

describe("per-service pulse", () => {
  test("the sync follows its own service even when an earlier line or service is dropped", () => {
    const { spec } = normalizeSpec(base({
      lines: [
        { short_name: "", long_name: "" }, // dropped: no name
        line([
          { calendar: "nope", periods: [{ from: "08:00", to: "09:00", headway_min: 30 }] }, // dropped: unknown calendar
          { calendar: "weekday", periods: [{ from: "08:00", to: "09:00", headway_min: 30 }], sync: { stop: "B", minute: 5 } },
          { calendar: "saturday", periods: [{ from: "08:00", to: "09:00", headway_min: 30 }], sync: false },
        ]),
      ],
    }));
    const [wkd, sat] = spec.lines[0].services;
    expect(wkd.calendar_id).toBe("WKD");
    expect(wkd.sync).toEqual({ stop_id: "B", minute: 5 });
    expect(sat.sync).toBe(false);
  });
});

describe("derived return", () => {
  test("an edited outbound re-derives the return still marked derived", () => {
    const first = normalizeSpec(base({ lines: [line([{ calendar: "weekday", departures: ["08:00"] }])] })).spec;
    expect(first.lines[0].directions[1]).toMatchObject({ stops: ["C", "B", "A"], derived: true });
    const edited = JSON.parse(JSON.stringify(first));
    edited.lines[0].directions[0].stops = ["A", "C"];
    const again = normalizeSpec(edited).spec;
    expect(again.lines[0].directions[1]).toMatchObject({ stops: ["C", "A"], derived: true });
  });

  test("a return the user edited (no derived mark) is kept as it is", () => {
    const first = normalizeSpec(base({ lines: [line([{ calendar: "weekday", departures: ["08:00"] }])] })).spec;
    const edited = JSON.parse(JSON.stringify(first));
    delete edited.lines[0].directions[1].derived;
    edited.lines[0].directions[1].stops = ["C", "A"];
    const again = normalizeSpec(edited).spec;
    expect(again.lines[0].directions[1].stops).toEqual(["C", "A"]);
    expect(again.lines[0].directions[1].derived).toBeUndefined();
  });
});

describe("commercial speed", () => {
  test("a 12 km urban bus line with 30 stops runs 36 min at 20 km/h, not ~53", () => {
    const legs = Array(29).fill(12000 / 29);
    const o = runningTimes(legs, { speedKmh: 20, dwellS: 20 });
    expect(o[o.length - 1].arrival).toBe(36 * 60);
    // Strictly increasing clock.
    for (let i = 1; i < o.length; i++) expect(o[i].arrival).toBeGreaterThan(o[i - 1].departure);
  });

  test("the road duration stays a floor per leg", () => {
    const o = runningTimes([1000], { speedKmh: 60, legDurationsS: [300] });
    expect(o[1].arrival).toBe(360);
  });

  test("operations without geometry use the commercial time, dwells not added twice", () => {
    const { spec } = normalizeSpec(base({ lines: [line([{ calendar: "weekday", departures: ["08:00"], direction: "0" }], { round_trip: false })] }));
    const ops = estimateOperations(spec, null, { layoverMin: 0 });
    const l = ops.per_line[0];
    // One trip: hours = km / 20 km/h, rounded to the minute like the estimate.
    expect(l.trips_weekday).toBe(1);
    const expectedMin = Math.round((l.km_weekday / 20) * 60);
    expect(Math.abs(l.hours_weekday * 60 - expectedMin)).toBeLessThanOrEqual(6);
  });
});

describe("the local weekend on a spec already normalised", () => {
  test("changing spec.weekend moves the weekday and weekend calendars with it", () => {
    const first = normalizeSpec(base({ lines: [line([{ calendar: "weekday", departures: ["08:00"] }, { calendar: "weekend", departures: ["10:00"] }])] })).spec;
    expect(first.calendars.find((c) => c.id === "WKD").days).toEqual(["mon", "tue", "wed", "thu", "fri"]);
    const again = normalizeSpec({ ...first, weekend: ["fri", "sat"] }).spec;
    expect(again.calendars.find((c) => c.id === "WKD").days).toEqual(["mon", "tue", "wed", "thu", "sun"]);
    expect(again.calendars.find((c) => c.id === "WKE").days).toEqual(["fri", "sat"]);
  });
});
