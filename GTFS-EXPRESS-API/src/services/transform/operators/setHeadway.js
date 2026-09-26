/**
 * set_headway — "Line 3 every 8 minutes from 7:00 to 9:00 on weekdays."
 *
 * The trips of the route (and direction) that leave in the window on the
 * given days are replaced by a regular series: first departure kept (or the
 * given start), then every `headway_min` until the end of the window.
 *
 *   • Days: a trip whose service also runs on other days is split first
 *     (gtfsOps.isolateDays) so the other days keep their timetable.
 *   • Several services can cover the days (e.g. a school-days service on
 *     top of the weekday one): the series is rebuilt on the PRIMARY service
 *     of each day (the one with most trips in the window); the others are
 *     extras, kept as they are and reported.
 *   • Running times: each new trip copies the original trip nearest in time
 *     (a 7:05 trip runs like the 7:00 one did, peak running times stay peak).
 *   • Patterns: when the window mixes patterns (a variant via the hospital
 *     every other trip) the instruction must say whether to keep the
 *     alternation or run the main pattern only — otherwise it is blocked.
 *   • frequencies.txt: frequency-based trips get their windows split and
 *     the new headway inside [from, to).
 *   • Blocks: new trips have no block_id (vehicle schedules must be re-cut).
 */

"use strict";

const R = require("../resolve");
const G = require("../gtfsOps");
const { _internals: fm } = require("../feedModel");

const { secToTime } = fm;

const resolve = (model, p) => {
  const ambiguities = [];
  const warnings = [];
  const route = R.route(model, p.route);
  if (route.ambiguity) ambiguities.push({ param: "route", ...route.ambiguity });
  const days = R.days(p.days);
  if (days.ambiguity) ambiguities.push({ param: "days", ...days.ambiguity });
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
  if (ambiguities.length) return { ambiguities, warnings };

  const dirs = direction === "both" ? [...new Set([...model.trips.values()].filter((t) => t.route_id === route.value.id).map((t) => t.direction_id))] : [direction];
  const perDir = [];
  for (const d of dirs) {
    const inWin = G.tripsIn(model, { routeId: route.value.id, direction: d, dows: days.value, from: win.value.from, to: win.value.to });
    const freqTrips = [...model.trips.values()].filter((t) => t.route_id === route.value.id && t.direction_id === d && model.frequencies.has(t.id) && [...G.serviceDows(model, t.service_id)].some((x) => days.value.includes(x)) && model.frequencies.get(t.id).some((f) => f.start < win.value.to && f.end > win.value.from));
    const onDays = G.tripsIn(model, { routeId: route.value.id, direction: d, dows: days.value });
    if (!inWin.length && !freqTrips.length && !onDays.length) {
      ambiguities.push({ param: "days", code: "no_service_on_days", message: `Line ${route.value.short_name || route.value.id} has no trip in direction ${d} on these days: adding a new day of service is another operation (add_day_service).` });
      continue;
    }
    const patterns = new Set(inWin.filter((t) => !model.frequencies.has(t.id)).map((t) => t.pattern));
    if (patterns.size > 1 && !["main", "alternate"].includes(p.patterns)) {
      const names = [...patterns].map((k) => {
        const pat = model.patterns.get(k);
        const last = model.stops.get(pat.stops[pat.stops.length - 1]);
        return `${pat.trips.length} trips to ${last?.name || "?"} (${pat.stops.length} stops)`;
      });
      ambiguities.push({ param: "patterns", code: "patterns_mixed", message: `In this window direction ${d} runs ${patterns.size} different routes (${names.join("; ")}). Keep the alternation, or run the main one only?`, options: ["alternate", "main"] });
      continue;
    }
    if (!inWin.length && !freqTrips.length) warnings.push(`Direction ${d}: no trip leaves in the window today; the new trips copy the nearest one in time.`);
    perDir.push({ direction: d, inWin: inWin.filter((t) => !model.frequencies.has(t.id)).map((t) => t.id), freqTrips: freqTrips.map((t) => t.id), nearest: onDays.map((t) => t.id) });
  }
  if (ambiguities.length) return { ambiguities, warnings };
  return { value: { routeId: route.value.id, label: route.value.short_name || route.value.id, dows: days.value, from: win.value.from, to: win.value.to, headway: Math.round(hw.value * 60), start, patternMode: p.patterns || "main", perDir }, ambiguities: [], warnings };
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

const apply = (db, v, { model }) => {
  const warnings = [];
  let created = 0;
  let removed = 0;
  const touchedServices = new Set();
  for (const d of v.perDir) {
    // Frequency-based trips: split their windows around [from, to).
    for (const tid of d.freqTrips) {
      const isolated = G.isolateDays(db, model, [tid], v.dows);
      for (const id of isolated.values()) {
        const rows = db.prepare("SELECT * FROM frequencies WHERE trip_id = ? ORDER BY start_time").all(id);
        db.prepare("DELETE FROM frequencies WHERE trip_id = ?").run(id);
        const ins = db.prepare("INSERT INTO frequencies (trip_id, start_time, end_time, headway_secs, exact_times) VALUES (?, ?, ?, ?, ?)");
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
    }
    if (!d.inWin.length && d.freqTrips.length) continue;

    // Explicit trips: isolate the days, find the primary service of each day.
    const originals = d.inWin.length ? d.inWin : [];
    G.isolateDays(db, model, originals, v.dows);
    const svcOf = new Map(originals.map((id) => [id, db.prepare("SELECT service_id FROM trips WHERE trip_id = ?").get(id).service_id]));
    const bySvc = new Map();
    for (const [id, s] of svcOf) {
      if (!bySvc.has(s)) bySvc.set(s, []);
      bySvc.get(s).push(id);
    }
    // Days each (possibly new) service runs, read back from the sandbox.
    const daysOf = (sid) => {
      const c = db.prepare("SELECT * FROM calendar WHERE service_id = ?").get(sid);
      const out = new Set();
      if (c) for (const [k, col] of Object.entries({ mon: "monday", tue: "tuesday", wed: "wednesday", thu: "thursday", fri: "friday", sat: "saturday", sun: "sunday" })) if (String(c[col]) === "1") out.add(k);
      for (const r of db.prepare("SELECT date FROM calendar_dates WHERE service_id = ? AND exception_type = 1").all(sid)) out.add(fm.dowOf(String(r.date)));
      return out;
    };
    const primary = new Set();
    for (const dow of v.dows) {
      let best = null;
      for (const [s, ids] of bySvc) if (daysOf(s).has(dow) && (!best || ids.length > bySvc.get(best).length)) best = s;
      if (best) primary.add(best);
    }
    const extras = [...bySvc.entries()].filter(([s]) => !primary.has(s));
    if (extras.length) warnings.push(`Direction ${d.direction}: ${extras.reduce((n, [, ids]) => n + ids.length, 0)} extra trip(s) on services running only some of the days (e.g. school days) were kept as they are.`);

    // Templates: when nothing leaves in the window, the nearest trip in time on these days.
    const templatesPool = originals.length ? originals : d.nearest;
    for (const s of primary.size ? primary : new Set([null])) {
      const pool = (s ? bySvc.get(s) : templatesPool).map((id) => model.trips.get(id)).filter(Boolean);
      if (!pool.length) continue;
      const serviceId = s || (() => {
        const near = pool.sort((a, b) => Math.abs(a.first - v.from) - Math.abs(b.first - v.from))[0];
        G.isolateDays(db, model, [near.id], v.dows);
        return db.prepare("SELECT service_id FROM trips WHERE trip_id = ?").get(near.id).service_id;
      })();
      // Patterns: main only, or cycling through them in proportion.
      const counts = new Map();
      for (const t of pool) counts.set(t.pattern, (counts.get(t.pattern) || 0) + 1);
      const shares = [...counts.entries()].map(([key, n]) => ({ key, n })).sort((a, b) => b.n - a.n);
      const next = v.patternMode === "alternate" && shares.length > 1 ? cycler(shares) : () => shares[0].key;
      const first = v.start ?? (s && pool.length ? Math.min(...pool.map((t) => t.first)) : v.from);
      const plan = [];
      for (let t = Math.max(first, v.from); t < v.to; t += v.headway) plan.push(t);
      for (const t of plan) {
        const key = next();
        const candidates = pool.filter((x) => x.pattern === key);
        const tpl = candidates.sort((a, b) => Math.abs(a.first - t) - Math.abs(b.first - t))[0];
        const hhmm = secToTime(t).slice(0, 5).replace(":", "");
        G.cloneTrip(db, tpl.id, { newId: G.uniqueId(db, "trips", "trip_id", `${v.routeId}_${d.direction}_${serviceId}_${hhmm}`), serviceId, shiftSec: t - tpl.first, patch: { block_id: null } });
        created += 1;
      }
      if (s) {
        removed += G.deleteTrips(db, bySvc.get(s));
        touchedServices.add(s);
      }
      if (pool.some((t) => t.block_id)) warnings.push(`Line ${v.label}: trips were in vehicle blocks; the new ones have none (re-cut the vehicle schedules).`);
    }
  }
  G.dropUnusedServices(db, [...touchedServices]);
  const minutes = Math.round(v.headway / 60);
  return {
    summary: `Line ${v.label}: every ${minutes} min from ${secToTime(v.from).slice(0, 5)} to ${secToTime(v.to).slice(0, 5)} on ${v.dows.join(", ")} — ${created} trip(s) created, ${removed} replaced.`,
    warnings: [...new Set(warnings)],
    noop: created === 0 && removed === 0 && !v.perDir.some((x) => x.freqTrips.length),
  };
};

module.exports = {
  type: "set_headway",
  title: "Change the frequency of a line over a period",
  category: "service",
  tables: ["trips", "stop_times", "frequencies", "calendar", "calendar_dates", "transfers"],
  params: [
    { name: "route", type: "route", required: true, description: "The line (short name, id or long name)." },
    { name: "days", type: "days", required: true, description: "weekday | saturday | sunday | daily | mon…sun, or a list." },
    { name: "from", type: "time", required: true, description: "Start of the window (HH:MM)." },
    { name: "to", type: "time", required: true, description: "End of the window (HH:MM), exclusive." },
    { name: "headway_min", type: "number", required: true, description: "Minutes between departures." },
    { name: "direction", type: "direction", required: false, description: "0, 1, both (default) or a destination." },
    { name: "start", type: "time", required: false, description: "First departure of the series (default: keep the first existing one)." },
    { name: "patterns", type: "enum", enum: ["main", "alternate"], required: false, description: "When the window mixes route variants: keep the alternation, or the main one only. Required when variants exist." },
  ],
  example: { route: "3", days: "weekday", from: "07:00", to: "09:00", headway_min: 8 },
  resolve,
  apply,
};
