/**
 * checks/timetable — the checks of a line's timetable, measured on every
 * timetable of the clause's scope (calendar.gridOf): headway_max, span, days,
 * no_service, trips_count, departure_at, running_time (like_day: the running
 * times of a reference day) and transfer_max_wait (a guaranteed connection at
 * a stop). Each check takes (clause, ctx) and returns its result.
 */

"use strict";

const networkSpec = require("../../network/networkSpec");
const { haversineMeters } = require("../../../utils/geoUtils");
const { tripsOf, stopKeys, indexIn } = require("../clauseTrips");
const { str, num, fmt, iso, given, timesOf, clockOf, clockText, listText } = require("../values");
const { result, missingLine } = require("../result");
const { DOW, parseYmd, scopeOf, gridOf, gridTally, where, clockWindow } = require("../calendar");
const { findLine, pairedLine, directionsOf, directionLabel, linesFor, patternsOfLine, stopNamesOf, sameDirection, isDirectionLabel, directionIn, withDirection, readDirection, endsThere, startsThere, callKind, clauseDirection, unreadDirection, servedKeysOf, stopsOfClause, occurrenceOf, occurrenceText, callOf, callsOfStop, repeatedNote, endingNote, terminusNote, baseSpecOf } = require("../locate");

const { timeToSec, nameKey } = networkSpec._internals;

/**
 * The directions trips_count counts, each starting at 0: the one the clause
 * names (even when the line has no pattern in it, a loop line say), else
 * those of the line's patterns, else "0" — a line without any trip left
 * still counts 0, never nothing (an empty count would pass every bound).
 */
const countedDirections = (patterns, direction = null) => {
  if (direction != null) return [String(direction)];
  const dirs = [...new Set(patterns.map((d) => String(d.direction ?? d.id ?? "0")))].sort();
  return dirs.length ? dirs : ["0"];
};

/**
 * The longest wait of a window [from, to] on sorted departures, and which
 * one it is: the edges count (from → first, last → to), so a promise of a
 * bus within N minutes of `from` holds from `from`.
 *   → { gap, kind: "inner" | "start" | "end" | "none", first, last }
 */
const gapOf = (deps, from, to) => {
  const inWin = deps.filter((t) => t >= from && t <= to);
  if (!inWin.length) return { gap: to - from + 1, kind: "none", first: null, last: null };
  const pts = [from, ...inWin, to];
  let gap = -1;
  let kind = "inner";
  for (let i = 1; i < pts.length; i++) {
    const g = pts[i] - pts[i - 1];
    if (g > gap) {
      gap = g;
      kind = i === 1 ? "start" : i === pts.length - 1 ? "end" : "inner";
    }
  }
  return { gap, kind, first: inWin[0], last: inWin[inWin.length - 1] };
};

/**
 * The worst wait as a measured text: which gap it is, and where. `exact`: to
 * the second — a wait whose whole minutes would read on the other side of the
 * bound is said as it is (10 min 08 s fails « every 10 min », 9 min 44 s holds
 * « every 9.75 min »: neither is said as « 10 min »).
 */
const gapText = (w, from, to, { exact = false } = {}) => {
  if (!w) return "no timetable";
  const seconds = Math.round(w.gap % 60);
  const wait = exact && seconds ? `${Math.floor(w.gap / 60)} min ${String(seconds).padStart(2, "0")} s` : `${Math.round(w.gap / 60)} min`;
  if (w.kind === "none") return `no service in the window${where(w.point)}`;
  const at = where(w.point);
  const on = at.startsWith(" on") ? `,${at}` : at;
  const stop = w.stop ? ` at ${w.stop}` : "";
  if (w.kind === "start") return `first departure ${fmt(w.first)}${stop}, ${wait} after ${fmt(from)}${on}`;
  if (w.kind === "end") return `last departure ${fmt(w.last)}${stop}, ${wait} before ${fmt(to)}${on}`;
  return `longest wait ${wait}${stop}${where(w.point)}`;
};

/**
 * The name of the stop a feed measures a direction's headway at, when it is
 * not where the direction's trips start (feedModel.departures' trunk: a line
 * whose branches or short workings meet down the line). null otherwise, and
 * for a design (its departures are its termini's).
 */
const trunkName = (spec, byDirection, deps) => {
  const trunk = byDirection && byDirection.trunk;
  if (!trunk || !trunk.size) return null;
  const dir = [...byDirection.entries()].find(([, v]) => v === deps)?.[0];
  const id = dir != null ? trunk.get(dir) : null;
  if (!id) return null;
  return stopNamesOf(spec).get(id) || id;
};

/** Bounds as a text: "36–40 min", "≥ 20 min", "≤ 30 min". */
const boundsText = (lo, hi, unit) => {
  if (Number.isFinite(lo) && Number.isFinite(hi)) return lo === hi ? `${lo}${unit}` : `${lo}–${hi}${unit}`;
  return Number.isFinite(lo) ? `≥ ${lo}${unit}` : `≤ ${hi}${unit}`;
};
const medianOf = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/**
 * The calls of a line's trips at a stop on one timetable, minute-rounded (a
 * published time is to the minute): `arr` the arrivals (not where a trip
 * starts: nobody arrives on it), `dep` the departures (not where it ends).
 * null: a design without compiled tables.
 */
const callsAt = (ctx, line, point, keys, which, direction = null) => {
  const trips = tripsOf(ctx, line, point);
  if (trips === null) return null;
  const out = [];
  for (const t of trips) {
    if (direction != null && direction !== "" && direction !== "both" && String(t.direction) !== String(direction)) continue;
    for (let i = 0; i < t.keys.length; i++) {
      if (!keys.has(t.keys[i])) continue;
      if (which === "arr" ? i === 0 : i === t.keys.length - 1) continue;
      const at = which === "arr" ? t.arr[i] : t.dep[i];
      if (at != null) out.push({ at: Math.floor(at / 60) * 60, trip: t });
    }
  }
  return out.sort((a, b) => a.at - b.at);
};

// ── Reference days (running_time like_day) ───────────────

// The representative dates a day word stands for on a feed's view (its representative DOW dates), or a date.
const refDatesOf = (view, word) => {
  const w = String(word || "").toLowerCase();
  const ymd = parseYmd(w);
  if (ymd) return [ymd];
  const dows = w === "weekday" || w === "weekdays" ? ["mon", "tue", "wed", "thu", "fri"] : w === "saturday" ? ["sat"] : w === "sunday" ? ["sun"] : w === "weekend" ? ["sat", "sun"] : DOW.includes(w.slice(0, 3)) ? [w.slice(0, 3)] : null;
  if (!dows) return null;
  return dows.map((d) => (typeof view.representativeDate === "function" ? view.representativeDate(d) : null)).filter(Boolean);
};

/**
 * The running times of the reference day (like_day) from A to B on the line, read in the feed before the plan when
 * there is one (and the line still has a counterpart there), else on the measured feed, each with its departure at A
 * (runs: the measure holds a trip to the reference trips of its own hour). → { min, max, count, runs: [{ at, v }],
 * word } | { error }
 */
const likeDayRunningTimes = (ctx, p, line, A, B, q, likeDay) => {
  const useBefore = Boolean(ctx.baseline && !ctx.baseline.self && p.like_in !== "after");
  const view = useBefore ? ctx.baseline.spec : ctx.spec;
  const rl = useBefore ? pairedLine(view, line) : line;
  if (!rl) return { error: `line ${line.short_name} has no counterpart in the feed before the plan` };
  if (typeof view.tripsOnDate !== "function") return { error: "a designed network has no reference day to read" };
  const dates = refDatesOf(view, likeDay);
  if (!dates) return { error: `"${likeDay}" is not a day (saturday, weekday, sunday, a weekday or a date)` };
  if (!dates.length) return { error: `no ${likeDay} date to read the running times on` };
  const runs = [];
  for (const date of dates) {
    for (const t of view.tripsOnDate(rl.id, date)) {
      if (!sameDirection(t, q)) continue;
      const i = indexIn(t, A.keys);
      const j = i < 0 ? -1 : indexIn(t, B.keys, i + 1);
      if (j < 0 || t.dep[i] == null || t.arr[j] == null) continue;
      runs.push({ at: t.dep[i], v: Math.round((t.arr[j] - t.dep[i]) / 60) });
    }
  }
  if (!runs.length) return { error: `no trip of line ${rl.short_name} from ${A.name} to ${B.name} on ${likeDay}${useBefore ? " in the feed before the plan" : ""}` };
  const values = runs.map((r) => r.v);
  return { min: Math.min(...values), max: Math.max(...values), count: values.length, runs, word: useBefore ? "before the plan" : "" };
};

const CHECKS = {
  headway_max(c, ctx) {
    const { spec } = ctx;
    const lines = linesFor(spec, c.params);
    if (!lines) return missingLine(c);
    const from = timeToSec(c.params.from || "07:00");
    const to = timeToSec(c.params.to || "09:00");
    const max = num(c.params.minutes);
    if (from == null || to == null || !(max > 0)) return result(c, "unknown", { note: "incomplete clause (day, from, to, minutes)" });
    const scope = scopeOf(c, ctx, { defaultDay: "weekday" });
    if (scope.error || scope.note) return result(c, "unknown", { expected: `every ${max} min or better, ${fmt(from)}–${fmt(to)}`, note: scope.error || scope.note });
    const limit = max * 60;
    const tally = gridTally(scope);
    let worst = null;
    const failing = [];
    // The most calls a measured trip makes at the stop (callsOfStop): read at the first when the clause names no occurrence.
    let repeated = 0;
    // A headway stated AT a stop (a desserte grid writes its band on its timing stop's row): the departures there —
    // at the call the clause means when a trip bears that name several times (occurrence), else the first (callOf).
    const atStop = str(c.params.stop?.name ?? c.params.stop) ? c.params.stop : null;
    const occurrence = atStop ? occurrenceOf(c.params) : null;
    if (occurrence?.error) return result(c, "unknown", { note: occurrence.error });
    // The direction read on each line (directionIn): the id of the one the clause names, said beside its words.
    const dirs = new Map(lines.map((l) => [l.id, directionIn([{ spec, line: l }], c.params.direction)]));
    const named = Boolean(str(c.params.line));
    const expected = `every ${max} min or better, ${fmt(from)}–${fmt(to)}${atStop ? ` at ${str(atStop?.name ?? atStop)}${occurrenceText(occurrence)}` : ""} (${scope.label}${directionLabel(c.params, named ? readDirection(dirs.get(lines[0].id)) : null)})`;
    // Said for several lines (« every line », a list): the ones that call at the stop are measured there; a line
    // that does not serve it is not the clause's — unless none does, which is then said as for one line. So is a
    // line none of whose trips go the way the clause names (unreadDirection).
    let elsewhere = null;
    let undirected = null;
    const candidates = [];
    for (const l of lines) {
      const dir = dirs.get(l.id);
      if (dir?.error) {
        if (unreadDirection(dir, named)) return result(c, "unknown", { expected, note: dir.error });
        undirected = undirected || dir;
        continue;
      }
      let at = null;
      if (atStop) {
        const stops = stopsOfClause(ctx, l, [atStop]);
        if (stops.result) {
          if (lines.length === 1) return stops.result(c);
          elsewhere = elsewhere || stops;
          continue;
        }
        [at] = stops.stops;
      }
      candidates.push({ l, dir, at });
    }
    // Nor is a line whose trips, the way the clause reads them, only end at the stop: no departure leaves from there
    // (the way back of a line to its terminus) — unless no line leaves from it.
    const leaving = candidates.filter((x) => !x.at || callKind(spec, x.l, x.at.keys, x.dir, occurrence) === "leaves");
    // Then the stop is only where the trips end (a band written on a grid's terminus row, a loop's last call): no
    // departure to measure, which is said, unknown — never a failure the network could not avoid. A line that left
    // from it before the plan is measured: the plan took its departures away, and it fails.
    if (atStop && !leaving.length && candidates.some((x) => callKind(spec, x.l, x.at.keys, x.dir, occurrence) === "ends")) {
      const base = baseSpecOf(ctx);
      const leftBefore = base && candidates.some((x) => {
        const b = pairedLine(base, x.l);
        return b && callKind(base, b, x.at.keys, x.dir, occurrence) === "leaves";
      });
      const dir = lines.length === 1 ? readDirection(dirs.get(lines[0].id)) : null;
      if (!leftBefore) return result(c, "unknown", { expected, note: terminusNote(str(atStop?.name ?? atStop), occurrence, dir) });
    }
    const targets = lines.length > 1 && leaving.length ? leaving : candidates;
    // The trips whose call at the stop is their last: they arrive there and end, which is no departure.
    const ending = new Set();
    for (const { l, dir, at } of targets) {
      const q = withDirection(c.params, dir);
      for (const point of gridOf(scope, ctx, [l])) {
        let byDirection = null;
        let directions;
        if (at) {
          const trips = tripsOf(ctx, l, point);
          if (trips === null) return result(c, "unknown", { expected: `every ${max} min or better, ${fmt(from)}–${fmt(to)} at ${at.name}`, note: "timetable not compiled" });
          const by = new Map();
          for (const t of trips) {
            if (!sameDirection(t, q)) continue;
            const i = callOf(t, at.keys, occurrence);
            if (i < 0 || t.dep[i] == null) continue;
            if (occurrence == null) repeated = Math.max(repeated, callsOfStop(t, at.keys));
            // A departure is a call the trip leaves from: at its last call it arrives (counting a terminus' arrivals,
            // the way back's, would make a 36-minute wait of a ten-minute headway) — but for a trip of a single call
            // (endsThere).
            if (endsThere(t, i)) {
              ending.add(`${l.id}|${t.id}`);
              continue;
            }
            if (!by.has(String(t.direction))) by.set(String(t.direction), []);
            by.get(String(t.direction)).push(t.dep[i]);
          }
          directions = [...by.values()].map((d) => d.sort((a, b) => a - b));
        } else {
          byDirection = point.deps(l, "headway");
          directions = directionsOf(byDirection, q);
        }
        // A day without any departure: the whole window is a wait.
        if (!directions.length) directions.push([]);
        let bad = false;
        for (const deps of directions) {
          const g = gapOf(deps, from, to);
          // Where it is measured: the stop the clause names, else a feed's trunk stop, named when the direction's trips do not all start there.
          if (!worst || g.gap > worst.gap) worst = { ...g, point, stop: at ? at.name : trunkName(spec, byDirection, deps) };
          if (g.gap > limit) bad = true;
        }
        tally.add(l, point, bad);
        if (bad && !failing.includes(l.id)) failing.push(l.id);
      }
    }
    if (!tally.count() && elsewhere) return elsewhere.result(c);
    if (!tally.count() && undirected) return result(c, "unknown", { expected, note: undirected.error });
    if (!tally.count()) return result(c, "unknown", { expected, note: "no line to measure" });
    // A wait whose whole minutes would read on the other side of the bound is said to the second: a failing
    // 10 min 08 s against « every 10 min », a passing 9 min 44 s against « every 9.75 min ».
    const exact = Boolean(worst) && (Math.round(worst.gap / 60) * 60 <= limit) !== (worst.gap <= limit);
    const measured = `${gapText(worst, from, to, { exact })}${tally.suffix()}`;
    // A failure says which call it read where the name recurs, and the trips that end at the stop it did not count.
    const stopName = str(atStop?.name ?? atStop);
    const notes = failing.length ? [repeated > 1 ? repeatedNote(stopName, repeated) : null, ending.size ? endingNote(stopName, ending.size) : null].filter(Boolean) : [];
    // The anchors: the failing lines, else the lines measured (never one the stop took out of the measure).
    return result(c, failing.length ? "fail" : "pass", { expected, measured, lines: failing.length ? failing : tally.lines(), measured_on: tally.measuredOn(), grid: tally.grid(), ...(notes.length ? { note: notes.join("; ") } : {}) });
  },

  // Every timetable must start and end within the clause's bounds (the worst
  // decides). Each bound is one-sided: first_before / last_after ask for
  // service early / late enough (a timetable without service fails them),
  // first_after / last_before forbid a departure earlier / later (a
  // timetable without service has none), amplitude_h asks the first to the
  // last departure to last that long. The bounds apply to the earliest first
  // and the latest last departure of the directions measured.
  span(c, ctx) {
    const { spec } = ctx;
    const p = c.params;
    const lines = linesFor(spec, p);
    if (!lines) return missingLine(c);
    const bound = (k) => (given(p[k]) ? timeToSec(clockText(p[k]) || p[k]) : null);
    const firstBefore = bound("first_before");
    const firstAfter = bound("first_after");
    const lastAfter = bound("last_after");
    const lastBefore = bound("last_before");
    const amplitude = num(p.amplitude_h);
    const unreadable = ["first_before", "first_after", "last_after", "last_before"].filter((k) => given(p[k]) && bound(k) == null);
    if (unreadable.length) return result(c, "unknown", { note: `incomplete clause (${unreadable.join(", ")} as HH:MM)` });
    if (given(p.amplitude_h) && !(amplitude > 0)) return result(c, "unknown", { note: "incomplete clause (amplitude_h in hours)" });
    if (firstBefore == null && firstAfter == null && lastAfter == null && lastBefore == null && amplitude == null) return result(c, "unknown", { note: "incomplete clause (day, first_before, first_after, last_after, last_before or amplitude_h)" });
    const hours = (s) => `${Math.round((s / 3600) * 10) / 10} h`;
    // The direction read on each line (directionIn), as headway_max reads it.
    const dirs = new Map(lines.map((l) => [l.id, directionIn([{ spec, line: l }], p.direction)]));
    const named = Boolean(str(p.line));
    const expected =
      [firstBefore != null ? `first ≤ ${fmt(firstBefore)}` : null, firstAfter != null ? `first ≥ ${fmt(firstAfter)}` : null, lastAfter != null ? `last ≥ ${fmt(lastAfter)}` : null, lastBefore != null ? `last ≤ ${fmt(lastBefore)}` : null, amplitude != null ? `amplitude ≥ ${hours(amplitude * 3600)}` : null].filter(Boolean).join(", ") + directionLabel(p, named ? readDirection(dirs.get(lines[0].id)) : null);
    const scope = scopeOf(c, ctx, { defaultDay: "weekday" });
    if (scope.error || scope.note) return result(c, "unknown", { expected, note: scope.error || scope.note });
    const tally = gridTally(scope);
    const failing = [];
    let worst = null;
    let undirected = null;
    const measuredLines = [];
    for (const l of lines) {
      const dir = dirs.get(l.id);
      if (dir?.error) {
        if (unreadDirection(dir, named)) return result(c, "unknown", { expected, note: dir.error });
        undirected = undirected || dir;
        continue;
      }
      const q = withDirection(p, dir);
      measuredLines.push(l.id);
      for (const point of gridOf(scope, ctx, [l])) {
        let lf = Infinity;
        let ll = -Infinity;
        for (const deps of directionsOf(point.deps(l, "span"), q)) {
          if (!deps.length) continue;
          lf = Math.min(lf, deps[0]);
          ll = Math.max(ll, deps[deps.length - 1]);
        }
        const service = Number.isFinite(lf);
        const span_ = service ? ll - lf : -Infinity;
        const bad = (firstBefore != null && !(lf <= firstBefore)) || (firstAfter != null && service && lf < firstAfter) || (lastAfter != null && !(ll >= lastAfter)) || (lastBefore != null && service && ll > lastBefore) || (amplitude != null && !(span_ >= amplitude * 3600));
        // The margin to the clause: the smallest decides which timetable is shown.
        const margins = [firstBefore != null ? firstBefore - lf : Infinity, firstAfter != null && service ? lf - firstAfter : Infinity, lastAfter != null ? ll - lastAfter : Infinity, lastBefore != null && service ? lastBefore - ll : Infinity, amplitude != null ? span_ - amplitude * 3600 : Infinity];
        const margin = Math.min(...margins);
        if (!worst || margin < worst.margin) worst = { lf, ll, point, margin };
        tally.add(l, point, bad);
        if (bad && !failing.includes(l.id)) failing.push(l.id);
      }
    }
    if (!tally.count() && undirected) return result(c, "unknown", { expected, note: undirected.error });
    if (!tally.count()) return result(c, "unknown", { expected, note: "no line to measure" });
    const measured = `${Number.isFinite(worst.lf) ? `${fmt(worst.lf)}–${fmt(worst.ll)}${amplitude != null ? ` (${hours(worst.ll - worst.lf)})` : ""}` : "no service"}${where(worst.point)}${tally.suffix()}`;
    return result(c, failing.length ? "fail" : "pass", { expected, measured, lines: failing.length ? failing : measuredLines, measured_on: tally.measuredOn(), grid: tally.grid() });
  },

  // Every timetable of the scope has a departure.
  days(c, ctx) {
    const { spec } = ctx;
    const lines = linesFor(spec, c.params);
    if (!lines) return missingLine(c);
    const scope = scopeOf(c, ctx);
    if (scope.error || scope.note) return result(c, "unknown", { note: scope.error || scope.note || "no day named" });
    const tally = gridTally(scope);
    const failing = [];
    const missing = [];
    for (const l of lines) {
      for (const point of gridOf(scope, ctx, [l])) {
        const any = [...point.deps(l, "headway").values()].some((d) => d.length);
        tally.add(l, point, !any);
        if (any) continue;
        missing.push(...(point.date ? point.dates : [point.label]));
        if (!failing.includes(l.id)) failing.push(l.id);
      }
    }
    if (!tally.count()) return result(c, "unknown", { expected: `runs on ${scope.label}`, note: "no line to measure" });
    const shown = [...new Set(missing)].sort().map((d) => (/^\d{8}$/.test(d) ? iso(d) : d));
    const more = shown.length > 3 ? ` (+${shown.length - 3} more)` : "";
    return result(c, failing.length ? "fail" : "pass", { expected: `runs on ${scope.label}`, measured: failing.length ? `no service on ${shown.slice(0, 3).join(", ")}${more}${tally.suffix()}` : `runs every listed day${tally.suffix()}`, lines: failing.length ? failing : lines.map((l) => l.id), measured_on: tally.measuredOn(), grid: tally.grid() });
  },

  // No timetable of the scope has a departure.
  no_service(c, ctx) {
    const { spec } = ctx;
    const lines = linesFor(spec, c.params);
    if (!lines) return missingLine(c);
    const scope = scopeOf(c, ctx);
    if (scope.error || scope.note) return result(c, "unknown", { note: scope.error || scope.note || "no day named" });
    const tally = gridTally(scope);
    const failing = [];
    let runs = null;
    for (const l of lines) {
      for (const point of gridOf(scope, ctx, [l])) {
        const any = [...point.deps(l, "headway").values()].some((d) => d.length);
        tally.add(l, point, any);
        if (!any) continue;
        if (!runs) runs = point;
        if (!failing.includes(l.id)) failing.push(l.id);
      }
    }
    if (!tally.count()) return result(c, "unknown", { expected: `no service on ${scope.label}`, note: "no line to measure" });
    return result(c, failing.length ? "fail" : "pass", { expected: `no service on ${scope.label}`, measured: failing.length ? `runs on a day it should not${where(runs, true)}${tally.suffix()}` : `no service${tally.suffix()}`, lines: failing, measured_on: tally.measuredOn(), grid: tally.grid() });
  },

  // ── The trip-level kinds (clauseTrips) ──────────────────────────────────

  // The scheduled time from a stop to a later one, on every trip that runs
  // them in that order (one clause is one direction): each trip, or the
  // timetable's median, within the bounds on every timetable of the scope.
  running_time(c, ctx) {
    const { spec } = ctx;
    const p = c.params;
    const need = [["line", p.line], ["from_stop", p.from_stop], ["to_stop", p.to_stop]].filter(([, v]) => !str(v?.name ?? v)).map(([k]) => k);
    if (need.length) return result(c, "unknown", { note: `incomplete clause (${need.join(", ")})` });
    const minutes = num(p.minutes);
    const tol = num(p.tolerance_min) ?? 2;
    const likeDay = given(p.like_day) ? str(p.like_day).toLowerCase() : null;
    if (minutes == null && num(p.min_minutes) == null && num(p.max_minutes) == null && !likeDay) return result(c, "unknown", { note: "incomplete clause (minutes, min_minutes, max_minutes or like_day)" });
    const l = findLine(spec, p.line);
    if (!l) return missingLine(c);
    const ends = stopsOfClause(ctx, l, [p.from_stop, p.to_stop]);
    if (ends.result) return ends.result(c);
    const [A, B] = ends.stops;
    const win = clockWindow(p);
    if (win.error) return result(c, "unknown", { note: win.error });
    const dir = directionIn([{ spec, line: l }], p.direction);
    if (dir?.error) return result(c, "unknown", { note: dir.error });
    const q = withDirection(p, dir);
    const median_ = p.measure === "median";
    // « Like Saturday »: the bounds are the reference day's own running times over the same stops (read before the
    // plan when there is a feed before: the day the brief points at is the one the network runs today), read by hour:
    // a trip is held to the reference trips leaving from_stop within an hour of it (the day's whole range when none
    // does), because a running time varies along the day and one time inside the day's range is not « like
    // Saturday » at every hour. The median is held to the day's range.
    let lo;
    let hi;
    let ref = null;
    if (likeDay) {
      ref = likeDayRunningTimes(ctx, p, l, A, B, q, likeDay);
      if (ref.error) return result(c, "unknown", { note: ref.error });
      lo = ref.min - tol;
      hi = ref.max + tol;
    } else {
      lo = minutes != null ? minutes - tol : num(p.min_minutes) ?? -Infinity;
      hi = minutes != null ? minutes + tol : num(p.max_minutes) ?? Infinity;
    }
    const boundsAt = (at) => {
      if (!ref) return { lo, hi };
      const near = ref.runs.filter((r) => Math.abs(r.at - at) <= 3600);
      const vs = (near.length ? near : ref.runs).map((r) => r.v);
      return { lo: Math.min(...vs) - tol, hi: Math.max(...vs) + tol };
    };
    const bounds = ref ? `${likeDay}'s running times at the same hour ± ${tol} min (${likeDay}${ref.word ? ` ${ref.word}` : ""}: ${ref.min}–${ref.max} min over the day, ${ref.count} trips)` : boundsText(lo, hi, " min");
    const scope = scopeOf(c, ctx, { defaultDay: "daily" });
    const expected = `${A.name} → ${B.name} in ${bounds}, ${median_ ? "median" : "each trip"}${win.text} (${scope.label || "…"}${directionLabel(p, dir)})`;
    if (scope.error || scope.note) return result(c, "unknown", { expected, note: scope.error || scope.note });
    const tally = gridTally(scope);
    const values = [];
    const noTrip = [];
    let perDay = 0;
    let worst = null;
    for (const point of gridOf(scope, ctx, [l])) {
      const trips = tripsOf(ctx, l, point);
      if (trips === null) return result(c, "unknown", { expected, note: "timetable not compiled" });
      const runs = [];
      for (const t of trips) {
        if (!sameDirection(t, q)) continue;
        const i = indexIn(t, A.keys);
        const j = i < 0 ? -1 : indexIn(t, B.keys, i + 1);
        if (j < 0 || t.dep[i] == null || t.arr[j] == null) continue;
        if (!win.has(t.dep[i])) continue;
        runs.push({ at: t.dep[i], v: Math.round((t.arr[j] - t.dep[i]) / 60) });
      }
      if (!runs.length) {
        noTrip.push(point);
        tally.add(l, point, false);
        continue;
      }
      const vs = runs.map((r) => r.v);
      const out = runs.map((r) => ({ ...r, b: boundsAt(r.at) })).filter((r) => r.v < r.b.lo || r.v > r.b.hi);
      const med = medianOf(vs);
      const bad = median_ ? med < lo || med > hi : out.length > 0;
      values.push(...vs);
      perDay = Math.max(perDay, runs.length);
      tally.add(l, point, bad);
      if (bad && !worst) worst = { point, runs, out, med, vs };
    }
    const note = noTrip.length ? `no trip on ${listText(noTrip.map((pt) => (pt.date ? iso(pt.date) : pt.label)))}` : null;
    if (!values.length) return result(c, "fail", { expected, measured: `no trip from ${A.name} to ${B.name}${tally.suffix()}`, lines: [l.id], measured_on: tally.measuredOn(), grid: tally.grid() });
    const range = (xs) => `${Math.min(...xs)}–${Math.max(...xs)} min`;
    let measured;
    if (!worst) measured = `${range(values)} (${perDay} trips)${tally.suffix()}`;
    else if (median_) measured = `median ${worst.med} min${where(worst.point, true)}, outside ${bounds}${tally.suffix()}`;
    else measured = `${range(worst.vs)}${where(worst.point, true)}: ${worst.out.length} of ${worst.runs.length} trips outside ${bounds} (${worst.out.slice(0, 3).map((r) => `${fmt(r.at)} ${r.v} min${ref ? ` (${likeDay} ${r.b.lo + tol}–${r.b.hi - tol})` : ""}`).join(", ")}${worst.out.length > 3 ? ", …" : ""})${tally.suffix()}`;
    return result(c, worst ? "fail" : "pass", { expected, measured, note, lines: [l.id], measured_on: tally.measuredOn(), grid: tally.grid() });
  },

  // Trips a day on every timetable: in each direction of the line (a
  // direction without trips counts 0), or in total.
  trips_count(c, ctx) {
    const { spec } = ctx;
    const p = c.params;
    if (!str(p.line)) return result(c, "unknown", { note: "incomplete clause (line)" });
    const exactly = num(p.exactly);
    const lo = exactly != null ? exactly : num(p.min) ?? -Infinity;
    const hi = exactly != null ? exactly : num(p.max) ?? Infinity;
    if (lo === -Infinity && hi === Infinity) return result(c, "unknown", { note: "incomplete clause (min, max or exactly)" });
    const l = findLine(spec, p.line);
    if (!l) return missingLine(c);
    // A towards written « Origin → Destination » is the direction (clauseDirection), never a stop.
    const named = stopsOfClause(ctx, l, [p.at_stop, isDirectionLabel(p.towards) ? null : p.towards].map((x) => (str(x?.name ?? x) ? x : null)));
    if (named.result) return named.result(c);
    const [at, towards] = named.stops;
    const win = clockWindow(p);
    if (win.error) return result(c, "unknown", { note: win.error });
    // Which call at_stop is when a trip bears its name several times (callOf); without it the first.
    const occurrence = at ? occurrenceOf(p) : null;
    if (occurrence?.error) return result(c, "unknown", { note: occurrence.error });
    const way = clauseDirection(spec, l, p);
    if (way.error) return result(c, "unknown", { note: way.error });
    const dir = way.dir;
    const per = p.per === "total" || p.per === "direction" ? p.per : dir || towards ? "total" : "direction";
    const dirs = countedDirections(patternsOfLine(l, spec), dir ? dir.id : null);
    const bounds = lo === hi ? `exactly ${lo}` : boundsText(lo, hi, "");
    const scope = scopeOf(c, ctx, { defaultDay: "weekday" });
    const expected = `${bounds} trips a day${per === "direction" ? " in each direction" : ""}${at ? ` at ${at.name}${occurrenceText(occurrence)}` : ""}${towards ? ` towards ${towards.name}` : ""}${win.text} (${scope.label || "…"}${directionLabel(p, dir)})`;
    if (scope.error || scope.note) return result(c, "unknown", { expected, note: scope.error || scope.note });
    // A design counts its departures without compiled tables, unless a stop or a window is named.
    const simple = spec.kind !== "feed" && !at && !towards && win.all;
    const tally = gridTally(scope);
    const all = [];
    let worst = null;
    let repeated = 0;
    for (const point of gridOf(scope, ctx, [l])) {
      const counts = new Map(dirs.map((d) => [d, 0]));
      if (simple) {
        for (const [d, deps] of point.deps(l, "span")) if (counts.has(String(d))) counts.set(String(d), deps.length);
      } else {
        const trips = tripsOf(ctx, l, point);
        if (trips === null) return result(c, "unknown", { expected, note: "timetable not compiled" });
        for (const t of trips) {
          if (dir && String(t.direction) !== dir.id) continue;
          // The call counted: the trip's origin, or its call at at_stop (towards `towards`, when given, later on).
          const i = at ? callOf(t, at.keys, occurrence) : 0;
          if (i < 0) continue;
          if (at && occurrence == null) repeated = Math.max(repeated, callsOfStop(t, at.keys));
          if (towards && indexIn(t, towards.keys, i + 1) < 0) continue;
          if (!win.has(t.dep[i])) continue;
          counts.set(String(t.direction), (counts.get(String(t.direction)) || 0) + 1);
        }
      }
      const values = per === "total" ? [["", [...counts.values()].reduce((a, b) => a + b, 0)]] : [...counts.entries()];
      const bad = values.find(([, v]) => v < lo || v > hi);
      all.push(...values.map(([, v]) => v));
      tally.add(l, point, Boolean(bad));
      if (bad && !worst) worst = { point, dir: bad[0], v: bad[1] };
    }
    if (!all.length) return result(c, "unknown", { expected, note: "no timetable to measure" });
    const unit = per === "direction" ? "a direction" : "a day";
    // Nothing counted anywhere while trips are required: the line does not run in the scope.
    const none = lo > 0 && all.every((v) => v === 0);
    const measured = none ? `no trip of line ${l.short_name || l.id} in the scope${tally.suffix()}` : worst ? `${worst.dir !== "" ? `dir ${worst.dir}: ` : ""}${worst.v}${where(worst.point, true)} (expected ${bounds})${tally.suffix()}` : `${Math.min(...all)}–${Math.max(...all)} ${unit}${tally.suffix()}`;
    return result(c, worst || none ? "fail" : "pass", { expected, measured, lines: [l.id], measured_on: tally.measuredOn(), grid: tally.grid(), ...((worst || none) && repeated > 1 ? { note: repeatedNote(at.name, repeated) } : {}) });
  },

  // A trip at each stated time at that stop (towards a stop when named), on
  // every timetable; present: false — no such trip any more.
  departure_at(c, ctx) {
    const { spec } = ctx;
    const p = c.params;
    const need = [["line", p.line], ["stop", p.stop], ["times", timesOf(p.times).join("")]].filter(([, v]) => !str(v?.name ?? v)).map(([k]) => k);
    if (need.length) return result(c, "unknown", { note: `incomplete clause (${need.join(", ")})` });
    const times = timesOf(p.times).map(clockOf);
    if (times.some((x) => x == null)) return result(c, "unknown", { note: "incomplete clause (times as HH:MM)" });
    const tol = (num(p.tolerance_min) ?? 0) * 60;
    const arrival = p.event === "arrival";
    const present = !(p.present === false || p.present === "false");
    const l = findLine(spec, p.line);
    if (!l) return missingLine(c);
    // A towards written « Origin → Destination » is the direction (clauseDirection), never a stop.
    const named = stopsOfClause(ctx, l, [p.stop, str(p.towards?.name ?? p.towards) && !isDirectionLabel(p.towards) ? p.towards : null]);
    if (named.result) return named.result(c);
    const [S, T] = named.stops;
    // Which call the stop is when a trip bears its name several times (a grid's terminus row « Centre Bourg » after
    // two villages of that name: last); without it the first (callOf).
    const occurrence = occurrenceOf(p);
    if (occurrence?.error) return result(c, "unknown", { note: occurrence.error });
    const way = clauseDirection(spec, l, p);
    if (way.error) return result(c, "unknown", { note: way.error });
    const q = withDirection(p, way.dir);
    const scope = scopeOf(c, ctx, { defaultDay: "weekday" });
    const what = `${present ? "" : "no "}${arrival ? "arrival" : "departure"}${times.length > 1 ? "s" : ""} at ${S.name}${occurrenceText(occurrence)} at ${times.map(fmt).join(", ")}${T ? ` towards ${T.name}` : ""}${tol ? ` (± ${tol / 60} min)` : ""}`;
    const expected = `${what} (${scope.label || "…"}${directionLabel(p, way.dir)})`;
    if (scope.error || scope.note) return result(c, "unknown", { expected, note: scope.error || scope.note });
    const tally = gridTally(scope);
    let problem = null;
    let repeated = 0;
    // Whether an arrival was read past a trip's origin (a loop's return), as the note on a failure says.
    let past = false;
    for (const point of gridOf(scope, ctx, [l])) {
      const trips = tripsOf(ctx, l, point);
      if (trips === null) return result(c, "unknown", { expected, note: "timetable not compiled" });
      const calls = [];
      // The arrivals of the trips that end at the stop: a time asked as a departure that is one is said so.
      const ends = [];
      for (const t of trips) {
        if (!sameDirection(t, q)) continue;
        let i = callOf(t, S.keys, occurrence);
        if (i < 0) continue;
        if (occurrence == null) repeated = Math.max(repeated, callsOfStop(t, S.keys));
        // Without an occurrence, an arrival is read where the trip first reaches the stop: past its origin on a loop
        // (it starts there and comes back), never at the origin no one arrives on.
        if (arrival && occurrence == null && startsThere(t, i)) {
          const back = indexIn(t, S.keys, i + 1);
          if (back >= 0) {
            i = back;
            past = true;
          }
        }
        // A departure is a call the trip leaves from — never its last, where it arrives and ends; an arrival, a call
        // it reaches — never its first, where it starts (a trip of a single call is both).
        if (arrival ? startsThere(t, i) : endsThere(t, i)) {
          if (!arrival && t.arr[i] != null) ends.push(Math.floor(t.arr[i] / 60) * 60);
          continue;
        }
        // A published time is to the minute: 06:38:38 departs at 06:38.
        const at = arrival ? t.arr[i] : t.dep[i];
        if (at == null) continue;
        // Towards T: T later in the trip — or, for an arrival, T itself (arriving at the terminus « towards » it).
        calls.push({ t, at: Math.floor(at / 60) * 60, ok: !T || indexIn(t, T.keys, arrival ? i : i + 1) >= 0 });
      }
      let bad = null;
      for (const x of times) {
        const near = calls.filter((k) => Math.abs(k.at - x) <= tol);
        if (present && near.some((k) => k.ok)) continue;
        if (!present) {
          if (near.some((k) => k.ok)) bad = bad || `${fmt(x)} still runs at ${S.name}${where(point, true)}`;
          continue;
        }
        if (T && near.length) {
          const at = where(point, true);
          bad = bad || `${fmt(x)} at ${S.name} goes to ${near[0].t.names[near[0].t.names.length - 1]}, not ${T.name}${at.startsWith(" on") ? `,${at}` : at}`;
          continue;
        }
        if (ends.some((y) => Math.abs(y - x) <= tol)) {
          bad = bad || `${fmt(x)} at ${S.name} is an arrival${where(point, true)}: its trip ends there, no departure`;
          continue;
        }
        const ok = calls.filter((k) => k.ok).map((k) => k.at);
        const before = ok.filter((y) => y < x).sort((a, b) => b - a)[0];
        const after = ok.filter((y) => y > x).sort((a, b) => a - b)[0];
        const nearest = [before, after].filter((y) => y != null).map(fmt);
        bad = bad || `${fmt(x)} missing at ${S.name}${where(point, true)} (${nearest.length ? `nearest ${nearest.join(", ")}` : "no trip"})`;
      }
      tally.add(l, point, Boolean(bad));
      if (bad && !problem) problem = bad;
    }
    const measured = problem ? `${problem}${tally.suffix()}` : `${present ? "" : "none at "}${times.map(fmt).join(", ")} at ${S.name}${T ? ` towards ${T.name}` : ""}${tally.suffix()}`;
    return result(c, problem ? "fail" : "pass", { expected, measured, lines: [l.id], measured_on: tally.measuredOn(), grid: tally.grid(), ...(problem && repeated > 1 ? { note: repeatedNote(S.name, repeated, past) } : {}) });
  },

  // ── The connection kind (transfer_max_wait) ──

  // A guaranteed connection at a stop: on every timetable of the scope, each
  // arrival of the feeder (a line's trips arriving there, or the external
  // arrival times the brief lists) in the window has a departure of the
  // other service (a line's trips leaving there, or the external departure
  // times) between min_wait and max_wait minutes later — or, `each:
  // "departure"`, each departure of the other service in the window has an
  // arrival of the feeder that much earlier (a bus for every TER departure:
  // not every bus has a train to catch). radius_m widens the stop to the
  // stops within that distance of it (a bus stop in front of the station). A
  // line whose guaranteed events never happen there in the scope fails; a
  // design without compiled tables cannot be measured.
  transfer_max_wait(c, ctx) {
    const { spec } = ctx;
    const p = c.params;
    const stopRef = str(p.stop?.name ?? p.stop);
    const maxWait = num(p.max_wait);
    const minWait = num(p.min_wait) ?? 0;
    const side = (lineKey, timesKey) => ({ line: str(p[lineKey]) ? str(p[lineKey]) : null, times: given(p[timesKey]) ? timesOf(p[timesKey]).map(clockOf) : null });
    const feeder = side("from_line", "from_times");
    const onward = side("to_line", "to_times");
    const need = [!stopRef && "stop", !feeder.line && !feeder.times && "from_line or from_times", !onward.line && !onward.times && "to_line or to_times", maxWait == null && "max_wait"].filter(Boolean);
    if (need.length) return result(c, "unknown", { note: `incomplete clause (${need.join(", ")})` });
    if ((feeder.line && feeder.times) || (onward.line && onward.times)) return result(c, "unknown", { note: "each side of the connection is a line or a list of times, not both" });
    if ([feeder.times, onward.times].some((t) => t && (!t.length || t.some((x) => x == null)))) return result(c, "unknown", { note: "incomplete clause (from_times / to_times as HH:MM)" });
    if (!feeder.line && !onward.line) return result(c, "unknown", { note: "nothing of the network to measure: name a line on one side at least" });
    if (!(maxWait >= 0) || minWait < 0 || minWait > maxWait) return result(c, "unknown", { note: "incomplete clause (0 ≤ min_wait ≤ max_wait, in minutes)" });
    const fromLine = feeder.line ? findLine(spec, feeder.line) : null;
    const toLine = onward.line ? findLine(spec, onward.line) : null;
    if (feeder.line && !fromLine) return result(c, "fail", { expected: `line ${feeder.line}`, measured: "no such line" });
    if (onward.line && !toLine) return result(c, "fail", { expected: `line ${onward.line}`, measured: "no such line" });
    const k = stopKeys(ctx, stopRef);
    if (!k) return result(c, "unknown", { note: `no stop named ${stopRef} in the network` });
    const keys = new Set(k.keys);
    const radius = num(p.radius_m) || 0;
    if (radius > 0) {
      const anchors = (spec.stops || []).filter((s) => k.keys.has(nameKey(s.name)) && Number.isFinite(num(s.lat)));
      for (const s of spec.stops || []) if (Number.isFinite(num(s.lat)) && anchors.some((a) => haversineMeters(a.lat, a.lon, s.lat, s.lon) <= radius)) keys.add(nameKey(s.name));
    }
    for (const l of [fromLine, toLine].filter(Boolean)) {
      const served = servedKeysOf(spec, l);
      if (![...keys].some((x) => served.has(x))) return result(c, "fail", { expected: `line ${l.short_name} at ${k.name}`, measured: `line ${l.short_name} does not serve ${k.name}${radius ? ` (nor a stop within ${radius} m)` : ""}`, lines: [l.id] });
    }
    const win = clockWindow(p);
    if (win.error) return result(c, "unknown", { note: win.error });
    // Each side's direction read on its line (directionIn), as its id.
    const fromDir = fromLine ? directionIn([{ spec, line: fromLine }], p.from_direction) : null;
    const toDir = toLine ? directionIn([{ spec, line: toLine }], p.to_direction) : null;
    const unread = [fromDir, toDir].find((d) => d?.error);
    if (unread) return result(c, "unknown", { note: unread.error });
    const scope = scopeOf(c, ctx, { defaultDay: "weekday" });
    const label = (l, times, dir) => (l ? `line ${l.short_name}${dir ? ` (direction ${dir.label})` : ""}` : `the external timetable (${times.length} time${times.length === 1 ? "" : "s"})`);
    // Which side is guaranteed: every arrival of the feeder (default), or every departure of the onward service.
    const byDeparture = p.each === "departure";
    const ofFrom = label(fromLine, feeder.times, fromDir);
    const ofTo = label(toLine, onward.times, toDir);
    const expected = `at ${k.name}${radius ? ` (or within ${radius} m)` : ""}: ${byDeparture ? `every departure of ${ofTo} has an arrival of ${ofFrom} ${minWait}–${maxWait} min before` : `every arrival of ${ofFrom} has a departure of ${ofTo} ${minWait}–${maxWait} min later`}${win.text} (${scope.label || "…"})`;
    if (scope.error || scope.note) return result(c, "unknown", { expected, note: scope.error || scope.note });
    const lines = [...new Map([fromLine, toLine].filter(Boolean).map((l) => [l.id, l])).values()];
    const lo = minWait * 60;
    const hi = maxWait * 60;
    const tally = gridTally(scope);
    const word = byDeparture ? "departure" : "arrival";
    let guarded = 0;
    let longest = null;
    let problem = null;
    for (const point of gridOf(scope, ctx, lines)) {
      const arr = fromLine ? callsAt(ctx, fromLine, point, keys, "arr", fromDir?.id ?? null) : feeder.times.map((at) => ({ at, trip: null }));
      const dep = toLine ? callsAt(ctx, toLine, point, keys, "dep", toDir?.id ?? null) : onward.times.map((at) => ({ at, trip: null }));
      if (arr === null || dep === null) return result(c, "unknown", { expected, note: "timetable not compiled" });
      const events = (byDeparture ? dep : arr).filter((e) => win.has(e.at));
      guarded += events.length;
      const missed = [];
      for (const e of events) {
        // The partner the transfer time allows, nearest first (a departure of the same trip is no connection):
        // after an arrival, the first departure at least min_wait later; before a departure, the last arrival at least min_wait earlier.
        const partner = byDeparture ? [...arr].reverse().find((a) => e.at - a.at >= lo && (!e.trip || a.trip !== e.trip)) : dep.find((d) => d.at - e.at >= lo && (!e.trip || d.trip !== e.trip));
        const wait = partner ? Math.abs(partner.at - e.at) : null;
        if (partner && wait <= hi) {
          if (!longest || wait > longest.wait) longest = { wait, e, partner, point };
        } else missed.push({ e, partner, wait });
      }
      tally.add(null, point, missed.length > 0);
      if (missed.length && !problem) {
        const shown = missed.slice(0, 3).map((x) => `${fmt(x.e.at)} ${byDeparture ? "←" : "→"} ${x.partner ? `${fmt(x.partner.at)} (${Math.round(x.wait / 60)} min)` : `no ${byDeparture ? "arrival" : "departure"}`}`).join(", ");
        problem = `${missed.length} of ${events.length} ${word}${events.length === 1 ? "" : "s"}${where(point, true)} without a connection within ${minWait}–${maxWait} min (${shown}${missed.length > 3 ? ", …" : ""})`;
      }
    }
    if (!tally.count()) return result(c, "unknown", { expected, note: "no timetable to measure" });
    if (!guarded) {
      // An external timetable with nothing in the window says nothing; a line whose guaranteed calls never happen there fails.
      const l = byDeparture ? toLine : fromLine;
      if (!l) return result(c, "unknown", { expected, note: `no ${word} time in the window` });
      return result(c, "fail", { expected, measured: `no ${word} of line ${l.short_name} at ${k.name} in the scope${win.text}${tally.suffix()}`, lines: [l.id], measured_on: tally.measuredOn(), grid: tally.grid() });
    }
    const measured = problem ? `${problem}${tally.suffix()}` : `${guarded} ${word}${guarded === 1 ? "" : "s"} connected, longest wait ${Math.round(longest.wait / 60)} min (${fmt(longest.e.at)} ${byDeparture ? "←" : "→"} ${fmt(longest.partner.at)}${where(longest.point)})${tally.suffix()}`;
    return result(c, problem ? "fail" : "pass", { expected, measured, lines: lines.map((l) => l.id), measured_on: tally.measuredOn(), grid: tally.grid() });
  },
};

module.exports = { CHECKS, gapOf, refDatesOf, likeDayRunningTimes };
