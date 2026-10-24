/**
 * The checks that compare the network measured with a reference: same_as, changed_in_scope and unchanged_except.
 * The reference is the feed before the plan (ctx.baseline); without one they are unknown.
 */

"use strict";

const { nameKey } = require("../../network/feedText");
const { tripsOf, stopKeys, indexIn, passings, sharedStopIds, multisetDiff } = require("../clauseTrips");
const { str, num, fmt, iso, given, listOf, timesOf, clockOf, listText } = require("../values");
const { result } = require("../result");
const { DAY_S } = require("../../../utils/time");
const { daysOf, dowOfYmd, parseYmd, dayWordsOf, dayLabel, scopeOf, gridOf, gridTally, clockWindow, serviceDayEnd, weekDay, weekDates } = require("../calendar");
const { findLine, pairedLine, directionLabel, patternsOfLine, sameDirection, directionIn, withDirection, readDirection, unreadDirection, linesOfClause } = require("../locate");


// The trip operators match a time given within ± 60 s (transform/selection.js).
const OPERATOR_MINUTE_S = 60;

/**
 * Whether `to` itself is in the window. Unless the clause says it (to_included), both readings are measured and a
 * verdict holding under one only becomes a question (boundNote): « de 7h à 9h » says nothing of a departure at 9h00.
 */
const boundReadings = ({ from, to, toIncluded, beyond }) => {
  if (to == null || !Number.isFinite(to)) return [true];
  if (toIncluded === true) return [true];
  if (toIncluded === false) return [false];
  // A one-minute window names a departure (« la course de 7h15 »). A window closed by the end of service (no trip
  // leaves after `to` in either feed) holds the day's last departure at `to`.
  if (from != null && from === to) return [true];
  if (beyond === false) return [true];
  return [true, false];
};
const boundNote = (to) => `the verdict depends on whether a departure at ${fmt(to)}, the window's end, is within the window: the brief does not say (to_included)`;

/**
 * The feed a same_as clause reads its reference day in: `like_in` "before" or "after"; by default the feed before when
 * the lines run on the reference date in it, else the feed measured.
 *   → { spec (null: the measured one), word, baseline } | { error }
 */
const refSide = (ctx, p, lines, refDates) => {
  const base = ctx.baseline;
  const before = () => ({ spec: base.self ? null : base.spec, word: "before", baseline: "before" });
  if (p.like_in === "before") return base ? before() : { error: "compares with the feed before the plan: none here" };
  if (p.like_in === "after" || !base) return { spec: null, word: "after", baseline: "self" };
  const runs = lines.some((l) => {
    const bl = pairedLine(base.spec, l);
    return bl && refDates.some((d) => base.spec.tripsOnDate(bl.id, d).length);
  });
  return runs ? before() : { spec: null, word: "after", baseline: "self" };
};

const timetableTrips = (ctx, line, point, date) => (point ? tripsOf(ctx, line, point) : ctx.spec.tripsOnDate(line.id, date));

const sameTrip = (x, y, tol) => x.direction === y.direction && x.keys.length === y.keys.length && x.keys.every((k, i) => k === y.keys[i]) && x.dep.length === y.dep.length && x.dep.every((v, i) => (v == null ? y.dep[i] == null : y.dep[i] != null && Math.abs(v - y.dep[i]) <= tol));

/** Compared as multisets, bucketed by direction and stops. */
const diffTrips = (a, b, tol) => {
  const bucket = (t) => `${t.direction}|${t.keys.join(">")}`;
  const pool = new Map();
  for (const t of b) pool.set(bucket(t), [...(pool.get(bucket(t)) || []), t]);
  const missing = [];
  for (const t of a) {
    const list = pool.get(bucket(t)) || [];
    const i = list.findIndex((y) => sameTrip(t, y, tol));
    if (i >= 0) list.splice(i, 1);
    else missing.push(t);
  }
  return { missing, extra: [...pool.values()].flat() };
};

/**
 * The lines named, or every line of either feed (by id, then by short name), less `except.lines`, paired between the
 * feed measured and the feed before. A named line is paired by its id (pairedLine): a renumbered line keeps its route
 * id, so « la ligne R devient la ligne 5 » is measured on line 5 against line R.
 *   → { list: [{ after, before, name }], label } | { error }
 */
const linePairs = (after, before, p) => {
  const names = [...new Set([...listOf(p.lines), ...listOf(p.line)])];
  // Read as findLine reads them: a label the engine's question offered names its line too.
  const exclude = listOf(p.except?.lines);
  const excluded = (l) => l && exclude.some((n) => findLine({ lines: [l] }, n) === l);
  let list;
  if (names.length) {
    list = names.map((n) => {
      const a = findLine(after, n);
      return { after: a, before: a ? pairedLine(before, a) : findLine(before, n), name: n };
    });
    const none = list.find((x) => !x.after && !x.before);
    if (none) return { error: `no line ${none.name} in the feed before or after the plan` };
  } else {
    const left = new Map((before.lines || []).map((l) => [l.id, l]));
    list = (after.lines || []).map((l) => {
      const b = left.get(l.id) || null;
      if (b) left.delete(l.id);
      return { after: l, before: b, name: l.short_name };
    });
    for (const x of list) {
      if (x.before) continue;
      const b = [...left.values()].find((y) => nameKey(y.short_name) === nameKey(x.after.short_name));
      if (b) {
        x.before = b;
        left.delete(b.id);
      }
    }
    for (const b of left.values()) list.push({ after: null, before: b, name: b.short_name });
  }
  list = list.filter((x) => !excluded(x.after) && !excluded(x.before));
  const label = names.length === 1 ? `line ${names[0]}` : names.length ? `lines ${names.join(", ")}` : exclude.length ? `every line but ${listOf(p.except.lines).join(", ")}` : "every line";
  return { list, label };
};

/**
 * The scopes of except.trips, departures as spans of seconds (win.spans), read as the operators read them:
 *   - a window `to` holds its whole minute, and one ending before it starts runs past midnight (« 23:00–01:00 » ends
 *     at 25:00, as remove_trips and shift_trips read it);
 *   - each of `times` within the operators' ± 60 s, never the span between them, which would hold a trip left
 *     between two; `tolerance_min` widens either.
 * A named period comes resolved by the caller (ctx.periods["<clause id>#trips<k>"]); one that could not be leaves the
 * scope out on its every date (more left out, never collateral measured as a change), said in `notes`.
 */
const tripScopesOf = (c, ctx) => {
  const list = Array.isArray(c.params?.except?.trips) ? c.params.except.trips : [];
  const parts = [];
  const notes = [];
  for (const [k, raw] of list.entries()) {
    const x = raw && typeof raw === "object" ? raw : {};
    // Never named by the operation's id (`op`): the person reading the verdict never sees it.
    const label = `#${k + 1} (${linesText(listOf(x.lines))})`;
    const bad = (what) => ({ error: `incomplete clause (except.trips ${label}: ${what})` });
    const days = given(x.days) ? new Set(daysOf(x.days, ctx.spec)) : null;
    if (days && !days.size) return bad(`no day named in "${listOf(x.days).join(", ")}"`);
    const [from, to] = ["from_date", "to_date"].map((key) => (given(x[key]) ? parseYmd(x[key]) : null));
    for (const [key, v] of [["from_date", from], ["to_date", to]]) if (given(x[key]) && !v) return bad(`${key} "${x[key]}" is not a date (YYYY-MM-DD)`);
    let dates = null;
    if (given(x.dates)) {
      dates = new Set((Array.isArray(x.dates) ? x.dates : String(x.dates).split(/[\s,;]+/).filter(Boolean)).map(parseYmd));
      if (dates.has(null)) return bad("dates as YYYY-MM-DD");
    }
    let period = null;
    if (given(x.period)) {
      const r = ctx.periods?.[`${c.id}#trips${k}`];
      if (r && !r.error) period = r.dates instanceof Set ? r.dates : new Set(r.dates || []);
      else notes.push(`the period "${str(x.period)}" of ${label} could not be resolved${r?.error ? ` (${r.error})` : ""}: its trips are left out on every date of its days`);
    }
    const [wFrom, wTo] = ["from", "to"].map((key) => (given(x[key]) ? clockOf(x[key]) : null));
    if ((given(x.from) && wFrom == null) || (given(x.to) && wTo == null)) return bad("from / to as HH:MM");
    const times = given(x.times) ? [...new Set(timesOf(x.times).map(clockOf))].sort((u, v) => u - v) : null;
    if (times && (!times.length || times.includes(null))) return bad("times as HH:MM");
    const minutes = given(x.tolerance_min) ? num(x.tolerance_min) : null;
    if (given(x.tolerance_min) && !(minutes >= 0)) return bad("tolerance_min in minutes");
    const tol = minutes != null ? minutes * 60 : times ? OPERATOR_MINUTE_S : 0;
    let spans = null;
    if (times) spans = times.map((t) => ({ from: t - tol, to: t + tol }));
    else if (wFrom != null || wTo != null) {
      spans = [{ from: wFrom == null ? -Infinity : wFrom - tol, to: wTo == null ? Infinity : serviceDayEnd(wFrom, wTo) + Math.max(59, tol) }];
    }
    const win = spans ? { spans, from: wFrom, to: wTo, times } : null;
    parts.push({ label, lines: listOf(x.lines), direction: given(x.direction) ? x.direction : null, days, from, to, dates, period, win, at: str(x.at_stop?.name ?? x.at_stop) || null, raw: x });
  }
  return { parts, notes };
};

const linesText = (lines) => (lines.length ? `line${lines.length === 1 ? "" : "s"} ${lines.join(", ")}` : "every line");
/** By what the scope holds, never by the id of the operation it comes from (the engine's, never shown). */
const tripScopeText = (x, spec) => {
  const when = !x.win ? null : x.win.times ? listText(x.win.times.map(fmt), 6) : `${x.win.from != null ? fmt(x.win.from) : "…"}–${x.win.to != null ? fmt(x.win.to) : "…"}`;
  const window = when ? `${x.at ? `at ${x.at}` : "leaving"} ${when}` : "all day";
  const bits = [
    x.direction != null ? `direction ${str(x.direction)}` : null,
    x.days ? dayLabel(x.days, spec) : null,
    x.from || x.to ? `${x.from ? iso(x.from) : "…"} → ${x.to ? iso(x.to) : "…"}` : null,
    x.dates ? `${x.dates.size} date${x.dates.size === 1 ? "" : "s"}` : null,
    given(x.raw.period) ? str(x.raw.period) : null,
    window,
  ].filter(Boolean);
  return `${linesText(x.lines)} (${bits.join(", ")})`;
};

/**
 * "0" not in the scope's dates; "1" in them, its weekday or day type one of the scope's days; "2" in them, but only a
 * trip's service may make it one: a Saturday service added on a holiday weekday runs as a Saturday
 * (transform/scope.dayTypeOf), and taking the Saturdays away takes it there too.
 */
const scopeOnDate = (x, d, spec, before) => {
  if ((x.from && d < x.from) || (x.to && d > x.to) || (x.dates && !x.dates.has(d)) || (x.period && !x.period.has(d))) return "0";
  if (!x.days || x.days.has(dowOfYmd(d))) return "1";
  return [spec, before].some((s) => x.days.has(s.dateTypeOf(d))) ? "1" : "2";
};

/** Bit "2" (scopeOnDate): the day is its service's own day type, in the feed it runs in. */
const scopeTakes = (x, bit, t, d, feed) => (x.dir == null || String(t.direction) === x.dir) && (bit !== "2" || (typeof feed.dayTypeOn === "function" && x.days.has(feed.dayTypeOn(t.service_id, d))));
/** At the scope's stop when it names one (null: the trip does not call there), else at its origin. */
const departureIn = (x, t) => {
  if (!x.atKeys) return t.first;
  const i = indexIn(t, x.atKeys);
  return i < 0 ? null : t.dep[i] ?? t.arr[i];
};
const scopeHolds = (x, bit, t, d, feed) => {
  if (!scopeTakes(x, bit, t, d, feed)) return false;
  if (!x.win) return true;
  const at = departureIn(x, t);
  return at != null && x.win.spans.some((s) => at >= s.from && at <= s.to);
};
/**
 * A span before midnight at which no trip of the scope leaves in either feed, while one leaves 24 h later, is read
 * past midnight, as the operators read « 00:30 » as 24:30; held literally, the trip the operation withdrew or added
 * there would count as the rest of the day's.
 */
const scopeOnDay = (x, bit, d, sides) => {
  if (!x.win) return x;
  const deps = sides.flatMap(([feed, trips]) => trips.filter((t) => scopeTakes(x, bit, t, d, feed)).map((t) => departureIn(x, t))).filter((v) => v != null);
  const leaves = (s) => deps.some((v) => v >= s.from && v <= s.to);
  let late = false;
  const spans = x.win.spans.map((s) => {
    if (!Number.isFinite(s.from) || !Number.isFinite(s.to) || s.to >= DAY_S || leaves(s)) return s;
    const next = { from: s.from + DAY_S, to: s.to + DAY_S };
    if (!leaves(next)) return s;
    late = true;
    return next;
  });
  return late ? { ...x, win: { ...x.win, spans } } : x;
};

const CHECKS = {
  same_as(c, ctx) {
    const { spec } = ctx;
    const p = c.params;
    const likeDate = given(p.like_date) ? parseYmd(p.like_date) : null;
    const likeWeek = given(p.like_week) ? parseYmd(p.like_week) : null;
    if (!likeDate && !likeWeek) return result(c, "unknown", { note: given(p.like_date) || given(p.like_week) ? `"${p.like_date || p.like_week}" is not a date (YYYY-MM-DD)` : "incomplete clause (like_date or like_week)" });
    if (!given(dayWordsOf(p)) && !["dates", "from_date", "to_date", "period"].some((k) => given(p[k]))) return result(c, "unknown", { note: "say when the timetable must be the same (a day, dates or a period)" });
    const lines = linesOfClause(spec, p);
    if (lines.missing) return result(c, "fail", { expected: `line ${lines.missing}`, measured: "no such line" });
    const scope = scopeOf(c, ctx);
    const refOf = (d) => (likeDate || (d ? weekDay(likeWeek, dowOfYmd(d)) : null));
    const refText = likeDate ? iso(likeDate) : `the week of ${iso(likeWeek)}`;
    const side = refSide(ctx, p, lines.list, likeDate ? [likeDate] : weekDates(likeWeek));
    if (side.error) return result(c, "unknown", { note: side.error });
    const sideWord = ` (${side.word})`;
    const refSpec = side.spec || spec;
    // The direction read on each line and on its reference (directionIn): the lines named are held to it.
    const named = listOf(p.lines).length + listOf(p.line).length > 0;
    const dirs = new Map(lines.list.map((l) => [l.id, directionIn([{ spec, line: l }, ...(side.spec ? [{ spec: refSpec, line: pairedLine(refSpec, l) }] : [])], p.direction)]));
    const expected = `${lines.label}: the same trips as ${refText}${sideWord} (${scope.label || "…"}${directionLabel(p, lines.list.length === 1 ? readDirection(dirs.get(lines.list[0].id)) : null)})`;
    if (scope.error || scope.note) return result(c, "unknown", { expected, note: scope.error || scope.note });
    const refCtx = side.spec ? { spec: side.spec } : ctx;
    const win = clockWindow(p);
    if (win.error) return result(c, "unknown", { expected, note: win.error });
    const tolS = (num(p.tolerance_min) ?? 0) * 60;
    const tally = gridTally(scope);
    let problem = null;
    let shownRef = null;
    let missingRef = null;
    let undirected = null;
    const measuredLines = [];
    for (const l of lines.list) {
      const dir = dirs.get(l.id);
      if (dir?.error) {
        if (unreadDirection(dir, named)) return result(c, "unknown", { expected, note: dir.error });
        undirected = undirected || dir;
        continue;
      }
      const q = withDirection(p, dir);
      measuredLines.push(l.id);
      const refLine = side.spec ? pairedLine(refSpec, l) : l;
      for (const point of gridOf(scope, ctx, [l], { splitBy: likeWeek ? dowOfYmd : null })) {
        const r = refOf(point.date);
        const v = refSpec.validity;
        if (v && (r < v.start || r > v.end)) return result(c, "unknown", { expected, note: `the reference date ${iso(r)} is outside the validity of the feed ${side.word || ""} (${iso(v.start)} → ${iso(v.end)})`.replace("  ", " ") });
        const mine = timetableTrips(ctx, l, point, null);
        const theirs = refLine ? timetableTrips(refCtx, refLine, null, r) : [];
        // No reference trip: this timetable cannot be compared (a failure elsewhere still decides).
        if (!theirs || !theirs.length) {
          missingRef = missingRef || `nothing to compare with: line ${l.short_name} has no trip on ${iso(r)}`;
          continue;
        }
        const keep = (t) => sameDirection(t, q) && win.has(t.first);
        const a = theirs.filter(keep);
        const b = (mine || []).filter(keep);
        const diff = diffTrips(a, b, tolS);
        const bad = diff.missing.length > 0 || diff.extra.length > 0;
        tally.add(l, point, bad);
        if (!shownRef) shownRef = r;
        if (bad && !problem) {
          const firstOf = (xs) => (xs.length ? fmt(Math.min(...xs.map((t) => t.first))) : "none");
          const sample = diff.missing.slice(0, 3).map((t) => fmt(t.first)).join(", ");
          problem = `${lines.list.length > 1 ? `line ${l.short_name} ` : ""}${point.date ? `on ${iso(point.date)}` : `(${point.label})`}: ${b.length} trips vs ${a.length} on ${iso(r)}${sideWord}; first departure ${firstOf(b)} vs ${firstOf(a)}; ${diff.missing.length} missing${diff.missing.length ? ` (${sample}${diff.missing.length > 3 ? ", …" : ""})` : ""}, ${diff.extra.length} extra`;
        }
      }
    }
    if (!problem && missingRef) return result(c, "unknown", { expected, note: missingRef, baseline: side.baseline });
    if (!tally.count() && undirected) return result(c, "unknown", { expected, note: undirected.error });
    if (!tally.count()) return result(c, "unknown", { expected, note: "no line to measure" });
    const measured = problem ? `${problem}${tally.suffix()}` : `same trips as ${likeDate ? iso(likeDate) : iso(shownRef)}${sideWord}${tally.suffix()}`;
    return result(c, problem ? "fail" : "pass", { expected, measured, lines: measuredLines, measured_on: tally.measuredOn(), grid: tally.grid(), baseline: side.baseline });
  },

  // The mirror of unchanged_except, on the same reading of lines, dates, directions and passings: measured on the
  // scope's first date only (a witness date).
  changed_in_scope(c, ctx) {
    const { spec } = ctx;
    const p = c.params;
    if (!ctx.baseline) return result(c, "unknown", { note: "compares with the feed before the plan: none here" });
    if (!listOf(p.lines).length && !str(p.line)) return result(c, "unknown", { note: "a change test names its lines" });
    if (ctx.baseline.self) return result(c, "fail", { expected: "changed compared with the feed before the plan", measured: "the feed before the plan (reference): nothing changed", baseline: "before" });
    const before = ctx.baseline.spec;
    const pairs = linePairs(spec, before, p);
    if (pairs.error) return result(c, "unknown", { note: pairs.error });
    const [wFrom, wTo] = ["from", "to"].map((key) => (given(p[key]) ? clockOf(p[key]) : null));
    if ((given(p.from) && wFrom == null) || (given(p.to) && wTo == null)) return result(c, "unknown", { note: "incomplete clause (from / to as HH:MM)" });
    let only = null;
    for (const ref of listOf(p.stops)) {
      const k = stopKeys(ctx, ref) || stopKeys({ spec: before }, ref);
      if (!k) return result(c, "unknown", { note: `no stop named ${ref} in the network` });
      only = only || new Set();
      k.keys.forEach((x) => only.add(x));
    }
    const bv = before.validity;
    const av = spec.validity;
    const inter = bv && av ? { start: bv.start > av.start ? bv.start : av.start, end: bv.end < av.end ? bv.end : av.end } : av;
    const scope = scopeOf(c, ctx, { everyDate: true, validity: inter });
    if (scope.error || scope.note) return result(c, "unknown", { note: scope.error || scope.note, baseline: "before" });
    const witness = scope.dates[0];
    const shared = sharedStopIds(spec, before);
    const readOn = (pair, value) => directionIn([{ spec, line: pair.after }, { spec: before, line: pair.before }], value);
    const one = pairs.list.length === 1 ? pairs.list[0] : null;
    const what = [
      given(p.direction) ? ` (direction ${readDirection(one ? readOn(one, p.direction) : null)?.label || str(p.direction)})` : "",
      wFrom != null || wTo != null ? `, within ${wFrom != null ? fmt(wFrom) : "…"}–${wTo != null ? fmt(wTo) : "…"}` : "",
      only ? `, at ${listOf(p.stops).join(", ")}` : "",
    ].join("");
    const expected = `${pairs.label} changed compared with the feed before the plan on ${iso(witness)} (${scope.label || "the scope"})${what}`;
    // A call within the window, not a departure from the origin: a departure named at a stop (« la course de 7h15 »)
    // is read at that stop.
    const inWindow = (toIn) => (t) => (wFrom == null && wTo == null) || (t.dep || []).some((s) => (wFrom == null || s >= wFrom) && (wTo == null || (toIn ? s <= wTo + 59 : s < wTo)));
    const measure = (toIn) => {
      const unchanged = [];
      let compared = 0;
      for (const pair of pairs.list) {
        const { after: a, before: b, name } = pair;
        const own = readOn(pair, p.direction);
        if (unreadDirection(own, true)) return { unknown: own.error };
        if (own?.error) continue;
        const keep = (t) => sameDirection(t, withDirection(p, own)) && inWindow(toIn)(t);
        const names = new Map();
        const pb = passings((b ? before.tripsOnDate(b.id, witness) : []).filter(keep), { only, ids: shared }, names);
        const pa = passings((a ? spec.tripsOnDate(a.id, witness) : []).filter(keep), { only, ids: shared }, names);
        compared += 1;
        const diff = multisetDiff(pb, pa);
        if (!diff.missing.length && !diff.extra.length) unchanged.push(`${name} (${pa.length} passing${pa.length === 1 ? "" : "s"} as before)`);
      }
      return { unchanged, compared };
    };
    const beyondEnd = wTo == null ? false : pairs.list.some((pair) => {
      const own = readOn(pair, p.direction);
      if (own?.error) return false;
      const trips = [...(pair.before ? before.tripsOnDate(pair.before.id, witness) : []), ...(pair.after ? spec.tripsOnDate(pair.after.id, witness) : [])];
      return trips.some((t) => sameDirection(t, withDirection(p, own)) && t.first > wTo + 59);
    });
    const readings = boundReadings({ from: wFrom, to: wTo, toIncluded: p.to_included, beyond: beyondEnd }).map(measure);
    const [m] = readings;
    if (m.unknown) return result(c, "unknown", { expected, note: m.unknown, baseline: "before" });
    if (readings.length === 2 && !readings[1].unknown && (m.unchanged.length > 0) !== (readings[1].unchanged.length > 0)) return result(c, "unknown", { expected, note: boundNote(wTo), baseline: "before" });
    if (!m.compared) return result(c, "unknown", { expected, note: "no trip of these lines goes the clause's way in either feed", baseline: "before" });
    if (m.unchanged.length) return result(c, "fail", { expected, measured: `unchanged on ${iso(witness)}: ${m.unchanged.join(", ")}`, lines: pairs.list.map((x) => (x.after || x.before)?.id).filter(Boolean), baseline: "before" });
    return result(c, "pass", { expected, measured: `changed on ${iso(witness)}`, lines: pairs.list.map((x) => (x.after || x.before)?.id).filter(Boolean), baseline: "before" });
  },
  unchanged_except(c, ctx) {
    const { spec } = ctx;
    const p = c.params;
    if (!ctx.baseline) return result(c, "unknown", { note: "compares with the feed before the plan: none here" });
    if (ctx.baseline.self) return result(c, "pass", { expected: "unchanged", measured: "the feed before the plan (reference)", baseline: "before" });
    const ex = p.except && typeof p.except === "object" ? p.except : {};
    // except.direction is read on each line below.
    const carve = { from: given(ex.from) ? clockOf(ex.from) : null, to: given(ex.to) ? clockOf(ex.to) : null, direction: null, stops: null, ids: null };
    if ((given(ex.from) && carve.from == null) || (given(ex.to) && carve.to == null)) return result(c, "unknown", { note: "incomplete clause (except.from / except.to as HH:MM)" });
    carve.to = serviceDayEnd(carve.from, carve.to);
    const scopes = tripScopesOf(c, ctx);
    if (scopes.error) return result(c, "unknown", { note: scopes.error });
    // to_included false: a trip leaving at `to` itself stays compared.
    if (carve.to != null && ex.to_included === false) carve.to -= 1;
    if (carve.from != null && carve.to == null) carve.to = Infinity;
    if (carve.to != null && carve.from == null) carve.from = -Infinity;
    const exStops = listOf(ex.stops);
    if (exStops.length) {
      carve.stops = new Set();
      for (const ref of exStops) {
        const k = stopKeys(ctx, ref) || stopKeys({ spec: ctx.baseline.spec }, ref);
        if (!k) return result(c, "unknown", { note: `no stop named ${ref} in the network` });
        k.keys.forEach((x) => carve.stops.add(x));
      }
    }
    const before = ctx.baseline.spec;
    carve.ids = sharedStopIds(spec, before);
    const pairs = linePairs(spec, before, p);
    if (pairs.error) return result(c, "unknown", { note: pairs.error });
    // except.beyond leaves out the passings past `stop` towards `towards`: a truncation names the stop the trips now
    // end at, not every stop they no longer reach.
    const beyond = ex.beyond && typeof ex.beyond === "object" ? ex.beyond : null;
    if (beyond) {
      const at = stopKeys({ spec: before }, beyond.stop);
      const towards = stopKeys({ spec: before }, beyond.towards);
      if (!at || !towards) return result(c, "unknown", { note: `no stop named ${!at ? str(beyond.stop) : str(beyond.towards)} in the feed before the plan (except.beyond)` });
      carve.stops = carve.stops || new Set();
      const names = new Map((before.stops || []).map((s) => [s.id, s.name]));
      for (const { before: b } of pairs.list) {
        if (!b) continue;
        for (const pattern of patternsOfLine(b, before)) {
          const keys = (pattern.stops || []).map((id) => nameKey(names.get(id) || id));
          const i = keys.findIndex((k) => at.keys.has(k));
          const j = keys.findIndex((k) => towards.keys.has(k));
          if (i < 0 || j < 0 || i === j) continue;
          (j > i ? keys.slice(i + 1) : keys.slice(0, i)).forEach((k) => carve.stops.add(k));
        }
      }
      // The stop the trips are cut at stays compared (its passings must keep their times).
      at.keys.forEach((k) => carve.stops.delete(k));
    }
    const bv = before.validity;
    const av = spec.validity;
    // Every date either feed covers: a date the plan took out of the validity is compared, never skipped.
    const covers = bv && av ? { start: bv.start < av.start ? bv.start : av.start, end: bv.end > av.end ? bv.end : av.end } : av;
    const scope = scopeOf(c, ctx, { everyDate: true, validity: covers });
    // Read in both feeds: a line the plan rebuilt still goes where it went.
    const readOn = (pair, value) => directionIn([{ spec, line: pair.after }, { spec: before, line: pair.before }], value);
    const one = pairs.list.length === 1 ? pairs.list[0] : null;
    const exDirection = given(ex.direction) ? readDirection(one ? readOn(one, ex.direction) : null)?.label || str(ex.direction) : null;
    const exceptText = [
      listOf(ex.lines).length && (listOf(p.lines).length || listOf(p.line).length) ? `lines ${listOf(ex.lines).join(", ")}` : null,
      carve.from != null || carve.to != null ? `trips leaving ${Number.isFinite(carve.from) ? fmt(carve.from) : "…"}–${Number.isFinite(carve.to) ? fmt(ex.to_included === false ? carve.to + 1 : carve.to) : "…"} (${ex.to_included === false ? "the end excluded" : ex.to_included === true || !Number.isFinite(carve.to) ? "bounds included" : "the end read both ways"})${exDirection != null ? `, direction ${exDirection}` : ""}` : exDirection != null ? `trips in direction ${exDirection}` : null,
      exStops.length ? `passings at ${exStops.join(", ")}` : null,
      beyond ? `passings past ${str(beyond.stop)} towards ${str(beyond.towards)}` : null,
      scopes.parts.length ? `the trips of ${listText(scopes.parts.map((x) => tripScopeText(x, spec)))}` : null,
    ]
      .filter(Boolean)
      .join("; ");
    const expected = `${pairs.label} unchanged compared with the feed before the plan${exceptText ? `, except ${exceptText}` : ""} (${scope.label || "every date"}${directionLabel(p, one ? readDirection(readOn(one, p.direction)) : null)})`;
    // Nothing left to compare is never a pass (except.lines naming every line in scope).
    if (!pairs.list.length) return result(c, "unknown", { expected, note: "no line left to compare (every line named is excepted)", baseline: "before" });
    if (scope.error || scope.note) return result(c, "unknown", { expected, note: scope.error || scope.note, baseline: "before" });
    // A date past the feed before's validity (a plan that extended it) is compared with the latest date of the same
    // weekday and scope the feed before covers (a school Monday with a school Monday); none stays unknown.
    const outside = bv ? scope.dates.filter((d) => d < bv.start || d > bv.end) : [];
    const likeOf = new Map();
    if (outside.length) {
      const { from_date: _from, to_date: _to, dates: _dates, ...rest } = p; // eslint-disable-line no-unused-vars
      const covered = scopeOf({ ...c, params: rest }, { ...ctx, today: null }, { everyDate: true, validity: bv });
      const span = `${iso(outside[0])} → ${iso(outside[outside.length - 1])}`;
      if (covered.error || covered.note) return result(c, "unknown", { expected, note: `the feed before does not cover ${span} (${covered.error || covered.note})`, baseline: "before" });
      for (const d of outside) {
        const like = covered.dates.filter((x) => dowOfYmd(x) === dowOfYmd(d)).at(-1);
        if (!like) return result(c, "unknown", { expected, note: `the feed before does not cover ${span} and ran no ${dowOfYmd(d)} of this scope`, baseline: "before" });
        likeOf.set(d, like);
      }
    }
    const tally = gridTally(scope);
    const failing = [];
    let problem = null;
    let undirected = null;
    let boundAmbiguous = null;
    const named = listOf(p.lines).length + listOf(p.line).length > 0;
    for (const pair of pairs.list) {
      const { after: a, before: b, name } = pair;
      // The clause's own direction (only its trips are compared) and except's (its trips are left out).
      const own = readOn(pair, p.direction);
      const out = readOn(pair, ex.direction);
      const unread = [own, out].find((d) => unreadDirection(d, named));
      if (unread) return result(c, "unknown", { expected, note: unread.error, baseline: "before" });
      // A line none of whose trips go the clause's way has nothing to compare, one none go except's way nothing to
      // leave out.
      if (own?.error) {
        undirected = undirected || own;
        continue;
      }
      const keep = (t) => sameDirection(t, withDirection(p, own));
      const lineCarve = out?.error ? { ...carve, from: null, to: null } : { ...carve, direction: out ? out.id : null };
      const here = [];
      for (const x of scopes.parts) {
        if (x.lines.length && !x.lines.some((n) => [a, b].some((l) => l && findLine({ lines: [l] }, n) === l))) continue;
        const dir = readOn(pair, x.direction);
        if (dir?.error) {
          if (x.lines.length || !dir.none) return result(c, "unknown", { expected, note: `except.trips ${x.label}: ${dir.error}`, baseline: "before" });
          continue;
        }
        const atKeys = x.at ? new Set([...(stopKeys(ctx, x.at)?.keys || []), ...(stopKeys({ spec: before }, x.at)?.keys || [])]) : null;
        if (atKeys && !atKeys.size) return result(c, "unknown", { expected, note: `except.trips ${x.label}: no stop named ${x.at} in the network`, baseline: "before" });
        here.push({ ...x, dir: dir ? dir.id : null, atKeys });
      }
      if (a && b && typeof spec.fingerprintOf === "function" && typeof before.fingerprintOf === "function" && spec.fingerprintOf(a.id) === before.fingerprintOf(b.id)) {
        for (const point of gridOf(scope, ctx, [a])) tally.add(a, point, false);
        continue;
      }
      // Dates compared once per timetable of both feeds and per the scopes they fall in.
      const onDate = (d) => here.map((x) => scopeOnDate(x, d, spec, before)).join("");
      const groups = new Map();
      for (const d of scope.dates) {
        const like = likeOf.get(d) || null;
        const key = `${like ? `~${b ? before.dateSignature(like, [b]) : ""}` : b ? before.dateSignature(d, [b]) : ""}#${a ? spec.dateSignature(d, [a]) : ""}#${onDate(d)}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(d);
      }
      const bad = [];
      for (const dates of groups.values()) {
        const d = dates[0];
        const bits = onDate(d);
        const like = likeOf.get(d) || null;
        const tb = b ? before.tripsOnDate(b.id, like || d) : [];
        const ta = a ? spec.tripsOnDate(a.id, d) : [];
        const on = here.map((x, i) => (bits[i] === "0" ? null : scopeOnDay(x, bits[i], d, [[before, tb], [spec, ta]])));
        const kept = (feed, trips) => trips.filter((t) => keep(t) && !on.some((x, i) => x && scopeHolds(x, bits[i], t, d, feed)));
        const names = new Map();
        const pb = passings(kept(before, tb), lineCarve, names);
        const pa = passings(kept(spec, ta), lineCarve, names);
        const diff = multisetDiff(pb, pa);
        const changed = diff.missing.length > 0 || diff.extra.length > 0;
        // A verdict that differs when a departure at `to` is left in the comparison is a question (boundReadings).
        const beyond = Number.isFinite(lineCarve.to) && [...kept(before, tb), ...kept(spec, ta)].some((t) => (lineCarve.direction == null || String(t.direction) === String(lineCarve.direction)) && t.first > lineCarve.to);
        if (boundReadings({ from: lineCarve.from, to: lineCarve.to, toIncluded: ex.to_included, beyond }).length === 2) {
          const strict = { ...lineCarve, to: lineCarve.to - 1 };
          const diffX = multisetDiff(passings(kept(before, tb), strict), passings(kept(spec, ta), strict));
          if ((diffX.missing.length > 0 || diffX.extra.length > 0) !== changed) boundAmbiguous = boundAmbiguous || lineCarve.to;
        }
        tally.add(a || b, { date: d, dates }, changed);
        if (changed) bad.push({ d, dates, diff, names, like });
      }
      if (!bad.length) continue;
      failing.push((a || b).id);
      if (problem) continue;
      const first = bad[0];
      const others = new Set(bad.flatMap((x) => x.dates));
      others.delete(first.d);
      // Passings are keyed by stop id or name, so the few shown are put back in time order.
      const byTime = (xs) => [...xs].sort((x, y) => Number(x.split("|")[2]) - Number(y.split("|")[2]));
      const show = (x) => {
        const [dir, key, t] = x.split("|");
        return `dir ${dir} ${first.names.get(key) || key} ${fmt(Number(t))}`;
      };
      problem = `line ${name} changed on ${iso(first.d)}${first.like ? ` (compared with ${iso(first.like)}, the same weekday the feed before covers)` : ""}${others.size ? ` (+ ${others.size} dates, ${bad.length} timetable${bad.length === 1 ? "" : "s"})` : ""}: ${first.diff.missing.length} passings missing${first.diff.missing.length ? ` (${byTime(first.diff.missing).slice(0, 3).map(show).join(", ")}${first.diff.missing.length > 3 ? ", …" : ""})` : ""}, ${first.diff.extra.length} new`;
    }
    if (boundAmbiguous != null) return result(c, "unknown", { expected, note: boundNote(boundAmbiguous), baseline: "before" });
    if (!problem && !tally.count() && undirected) return result(c, "unknown", { expected, note: undirected.error, baseline: "before" });
    if (!problem && !tally.count()) return result(c, "unknown", { expected, note: "no timetable to compare on the scope's dates", baseline: "before" });
    const compared = tally.lines().length || pairs.list.length;
    const measured = problem || `unchanged — ${compared} line${compared === 1 ? "" : "s"}, ${tally.count()} timetable${tally.count() === 1 ? "" : "s"}, ${scope.dates.length} dates${likeOf.size ? ` (${likeOf.size} past the feed before's validity, compared with the same weekday it covers)` : ""}`;
    return result(c, problem ? "fail" : "pass", { expected, measured, lines: failing, measured_on: tally.measuredOn(), grid: tally.grid(), baseline: "before", ...(scopes.notes.length ? { note: scopes.notes.join("; ") } : {}) });
  },
};

module.exports = { CHECKS, linePairs };
