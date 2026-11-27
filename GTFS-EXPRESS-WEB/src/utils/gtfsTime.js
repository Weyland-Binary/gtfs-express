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

// The validator's own reading (GtfsTime): one to three hour digits, the minutes and the seconds 00 to 59, the text
// as it is. The API's utils/time.js isGtfsTime reads the same.
const GTFS_TIME_RE = /^\d{1,3}:[0-5]\d:[0-5]\d$/;

/** True when the text is a GTFS time as the validator and the server take one ("8:05:00", "25:10:00"). */
export const isGtfsTime = (text) => typeof text === "string" && GTFS_TIME_RE.test(text);

/** "HH:MM:SS" (hours past 24 kept), or "" without a number. */
export const secondsToGtfsTime = (sec) => {
  if (sec == null || Number.isNaN(Number(sec))) return "";
  const total = Math.round(Number(sec));
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
};

/**
 * A time as a person types or pastes it ("7:05", "7h05", "07.05.30", "0705") as its hour, minute and second parts,
 * each as written; null when it reads as no time. Any separator parts them; written in one piece, its last two digits
 * are the minutes (its last four the minutes and the seconds, past four digits).
 */
export const typedTimeParts = (text) => {
  const groups = String(text ?? "").split(/\D+/).filter(Boolean);
  let parts = groups;
  if (groups.length === 1 && groups[0].length > 2) {
    const digits = groups[0];
    const tail = digits.length > 4 ? 4 : 2;
    parts = [digits.slice(0, -tail), ...digits.slice(-tail).match(/\d{2}/g)];
  }
  if (parts.length < 1 || parts.length > 3) return null;
  const [h = "", m = "", sec = ""] = parts;
  if (!h || h.length > 3 || m.length > 2 || sec.length > 2 || Number(m) > 59 || Number(sec) > 59) return null;
  return [h, m, sec];
};

/**
 * The GTFS time of its typed parts: whole with its hours and its minutes (the seconds read as :00, an hour past 23
 * kept), empty when no part is typed (the time is cleared), else incomplete: nothing is made up for a missing part.
 */
export const timeOfParts = ([h = "", m = "", sec = ""]) => {
  if (!h && !m && !sec) return { time: "", complete: true };
  if (!h || !m) return { time: null, complete: false };
  return { time: [h, m, sec || "0"].map((part) => part.padStart(2, "0")).join(":"), complete: true };
};

/** True when one of the times has seconds other than :00, so a column shows them all. */
export const hasSeconds = (times) =>
  times.some((t) => {
    if (!t) return false;
    const parts = String(t).split(":");
    return parts.length === 3 && parts[2] !== "00";
  });

// GTFS allows "H:MM:SS": the hour is padded on screen, so that times read and line up alike.
const paddedParts = (time) => {
  const parts = time.split(":");
  if (/^\d$/.test(parts[0])) parts[0] = `0${parts[0]}`;
  return parts;
};

/** A GTFS time as the readers show it: with its seconds with `seconds`, else without a ":00". */
export const formatGtfsTime = (time, { seconds = false } = {}) => {
  if (!time || typeof time !== "string") return "";
  const parts = paddedParts(time);
  if (parts.length < 2) return time;
  if (!seconds && parts.length === 3 && parts[2] === "00") parts.pop();
  return parts.join(":");
};

/** Hours and minutes only ("25:10"), for a compact line. */
export const gtfsHourMinute = (time) => {
  if (!time || typeof time !== "string") return "";
  const parts = paddedParts(time);
  return parts.length >= 2 ? `${parts[0]}:${parts[1]}` : time;
};

/** A length of time in the interface's units, as far down as it needs: 400 → "6 min 40 s", never "6.67 min". */
export const formatDuration = (seconds, t) => {
  const total = Math.round(Number(seconds));
  if (!Number.isFinite(total) || total < 0) return "";
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  return [hours ? t("error.human.wait.hours", { count: hours }) : "", minutes ? t("error.human.wait.minutes", { count: minutes }) : "", rest || total === 0 ? t("error.human.wait.seconds", { count: rest }) : ""].filter(Boolean).join(" ");
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
