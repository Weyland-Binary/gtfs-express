/**
 * GTFS clock times as seconds past the service day's midnight. Hours past 24 are the same service day's after
 * midnight ("25:10:00"), never wrapped.
 */

"use strict";

const DAY_S = 24 * 3600;
// A clock time before 06:00 may be meant after midnight (a night trip written "00:40" for "24:40").
const EARLY_MORNING_S = 6 * 3600;

const pad = (n) => String(n).padStart(2, "0");
const textOf = (v, trim) => {
  const s = typeof v === "string" ? v : v == null ? "" : String(v);
  return trim ? s.trim() : s;
};

const PATTERNS = new Map();
const patternOf = (hourDigits, seconds, prefix) => {
  const key = `${hourDigits}|${seconds}|${prefix}`;
  if (!PATTERNS.has(key)) {
    const h = hourDigits === Infinity ? "\\d+" : `\\d{1,${hourDigits}}`;
    const s = seconds === "required" ? ":(\\d{2})" : seconds === "optional" ? "(?::(\\d{2}))?" : "";
    PATTERNS.set(key, new RegExp(`^(${h}):(\\d{2})${prefix ? "" : `${s}$`}`));
  }
  return PATTERNS.get(key);
};

// "HH:MM:SS" without a regex: a city feed holds millions of stop_times.
const fastHms = (t) => {
  if (t.length !== 8 || t.charCodeAt(2) !== 58 || t.charCodeAt(5) !== 58) return null;
  const a = t.charCodeAt(0) - 48;
  const b = t.charCodeAt(1) - 48;
  const c = t.charCodeAt(3) - 48;
  const e = t.charCodeAt(4) - 48;
  const f = t.charCodeAt(6) - 48;
  const g = t.charCodeAt(7) - 48;
  if (!(a >= 0 && a <= 9 && b >= 0 && b <= 9 && c >= 0 && c <= 5 && e >= 0 && e <= 9 && f >= 0 && f <= 5 && g >= 0 && g <= 9)) return null;
  return (a * 10 + b) * 3600 + (c * 10 + e) * 60 + f * 10 + g;
};

/**
 * "H:MM[:SS]" → seconds, or null when it is not a clock time.
 * hourDigits: 2 (default), 3 or Infinity. seconds: "optional" (default) or "required". strict (default true):
 * minutes or seconds above 59 are refused. trim (default true). prefix: read the leading "H:MM" of a longer text,
 * its seconds ignored. lenient: split on ":" and parseInt each part, as hand-typed edit values have always been read
 * (exactly three parts, or two or three with seconds "optional").
 */
const parseTime = (value, { hourDigits = 2, seconds = "optional", strict = true, trim = true, prefix = false, lenient = false } = {}) => {
  if (lenient) {
    if (!value) return null;
    const parts = String(value).split(":");
    if (parts.length !== 3 && !(seconds === "optional" && parts.length === 2)) return null;
    return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + (parts[2] == null ? 0 : parseInt(parts[2], 10));
  }
  const t = textOf(value, trim);
  if (!prefix && hourDigits >= 2) {
    const fast = fastHms(t);
    if (fast != null) return fast;
  }
  const m = patternOf(hourDigits, prefix ? "none" : seconds, prefix).exec(t);
  if (!m) return null;
  const mi = parseInt(m[2], 10);
  const s = !prefix && m[3] ? parseInt(m[3], 10) : 0;
  if (strict && (mi > 59 || s > 59)) return null;
  return parseInt(m[1], 10) * 3600 + mi * 60 + s;
};

// A time as a person writes it in a brief: "7h30", "7:30", "19h", "07:40:00"; bareHour also reads "19".
// squeeze drops every space first ("7 h 30").
const parseClock = (value, { bareHour = false, squeeze = false } = {}) => {
  const raw = textOf(value, true);
  const t = squeeze ? raw.toLowerCase().replace(/\s+/g, "") : raw;
  const m = (bareHour ? /^(\d{1,2})(?:[h:](\d{2})?(?::(\d{2}))?)?$/i : /^(\d{1,2})[h:](\d{2})?(?::(\d{2}))?$/i).exec(t);
  if (!m || +(m[2] || 0) > 59) return null;
  return +m[1] * 3600 + +(m[2] || 0) * 60 + +(m[3] || 0);
};

/**
 * Seconds → "HH:MM:SS", hours past 24 kept. seconds: true (default), false ("HH:MM") or "auto" (only when not
 * zero). round and clamp (default true) round to the second and floor at 0 first; without them the value is
 * written as given.
 */
const formatTime = (value, { seconds = true, round = true, clamp = true } = {}) => {
  let v = round ? Math.round(value) : value;
  if (clamp) v = Math.max(0, v);
  const hm = `${pad(Math.floor(v / 3600))}:${pad(Math.floor((v % 3600) / 60))}`;
  const s = v % 60;
  return seconds === true || (seconds === "auto" && s) ? `${hm}:${pad(s)}` : hm;
};

// The engine reads a feed's own times as they come: up to three hour digits, minutes or seconds above 59 kept.
const FEED = { hourDigits: 3, strict: false };
const parseFeedTime = (t) => parseTime(t, FEED);
const HM = { seconds: false };
const formatHm = (v) => formatTime(v, HM);

/** A time moved by `sec` seconds, floored at 00:00:00; what is not a time comes back as it was. */
const shiftTime = (t, sec, parse = FEED, format = {}) => {
  const v = parseTime(t, parse);
  return v == null ? t : formatTime(v + sec, format);
};

/** The share of the way from a to b a point at d lies at, by shape_dist_traveled; null unless a ≤ d ≤ b and b > a. */
const shareAlong = (a, b, d) => {
  if (![a, b, d].every(Number.isFinite) || !(b > a) || d < a || d > b) return null;
  return (d - a) / (b - a);
};

/**
 * Fills, in place, the calls left untimed between two timed ones (arr and dep in seconds, null when empty): by
 * shape_dist_traveled when every call of the gap carries it and it never falls, else by stop index.
 */
const fillUntimed = (arr, dep, dist = null) => {
  let last = -1;
  for (let i = 0; i < dep.length; i++) {
    if (dep[i] == null) continue;
    if (last >= 0 && i - last > 1) {
      const span = dist ? dist.slice(last, i + 1) : null;
      const rising = span && span.every((d, k) => Number.isFinite(d) && (k === 0 || d >= span[k - 1])) && span[span.length - 1] > span[0];
      for (let k = last + 1; k < i; k++) {
        const gap = arr[i] - dep[last];
        const v = Math.round(dep[last] + (rising ? gap * shareAlong(dist[last], dist[i], dist[k]) : (gap * (k - last)) / (i - last)));
        arr[k] = v;
        dep[k] = v;
      }
    }
    last = i;
  }
};

module.exports = { DAY_S, EARLY_MORNING_S, parseTime, parseFeedTime, parseClock, formatTime, formatHm, shiftTime, shareAlong, fillUntimed };
