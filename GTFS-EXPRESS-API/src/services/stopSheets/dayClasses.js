/**
 * The day classes of a period, read from the network itself and from nothing else: every date has a regime (the set
 * of services running), and the classes follow the regimes. The days of the week sharing the regime most days run
 * are the working days; the other days of the week are the rest days, one class per distinct regime; a working day
 * run with a rest day's regime is a public holiday, counted with that rest class; working days run with another
 * regime over a block of dates (school holidays, a summer timetable, a change for good) make a class of their own,
 * labelled by its dates. A regime that holds only a day or two, or that differs from another by a few trips only
 * (`similar`), is never a class: its dates stay in their class and the departures say the difference in a note; a
 * block a named period covers is a class whatever its size, since the name says why. Names (school holidays, a
 * period's name, a holiday's name) are a layer laid over the classes by whoever knows them, never guessed here.
 */

"use strict";

const DOWS = Object.freeze(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
// A block of another regime is a class from this many working dates; shorter, it is a note.
const MIN_BLOCK_DATES = 3;
const MAX_ALT_CLASSES = 3;
// A class is named by the periods covering at least this share of its dates.
const NAMED_SHARE = 0.8;

const mostFrequent = (values) => {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  let best = null;
  for (const [v, n] of counts) if (!best || n > best[1]) best = [v, n];
  return best ? best[0] : "";
};

/** Days of the week as a cyclic run when they are consecutive: { from, to }, else null. */
const dowRun = (dows) => {
  const set = new Set(dows);
  if (set.size === 7) return { from: "mon", to: "sun" };
  if (!set.size) return null;
  for (let start = 0; start < 7; start++) {
    if (!set.has(DOWS[start]) || set.has(DOWS[(start + 6) % 7])) continue;
    let n = 0;
    while (n < 7 && set.has(DOWS[(start + n) % 7])) n += 1;
    return n === set.size ? { from: DOWS[start], to: DOWS[(start + n - 1) % 7] } : null;
  }
  return null;
};

/** Runs of consecutive members of `base` (sorted) that are all in `subset`: [[first, last]]. */
const rangesOf = (subset, base) => {
  const inSub = subset instanceof Set ? subset : new Set(subset);
  const out = [];
  let open = null;
  for (const d of base) {
    if (inSub.has(d)) {
      if (open) open[1] = d;
      else open = [d, d];
    } else if (open) {
      out.push(open);
      open = null;
    }
  }
  if (open) out.push(open);
  return out;
};

/**
 * `dates` in order, `sigOf(date)` the regime, `dowOf(date)`, `similar(a, b)` whether two regimes differ by a few
 * trips only; `names`: { periods: [{ from, to, name, kind }], holidays: Map(date → name) } or null. Returns
 * { classes, classOf, holidays, workdays }.
 */
const classesOf = ({ dates, sigOf, dowOf, similar = (a, b) => a === b, names = null }) => {
  const byDow = new Map(DOWS.map((d) => [d, []]));
  for (const d of dates) byDow.get(dowOf(d)).push(d);
  const dominant = new Map();
  for (const [dow, list] of byDow) if (list.length) dominant.set(dow, mostFrequent(list.map(sigOf)));
  if (!dominant.size) return { classes: [], classOf: new Map(), holidays: new Set(), workdays: [] };
  // The days of the week by their usual regime, alike regimes together; the group with most days is the working week.
  const groups = [];
  for (const dow of DOWS) {
    if (!dominant.has(dow)) continue;
    const sig = dominant.get(dow);
    const group = groups.find((g) => similar(g.sig, sig));
    if (group) group.dows.push(dow);
    else groups.push({ sig, dows: [dow] });
  }
  groups.sort((a, b) => b.dows.length - a.dows.length || DOWS.indexOf(a.dows[0]) - DOWS.indexOf(b.dows[0]));
  const workSig = groups[0].sig;
  const workdays = groups[0].dows;
  const workSet = new Set(workdays);
  const periods = names?.periods || [];
  const named = (d) => periods.some((p) => d >= p.from && d <= p.to);

  const classOf = new Map();
  const holidays = new Set();
  const restClasses = groups.slice(1).map((g) => ({ id: `rest:${g.dows[0]}`, kind: "rest", sig: g.sig, dows: g.dows, dates: [], holidays: [] }));
  const workClass = { id: "work", kind: "work", sig: workSig, dows: workdays, dates: [], holidays: [] };
  for (const cls of restClasses) for (const d of dates) if (cls.dows.includes(dowOf(d))) cls.dates.push(d);
  // Working dates: the usual regime, a rest day's regime (a holiday), or another one (a candidate block). A date a
  // named period covers is a candidate as soon as its regime differs: the name says why.
  const other = [];
  for (const d of dates) {
    if (!workSet.has(dowOf(d))) continue;
    const sig = sigOf(d);
    if (sig === workSig || (!named(d) && similar(sig, workSig))) {
      workClass.dates.push(d);
      continue;
    }
    const rest = sig !== "" ? restClasses.find((c) => c.sig !== "" && similar(c.sig, sig)) : null;
    if (rest) {
      rest.dates.push(d);
      rest.holidays.push(d);
      holidays.add(d);
      continue;
    }
    if (sig === "") {
      workClass.dates.push(d);
      continue;
    }
    other.push(d);
  }
  // Blocks: consecutive working dates (rest days and holidays between them allowed) of alike regimes.
  const runs = [];
  for (const d of other) {
    const sig = sigOf(d);
    const last = runs[runs.length - 1];
    const workBetween = last ? dates.filter((x) => x > last.to && x < d && workSet.has(dowOf(x)) && !holidays.has(x)).length : 0;
    if (last && similar(last.sig, sig) && workBetween === 0) {
      last.to = d;
      last.dates.push(d);
    } else runs.push({ sig, from: d, to: d, dates: [d] });
  }
  const bySig = [];
  for (const r of runs) {
    if (r.dates.length < MIN_BLOCK_DATES) {
      workClass.dates.push(...r.dates);
      continue;
    }
    let cls = bySig.find((c) => similar(c.sig, r.sig));
    if (!cls) bySig.push((cls = { id: `alt:${bySig.length + 1}`, kind: "alt", sig: r.sig, dows: workdays, dates: [], holidays: [], ranges: [] }));
    cls.dates.push(...r.dates);
    cls.ranges.push([r.from, r.to]);
  }
  const altClasses = bySig.sort((a, b) => b.dates.length - a.dates.length);
  for (const cls of altClasses.slice(MAX_ALT_CLASSES)) workClass.dates.push(...cls.dates);
  const kept = altClasses.slice(0, MAX_ALT_CLASSES).sort((a, b) => a.dates[0].localeCompare(b.dates[0]));
  kept.forEach((cls, i) => {
    cls.id = `alt:${i + 1}`;
  });
  for (const cls of restClasses) cls.dates.sort();
  workClass.dates.sort();

  // The rest classes in the week's order after the working days.
  const after = DOWS.indexOf(workdays[workdays.length - 1]);
  const order = (dow) => (DOWS.indexOf(dow) - after + 6) % 7;
  restClasses.sort((a, b) => order(a.dows[0]) - order(b.dows[0]));
  const classes = [workClass, ...kept, ...restClasses].filter((c) => c.dates.length);
  for (const cls of classes) for (const d of cls.dates) classOf.set(d, cls);

  // Names over the classes: a block covered by named periods takes their name; a holiday its name.
  for (const cls of kept) {
    const covering = periods.filter((p) => cls.dates.some((d) => d >= p.from && d <= p.to));
    const covered = cls.dates.filter((d) => covering.some((p) => d >= p.from && d <= p.to)).length;
    if (covering.length && covered >= cls.dates.length * NAMED_SHARE) {
      const kinds = new Set(covering.map((p) => p.kind || "other"));
      cls.name = { kind: kinds.size === 1 && kinds.has("school") ? "school" : "other", text: [...new Set(covering.map((p) => p.name).filter(Boolean))].join(", ") };
    }
  }
  if (kept.some((c) => c.name?.kind === "school")) workClass.school = true;
  for (const cls of restClasses) cls.holidayNames = cls.holidays.map((d) => ({ date: d, name: names?.holidays?.get(d) || null }));
  const colour = (cls, i, all) => {
    if (cls.kind === "work") return "weekday";
    if (cls.kind === "alt") return "holiday_weekday";
    const rest = all.filter((c) => c.kind === "rest");
    return rest.length > 1 && cls === rest[0] ? "saturday" : "sunday_holiday";
  };
  for (const cls of classes) cls.colour = colour(cls, 0, classes);
  return { classes, classOf, holidays, workdays };
};

module.exports = { classesOf, dowRun, rangesOf, DOWS, MIN_BLOCK_DATES };
