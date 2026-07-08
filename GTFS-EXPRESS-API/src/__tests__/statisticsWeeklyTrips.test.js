/**
 * statisticsWeeklyTrips.test.js — the weeklyTrips coverage counters must
 * count trips whether calendar day flags arrive as numbers or strings.
 *
 * Regression: buildStatisticsResponse compared service[day] === "1" while
 * getStatistics hydrates data.calendar straight from SQLite, where the
 * monday..sunday columns are INTEGER and come back as JS numbers — the
 * strict string comparison was always false, so the weekly coverage chart
 * reported 0 trips for all seven days on every feed.
 */

"use strict";

const { buildStatisticsResponse } = require("../services/statisticsService");

const ALL_DAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

const mkCalendarRow = (serviceId, activeDays, flag) => {
  const row = {
    service_id: serviceId,
    start_date: "20260706",
    end_date: "20260712",
  };
  for (const day of ALL_DAYS) {
    row[day] = activeDays.includes(day) ? flag(1) : flag(0);
  }
  return row;
};

const mkData = (flag) => ({
  agencies: [],
  routes: [],
  stops: [],
  shapes: [],
  frequencies: [],
  calendarDates: [],
  calendar: [
    mkCalendarRow("WEEK", ["monday", "tuesday", "wednesday", "thursday", "friday"], flag),
    mkCalendarRow("SAT", ["saturday"], flag),
  ],
  trips: [
    { trip_id: "T1", route_id: "R1", service_id: "WEEK" },
    { trip_id: "T2", route_id: "R1", service_id: "WEEK" },
    { trip_id: "T3", route_id: "R1", service_id: "WEEK" },
    { trip_id: "T4", route_id: "R1", service_id: "SAT" },
    { trip_id: "T5", route_id: "R1", service_id: "SAT" },
  ],
});

const EMPTY_STOP_TIMES_STATS = { count: 0, earliest: null, latest: null };

const EXPECTED_WEEKLY_TRIPS = {
  monday: 3,
  tuesday: 3,
  wednesday: 3,
  thursday: 3,
  friday: 3,
  saturday: 2,
  sunday: 0,
};

test("counts trips when day flags are numbers (SQLite INTEGER columns)", () => {
  const result = buildStatisticsResponse(
    mkData((v) => v),
    EMPTY_STOP_TIMES_STATS,
    "stats-test-session",
  );
  expect(result.weeklyTrips).toEqual(EXPECTED_WEEKLY_TRIPS);
});

test("counts trips when day flags are strings (CSV-sourced rows)", () => {
  const result = buildStatisticsResponse(
    mkData((v) => String(v)),
    EMPTY_STOP_TIMES_STATS,
    "stats-test-session",
  );
  expect(result.weeklyTrips).toEqual(EXPECTED_WEEKLY_TRIPS);
});
