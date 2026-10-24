/**
 * The two « inchangé » clauses (« le reste du réseau / de la journée est inchangé »), written before the plan's
 * operations are known. Each is an unchanged_except clause with params.derive, derived at every measure from the
 * plan's OPERATIONS (the lines and scope each declares), never from the semantic diff: excepting what the plan
 * did would except what went wrong, and the clause would always pass. One that cannot be derived is unknown.
 */

"use strict";

const { nameKey } = require("../network/feedText");
const R = require("../transform/resolve");
const { parseDate, canonical } = require("../transform/calendars");
const { norm, ALL_WORDS, OPEN_END } = require("../transform/operators/calendarOps")._internals;

const DERIVED = Object.freeze({ other_lines: "other_lines_unchanged", rest_of_day: "rest_of_the_day_unchanged" });
const CLOCK = /^(\d{1,2})[:h](\d{2})$/;

const str = (v) => (v == null ? "" : String(v).trim());
const given = (v) => v != null && v !== "" && !(Array.isArray(v) && !v.length);
const asList = (v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]);
const clockOf = (v) => {
  const m = CLOCK.exec(String(v ?? "").trim());
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
};
const shiftClock = (hhmm, minutes) => {
  const [h, m] = hhmm.split(":").map(Number);
  const t = Math.max(0, h * 60 + m + Math.round(minutes));
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};

// null when the operation names no line, or every line (« all » is the whole network, not a line named so).
const linesOf = (op) => {
  const p = op?.params || {};
  const names = [...asList(p.route), ...asList(p.routes), ...asList(p.line), ...asList(p.lines), ...asList(p.changes).map((c) => c?.route)].filter((x) => typeof x === "string" && x.trim());
  if (!names.length || names.some((x) => ALL_WORDS.has(norm(x)))) return null;
  return names.map((x) => x.trim());
};
// null for an open end: a suspension until further notice runs to the end of the feed.
const lastDateOf = (op) => {
  const v = op.params?.to_date;
  return op.type === "discontinue_route" || !given(v) || OPEN_END.has(norm(v)) ? null : v;
};

const TIMED_AT_ORIGIN = new Set(["add_trips", "remove_trips"]);
// The minute within which those operators match a given time.
const OPERATOR_MINUTE = 1;
const clocksOf = (v) => asList(v).flatMap((x) => String(x).split(/[,;\s]+/)).map(clockOf).filter(Boolean);

// Operations stating the whole timetable of their scope, and trip selections taking every trip (all: true).
const WHOLE_DAY = new Set(["build_timetable", "remove_day_service", "copy_day_service", "run_like", "suspend_service", "discontinue_route"]);
const ALL_TRIPS = new Set(["remove_trips", "shift_trips"]);
// Operations changing every trip of their line unless a from / to window selects some (counted whole, else a
// remove_stop would leave the rest of the day unknown for the whole plan). A narrower selection
// (times, a pattern) still counts as whole: more is left out, never one of its trips measured as collateral.
const ALL_OF_LINE = new Set(["remove_stop", "add_stop", "relocate_stop", "reroute", "extend_route", "truncate_route", "adjust_running_times", "set_dwell", "merge_routes", "split_route"]);
const isWholeDay = (op) => WHOLE_DAY.has(op?.type) || (ALL_TRIPS.has(op?.type) && (op.params?.all === true || op.params?.all === "true")) || (ALL_OF_LINE.has(op?.type) && !windowOf(op));

/**
 * The time window an operation declares, or null. Added or withdrawn departures give each of their times,
 * never the span between them (a 07:30 dropped beside 07:00 and 08:00 would pass); a shift widens its window
 * by its minutes. Arrivals, an added return trip or times past midnight put the departures elsewhere: no window.
 */
const windowOf = (op) => {
  const p = op?.params || {};
  const at = str(p.at_stop?.name ?? p.at_stop);
  const read = (from, to) => ({ from, to, ...(at ? { at_stop: at } : {}) });
  const from = clockOf(p.from);
  const to = clockOf(p.to);
  if (op?.type === "shift_trips") {
    const minutes = Number(p.minutes);
    return from && to && given(p.minutes) && Number.isFinite(minutes) && !given(p.target) ? read(shiftClock(from, Math.min(0, minutes)), shiftClock(to, Math.max(0, minutes))) : null;
  }
  if (from && to) return read(from, to);
  if (!TIMED_AT_ORIGIN.has(op?.type)) return null;
  const elsewhere = p.event === "arrive" || (p.round_trip_layover_min != null && p.round_trip_layover_min !== "") || p.after_midnight === true || p.after_midnight === "true";
  if (elsewhere) return null;
  const times = [...new Set(clocksOf(p.times))].sort();
  if (times.length) return { times, ...(at ? { at_stop: at } : {}) };
  const series = p.series && typeof p.series === "object" ? p.series : null;
  const sFrom = clockOf(series?.from);
  const sTo = clockOf(series?.to);
  return sFrom && sTo ? { ...read(sFrom, sTo), tolerance_min: OPERATOR_MINUTE } : null;
};

const directionOf = (p) => (given(p.direction) && !["both", "all"].includes(str(p.direction).toLowerCase()) ? str(p.direction) : null);
// null: every day (none said, or words the engine itself asks about).
const dayKeysOf = (op) => {
  const raw = op.type === "copy_day_service" ? op.params?.to_days : op.params?.days;
  if (!given(raw) || raw === "all") return null;
  const d = R.days(raw);
  return d.value && d.value.length < 7 ? d.value : null;
};
// A discontinued line without from_date starts the day after its last_date.
const firstDateOf = (op) => {
  const p = op.params || {};
  if (op.type !== "discontinue_route" || given(p.from_date) || !given(p.last_date)) return given(p.from_date) ? p.from_date : null;
  const last = parseDate(p.last_date);
  if (!last) return null;
  const d = new Date(Date.UTC(+last.slice(0, 4), +last.slice(4, 6) - 1, +last.slice(6, 8) + 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
};

/** What an operation may change, as a scope of except.trips; null when it declares neither a window nor a whole day. */
const scopeOfOperation = (op) => {
  const p = op.params || {};
  const whole = isWholeDay(op);
  const win = whole ? null : windowOf(op);
  if (!whole && !win) return null;
  const scope = { op: str(op.id) || op.type, lines: linesOf(op), direction: directionOf(p), days: dayKeysOf(op), from_date: firstDateOf(op), to_date: lastDateOf(op), dates: p.dates, period: p.period, region: p.region, ...(win || {}) };
  return Object.fromEntries(Object.entries(scope).filter(([, v]) => given(v)));
};

// dates false: dates it cannot read, which cover nothing.
const extentOf = (op) => {
  const p = op.params || {};
  const dates = given(p.dates) ? asList(p.dates).flatMap((x) => String(x).split(/[\s,;]+/)).filter(Boolean).map(parseDate) : null;
  return {
    lines: new Set((linesOf(op) || []).map(nameKey)),
    direction: directionOf(p),
    days: dayKeysOf(op),
    from: parseDate(firstDateOf(op)) || null,
    to: parseDate(lastDateOf(op)) || null,
    dates: dates ? (dates.includes(null) ? false : new Set(dates)) : null,
    period: given(p.period) ? `${canonical(str(p.period))}|${str(p.region)}` : null,
    except: given(p.except),
    holidayWeekdays: str(p.holiday_weekdays) || null,
  };
};

/** Whether every trip operation a may touch lies in whole-day operation b's scope. */
const coveredBy = (a, b) => {
  if (a.dates === false || b.dates === false) return false;
  const inRange = (d) => (!b.from || d >= b.from) && (!b.to || d <= b.to) && (!b.dates || b.dates.has(d));
  const datesIn = a.dates ? [...a.dates].every(inRange) : (!b.from || (a.from && a.from >= b.from)) && (!b.to || (a.to && a.to <= b.to)) && !b.dates;
  return (
    a.lines.size > 0 &&
    [...a.lines].every((l) => b.lines.has(l)) &&
    (b.direction == null || a.direction === b.direction) &&
    (b.days == null || (a.days != null && a.days.every((d) => b.days.includes(d)))) &&
    datesIn &&
    (b.period == null || a.period === b.period) &&
    !b.except &&
    (b.holidayWeekdays == null || a.holidayWeekdays === b.holidayWeekdays)
  );
};

const unknownResult = (c, note) => ({ id: c.id, kind: c.kind, level: c.level || "must", status: "unknown", text: c.text || null, expected: null, measured: null, note });

const derive = (c, operations) => {
  const which = c?.params?.derive;
  const ops = (Array.isArray(operations) ? operations : []).filter((o) => o && typeof o === "object");
  if (!ops.length) return { note: "no operation yet: the lines and the window the change touches are not known" };
  const perOp = ops.map(linesOf);
  if (perOp.some((l) => !l)) return { note: "an operation of the plan names no line (it applies to the whole network): the rest of the network cannot be told apart" };
  const lines = [...new Set(perOp.flat())];
  const { derive: _drop, ...rest } = c.params || {}; // eslint-disable-line no-unused-vars
  if (which === "other_lines") return { clause: { ...c, params: { ...rest, except: { ...(rest.except || {}), lines } } } };
  // An operation a whole-day operation of the plan covers needs no scope of its own.
  const wholes = ops.filter(isWholeDay).map(extentOf);
  const trips = [];
  for (const o of ops) {
    if (!isWholeDay(o) && wholes.some((w) => coveredBy(extentOf(o), w))) continue;
    const scope = scopeOfOperation(o);
    if (!scope) return { note: "an operation of the plan has no time window (from / to, or departures at its origin or at a stop) nor a whole day of its own, and no whole-day operation of the plan holds it: the rest of the day cannot be told apart" };
    trips.push(scope);
  }
  return { clause: { ...c, params: { ...rest, lines, except: { ...(rest.except || {}), trips } } } };
};

const deriveRequirements = (requirements, operations) => {
  const clauses = Array.isArray(requirements?.clauses) ? requirements.clauses : [];
  if (!clauses.some((c) => c?.params?.derive && DERIVED[c.params.derive])) return { requirements, unknown: [] };
  const out = [];
  const unknown = [];
  for (const c of clauses) {
    if (!c?.params?.derive || !DERIVED[c.params.derive]) {
      out.push(c);
      continue;
    }
    const d = derive(c, operations);
    if (d.clause) out.push(d.clause);
    else unknown.push(unknownResult(c, d.note));
  }
  return { requirements: { ...requirements, clauses: out }, unknown };
};

/** One of the two clauses as a plan writes it, before its operations are known. */
const template = (which, { id = DERIVED[which], text = null, level = "must" } = {}) => ({ id, kind: "unchanged_except", level, status: "stated", ...(text ? { text } : {}), params: { derive: which } });

module.exports = { DERIVED, WHOLE_DAY, deriveRequirements, template, _internals: { linesOf, windowOf, scopeOfOperation, coveredBy, extentOf, derive } };
