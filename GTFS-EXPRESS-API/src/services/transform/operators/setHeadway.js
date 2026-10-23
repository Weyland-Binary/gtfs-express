/**
 * set_headway: the departures of a line in a window [from, to) on the scope's dates replaced by a regular series.
 * - The series keeps the grid of the line's first departure in the window, moved back by whole headways towards the
 *   window's start, so the first wait is at most one headway, as a headway_max clause measures it.
 * - Each day timetable (scope.dayGroups) gets its own series from its own trips, each copy running like the nearest
 *   trip in time; other dates keep their timetable.
 * - A departure the line already runs (same pattern, same time, once on every date) keeps its trip_id, which a
 *   realtime feed keys on, unless an earlier step put it into a block overlap the validator refuses.
 * - Mixed patterns, scheduled and frequency-based trips in one window (rebuilding both would add their services up),
 *   and holiday weekdays run as Saturdays are questions, never guessed.
 * - Departures are rounded once to the feed's time step; new trips get no block_id (counted, never re-chained); a copy
 *   drops a trip_short_name that numbers each trip, so no number runs twice a day.
 */

"use strict";

const R = require("../resolve");
const G = require("../gtfsOps");
const S = require("../scope");
const blocking = require("../blocking");
const { tripsOfRoute, referenceStop } = require("../feedModel");
const { formatTime } = require("../../../utils/time");
const runtime = require("../runtime");
const { tr } = require("../i18n");

const PATTERN_MODES = ["alternate", "main", "main_only"];
const REGIMES = ["scheduled", "frequencies", "both"];

const resolve = async (model, p, ctx) => {
  const lang = ctx?.lang;
  const ambiguities = [];
  const route = R.route(model, p.route, { lang });
  if (route.ambiguity) ambiguities.push({ param: "route", ...route.ambiguity });
  const sc = await S.resolveScope(model, p, ctx, { daysRequired: true });
  ambiguities.push(...sc.ambiguities);
  const warnings = [...sc.warnings];
  const scope = sc.value;
  const win = R.window(p.from, p.to, { lang });
  if (win.ambiguity) ambiguities.push({ param: "from", ...win.ambiguity });
  const hw = R.positive(p.headway_min, "headway_min", { max: 240, lang });
  if (hw.ambiguity) ambiguities.push({ param: "headway_min", ...hw.ambiguity });
  let direction = "both";
  if (route.value) {
    const d = R.direction(model, route.value.id, p.direction, { lang });
    if (d.ambiguity) ambiguities.push({ param: "direction", ...d.ambiguity });
    else direction = d.value;
  }
  let start = null;
  const keepFirst = p.start === "keep_first";
  if (p.start != null && p.start !== "" && !keepFirst) {
    start = R.timeToSec(p.start);
    if (start == null) ambiguities.push({ param: "start", code: "time_invalid", message: tr(lang, "resolve.time_invalid", { value: String(p.start) }) });
  }
  if (p.patterns != null && p.patterns !== "" && !PATTERN_MODES.includes(p.patterns)) ambiguities.push({ param: "patterns", code: "patterns_invalid", message: tr(lang, "set_headway.patterns_invalid", { modes: PATTERN_MODES.join(", ") }), options: PATTERN_MODES });
  const regime = p.regime == null || p.regime === "" ? null : String(p.regime);
  if (regime && !REGIMES.includes(regime)) ambiguities.push({ param: "regime", code: "regime_invalid", message: tr(lang, "set_headway.regime_invalid", { modes: REGIMES.join(", ") }), options: REGIMES });
  // The stop the window is read at (default: each trip's origin).
  let at = null;
  if (route.value && p.at_stop != null && p.at_stop !== "") {
    const r = R.stop(model, p.at_stop, { routeId: route.value.id, group: true, lang });
    if (r.ambiguity) ambiguities.push({ param: "at_stop", ...r.ambiguity });
    else if (!r.value.id) ambiguities.push({ param: "at_stop", code: "stop_unknown", message: tr(lang, "set_headway.at_stop_unknown", { stop: String(p.at_stop) }) });
    else {
      const ids = new Set();
      for (const x of r.many || [r.value]) {
        ids.add(x.id);
        for (const y of model.stops.values()) if (y.parent === x.id) ids.add(y.id);
      }
      at = { name: r.value.name, ids: [...ids].sort() };
    }
  }
  if (ambiguities.length) return { ambiguities, warnings };
  const timeOf = timeAt(at);

  // A weekday change on a line whose school-holiday weekdays run its Saturday timetable: asked, or said.
  const hole = S.holidayWeekdaysStep(S.weekdayHole(model, [...new Set(tripsOfRoute(model, route.value.id).map((t) => t.service_id))], scope), scope, { line: route.value.short_name || route.value.id, lang });
  if (hole.ambiguity) return { ambiguities: [hole.ambiguity], warnings };
  if (hole.warning) warnings.push(hole.warning);

  const dirs = direction === "both" ? [...new Set([...model.trips.values()].filter((t) => t.route_id === route.value.id).map((t) => t.direction_id))].sort() : [direction];
  const perDir = [];
  for (const d of dirs) {
    const onDays = S.tripsInScope(model, { routeId: route.value.id, direction: d }, scope).sort((a, b) => a.first - b.first);
    const freqTrips = onDays.filter((t) => model.frequencies.has(t.id) && model.frequencies.get(t.id).some((f) => f.start < win.value.to && f.end > win.value.from));
    const plain = onDays.filter((t) => !model.frequencies.has(t.id));
    const inWin = plain.filter((t) => timeOf(t) != null && timeOf(t) >= win.value.from && timeOf(t) < win.value.to);
    if (!onDays.length) {
      ambiguities.push({ param: "days", code: "no_service_on_days", message: tr(lang, "set_headway.no_service_on_days", { line: route.value.short_name || route.value.id, direction: d }) });
      continue;
    }
    if (at && !plain.some((t) => timeOf(t) != null)) {
      ambiguities.push({ param: "at_stop", code: "at_stop_not_served", message: tr(lang, "set_headway.at_stop_not_served", { stop: at.name, direction: d }) });
      continue;
    }
    // Read at the origins while a headway clause reads the trunk (feedModel.referenceStop): said, with the stop to give.
    if (!at) {
      const r = model.routes.get(route.value.id);
      const trunk = referenceStop(r, plain, d);
      const origin = r.patterns.find((p) => p.direction_id === d)?.stops[0] || null;
      if (trunk && trunk !== origin && inWin.some((t) => t.stops[0] !== trunk)) warnings.push(tr(lang, "set_headway.trunk", { direction: d, stop: model.stops.get(trunk)?.name || trunk }));
    }
    // Scheduled and frequency-based trips in the same window: rebuilding both would add their services up.
    if (freqTrips.length && inWin.length && !regime) {
      ambiguities.push({ param: "regime", code: "mixed_timetable", message: tr(lang, "set_headway.mixed_timetable", { direction: d, scheduled: inWin.length, frequency: freqTrips.length }), options: REGIMES });
      continue;
    }
    const counts = new Map();
    for (const t of inWin) counts.set(t.pattern, (counts.get(t.pattern) || 0) + 1);
    if (counts.size > 1 && !p.patterns) {
      const names = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => {
        const pat = model.patterns.get(k);
        return tr(lang, "set_headway.pattern_share", { count: n, stop: model.stops.get(pat.stops[pat.stops.length - 1])?.name || "?", stops: pat.stops.length });
      });
      ambiguities.push({ param: "patterns", code: "patterns_mixed", message: tr(lang, "set_headway.patterns_mixed", { direction: d, count: counts.size, routes: names.join("; ") }), options: PATTERN_MODES });
      continue;
    }
    if (!inWin.length && !freqTrips.length) warnings.push(tr(lang, "set_headway.no_trip_in_window", { direction: d }));
    // The main pattern: the one most trips of the window run (else of the day).
    const pool = inWin.length ? inWin : plain;
    const mainCount = new Map();
    for (const t of pool) mainCount.set(t.pattern, (mainCount.get(t.pattern) || 0) + 1);
    const main = [...mainCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    perDir.push({ direction: d, plain: regime === "frequencies" ? [] : plain.map((t) => t.id), freqTrips: regime === "scheduled" ? [] : freqTrips.map((t) => t.id), main });
  }
  if (ambiguities.length) return { ambiguities, warnings };
  return { value: { routeId: route.value.id, label: route.value.short_name || route.value.id, scope, from: win.value.from, to: win.value.to, headway: Math.round(hw.value * 60), start, keepFirst, at, patternMode: p.patterns || "main", perDir }, ambiguities: [], warnings };
};

/** When a trip is read by the window: at its origin, or at its first call at `at` (null: not calling there). */
const timeAt = (at) => {
  if (!at) return (t) => t.first;
  const ids = new Set(at.ids);
  return (t) => {
    const i = t.stops.findIndex((x) => ids.has(x));
    return i < 0 ? null : t.dep[i];
  };
};

/** The given start, else the line's first departure in the window moved back by whole headways towards `from`. */
const seriesStart = (v, kept) => {
  if (v.start != null) return v.start;
  if (kept == null) return v.from;
  if (v.keepFirst) return kept;
  return kept - v.headway * Math.floor((kept - v.from) / v.headway);
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
      if (a < v.from) ins.run(id, f.start_time, formatTime(v.from), f.headway_secs, f.exact_times);
      ins.run(id, formatTime(Math.max(a, v.from)), formatTime(Math.min(b, v.to)), v.headway, f.exact_times);
      if (b > v.to) ins.run(id, formatTime(v.to), f.end_time, f.headway_secs, f.exact_times);
    }
  }
};

const apply = (db, v, { model, lang } = {}) => {
  const warnings = [];
  const step = runtime.timePrecision(model).step;
  const rounded = []; // [exact, written] departures of the series
  let created = 0;
  const withdraw = new Map(); // trip id → dates it stops running on
  let series = 0;
  const edges = new Set(); // departures added before the line's own first one, to cover the window's start
  const stays = new Set(); // trips of the window the series keeps as they are (it runs their departure)
  const existing = new Map();
  for (const sid of model.services.keys()) existing.set(S.activeDates(model, sid).join(","), sid);
  const overlaps = blocking.overlapReader(db);
  // trip_short_name numbers each trip when, within one service (a number may recur on another), most trips bear their
  // own value: never copied then. A label the trips share (« Ligne 1 » on every trip) is kept.
  const groups = db.prepare("SELECT COUNT(*) AS c FROM trips WHERE route_id = ? AND TRIM(COALESCE(trip_short_name, '')) <> '' GROUP BY service_id, trip_short_name").all(v.routeId);
  const namedTrips = groups.reduce((n, g) => n + g.c, 0);
  const numbered = namedTrips > 1 && groups.filter((g) => g.c === 1).length * 2 > namedTrips;
  let unnumbered = 0;
  for (const d of v.perDir) {
    if (d.freqTrips.length) splitFrequencies(db, model, v, d.freqTrips);
    if (!d.plain.length) continue;

    // One plan per day timetable; identical plans share one series.
    const plans = new Map();
    const timeOf = timeAt(v.at);
    for (const g of S.dayGroups(model, d.plain, v.scope)) {
      const trips = g.trips.map((id) => model.trips.get(id)).filter((t) => timeOf(t) != null);
      if (!trips.length) continue;
      const inWin = trips.filter((t) => timeOf(t) >= v.from && timeOf(t) < v.to).sort((a, b) => timeOf(a) - timeOf(b));
      const replaced = v.patternMode === "main" ? inWin.filter((t) => t.pattern === d.main) : inWin;
      let pool = v.patternMode === "alternate" ? inWin : inWin.filter((t) => t.pattern === d.main);
      if (!pool.length) {
        // Nothing of this pattern in the window that day: the nearest trip in time.
        const same = trips.filter((t) => t.pattern === d.main);
        pool = (same.length ? same : trips).slice().sort((a, b) => Math.abs(timeOf(a) - v.from) - Math.abs(timeOf(b) - v.from)).slice(0, 1);
      }
      if (v.patternMode === "main" && inWin.length > replaced.length) warnings.push(tr(lang, "set_headway.others_kept", { direction: d.direction, count: inWin.length - replaced.length }));
      const key = JSON.stringify([replaced.map((t) => `${t.pattern}|${t.first}|${t.lastArr}`), pool.map((t) => `${t.pattern}|${t.first}|${t.lastArr}`)]);
      if (!plans.has(key)) plans.set(key, { dates: [], replaced: [], pool });
      const plan = plans.get(key);
      plan.dates.push(...g.dates);
      plan.replaced.push(...replaced);
    }

    for (const plan of plans.values()) {
      const dates = [...new Set(plan.dates)].sort();
      const pool = plan.pool;
      // The series' service, made when a copy needs it (a series the line already runs whole needs none).
      let serviceId = null;
      const service = () => serviceId || (serviceId = S.serviceForDates(db, model, pool[0].service_id, dates, { existing }));
      // The trips it replaces, each once (the groups of one series share theirs).
      const replaced = [...new Map(plan.replaced.map((t) => [t.id, t])).values()];
      const onceADate = (trips) => {
        const runs = new Map();
        for (const t of trips) for (const x of S.activeDates(model, t.service_id)) runs.set(x, (runs.get(x) || 0) + 1);
        return dates.every((x) => runs.get(x) === 1);
      };
      const same = new Set();
      const counts = new Map();
      for (const t of pool) counts.set(t.pattern, (counts.get(t.pattern) || 0) + 1);
      const shares = [...counts.entries()].map(([key, n]) => ({ key, n })).sort((a, b) => b.n - a.n);
      const next = v.patternMode === "alternate" && shares.length > 1 ? cycler(shares) : () => shares[0].key;
      const kept = plan.replaced.length ? Math.min(...plan.replaced.map((t) => timeOf(t))) : null;
      const first = seriesStart(v, kept);
      if (v.start == null && kept != null && first < kept) edges.add(tr(lang, "set_headway.edge_item", { direction: d.direction, first: formatTime(runtime.roundTo(first, step)).slice(0, 5), minutes: Number(((kept - first) / 60).toFixed(2)), kept: formatTime(kept).slice(0, 5) }));
      // Every headway on the exact clock, each departure rounded once to the feed's step.
      let prev = null;
      for (let t = Math.max(first, v.from); t < v.to; t += v.headway) {
        const key = next();
        const tpl = pool.filter((x) => x.pattern === key).sort((a, b) => Math.abs(timeOf(a) - t) - Math.abs(timeOf(b) - t))[0];
        // Whole steps from the template: its on-grid times stay on the grid.
        const shift = runtime.roundTo(t - timeOf(tpl), step);
        const at = timeOf(tpl) + shift;
        if (at === prev) continue;
        prev = at;
        rounded.push([t, at]);
        // A departure the line already runs on that pattern and time, once on every date, keeps its trip_id. A doubling,
        // or a trip an earlier step re-timed into a block overlap the validator refuses, is copied and replaced.
        const already = replaced.filter((x) => x.pattern === key && timeOf(x) === at);
        if (already.length && onceADate(already) && !already.some((x) => overlaps(x.id))) {
          for (const x of already) {
            same.add(x.id);
            stays.add(x.id);
          }
          continue;
        }
        const hhmm = formatTime(tpl.first + shift).slice(0, 5).replace(":", "");
        const number = numbered && String(db.prepare("SELECT trip_short_name AS n FROM trips WHERE trip_id = ?").get(tpl.id)?.n || "").trim();
        if (number) unnumbered += 1;
        G.cloneTrip(db, tpl.id, { newId: G.uniqueId(db, "trips", "trip_id", `${v.routeId}_${d.direction}_${service()}_${hhmm}`), serviceId: service(), shiftSec: shift, patch: { block_id: null, ...(number ? { trip_short_name: null } : {}) } });
        created += 1;
      }
      series += 1;
      for (const t of plan.replaced) {
        if (same.has(t.id)) continue;
        if (!withdraw.has(t.id)) withdraw.set(t.id, new Set());
        dates.forEach((x) => withdraw.get(t.id).add(x));
      }
    }
  }
  // Only the trips that stay whole: one another series replaces on its own dates is among the replaced.
  const whole = [...stays].filter((id) => !withdraw.has(id)).length;
  if (whole) warnings.push(tr(lang, "set_headway.kept_same", { count: whole }));
  if (unnumbered) warnings.push(tr(lang, "timetable.short_names"));
  // Blocks are left to the operator's scheduling tool, never re-chained here: said, counted, noted for the engine.
  const chain = blocking.unchained(model, { routeId: v.routeId, label: v.label, created, withdrawn: withdraw, lang });
  if (chain.warning) warnings.push(chain.warning);
  // Replaced trips stop running on the rebuilt dates only.
  const buckets = new Map();
  for (const [id, dates] of withdraw) {
    const k = [...dates].sort().join(",");
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(id);
  }
  let restricted = 0;
  for (const [k, ids] of buckets) restricted += S.withdrawOnDates(db, model, ids, k.split(",")).restricted;
  if (series > 1) warnings.push(tr(lang, "set_headway.series", { line: v.label, count: series }));
  const moved = rounded.filter(([a, b]) => a !== b);
  if (moved.length && step > 1) {
    const few = moved.slice(0, 4).map(([a, b]) => `${formatTime(a)} → ${formatTime(b).slice(0, 5)}`).join(", ");
    warnings.push(tr(lang, "set_headway.rounded", { departures: few, more: moved.length > 4 ? ` (+${moved.length - 4})` : "" }));
  }
  const minutes = Number((v.headway / 60).toFixed(2));
  const words = { line: v.label, minutes, from: formatTime(v.from).slice(0, 5), to: formatTime(v.to).slice(0, 5), scope: S.describeScope(v.scope, lang), created, replaced: withdraw.size, kept: restricted };
  const edgeText = edges.size ? ` ${tr(lang, "set_headway.edge", { from: words.from, edges: [...edges].join(tr(lang, "common.semicolon")) })}` : "";
  return {
    summary: tr(lang, restricted ? "set_headway.summary_kept" : "set_headway.summary", words) + edgeText,
    warnings: [...new Set(warnings)],
    notes: chain.note ? [chain.note] : [],
    noop: created === 0 && withdraw.size === 0 && !v.perDir.some((x) => x.freqTrips.length),
  };
};

module.exports = {
  type: "set_headway",
  title: "Change the frequency of a line over a period",
  category: "service",
  tables: ["trips", "stop_times", "frequencies", "calendar", "calendar_dates", "transfers"],
  description: "Replace the departures of a line in a time window by a regular series, on the scope's dates only; each day timetable of the line (school days, Wednesdays, holidays…) is rebuilt from its own trips and running times. It REBUILDS the window (the departures in it move onto the series or go): for an extension of the service after its last departure (or before its first), use set_span, which keeps what runs.",
  params: [
    { name: "route", type: "route", required: true, description: "The line (short name, id or long name)." },
    { name: "days", type: "days", required: true, description: "weekday | saturday | sunday | daily | mon…sun, or a list." },
    ...S.SCOPE_PARAMS,
    { name: "from", type: "time", required: true, description: "Start of the window (HH:MM)." },
    { name: "to", type: "time", required: true, description: "End of the window (HH:MM), excluded: the next band starts there." },
    { name: "headway_min", type: "number", required: true, description: "Minutes between departures." },
    { name: "direction", type: "direction", required: false, description: "0, 1, both (default) or a destination." },
    { name: "at_stop", type: "stop", required: false, description: "The stop the window, the headway and start are read at (default: each trip's origin). A headway_max clause measures a line at its trunk, where most trips pass: the step names that stop when it is not where the trips start." },
    { name: "start", type: "time", required: false, description: "First departure of the series (HH:MM), or keep_first: the line's first departure in the window, nothing before it. Default: the series covers the window from `from` on the grid of the line's first departure (kept)." },
    { name: "patterns", type: "enum", enum: PATTERN_MODES, required: false, description: "When the window mixes routes of the line: alternate (keep the mix), main (series on the main route, the others kept), main_only (the others go). Required when variants exist." },
    { name: "regime", type: "enum", enum: REGIMES, required: false, description: "Only when a direction runs both scheduled and frequency-based trips (frequencies.txt) in the window: scheduled (rebuild the scheduled trips), frequencies (set the frequency windows) or both (each at the new headway: their services add up)." },
  ],
  example: { route: "3", days: "weekday", from: "07:00", to: "09:00", headway_min: 8 },
  resolve,
  apply,
};
