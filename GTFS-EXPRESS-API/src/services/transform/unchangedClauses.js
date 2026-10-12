/**
 * unchangedClauses — the two « inchangé » clauses a modify project's contract
 * carries from ② (target design §4 A2, B2): « Le reste du réseau est
 * inchangé » (other_lines_unchanged) and « Le reste de la journée est
 * inchangé » (rest_of_the_day_unchanged), prefilled and kept by default,
 * waivable by name.
 *
 * At ② the plan is not written yet, so neither can name its lines or its
 * window: each is recorded as step 2's `unchanged_except` with
 * `params.derive` ("other_lines" | "rest_of_day") and is derived, at every
 * measure, from the OPERATIONS of the plan — the lines they declare (route,
 * routes, line, lines, changes[].route) and the scope each one declares
 * (scopeOfOperation) — never from what the plan did to the feed (the
 * semantic diff would except what went wrong and the clause would always
 * pass):
 *
 *   other_lines  → unchanged_except { except: { lines: the lines the operations name } }
 *                  (every other line, on every date, keeps its timetable)
 *   rest_of_day  → unchanged_except { lines: the lines the operations name,
 *                  except: { trips: [the scope of each operation] } }
 *                  (on those lines, every trip no operation's scope holds keeps its timetable)
 *
 * An operation's scope is what it may change: its lines, its direction, its
 * days and dates, and its window — from / to, or the departures it adds or
 * withdraws (their times, or a series), read at its stop when it names one
 * (at_stop: a set_headway reads its window there, a withdrawal its times) —
 * or the WHOLE DAY for an operation that states the whole timetable of its
 * scope (WHOLE_DAY: an offer order's grid, a day's service taken away,
 * copied or run like another day, a suspension, a line discontinued from a
 * date, every trip of a selection) or changes every trip of its line without
 * a window (ALL_OF_LINE: a stop taken out, served or moved, a route redrawn,
 * extended or cut, its running times or dwells, lines merged or split). A
 * whole-day operation has a rest of the day too — its line's other
 * direction, other days and dates — measured like any other, never passed on
 * the plan's own words nor left unknown (2026-10-07,
 * libéA Albi: line D's weekday order beside a withdrawal at Pélissier, line
 * F's Saturday order and line A's Saturdays taken away left « le reste de la
 * journée » unknown at the delivery).
 *
 * A clause that cannot be derived is measured "unknown", with its reason, and
 * is acknowledged by name at delivery like any must clause not measured: an
 * operation without a line (it applies to the whole network — so does a
 * calendar operator's `routes: "all"`, never a line named « all ») for both; for
 * the second, an operation without a window (a span, an arrival, an added
 * return trip, times past midnight) that no whole-day operation of the plan
 * holds (coveredBy: its lines, direction, days and dates all inside the
 * whole-day one's — a withdrawal on the weekdays of a direction whose weekday
 * grid the plan rebuilds); no operation yet for both.
 *
 * A suspension « until further notice » (suspend_service's to_date
 * "until_further_notice", which its operator documents) has no last date: its
 * scope runs to the end of the feed — copied as written, it was a date the
 * checker could not read, and the clause was unknown for it.
 *
 *   DERIVED = { other_lines: "other_lines_unchanged", rest_of_day: "rest_of_the_day_unchanged" }
 *   deriveRequirements(requirements, operations) → { requirements (measurable), unknown: [result] }
 *   template(which, { id, text, level }) → the clause ② prefills
 */

"use strict";

const { nameKey } = require("../network/networkSpec")._internals;
const R = require("./resolve");
const { parseDate, canonical } = require("./calendars");
// The calendar operators' own words: every line (`routes: "all"`), and an open end (`to_date: "until_further_notice"`).
const { norm, ALL_WORDS, OPEN_END } = require("./operators/calendarOps")._internals;

const DERIVED = Object.freeze({ other_lines: "other_lines_unchanged", rest_of_day: "rest_of_the_day_unchanged" });
const CLOCK = /^(\d{1,2})[:h](\d{2})$/;

const str = (v) => (v == null ? "" : String(v).trim());
const given = (v) => v != null && v !== "" && !(Array.isArray(v) && !v.length);
const asList = (v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]);
const clockOf = (v) => {
  const m = CLOCK.exec(String(v ?? "").trim());
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
};
/** A clock moved by some minutes ("07:10" − 15 → "06:55"), never before midnight. */
const shiftClock = (hhmm, minutes) => {
  const [h, m] = hhmm.split(":").map(Number);
  const t = Math.max(0, h * 60 + m + Math.round(minutes));
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};

/**
 * The lines an operation declares (its public numbers or ids, as written), or
 * null when it names none — nor when it names every line (« all », « toutes les
 * lignes »: the calendar operators' whole network), which is no line named
 * « all ».
 */
const linesOf = (op) => {
  const p = op?.params || {};
  const names = [...asList(p.route), ...asList(p.routes), ...asList(p.line), ...asList(p.lines), ...asList(p.changes).map((c) => c?.route)].filter((x) => typeof x === "string" && x.trim());
  if (!names.length || names.some((x) => ALL_WORDS.has(norm(x)))) return null;
  return names.map((x) => x.trim());
};
/** The last date an operation changes, as written; null for an open end (a line discontinued, a suspension until further notice). */
const lastDateOf = (op) => {
  const v = op.params?.to_date;
  return op.type === "discontinue_route" || !given(v) || OPEN_END.has(norm(v)) ? null : v;
};

// The operations whose departures, given at the line's origin (or at a stop), are the trips they add or withdraw.
const TIMED_AT_ORIGIN = new Set(["add_trips", "remove_trips"]);
// The minute within which those operators match a time given (selection.js, add_trips' template shift).
const OPERATOR_MINUTE = 1;
const clocksOf = (v) => asList(v).flatMap((x) => String(x).split(/[,;\s]+/)).map(clockOf).filter(Boolean);

// The operations that state the whole timetable of their scope: every trip of their lines (direction), days and
// dates is theirs — and a trip selection that takes every one of them (all: true).
const WHOLE_DAY = new Set(["build_timetable", "remove_day_service", "copy_day_service", "run_like", "suspend_service", "discontinue_route"]);
const ALL_TRIPS = new Set(["remove_trips", "shift_trips"]);
// The operations that change every trip of their line — in their direction, on their days and dates — unless a
// window (from / to) selects some: a stop taken out, served or moved, the route redrawn, extended or cut, its running
// times or dwells, lines merged or split (2026-10-07: « VERNON - Fonderie retiré de 180 courses de la ligne 5 », a
// remove_stop, left « le reste de la journée » unknown for the whole plan). Times, a pattern or one trip in N select
// some of those trips: the whole scope holds them (more left out, never one of their trips measured as collateral).
const ALL_OF_LINE = new Set(["remove_stop", "add_stop", "relocate_stop", "reroute", "extend_route", "truncate_route", "adjust_running_times", "set_dwell", "merge_routes", "split_route"]);
const isWholeDay = (op) => WHOLE_DAY.has(op?.type) || (ALL_TRIPS.has(op?.type) && (op.params?.all === true || op.params?.all === "true")) || (ALL_OF_LINE.has(op?.type) && !windowOf(op));

/**
 * The time window an operation declares ({ from, to, at_stop? } | { times,
 * at_stop? }), or null: its from / to (read at its stop when it names one);
 * for departures added or withdrawn, those departures — at its stop when it
 * names one, else at the origin: each of its `times` (never the span between
 * them: « supprimer les 07:00 et 08:00 » made 07:00–08:00 the scope, and a
 * 07:30 dropped beside them passed), or its `series` from / to with the
 * operators' minute (tolerance_min: a series' first departure, from a template
 * timed to the second, leaves within a minute of `from`); a shift, its window
 * widened by its minutes (the trips it moves leave there before and after).
 * The unchanged_except measure leaves out the trips leaving inside the window
 * — exactly the ones the operation touches: each time within the minute the
 * operators match it, read past midnight where they read it so
 * (conformanceService tripScopesOf). Arrivals, an added return trip or times
 * after midnight leave the trips' departures elsewhere: no window then
 * (« ajouter des départs à 07:05 et 07:35 » was measured "unknown" and asked
 * for an acknowledgement at every delivery).
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

/** The one direction an operation names, as written ("0", a destination), or null (both). */
const directionOf = (p) => (given(p.direction) && !["both", "all"].includes(str(p.direction).toLowerCase()) ? str(p.direction) : null);
/** The days an operation applies to, as day keys; null: every day (none said, or words the engine itself asks about). */
const dayKeysOf = (op) => {
  const raw = op.type === "copy_day_service" ? op.params?.to_days : op.params?.days;
  if (!given(raw) || raw === "all") return null;
  const d = R.days(raw);
  return d.value && d.value.length < 7 ? d.value : null;
};
/** The first date an operation changes: a discontinued line's first date without it (from_date, or the day after last_date). */
const firstDateOf = (op) => {
  const p = op.params || {};
  if (op.type !== "discontinue_route" || given(p.from_date) || !given(p.last_date)) return given(p.from_date) ? p.from_date : null;
  const last = parseDate(p.last_date);
  if (!last) return null;
  const d = new Date(Date.UTC(+last.slice(0, 4), +last.slice(4, 6) - 1, +last.slice(6, 8) + 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
};

/**
 * What an operation may change, as a scope of unchanged_except's except.trips
 * (conformanceService): its lines, direction, days, dates and window — none
 * for a whole-day operation. null: it declares no window, and no whole day.
 */
const scopeOfOperation = (op) => {
  const p = op.params || {};
  const whole = isWholeDay(op);
  const win = whole ? null : windowOf(op);
  if (!whole && !win) return null;
  const scope = { op: str(op.id) || op.type, lines: linesOf(op), direction: directionOf(p), days: dayKeysOf(op), from_date: firstDateOf(op), to_date: lastDateOf(op), dates: p.dates, period: p.period, region: p.region, ...(win || {}) };
  return Object.fromEntries(Object.entries(scope).filter(([, v]) => given(v)));
};

/** An operation's extent as coveredBy compares it: its lines, direction, days and dates (false: dates it cannot read). */
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

/**
 * Whether every trip an operation may touch lies in a whole-day operation's
 * scope: its lines among the other's, the same direction (or the other takes
 * both), its days among the other's, its dates inside the other's range,
 * dates and period — the other taking none of them out (except) and reading
 * the holiday weekdays alike. Dates either cannot read hold nothing.
 */
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
  // What each operation may change; one that a whole-day operation of the plan holds needs no scope of its own.
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

/** The requirements as the checker measures them: the derived clauses made concrete, the underivable ones apart. */
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

/** The clause ② prefills in a modify project (kept by default, waivable by name). */
const template = (which, { id = DERIVED[which], text = null, level = "must" } = {}) => ({ id, kind: "unchanged_except", level, status: "stated", ...(text ? { text } : {}), params: { derive: which } });

module.exports = { DERIVED, WHOLE_DAY, deriveRequirements, template, _internals: { linesOf, windowOf, scopeOfOperation, coveredBy, extentOf, derive } };
