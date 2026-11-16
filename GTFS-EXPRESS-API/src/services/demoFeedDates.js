"use strict";

// The demo network's dates follow the day it is opened, so it never expires: its services run from the first day of
// the current month for a year, and its public holidays are the window's own, each run with the Sunday service in
// place of the day's own. In the demo only calendar.txt, calendar_dates.txt and feed_info.txt carry dates.

const fsp = require("fs/promises");
const path = require("path");
const { parseCSV } = require("./csvUtils");

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const utc = (y, m, d) => new Date(Date.UTC(y, m, d));
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");

/** The first day of `today`'s month and the day before the same day a year later. */
const windowOf = (today = new Date()) => ({
  start: utc(today.getUTCFullYear(), today.getUTCMonth(), 1),
  end: utc(today.getUTCFullYear() + 1, today.getUTCMonth(), 0),
});

/** New York's holidays the demo runs as Sundays: New Year's Day, Independence Day, Thanksgiving, Christmas. */
const holidaysOf = (year) => {
  const firstNovember = utc(year, 10, 1).getUTCDay();
  const thanksgiving = utc(year, 10, 1 + ((4 - firstNovember + 7) % 7) + 21);
  return [utc(year, 0, 1), utc(year, 6, 4), thanksgiving, utc(year, 11, 25)];
};

const cell = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const headerOf = async (file) => (await fsp.readFile(file, "utf8")).replace(/^﻿/, "").split(/\r?\n/, 1)[0].split(",").map((h) => h.trim());
const write = (file, header, rows) => fsp.writeFile(file, [header.join(","), ...rows.map((r) => header.map((h) => cell(r[h])).join(","))].join("\n") + "\n");

/**
 * Rewrites the dated files of `dir`, a copy of the demo, for the window around `today`. A holiday that is no Sunday
 * removes every service running that weekday (but a service running every day) and adds the Sunday-only services.
 */
const refreshDemoDates = async (dir, today = new Date()) => {
  const { start, end } = windowOf(today);
  const calendarFile = path.join(dir, "calendar.txt");
  const calendarHeader = await headerOf(calendarFile);
  const calendar = await parseCSV(calendarFile);
  for (const row of calendar) {
    row.start_date = ymd(start);
    row.end_date = ymd(end);
  }
  await write(calendarFile, calendarHeader, calendar);

  const runs = (row, day) => String(row[day]) === "1";
  const daily = (row) => DAYS.every((d) => runs(row, d));
  const sundayOnly = calendar.filter((row) => runs(row, "sunday") && DAYS.filter((d) => runs(row, d)).length === 1);
  const exceptions = [];
  for (let year = start.getUTCFullYear(); year <= end.getUTCFullYear(); year++) {
    for (const day of holidaysOf(year)) {
      if (day < start || day > end || day.getUTCDay() === 0) continue;
      const weekday = DAYS[day.getUTCDay()];
      for (const row of calendar) if (runs(row, weekday) && !daily(row)) exceptions.push({ service_id: row.service_id, date: ymd(day), exception_type: 2 });
      for (const row of sundayOnly) exceptions.push({ service_id: row.service_id, date: ymd(day), exception_type: 1 });
    }
  }
  await write(path.join(dir, "calendar_dates.txt"), ["service_id", "date", "exception_type"], exceptions);

  const infoFile = path.join(dir, "feed_info.txt");
  const infoHeader = await headerOf(infoFile).catch(() => null);
  if (infoHeader) {
    const info = await parseCSV(infoFile);
    for (const row of info) {
      if (infoHeader.includes("feed_start_date")) row.feed_start_date = ymd(start);
      if (infoHeader.includes("feed_end_date")) row.feed_end_date = ymd(end);
    }
    await write(infoFile, infoHeader, info);
  }
  return { start: ymd(start), end: ymd(end), exceptions: exceptions.length };
};

module.exports = { refreshDemoDates, windowOf, holidaysOf };
