/**
 * GTFS times of day ("HH:MM:SS"), which run past 24:00:00 for a trip after midnight and are shown so ("25:10").
 * Not a clock time of a moment: that is formatDate.formatClockTime.
 */

/** Seconds from the start of the service day, or null when empty or not "H:MM:SS". */
export const gtfsTimeToSeconds = (time) => {
  if (!time) return null;
  const parts = String(time).split(":");
  if (parts.length !== 3) return null;
  const [h, m, s] = parts.map((p) => parseInt(p, 10));
  if ([h, m, s].some((n) => Number.isNaN(n))) return null;
  return h * 3600 + m * 60 + s;
};

/** "HH:MM:SS" (hours past 24 kept), or "" without a number. */
export const secondsToGtfsTime = (sec) => {
  if (sec == null || Number.isNaN(Number(sec))) return "";
  const total = Math.round(Number(sec));
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
};

/** True when one of the times has seconds other than :00, so a column shows them all. */
export const hasSeconds = (times) =>
  times.some((t) => {
    if (!t) return false;
    const parts = String(t).split(":");
    return parts.length === 3 && parts[2] !== "00";
  });

/** A GTFS time as the readers show it: as written with `seconds`, else without a ":00". */
export const formatGtfsTime = (time, { seconds = false } = {}) => {
  if (!time || typeof time !== "string") return "";
  const parts = time.split(":");
  if (!seconds && parts.length === 3 && parts[2] === "00") return `${parts[0]}:${parts[1]}`;
  return time;
};

/** Hours and minutes only ("25:10"), for a compact line. */
export const gtfsHourMinute = (time) => {
  if (!time || typeof time !== "string") return "";
  const parts = time.split(":");
  return parts.length >= 2 ? `${parts[0]}:${parts[1]}` : time;
};

/** The share of the way from a to b a point at d lies at (shape_dist_traveled); null unless a ≤ d ≤ b and b > a. */
export const shareAlong = (a, b, d) => {
  if (![a, b, d].every(Number.isFinite) || !(b > a) || d < a || d > b) return null;
  return (d - a) / (b - a);
};

/** The time `share` of the way from one GTFS time to the next, or null when either does not parse. */
export const timeBetween = (from, to, share = 0.5) => {
  const a = gtfsTimeToSeconds(from);
  const b = gtfsTimeToSeconds(to);
  if (a == null || b == null) return null;
  return secondsToGtfsTime(a + (b - a) * share);
};
