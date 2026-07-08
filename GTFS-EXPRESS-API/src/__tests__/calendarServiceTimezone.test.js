/**
 * calendarServiceTimezone.test.js — getServiceIdsForDate must resolve the
 * weekday of a YYYYMMDD date independently of the server's timezone, and
 * must not fabricate a weekday for nonexistent dates.
 *
 * Regression 1: the weekday used to be computed with
 * new Date("YYYY-MM-DD").getDay() — an ISO date-only string is parsed as
 * UTC midnight, but getDay() converts to process-local time, so on any
 * UTC-negative host (e.g. America/New_York) every date resolved to the
 * PREVIOUS weekday: a Tuesday-only service was reported inactive on
 * Tuesdays while a Monday-only service was reported active on them.
 *
 * The timezone matrix spawns a fresh node process per zone with TZ set in
 * its environment: TZ is only reliably honoured at process START on every
 * platform (runtime process.env.TZ reassignment is inert under Jest, whose
 * sandboxed env clone bypasses Node's TZ-reset hook, and on Windows).
 *
 * Regression 2 guard: Date.UTC(y, m-1, d) silently rolls out-of-range
 * fields over (20260732 → 2026-08-01), so nonexistent dates must be
 * rejected explicitly instead of matching another day's services.
 */

"use strict";

const path = require("path");
const { execFileSync } = require("child_process");

const { getServiceIdsForDate } = require("../services/calendarService");

const ALL_DAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

// 2026-07-06 is a Monday; the week runs through Sunday 2026-07-12.
const WEEK = [
  ["20260706", "monday"],
  ["20260707", "tuesday"],
  ["20260708", "wednesday"],
  ["20260709", "thursday"],
  ["20260710", "friday"],
  ["20260711", "saturday"],
  ["20260712", "sunday"],
];

// Builds a calendar row with numeric day flags, matching what better-sqlite3
// returns for the INTEGER monday..sunday columns.
const mkService = (serviceId, activeDays, startDate, endDate) => {
  const row = { service_id: serviceId, start_date: startDate, end_date: endDate };
  for (const day of ALL_DAYS) {
    row[day] = activeDays.includes(day) ? 1 : 0;
  }
  return row;
};

// One service per weekday, all spanning the same full week.
const ONE_SERVICE_PER_DAY = ALL_DAYS.map((day) =>
  mkService(`SVC_${day.toUpperCase()}`, [day], "20260706", "20260712"),
);

describe("weekday resolution", () => {
  test.each(WEEK)("%s activates only the %s-flagged service", (date, day) => {
    expect(getServiceIdsForDate(date, ONE_SERVICE_PER_DAY, [])).toEqual([
      `SVC_${day.toUpperCase()}`,
    ]);
  });

  test("calendar_dates exceptions add and remove on the exact date", () => {
    const calendarDates = [
      { service_id: "SVC_ADDED", date: "20260707", exception_type: 1 },
      { service_id: "SVC_TUESDAY", date: "20260707", exception_type: 2 },
    ];
    expect(
      getServiceIdsForDate("20260707", ONE_SERVICE_PER_DAY, calendarDates),
    ).toEqual(["SVC_ADDED"]);
  });
});

describe("nonexistent dates must not roll over to another day's services", () => {
  // Every weekday is flagged, so ANY fabricated weekday would match.
  const allWeekCalendar = [
    mkService("SVC_ALL", ALL_DAYS, "20260101", "20261231"),
  ];

  test.each(["20260732", "20261301", "20260700", "20260229"])(
    "%s (nonexistent) activates nothing",
    (badDate) => {
      expect(getServiceIdsForDate(badDate, allWeekCalendar, [])).toEqual([]);
    },
  );

  test("20240229 (leap day) is a real date and activates normally", () => {
    const leap = [mkService("SVC_LEAP", ["thursday"], "20240201", "20240301")];
    expect(getServiceIdsForDate("20240229", leap, [])).toEqual(["SVC_LEAP"]);
  });
});

describe("holiday encoded as a weekday-less calendar row (real-world feed shape)", () => {
  // Mirrors a real feed: the Sunday-type holiday service is declared
  // sunday-only over a one-day range that is a Tuesday (2026-07-14), so
  // calendar.txt activates zero dates.
  const holidayCalendar = [
    mkService("16_DIMANCHE", ["sunday"], "20260714", "20260714"),
  ];

  test("is inactive per spec when no calendar_dates exception exists", () => {
    expect(getServiceIdsForDate("20260714", holidayCalendar, [])).toEqual([]);
  });

  test("becomes active through an exception_type=1 calendar_dates row", () => {
    const calendarDates = [
      { service_id: "16_DIMANCHE", date: "20260714", exception_type: 1 },
    ];
    expect(
      getServiceIdsForDate("20260714", holidayCalendar, calendarDates),
    ).toEqual(["16_DIMANCHE"]);
  });
});

describe("timezone independence (fresh node process per zone)", () => {
  const SERVICE_PATH = path.resolve(
    __dirname,
    "../services/calendarService.js",
  );

  // The child rebuilds the one-service-per-weekday fixture and asserts the
  // full week mapping; it prints OK only if every weekday resolved correctly
  // under the TZ its process was started with.
  const CHILD_SCRIPT = `
    const assert = require("assert");
    const { getServiceIdsForDate } = require(${JSON.stringify(SERVICE_PATH)});
    const days = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"];
    const calendar = days.map((day) => {
      const row = { service_id: "SVC_" + day.toUpperCase(), start_date: "20260706", end_date: "20260712" };
      for (const d of days) row[d] = d === day ? 1 : 0;
      return row;
    });
    const week = [
      ["20260706","MONDAY"], ["20260707","TUESDAY"], ["20260708","WEDNESDAY"],
      ["20260709","THURSDAY"], ["20260710","FRIDAY"], ["20260711","SATURDAY"],
      ["20260712","SUNDAY"],
    ];
    for (const [date, day] of week) {
      assert.deepStrictEqual(
        getServiceIdsForDate(date, calendar, []),
        ["SVC_" + day],
        date + " misresolved under TZ=" + process.env.TZ,
      );
    }
    console.log("OK");
  `;

  test.each(["UTC", "America/New_York", "America/Anchorage", "Pacific/Kiritimati"])(
    "weekdays stay correct under TZ=%s",
    (tz) => {
      const stdout = execFileSync(process.execPath, ["-e", CHILD_SCRIPT], {
        env: { ...process.env, TZ: tz },
        encoding: "utf8",
        timeout: 30_000,
      });
      // Last line only: transitive imports (dotenv) may log to stdout first.
      expect(stdout.trim().split(/\r?\n/).pop().trim()).toBe("OK");
    },
  );
});
