/**
 * formatDate — dates, times and numbers in the interface's language.
 *
 * Seven languages, seven conventions: "28 sept. 2026" in fr, "Sep 28, 2026"
 * in en, "2026/9/28" in zh — never one pattern ("jj/mm/aaaa") imposed on all.
 * Every screen that shows a date, a time or a count goes through here so the
 * convention is Intl's, for the language the person chose, not the
 * browser's. A value that is not a date (null, "", an unparsable string)
 * gives "" — never "Invalid Date", never the epoch of `new Date(null)`.
 *
 *   formatDate(value, language, style?)      "28 sept. 2026" (style: short | medium | long)
 *   formatDateTime(value, language)          "28 sept. 2026, 14:32"
 *   formatTime(value, language)              "14:32" (fr) · "2:32 PM" (en)
 *   formatNumber(n, language, options?)      "3 908" (fr) · "3,908" (en)
 *   formatYmd(yyyymmdd, language, style?)    a GTFS date (20260901) as formatDate
 *
 * Every language keeps Latin digits (`-u-nu-latn`, Hindi included): the timetables
 * and the GTFS identifiers next to them are written that way.
 */

const DATE_STYLES = Object.freeze({
  short: { day: "numeric", month: "numeric", year: "numeric" },
  medium: { day: "numeric", month: "short", year: "numeric" },
  long: { day: "numeric", month: "long", year: "numeric" },
});

/** The Intl locale of an interface language: its two letters, Latin digits. */
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

/** A calendar date in the interface's language. */
export const formatDate = (value, language, style = "medium") => format(value, language, DATE_STYLES[style] || DATE_STYLES.medium);

/** A date with its clock time. */
export const formatDateTime = (value, language) => format(value, language, { ...DATE_STYLES.medium, hour: "numeric", minute: "2-digit" });

/** A clock time. */
export const formatTime = (value, language) => format(value, language, { hour: "numeric", minute: "2-digit" });

/** A number (a count, a distance) in the interface's language. */
export const formatNumber = (n, language, options = {}) => {
  const value = Number(n);
  if (!Number.isFinite(value)) return "";
  try {
    return new Intl.NumberFormat(localeOf(language), options).format(value);
  } catch {
    return String(value);
  }
};

/** A GTFS date (YYYYMMDD, a string or a number) in the interface's language; "" when it is not one. */
export const formatYmd = (ymd, language, style = "medium") => {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(ymd ?? ""));
  if (!m) return "";
  // Noon UTC: the day is the same in every time zone the browser may be in.
  return format(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12)), language, { ...(DATE_STYLES[style] || DATE_STYLES.medium), timeZone: "UTC" });
};
