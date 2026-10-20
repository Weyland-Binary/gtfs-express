/**
 * values — how the judge reads a clause's params and writes what it
 * measured: trimmed text, numbers, lists of names, clock times, a date or a
 * time as a verdict says it. Shared by every part of the judge.
 */

"use strict";

const networkSpec = require("../network/networkSpec");

const { secToTime } = networkSpec._internals;

const str = (v) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());
const num = (v) => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
};
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

const fmt = (s) => secToTime(s).slice(0, 5);
const iso = (ymd) => (/^\d{8}$/.test(String(ymd || "")) ? `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}` : String(ymd || ""));
const given = (v) => v != null && v !== "" && !(Array.isArray(v) && !v.length);

/** A list the brief gives: names (a string is one name) as trimmed strings. */
const listOf = (v) => (Array.isArray(v) ? v : given(v) ? [v] : []).map((x) => str(x && typeof x === "object" ? x.name : x)).filter(Boolean);
/** Times as the brief writes them: a list, or one string ("19:35, 20:35", "7h40 et 8h10"). */
const timesOf = (v) => listOf(v).flatMap((x) => x.split(/\s*[,;]\s*|\s+(?:et|and)\s+|\s+/i)).filter(Boolean);

/** A clock time ("07:40", "7:40", "7h40", "19h", "07:40:00") → seconds (past 24:00 kept); null when it is not one. */
const clockOf = (v) => {
  const m = /^(\d{1,2})(?:[h:](\d{2})?(?::(\d{2}))?)?$/i.exec(str(v).toLowerCase().replace(/\s+/g, ""));
  if (!m || +(m[2] || 0) > 59) return null;
  return +m[1] * 3600 + +(m[2] || 0) * 60 + +(m[3] || 0);
};
/** "HH:MM" of a clock time as the brief writes it, or null. */
const clockText = (v) => {
  const s = clockOf(v);
  return s == null ? null : fmt(s);
};

const listText = (items, n = 3) => `${items.slice(0, n).join(", ")}${items.length > n ? ` (+${items.length - n} more)` : ""}`;

module.exports = { str, num, clip, fmt, iso, given, listOf, timesOf, clockOf, clockText, listText };
