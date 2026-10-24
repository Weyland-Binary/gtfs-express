const DAY_KEYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

export function isoToGTFSDate(isoStr) {
  if (!isoStr) return null;
  return isoStr.replace(/-/g, "");
}

/** Sorted service_ids running on `isoDate` ("YYYY-MM-DD"). */
export function getActiveServiceIds(isoDate, calendar, calendarDates) {
  if (!isoDate || !calendar || !calendarDates) return [];

  const dateStr = isoToGTFSDate(isoDate);
  // A local date: new Date("YYYY-MM-DD") parses as UTC and can shift the weekday.
  const parts = isoDate.split("-");
  const dow = new Date(
    parseInt(parts[0]),
    parseInt(parts[1]) - 1,
    parseInt(parts[2]),
  ).getDay();

  const activeSet = new Set();
  for (const entry of calendar) {
    if (
      dateStr >= String(entry.start_date) &&
      dateStr <= String(entry.end_date)
    ) {
      if (String(entry[DAY_KEYS[dow]]) === "1") {
        activeSet.add(entry.service_id);
      }
    }
  }

  const addedSet = new Set();
  const removedSet = new Set();
  for (const entry of calendarDates) {
    if (String(entry.date) === dateStr) {
      if (String(entry.exception_type) === "1") {
        addedSet.add(entry.service_id);
      } else if (String(entry.exception_type) === "2") {
        removedSet.add(entry.service_id);
      }
    }
  }

  for (const sid of removedSet) activeSet.delete(sid);
  for (const sid of addedSet) activeSet.add(sid);

  return Array.from(activeSet).sort();
}
