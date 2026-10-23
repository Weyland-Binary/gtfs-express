/** How the judge reads a clause's params and writes what it measured. */

"use strict";

const { parseClock, formatTime } = require("../../utils/time");


const str = (v) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());
const num = (v) => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
};
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

const fmt = (s) => formatTime(s, { seconds: false, round: false, clamp: false });
const iso = (ymd) => (/^\d{8}$/.test(String(ymd || "")) ? `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}` : String(ymd || ""));
const given = (v) => v != null && v !== "" && !(Array.isArray(v) && !v.length);

const listOf = (v) => (Array.isArray(v) ? v : given(v) ? [v] : []).map((x) => str(x && typeof x === "object" ? x.name : x)).filter(Boolean);
// A list, or one string: "19:35, 20:35", "7h40 et 8h10".
const timesOf = (v) => listOf(v).flatMap((x) => x.split(/\s*[,;]\s*|\s+(?:et|and)\s+|\s+/i)).filter(Boolean);

// "07:40", "7h40", "19h", "07:40:00" → seconds, past 24:00 kept; null when not a clock time.
const clockOf = (v) => parseClock(v, { bareHour: true, squeeze: true });
const clockText = (v) => {
  const s = clockOf(v);
  return s == null ? null : fmt(s);
};

const listText = (items, n = 3) => `${items.slice(0, n).join(", ")}${items.length > n ? ` (+${items.length - n} more)` : ""}`;

module.exports = { str, num, clip, fmt, iso, given, listOf, timesOf, clockOf, clockText, listText };
