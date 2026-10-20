/**
 * contract/intentSheet — the intent sheet: what the brief asks, one DEMAND per requirement, with its scope and the
 * form of the change, as the reading writes it (contract/objectivesExtractor) and clauseFixes reads it.
 *
 * A demand carries its scope (lines, direction, day types, dates or period), the FORM of the change (what it does
 * to what exists), its references (« comme le samedi », « l'itinéraire de la ligne N4 »), the window of the day it
 * touches, the count a full timetable states, and what the brief says stays as it is. The sheet is written by the
 * reading (the extractor) or by hand (the bank's replays), validated by the person, and read by the engine; nothing
 * in it is decided by the engine: a value the reading cannot establish is null, and null is a question for the
 * person, never a default.
 *
 *   {
 *     effective_date: "YYYY-MM-DD" | null,          the date the brief's changes take effect, when it states one
 *     demands: [{
 *       id, quote?, document?,
 *       scope: { lines: [names], direction?: "0" | "1" | "both" | { towards: name } | null,
 *                days?: [weekday | saturday | sunday | mon…sun] | null, period?: school_days | school_holidays | … | null,
 *                from_date?, to_date?, dates?: [YYYY-MM-DD], stops?: [names] },
 *       shape: extend | replace | add | modify | remove | attribute | reroute | create | delete | keep,
 *       replaces_existing?: true | false | null,     a full timetable: replaces the existing trips, or adds to them
 *       window?: { from?: "HH:MM", to?: "HH:MM", to_included?: true | false | null },
 *                                                     the part of the day the demand changes (the rest is kept);
 *                                                     to_included when the brief says whether `to` itself is in it
 *       counts?: [{ day, trips, per: direction | total, period? }],   what a full timetable states (replace)
 *       references?: [{ kind: like_day, day (a day type, a date, or "same": today's own), what: running_times | timetable, from_stop?, to_stop?, like_date? }
 *                     | { kind: like_line, line, what: shape | stops, from_stop, to_stop, direction? }],
 *       keeps?: [{ quote?, scope }],                 what the brief says stays as it is
 *       clauses?: [vocabulary clauses]               the measurable promises the reading wrote (the contract's)
 *     }],
 *     keeps?: [{ quote?, scope }],                   sheet-level keeps (« aucune autre ligne ne change »)
 *     questions?: [{ demand, kind, text, options }]  what the reading could not establish
 *   }
 *
 *   normalizeSheet(raw) → the sheet with every field in its shape (unknown values null, lists as lists), or null
 *   SHAPES, DAY_WORDS
 */

"use strict";

const SHAPES = Object.freeze(["extend", "replace", "add", "modify", "remove", "attribute", "reroute", "create", "delete", "keep"]);
const DAY_WORDS = Object.freeze(["weekday", "saturday", "sunday", "daily", "mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
const REFERENCE_KINDS = Object.freeze(["like_day", "like_line"]);

const str = (v, n = 200) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);
const ymd = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : null);
const hhmm = (v) => (typeof v === "string" && /^\d{1,2}:\d{2}$/.test(v.trim()) ? v.trim().padStart(5, "0") : null);
const list = (v, n = 60) => (Array.isArray(v) ? v.filter((x) => str(x)).map((x) => str(x)).slice(0, n) : []);
const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

const dayWord = (w) => {
  const s = String(w || "").toLowerCase().trim();
  if (["weekdays", "workday", "workdays"].includes(s)) return "weekday";
  if (["saturdays", "sat."].includes(s)) return "saturday";
  if (["sundays", "sun."].includes(s)) return "sunday";
  return DAY_WORDS.includes(s) ? s : null;
};

// A count is per day type: a weekday name is a weekday, sat a saturday, sun a sunday.
const dayTypeWord = (w) => {
  const d = dayWord(w);
  if (!d || d === "daily") return "weekday";
  if (d === "sat" || d === "saturday") return "saturday";
  if (d === "sun" || d === "sunday") return "sunday";
  return "weekday";
};

const directionOf = (v) => (v == null ? null : isObject(v) && str(v.towards) ? { towards: str(v.towards) } : ["0", "1", "both"].includes(String(v)) ? String(v) : null);

const scopeOf = (raw) => {
  const s = isObject(raw) ? raw : {};
  const direction = directionOf(s.direction);
  const days = Array.isArray(s.days) ? s.days.map(dayWord).filter(Boolean) : typeof s.days === "string" && dayWord(s.days) ? [dayWord(s.days)] : null;
  return {
    lines: list(s.lines),
    direction,
    days: days && days.length ? [...new Set(days)] : null,
    period: str(s.period, 40),
    from_date: ymd(s.from_date),
    to_date: ymd(s.to_date),
    dates: Array.isArray(s.dates) ? s.dates.map(ymd).filter(Boolean).slice(0, 100) : [],
    stops: list(s.stops),
    // What the scope leaves out (a keep of « every other line »): lines.
    except: isObject(s.except) && list(s.except.lines).length ? { lines: list(s.except.lines) } : null,
  };
};

const referenceOf = (raw) => {
  if (!isObject(raw) || !REFERENCE_KINDS.includes(raw.kind)) return null;
  if (raw.kind === "like_day") {
    // "same": today's own day type (« les temps de parcours actuels »), each day type of the demand its own.
    const day = ["same", "today", "current"].includes(String(raw.day || "").toLowerCase().trim()) ? "same" : dayWord(raw.day) || ymd(raw.day);
    if (!day) return null;
    return { kind: "like_day", day, what: ["running_times", "timetable"].includes(raw.what) ? raw.what : "timetable", from_stop: str(raw.from_stop), to_stop: str(raw.to_stop), like_date: ymd(raw.like_date), direction: directionOf(raw.direction) };
  }
  if (!str(raw.line)) return null;
  return { kind: "like_line", line: str(raw.line), what: ["shape", "stops"].includes(raw.what) ? raw.what : "shape", from_stop: str(raw.from_stop), to_stop: str(raw.to_stop), direction: directionOf(raw.direction), like_direction: directionOf(raw.like_direction) };
};

const demandOf = (raw, i) => {
  if (!isObject(raw)) return null;
  const shape = SHAPES.includes(raw.shape) ? raw.shape : null;
  // to_included: whether a departure exactly at `to` is within the window, when the brief says it (« 9h00 exclu »);
  // null when it does not — the engine then asks when a plan changes a departure on that bound, rather than reading
  // the bound one way.
  const window = isObject(raw.window) ? { from: hhmm(raw.window.from), to: hhmm(raw.window.to), to_included: raw.window.to_included === true ? true : raw.window.to_included === false ? false : null } : null;
  return {
    id: str(raw.id, 20) || `d${i + 1}`,
    quote: str(raw.quote, 400),
    document: str(raw.document, 160),
    scope: scopeOf(raw.scope),
    shape,
    replaces_existing: raw.replaces_existing === true ? true : raw.replaces_existing === false ? false : null,
    window: window && (window.from || window.to) ? window : null,
    counts: (Array.isArray(raw.counts) ? raw.counts : []).filter((c) => isObject(c) && Number.isInteger(c.trips) && c.trips >= 0).map((c) => ({ day: dayTypeWord(c.day), trips: c.trips, per: c.per === "total" ? "total" : "direction", period: str(c.period, 40), direction: c.direction == null ? null : String(c.direction) })).slice(0, 12),
    references: (Array.isArray(raw.references) ? raw.references : []).map(referenceOf).filter(Boolean).slice(0, 12),
    keeps: (Array.isArray(raw.keeps) ? raw.keeps : []).filter(isObject).map((k) => ({ quote: str(k.quote, 400), scope: scopeOf(k.scope) })).slice(0, 12),
    clauses: Array.isArray(raw.clauses) ? raw.clauses.filter(isObject).slice(0, 60) : [],
  };
};

/** The sheet as the engine reads it; null for nothing. */
const normalizeSheet = (raw) => {
  if (!isObject(raw)) return null;
  const demands = (Array.isArray(raw.demands) ? raw.demands : []).map(demandOf).filter(Boolean).slice(0, 60);
  return {
    effective_date: ymd(raw.effective_date),
    demands,
    keeps: (Array.isArray(raw.keeps) ? raw.keeps : []).filter(isObject).map((k) => ({ quote: str(k.quote, 400), scope: scopeOf(k.scope) })).slice(0, 20),
    questions: (Array.isArray(raw.questions) ? raw.questions : []).filter(isObject).map((q) => ({ demand: str(q.demand, 20), kind: str(q.kind, 40), text: str(q.text, 400), options: list(q.options, 8) })).slice(0, 20),
  };
};

module.exports = { SHAPES, DAY_WORDS, REFERENCE_KINDS, normalizeSheet, _internals: { dayWord, scopeOf, demandOf, referenceOf } };
