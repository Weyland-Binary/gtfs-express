/**
 * set_headway — "Line 3 every 8 minutes from 7:00 to 9:00 on weekdays."
 *
 * The trips of the route (and direction) that leave in the window on the
 * scope's dates are replaced by a regular series: first departure kept (or
 * the given start), then every `headway_min` until the end of the window.
 *
 *   • Day timetables: on a real feed a weekday is often several services at
 *     once (all year + school days + Wednesdays) and periods differ
 *     (September, school term, holidays). The scope's dates are grouped by
 *     the timetable the line runs that day (scope.dayGroups) and each group
 *     gets its own series, built from ITS trips — groups whose window is
 *     the same are rebuilt once, on the union of their dates.
 *   • Other dates keep their timetable: a replaced trip only stops running
 *     on the rebuilt dates (scope.withdrawOnDates keeps its id on the rest).
 *   • Running times: each new trip copies the trip of that day timetable
 *     nearest in time (a 7:05 trip runs like the 7:00 one did, peak running
 *     times stay peak, holiday running times stay holiday ones).
 *   • Patterns: when the window mixes patterns (a variant via the hospital
 *     every other trip) the instruction must say what to do — alternate
 *     (the series keeps the mix in proportion), main (the series runs the
 *     main pattern, the variant trips stay as they are) or main_only (the
 *     variant trips go too) — otherwise the step is blocked.
 *   • frequencies.txt: frequency-based trips get their windows split and
 *     the new headway inside [from, to).
 *   • Blocks: new trips have no block_id (vehicle schedules must be re-cut).
 */

"use strict";

const R = require("../resolve");
const G = require("../gtfsOps");
const S = require("../scope");
const { _internals: fm } = require("../feedModel");

const { secToTime } = fm;
const PATTERN_MODES = ["alternate", "main", "main_only"];

const resolve = async (model, p, ctx) => {
  const ambiguities = [];
  const route = R.route(model, p.route);
  if (route.ambiguity) ambiguities.push({ param: "route", ...route.ambiguity });
  const sc = await S.resolveScope(model, p, ctx, { daysRequired: true });
  ambiguities.push(...sc.ambiguities);
  const warnings = [...sc.warnings];
  const scope = sc.value;
  const win = R.window(p.from, p.to);
  if (win.ambiguity) ambiguities.push({ param: "from", ...win.ambiguity });
  const hw = R.positive(p.headway_min, "headway_min", { max: 240 });
  if (hw.ambiguity) ambiguities.push({ param: "headway_min", ...hw.ambiguity });
  let direction = "both";
  if (route.value) {
    const d = R.direction(model, route.value.id, p.direction);
    if (d.ambiguity) ambiguities.push({ param: "direction", ...d.ambiguity });
    else direction = d.value;
  }
  let start = null;
  if (p.start != null && p.start !== "" && p.start !== "keep_first") {
    start = R.timeToSec(p.start);
    if (start == null) ambiguities.push({ param: "start", code: "time_invalid", message: `"${p.start}" is not a time.` });
  }
  if (p.patterns != null && p.patterns !== "" && !PATTERN_MODES.includes(p.patterns)) ambiguities.push({ param: "patterns", code: "patterns_invalid", message: `patterns is one of ${PATTERN_MODES.join(", ")}.`, options: PATTERN_MODES });
  if (ambiguities.length) return { ambiguities, warnings };

  const dirs = direction === "both" ? [...new Set([...model.trips.values()].filter((t) => t.route_id === route.value.id).map((t) => t.direction_id))].sort() : [direction];
  const perDir = [];
  for (const d of dirs) {
    const onDays = S.tripsInScope(model, { routeId: route.value.id, direction: d }, scope).sort((a, b) => a.first - b.first);
    const freqTrips = onDays.filter((t) => model.frequencies.has(t.id) && model.frequencies.get(t.id).some((f) => f.start < win.value.to && f.end > win.value.from));
    const plain = onDays.filter((t) => !model.frequencies.has(t.id));
    const inWin = plain.filter((t) => t.first != null && t.first >= win.value.from && t.first < win.value.to);
    if (!onDays.length) {
      ambiguities.push({ param: "days", code: "no_service_on_days", message: `Line ${route.value.short_name || route.value.id} has no trip in direction ${d} on these days: adding a new day of service is another operation (copy_day_service).` });
      continue;
    }
    const counts = new Map();
    for (const t of inWin) counts.set(t.pattern, (counts.get(t.pattern) || 0) + 1);
    if (counts.size > 1 && !p.patterns) {
      const names = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => {
        const pat = model.patterns.get(k);
        return `${n} trips to ${model.stops.get(pat.stops[pat.stops.length - 1])?.name || "?"} (${pat.stops.length} stops)`;
      });
      ambiguities.push({ param: "patterns", code: "patterns_mixed", message: `In this window direction ${d} runs ${counts.size} different routes (${names.join("; ")}). Keep the mix (alternate), run the main one and keep the others as they are (main), or run the main one only (main_only)?`, options: PATTERN_MODES });
      continue;
    }
    if (!inWin.length && !freqTrips.length) warnings.push(`Direction ${d}: no trip leaves in the window on these days; the new trips copy the nearest one in time.`);
    // The main pattern: the one most trips of the window run (else of the day).
    const pool = inWin.length ? inWin : plain;
    const mainCount = new Map();
    for (const t of pool) mainCount.set(t.pattern, (mainCount.get(t.pattern) || 0) + 1);
    const main = [...mainCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    perDir.push({ direction: d, plain: plain.map((t) => t.id), freqTrips: freqTrips.map((t) => t.id), main });
  }
  if (ambiguities.length) return { ambiguities, warnings };
  return { value: { routeId: route.value.id, label: route.value.short_name || route.value.id, scope, from: win.value.from, to: win.value.to, headway: Math.round(hw.value * 60), start, patternMode: p.patterns || "main", perDir }, ambiguities: [], warnings };
};

// Bresenham-like cycle through patterns in proportion to their share.
const cycler = (shares) => {
  const total = shares.reduce((s, x) => s + x.n, 0);
  const acc = shares.map(() => 0);
  return () => {
    let best = 0;
    shares.forEach((x, i) => {
      acc[i] += x.n / total;
      if (acc[i] > acc[best]) best = i;
    });
    acc[best] -= 1;
    return shares[best].key;
  };
};

const splitFrequencies = (db, model, v, tripIds) => {
  const ins = db.prepare("INSERT INTO frequencies (trip_id, start_time, end_time, headway_secs, exact_times) VALUES (?, ?, ?, ?, ?)");
  for (const id of S.isolateScope(db, model, tripIds, v.scope)) {
    const rows = db.prepare("SELECT * FROM frequencies WHERE trip_id = ? ORDER BY start_time").all(id);
    db.prepare("DELETE FROM frequencies WHERE trip_id = ?").run(id);
    for (const f of rows) {
      const a = R.timeToSec(f.start_time);
      const b = R.timeToSec(f.end_time);
      if (b <= v.from || a >= v.to) {
        ins.run(id, f.start_time, f.end_time, f.headway_secs, f.exact_times);
        continue;
      }
      if (a < v.from) ins.run(id, f.start_time, secToTime(v.from), f.headway_secs, f.exact_times);
      ins.run(id, secToTime(Math.max(a, v.from)), secToTime(Math.min(b, v.to)), v.headway, f.exact_times);
      if (b > v.to) ins.run(id, secToTime(v.to), f.end_time, f.headway_secs, f.exact_times);
    }
  }
};

const apply = (db, v, { model }) => {
  const warnings = [];
  let created = 0;
  const withdraw = new Map(); // trip id → dates it stops running on
  let series = 0;
  const existing = new Map();
  for (const sid of model.services.keys()) existing.set(S.activeDates(model, sid).join(","), sid);
  for (const d of v.perDir) {
    if (d.freqTrips.length) splitFrequencies(db, model, v, d.freqTrips);
    if (!d.plain.length) continue;

    // One plan per day timetable; identical plans share one series.
    const plans = new Map();
    for (const g of S.dayGroups(model, d.plain, v.scope)) {
      const trips = g.trips.map((id) => model.trips.get(id));
      const inWin = trips.filter((t) => t.first != null && t.first >= v.from && t.first < v.to).sort((a, b) => a.first - b.first);
      const replaced = v.patternMode === "main" ? inWin.filter((t) => t.pattern === d.main) : inWin;
      let pool = v.patternMode === "alternate" ? inWin : inWin.filter((t) => t.pattern === d.main);
      if (!pool.length) {
        // Nothing of this pattern in the window that day: the nearest trip in time.
        const same = trips.filter((t) => t.pattern === d.main);
        pool = (same.length ? same : trips).slice().sort((a, b) => Math.abs(a.first - v.from) - Math.abs(b.first - v.from)).slice(0, 1);
      }
      if (v.patternMode === "main" && inWin.length > replaced.length) warnings.push(`Direction ${d.direction}: ${inWin.length - replaced.length} trip(s) of other routes of the line in the window were kept as they are.`);
      const key = JSON.stringify([replaced.map((t) => `${t.pattern}|${t.first}|${t.lastArr}`), pool.map((t) => `${t.pattern}|${t.first}|${t.lastArr}`)]);
      if (!plans.has(key)) plans.set(key, { dates: [], replaced: [], pool });
      const plan = plans.get(key);
      plan.dates.push(...g.dates);
      plan.replaced.push(...replaced);
    }

    for (const plan of plans.values()) {
      const dates = [...new Set(plan.dates)].sort();
      const pool = plan.pool;
      const serviceId = S.serviceForDates(db, model, pool[0].service_id, dates, { existing });
      const counts = new Map();
      for (const t of pool) counts.set(t.pattern, (counts.get(t.pattern) || 0) + 1);
      const shares = [...counts.entries()].map(([key, n]) => ({ key, n })).sort((a, b) => b.n - a.n);
      const next = v.patternMode === "alternate" && shares.length > 1 ? cycler(shares) : () => shares[0].key;
      const first = v.start ?? (plan.replaced.length ? Math.min(...plan.replaced.map((t) => t.first)) : v.from);
      for (let t = Math.max(first, v.from); t < v.to; t += v.headway) {
        const key = next();
        const tpl = pool.filter((x) => x.pattern === key).sort((a, b) => Math.abs(a.first - t) - Math.abs(b.first - t))[0];
        const hhmm = secToTime(t).slice(0, 5).replace(":", "");
        G.cloneTrip(db, tpl.id, { newId: G.uniqueId(db, "trips", "trip_id", `${v.routeId}_${d.direction}_${serviceId}_${hhmm}`), serviceId, shiftSec: t - tpl.first, patch: { block_id: null } });
        created += 1;
      }
      series += 1;
      for (const t of plan.replaced) {
        if (!withdraw.has(t.id)) withdraw.set(t.id, new Set());
        dates.forEach((x) => withdraw.get(t.id).add(x));
      }
      if (pool.some((t) => t.block_id) || plan.replaced.some((t) => t.block_id)) warnings.push(`Line ${v.label}: trips were in vehicle blocks; the new ones have none (re-cut the vehicle schedules).`);
    }
  }
  // Replaced trips stop running on the rebuilt dates only.
  const buckets = new Map();
  for (const [id, dates] of withdraw) {
    const k = [...dates].sort().join(",");
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(id);
  }
  let restricted = 0;
  for (const [k, ids] of buckets) restricted += S.withdrawOnDates(db, model, ids, k.split(",")).restricted;
  if (series > 1) warnings.push(`Line ${v.label}: ${series} series built, one per day timetable of the line (e.g. school days, Wednesdays, holidays), each from its own trips.`);
  const minutes = Math.round(v.headway / 60);
  const kept = restricted ? `, ${restricted} of them kept on their other dates` : "";
  return {
    summary: `Line ${v.label}: every ${minutes} min from ${secToTime(v.from).slice(0, 5)} to ${secToTime(v.to).slice(0, 5)} (${S.describeScope(v.scope)}) — ${created} trip(s) created, ${withdraw.size} replaced${kept}.`,
    warnings: [...new Set(warnings)],
    noop: created === 0 && withdraw.size === 0 && !v.perDir.some((x) => x.freqTrips.length),
  };
};

module.exports = {
  type: "set_headway",
  title: "Change the frequency of a line over a period",
  category: "service",
  tables: ["trips", "stop_times", "frequencies", "calendar", "calendar_dates", "transfers"],
  description: "Replace the departures of a line in a time window by a regular series, on the scope's dates only; each day timetable of the line (school days, Wednesdays, holidays…) is rebuilt from its own trips and running times.",
  params: [
    { name: "route", type: "route", required: true, description: "The line (short name, id or long name)." },
    { name: "days", type: "days", required: true, description: "weekday | saturday | sunday | daily | mon…sun, or a list." },
    ...S.SCOPE_PARAMS,
    { name: "from", type: "time", required: true, description: "Start of the window (HH:MM)." },
    { name: "to", type: "time", required: true, description: "End of the window (HH:MM), exclusive." },
    { name: "headway_min", type: "number", required: true, description: "Minutes between departures." },
    { name: "direction", type: "direction", required: false, description: "0, 1, both (default) or a destination." },
    { name: "start", type: "time", required: false, description: "First departure of the series (default: keep the first existing one)." },
    { name: "patterns", type: "enum", enum: PATTERN_MODES, required: false, description: "When the window mixes routes of the line: alternate (keep the mix), main (series on the main route, the others kept), main_only (the others go). Required when variants exist." },
  ],
  example: { route: "3", days: "weekday", from: "07:00", to: "09:00", headway_min: 8 },
  resolve,
  apply,
};
