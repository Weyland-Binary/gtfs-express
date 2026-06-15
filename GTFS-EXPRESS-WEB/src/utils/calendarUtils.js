/**
 * GTFS calendar utilities — shared logic for computing active services on a date.
 */

const DAY_KEYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

/**
 * Convert an ISO date string "YYYY-MM-DD" to a GTFS date string "YYYYMMDD".
 */
export function isoToGTFSDate(isoStr) {
  if (!isoStr) return null;
  return isoStr.replace(/-/g, "");
}

/**
 * Returns the sorted list of service_id strings that are active on the given date.
 *
 * @param {string} isoDate  - ISO date string "YYYY-MM-DD"
 * @param {Array}  calendar      - rows from calendar.txt
 * @param {Array}  calendarDates - rows from calendar_dates.txt
 * @returns {string[]} active service_ids
 */
export function getActiveServiceIds(isoDate, calendar, calendarDates) {
  if (!isoDate || !calendar || !calendarDates) return [];

  const dateStr = isoToGTFSDate(isoDate);
  // Compute day-of-week correctly from ISO string to avoid timezone shifts
  const parts = isoDate.split("-");
  const dow = new Date(
    parseInt(parts[0]),
    parseInt(parts[1]) - 1,
    parseInt(parts[2]),
  ).getDay();

  // Step 1: services active via calendar.txt (regular schedule)
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

  // Step 2: apply calendar_dates.txt exceptions
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

  // Remove suppressed services, add exception-added services
  for (const sid of removedSet) activeSet.delete(sid);
  for (const sid of addedSet) activeSet.add(sid);

  return Array.from(activeSet).sort();
}
