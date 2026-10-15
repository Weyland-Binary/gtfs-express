/**
 * contract/derivedChecks — the acceptance tests of a change, derived by the engine from the intent sheet
 * (contract/intentSheet), without any model: clauses of the vocabulary the gate holds the plan to like the
 * objectives the person decided, each named after what it tests. Deterministic, replayable for free, and no false
 * alarm by construction when the sheet is right: the sheet says what changes and where, and everything the sheet does
 * not name is held unchanged against the feed before the plan — which is why every keep is bounded by what the
 * OTHER demands of the sheet change on the same line (a keep that overlapped another demand would fail a right plan).
 *
 * For each demand of the sheet (scope S, effective date E = S.from_date or the sheet's; a demand on listed dates has
 * none), on the day types the line runs (weekday, saturday, sunday):
 *   keep_before_effect   S.lines unchanged up to the day before E, per day type, up to the day before another
 *                        demand of the line changes that day type (the dates another demand lists left out)
 *   keep_after_effect    S.lines unchanged from the day after S.to_date, on the day types no other demand changes
 *   keep_other_days      S.lines unchanged on the day types S does not name, from E (for ever when no other demand
 *                        changes them, else up to that demand's own date)
 *   keep_other_period    S.lines unchanged on the complementary school period (school_days ↔ school_holidays)
 *   keep_other_direction S.lines unchanged in the other direction (S names one), on S's days from E
 *   keep_outside_window  S.lines unchanged outside the window of the day the demand changes (extend, modify, remove)
 *   count_replaces       a full timetable replaces the existing one: exactly the stated trips a day (replace)
 *   attribute_unchanged_before  an attribute set from E keeps its former values up to E − 1 (accessibility)
 *   like_day_running_times      running times within the reference day's own (like_day, running_times)
 *   like_day_timetable   the same timetable as the reference day's (like_day, timetable → same_as), read after the
 *                        plan when another demand of the sheet changes that reference day, before it otherwise
 *   like_line_shape      the route between two stops follows the reference line's (like_line, shape → shape_follows)
 *   keep_demand          what the demand says stays as it is, on what the demands on its lines leave of it
 * and once for the sheet:
 *   keep_other_lines     every line no demand names unchanged (from the earliest E)
 *   keep_sheet           what the sheet says stays as it is (a demand of the form keep too), on what the demands leave of it
 *
 * Every derived clause is must, carries `origin: { kind: "derived", demand, test }` and a text; the same test is
 * derived once; the contract keeps them beside the person's objectives, and the gate refuses a plan that fails one as
 * it refuses a failing objective.
 *
 *   deriveChecks(sheet, { model, idFrom }) → clauses[]     model: the feed before the plan (transform/feedModel), to
 *                                                         know the day types each line runs and the dates of its
 *                                                         validity; idFrom: the first id's number (default 1)
 */

"use strict";

const { normalizeSheet } = require("./intentSheet");

const DAY_TYPES = ["weekday", "saturday", "sunday"];
const DOW_OF = { weekday: ["mon", "tue", "wed", "thu", "fri"], saturday: ["sat"], sunday: ["sun"] };
const SCHOOL = { school_days: "school_holidays", school_holidays: "school_days" };
const MAX_RANGES = 6;

const iso = (ymd8) => `${ymd8.slice(0, 4)}-${ymd8.slice(4, 6)}-${ymd8.slice(6, 8)}`;
const shift = (iso10, days) => {
  const d = new Date(Date.UTC(+iso10.slice(0, 4), +iso10.slice(5, 7) - 1, +iso10.slice(8, 10)));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const dowOf = (iso10) => ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][new Date(Date.UTC(+iso10.slice(0, 4), +iso10.slice(5, 7) - 1, +iso10.slice(8, 10))).getUTCDay()];
const dayTypeOfDate = (iso10) => ({ sat: "saturday", sun: "sunday" })[dowOf(iso10)] || "weekday";

/** The day types of a scope: the ones it names, every one when it names none. */
const dayTypesOf = (days) => {
  if (!days || !days.length || days.includes("daily")) return DAY_TYPES.slice();
  const out = new Set();
  for (const d of days) {
    if (DAY_TYPES.includes(d)) out.add(d);
    else if (d === "sat") out.add("saturday");
    else if (d === "sun") out.add("sunday");
    else out.add("weekday");
  }
  return [...out];
};

/** Whether the line runs that day type in the feed before (unknown model: assume yes). */
const lineRuns = (model, lineName, dayType) => {
  if (!model) return true;
  const route = [...model.routes.values()].find((r) => String(r.short_name || r.id) === String(lineName)) || null;
  if (!route) return true;
  const trips = [...model.trips.values()].filter((t) => t.route_id === route.id);
  const dates = DOW_OF[dayType].map((d) => model.representative?.[d]).filter(Boolean);
  return dates.some((date) => trips.some((t) => model.runsOn(t.service_id, date)));
};

const validityOf = (model) => (model?.range ? { start: iso(model.range.start), end: iso(model.range.end) } : null);

/** Contiguous ranges of [start, end] minus a set of dates, as [{ from, to }]. */
const rangesMinus = (start, end, excluded) => {
  const out = [];
  let from = null;
  if (start > end) return out;
  for (let d = start; d <= end; d = shift(d, 1)) {
    if (excluded.has(d)) {
      if (from) out.push({ from, to: shift(d, -1) });
      from = null;
    } else if (!from) from = d;
  }
  if (from) out.push({ from, to: end });
  return out;
};

const directionParam = (direction) => (direction == null || direction === "both" ? null : typeof direction === "object" ? direction.towards : direction);

const deriveChecks = (rawSheet, { model = null, idFrom = 1 } = {}) => {
  const sheet = normalizeSheet(rawSheet);
  if (!sheet) return [];
  const validity = validityOf(model);
  const out = [];
  const seen = new Set();
  let n = idFrom;
  const push = (test, demand, kind, params, text) => {
    const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && !v.length)).map(([k, v]) => [k, k === "except" && v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null && x !== undefined)) : v]));
    if (clean.except && !Object.keys(clean.except).length) delete clean.except;
    const key = `${kind}|${JSON.stringify(clean)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ id: `dk${n++}`, kind, level: "must", status: "confirmed", params: clean, text, origin: { kind: "derived", demand: demand ? demand.id : null, test } });
  };
  // A demand on listed dates has no date of effect of its own (the sheet's does not apply to it).
  const effectOf = (d) => d.scope.from_date || (d.scope.dates.length ? null : sheet.effective_date) || null;
  const demands = sheet.demands.filter((d) => d.scope.lines.length && d.shape !== "keep");
  const allLines = [...new Set(sheet.demands.flatMap((d) => d.scope.lines))];
  const earliestEffect = demands.map(effectOf).filter(Boolean).sort()[0] || sheet.effective_date || null;
  // The other undated demands that change a day type of a line, with their date of effect (null: from the start).
  const changers = (d, line, dayType) => demands.filter((x) => x !== d && x.scope.lines.includes(line) && !x.scope.dates.length && dayTypesOf(x.scope.days).includes(dayType));
  // The dates other demands list on a line.
  const listedDates = (d, line) => new Set(demands.filter((x) => x !== d && x.scope.lines.includes(line)).flatMap((x) => x.scope.dates));
  // A keep (a demand's, or the sheet's) holds on what the demands on its lines leave of it. Their changes are carved
  // out along the dimensions the engine's words express: dates (a keep ending before every change on the line, or
  // starting after them, keeps its own dates), school period (a keep on a period no change names keeps it) and day
  // types (one clause per day type the keep names and no change does; the other direction is already the demand's
  // own keep, keep_other_direction). A keep inside the changes on every dimension says what they leave at the stops
  // and times they touch — the demands' own clauses hold that, and no test is derived from it, which would contradict
  // the change. A keep naming no line (the other lines, listed dates) is kept as stated.
  const keepLeft = (test, d, k, fallbackLines) => {
    const ks = k.scope;
    const lines = ks.lines.length ? ks.lines : fallbackLines;
    const kday = ks.days && ks.days.length === 1 ? ks.days[0] : null;
    const except = ks.except ? { lines: ks.except.lines } : null;
    const dates = ks.dates.length ? ks.dates : null;
    const text = k.quote ? `Unchanged: « ${k.quote.slice(0, 120)} »` : lines.length ? `Lines ${lines.join(", ")}: unchanged on that scope` : "Unchanged on that scope";
    if (!lines.length) {
      if (dates || ks.days || except) push(test, d, "unchanged_except", { day: kday, period: ks.period, from_date: ks.from_date, to_date: ks.to_date, dates, except }, text);
      return;
    }
    for (const line of lines) {
      const on = demands.filter((x) => x.scope.lines.includes(line));
      const base = { lines: [line], period: ks.period, dates, except };
      const starts = on.map(effectOf);
      const from = on.length && !starts.some((x) => !x) ? starts.sort()[0] : null;
      const ends = on.map((x) => x.scope.to_date);
      const to = on.length && !ends.some((x) => !x) ? ends.sort().pop() : null;
      const outside = (ks.to_date && from && ks.to_date < from) || (ks.from_date && to && ks.from_date > to) || (dates && dates.every((x) => (from && x < from) || (to && x > to)));
      if (!on.length || outside) {
        push(test, d, "unchanged_except", { ...base, day: kday, from_date: ks.from_date, to_date: ks.to_date }, text);
        continue;
      }
      const bounded = { from_date: ks.from_date || from, to_date: ks.to_date || to };
      if (ks.period && !on.some((x) => x.scope.period === ks.period)) {
        push(test, d, "unchanged_except", { ...base, day: kday, ...bounded }, text);
        continue;
      }
      const changedDays = new Set(on.flatMap((x) => dayTypesOf(x.scope.days)));
      for (const day of dayTypesOf(ks.days).filter((t) => !changedDays.has(t) && lineRuns(model, line, t))) push(test, d, "unchanged_except", { ...base, day, ...bounded }, text);
    }
  };

  for (const d of demands) {
    const S = d.scope;
    const E = effectOf(d);
    const days = dayTypesOf(S.days);
    const linesWord = S.lines.join(", ");
    // keep_before_effect: up to the day before the change, the line as it was — per day type, up to the day before
    // another demand of the line changes that day type (the dates another demand lists left out).
    if (E && validity && E > validity.start) {
      const perDay = new Map();
      for (const day of DAY_TYPES) {
        const lines = S.lines.filter((l) => lineRuns(model, l, day));
        if (!lines.length) continue;
        let end = shift(E, -1);
        const excluded = new Set();
        for (const line of lines) {
          for (const x of changers(d, line, day)) {
            const ex = effectOf(x);
            if (ex && ex <= end) end = shift(ex, -1);
            else if (!ex) end = null;
          }
          for (const date of listedDates(d, line)) excluded.add(date);
        }
        if (!end || end < validity.start) continue;
        // A range without a date of that day type (two days of a weekend for a weekday keep) measures nothing.
        const hasDay = (r) => { for (let x = r.from; x <= r.to; x = shift(x, 1)) if (dayTypeOfDate(x) === day) return true; return false; };
        const ranges = rangesMinus(validity.start, end, excluded).filter(hasDay).slice(0, MAX_RANGES);
        if (ranges.length) perDay.set(day, { lines, ranges });
      }
      const sig = (v) => JSON.stringify([v.lines, v.ranges]);
      const same = perDay.size === DAY_TYPES.filter((day) => S.lines.some((l) => lineRuns(model, l, day))).length && [...perDay.values()].every((v) => sig(v) === sig([...perDay.values()][0]));
      for (const [day, v] of perDay) {
        for (const r of v.ranges) push("keep_before_effect", d, "unchanged_except", { lines: v.lines, day: same ? null : day, from_date: r.from === validity.start ? null : r.from, to_date: r.to }, `Lines ${v.lines.join(", ")}: ${same ? "" : `${day} `}unchanged ${r.from === validity.start ? "up to" : `from ${r.from} to`} ${r.to} (before the change of ${E})`);
        if (same) break;
      }
    }
    // keep_after_effect: a change bounded in time leaves the line as it was afterwards, on the day types no other
    // demand changes.
    if (S.to_date && validity && S.to_date < validity.end) {
      for (const day of days) {
        const lines = S.lines.filter((l) => lineRuns(model, l, day) && !changers(d, l, day).length);
        if (!lines.length) continue;
        push("keep_after_effect", d, "unchanged_except", { lines, day: days.length === DAY_TYPES.length ? null : day, from_date: shift(S.to_date, 1) }, `Lines ${lines.join(", ")}: ${days.length === DAY_TYPES.length ? "" : `${day} `}unchanged from ${shift(S.to_date, 1)} (after the change ending ${S.to_date})`);
        if (days.length === DAY_TYPES.length) break;
      }
    }
    // keep_other_days: the day types the demand does not name, from the change on — for ever when no other demand
    // changes them, else up to the day before that demand's own date.
    if (S.days && !S.days.includes("daily") && !S.dates.length) {
      for (const day of DAY_TYPES.filter((t) => !days.includes(t))) {
        for (const line of S.lines.filter((l) => lineRuns(model, l, day))) {
          const others = changers(d, line, day);
          const bounds = others.map(effectOf);
          if (bounds.some((b) => !b || !E || b <= E)) continue;
          const to = bounds.length ? shift(bounds.sort()[0], -1) : S.to_date;
          push("keep_other_days", d, "unchanged_except", { lines: [line], day, from_date: E, to_date: to }, `Line ${line}: ${day} unchanged${E ? ` from ${E}` : ""}${to ? ` to ${to}` : ""}`);
        }
      }
    }
    // keep_other_period: the complementary school period of a demand that names one.
    if (S.period && SCHOOL[S.period]) {
      const other = SCHOOL[S.period];
      const lines = S.lines.filter((l) => !demands.some((x) => x !== d && x.scope.lines.includes(l) && (x.scope.period === other || (!x.scope.period && !x.scope.dates.length && dayTypesOf(x.scope.days).some((t) => days.includes(t))))));
      if (lines.length) push("keep_other_period", d, "unchanged_except", { lines, day: days.length === 1 ? days[0] : null, period: other, from_date: E, to_date: S.to_date }, `Lines ${lines.join(", ")}: unchanged in ${other.replace("_", " ")}${E ? ` from ${E}` : ""}`);
    }
    // keep_other_direction: the other direction of a demand that names one (on the day types no other demand changes).
    const dir = directionParam(S.direction);
    if (dir != null && !S.dates.length) {
      for (const day of days) {
        const lines = S.lines.filter((l) => lineRuns(model, l, day) && !changers(d, l, day).some((x) => directionParam(x.scope.direction) !== dir));
        if (!lines.length) continue;
        push("keep_other_direction", d, "unchanged_except", { lines, day, period: S.period, from_date: E, to_date: S.to_date, except: { direction: dir } }, `Lines ${lines.join(", ")}: the other direction unchanged (${day}${E ? `, from ${E}` : ""})`);
      }
    }
    // keep_outside_window: the rest of the day untouched (an extension, a modification or a removal in a window).
    if (d.window && ["extend", "modify", "remove", "add"].includes(d.shape)) {
      // A window on listed dates: kept only where no other demand changes those dates' day type on the line.
      const dated = (l) => !S.dates.some((date) => changers(d, l, dayTypeOfDate(date)).some((x) => { const ex = effectOf(x); return (!ex || ex <= date) && (!x.scope.to_date || x.scope.to_date >= date); }));
      for (const day of S.dates.length ? [null] : days) {
        const lines = S.lines.filter((l) => (day ? lineRuns(model, l, day) && !changers(d, l, day).length : dated(l)));
        if (!lines.length) continue;
        push("keep_outside_window", d, "unchanged_except", { lines, day, period: S.period, from_date: E, to_date: S.to_date, dates: S.dates.length ? S.dates : null, except: { from: d.window.from, to: d.window.to, direction: dir } }, `Lines ${lines.join(", ")}: unchanged outside ${d.window.from || "…"}–${d.window.to || "…"} (${day || S.dates.join(", ")}${E ? `, from ${E}` : ""})`);
      }
    }
    // count_replaces: a full timetable replaces the existing trips — exactly its count, never the old ones beside.
    if (d.shape === "replace" || d.replaces_existing === true) {
      for (const c of d.counts) {
        for (const line of S.lines) push("count_replaces", d, "trips_count", { line, exactly: c.trips, per: c.per, day: c.day, period: c.period || S.period, direction: c.direction || dir, from_date: E, to_date: S.to_date, dates: S.dates.length ? S.dates : null }, `Line ${line}: exactly ${c.trips} trips a day${c.per === "direction" ? " in each direction" : ""} (${c.day}${E ? `, from ${E}` : ""}): the timetable replaces the old one`);
      }
    }
    // attribute_unchanged_before: an attribute that changes from E keeps its former values before it.
    if (d.shape === "attribute" && E && validity && E > validity.start) {
      for (const c of d.clauses) {
        if (c.kind === "accessibility" && c.params?.measure === "trips") push("attribute_unchanged_before", d, "accessibility", { line: c.params.line, lines: c.params.lines, measure: "trips", unchanged: true, to_date: shift(E, -1) }, `Line ${c.params.line || (c.params.lines || []).join(", ")}: wheelchair accessibility of the trips unchanged up to ${shift(E, -1)}`);
      }
    }
    // references
    for (const ref of d.references) {
      if (ref.kind === "like_day" && ref.what === "running_times" && ref.from_stop && ref.to_stop) {
        for (const line of S.lines) {
          const dirs = ref.direction != null ? [directionParam(ref.direction)] : dir != null ? [dir] : [null];
          for (const dd of dirs) push("like_day_running_times", d, "running_time", { line, direction: dd, from_stop: ref.from_stop, to_stop: ref.to_stop, like_day: ref.day, tolerance_min: 0, day: days.length === 1 ? days[0] : null, period: S.period, from_date: E, to_date: S.to_date, dates: S.dates.length ? S.dates : null }, `Line ${line}: from ${ref.from_stop} to ${ref.to_stop}, running times as ${ref.day}`);
        }
      } else if (ref.kind === "like_day" && ref.what === "timetable" && ref.like_date) {
        // The reference day as the plan leaves it when another demand of the sheet changes it, as it was otherwise.
        const refType = dayTypeOfDate(ref.like_date);
        const changed = S.lines.some((l) => changers(d, l, refType).some((x) => { const ex = effectOf(x); return !ex || ex <= ref.like_date; }));
        push("like_day_timetable", d, "same_as", { lines: S.lines, like_date: ref.like_date, like_in: changed ? "after" : "before", day: days.length === 1 ? days[0] : null, period: S.period, from_date: E, to_date: S.to_date, dates: S.dates.length ? S.dates : null }, `Lines ${linesWord}: the timetable of ${ref.like_date}${changed ? " as the plan leaves it" : ""}`);
      } else if (ref.kind === "like_line" && ref.what === "shape" && ref.from_stop && ref.to_stop) {
        for (const line of S.lines) push("like_line_shape", d, "shape_follows", { line, direction: ref.direction != null ? directionParam(ref.direction) : dir, from_stop: ref.from_stop, to_stop: ref.to_stop, like_line: ref.line, like_direction: directionParam(ref.like_direction), from_date: E, to_date: S.to_date }, `Line ${line}: between ${ref.from_stop} and ${ref.to_stop}, the route follows line ${ref.line}'s`);
      }
    }
    // keep_demand: the keeps the demand states, on what the demands on their lines leave of them.
    for (const k of d.keeps) keepLeft("keep_demand", d, k, S.lines);
  }
  // keep_other_lines: every line no demand names, from the earliest change on.
  if (allLines.length) push("keep_other_lines", null, "unchanged_except", { from_date: earliestEffect, except: { lines: allLines } }, `Every other line than ${allLines.join(", ")} unchanged${earliestEffect ? ` from ${earliestEffect}` : ""}`);
  // keep_sheet: the sheet's keeps, and the demands of the form keep (a keep written as a demand), on what the demands
  // leave of them.
  for (const k of [...sheet.keeps, ...sheet.demands.filter((x) => x.shape === "keep").map((x) => ({ quote: x.quote, scope: x.scope }))]) keepLeft("keep_sheet", null, k, []);
  return out;
};

module.exports = { deriveChecks, _internals: { dayTypesOf, rangesMinus, shift, dowOf, dayTypeOfDate, lineRuns } };
