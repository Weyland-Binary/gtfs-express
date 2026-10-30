/**
 * Dates, times and numbers in the interface's chosen language (not the browser's), through Intl.
 * A value that is not a date gives "", never "Invalid Date" nor the epoch of `new Date(null)`.
 * Latin digits everywhere (Hindi included): timetables and GTFS identifiers beside them use them.
 */

const DATE_STYLES = Object.freeze({
  short: { day: "numeric", month: "numeric", year: "numeric" },
  medium: { day: "numeric", month: "short", year: "numeric" },
  long: { day: "numeric", month: "long", year: "numeric" },
});

export const localeOf = (language) => `${String(language || "en").slice(0, 2)}-u-nu-latn`;

/** A Date, or null when `value` does not name a moment. */
export const toDate = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const format = (value, language, options) => {
  const date = toDate(value);
  if (!date) return "";
  try {
    return new Intl.DateTimeFormat(localeOf(language), options).format(date);
  } catch {
    return date.toISOString().slice(0, 16).replace("T", " ");
  }
};

export const formatDate = (value, language, style = "medium") => format(value, language, DATE_STYLES[style] || DATE_STYLES.medium);

export const formatDateTime = (value, language) => format(value, language, { ...DATE_STYLES.medium, hour: "numeric", minute: "2-digit" });

/** The clock time of a moment ("14:32", "2:32 PM"); a GTFS time of day is gtfsTime.formatGtfsTime. */
export const formatClockTime = (value, language) => format(value, language, { hour: "numeric", minute: "2-digit" });

export const formatNumber = (n, language, options = {}) => {
  const value = Number(n);
  if (!Number.isFinite(value)) return "";
  try {
    return new Intl.NumberFormat(localeOf(language), options).format(value);
  } catch {
    return String(value);
  }
};

/** A GTFS date (YYYYMMDD, string or number); "" when it is not one. */
export const formatYmd = (ymd, language, style = "medium") => {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(ymd ?? ""));
  if (!m) return "";
  // Noon UTC: the day is the same in every time zone the browser may be in.
  return format(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12)), language, { ...(DATE_STYLES[style] || DATE_STYLES.medium), timeZone: "UTC" });
};
