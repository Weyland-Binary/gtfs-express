/**
 * selection — WHICH trips of a line an instruction means.
 *
 *   "the 9:50, 11:00 and 14:30 departures from Mare Gallot"
 *   "evening journeys (after 20:00)"      "every other trip"
 *   "trips to St-Denis Collège"           "trips via the hospital"
 *
 * Parameters (all optional, combined with AND; `route`, `direction` and the
 * scope are resolved by the caller):
 *   from, to      the departure (at `at_stop`, else at the origin) is in [from, to)
 *   times         ["09:50", "11:00"]: each time must match a departure (± 1 min);
 *                 a time matching nothing is a question with the nearest times
 *   at_stop       the stop the times and the window refer to (default: each trip's origin)
 *   pattern       "main" (the most frequent pattern of each direction), or a
 *                 stop name: trips that end there or pass through it
 *   every         2 → one trip out of two in departure order (`offset` 0|1…)
 *
 *   resolveSelection(model, params, { routeId, direction, scope, lang }) →
 *     { value: { trips: [tripId], describe }, ambiguities, warnings }
 *   (questions and `describe` in `lang`, i18n.js; English by default)
 */

"use strict";

const R = require("./resolve");
const S = require("./scope");
const { _internals: fm } = require("./feedModel");
const { tr } = require("./i18n");

const SELECTION_PARAMS = [
  { name: "from", type: "time", required: false, description: "Only trips departing at or after this time (at at_stop, else at their origin)." },
  { name: "to", type: "time", required: false, description: "Only trips departing before this time (excluded)." },
  { name: "times", type: "times", required: false, description: "Only the trips departing at these times (HH:MM) from at_stop (default: their origin)." },
  { name: "at_stop", type: "stop", required: false, description: "The stop that times, from and to refer to." },
  { name: "pattern", type: "string", required: false, description: "main (the usual route of each direction) or a stop: only trips ending at or passing through it." },
  { name: "every", type: "number", required: false, description: "One trip out of N, in departure order (with offset)." },
  { name: "offset", type: "number", required: false, description: "Which trip of each group of `every` (0 = the first)." },
];

const hhmm = (s) => fm.secToTime(s).slice(0, 5);

const resolveSelection = (model, p, { routeId, direction = "both", scope = null, lang } = {}) => {
  const ambiguities = [];
  const warnings = [];
  let trips = S.tripsInScope(model, { routeId, direction }, scope);
  if (!trips.length) return { value: { trips: [], describe: tr(lang, "selection.no_trip") }, ambiguities, warnings };
  const parts = [];

  // The stop times refer to.
  let atStop = null;
  let atIds = null;
  if (p.at_stop != null && p.at_stop !== "") {
    // The side of the street served in the direction; in both directions,
    // the stops of that name at the same place (one per side) together.
    const s = R.stop(model, p.at_stop, { routeId, direction, group: true, lang });
    if (s.ambiguity) ambiguities.push({ param: "at_stop", ...s.ambiguity });
    else if (!s.value.id) ambiguities.push({ param: "at_stop", code: "stop_unknown", message: tr(lang, "selection.at_stop_new") });
    else {
      atStop = s.value;
      const base = s.many || [s.value];
      // …and their platforms, from the resolver's per-model index (never a walk over every stop per side).
      atIds = new Set(base.flatMap((b) => [b.id, ...R.childrenOf(model, b.id)]));
    }
  }
  const timeAt = (t) => {
    if (!atStop) return t.first;
    const k = t.stops.findIndex((id) => atIds.has(id));
    return k < 0 ? null : t.dep[k] ?? t.arr[k];
  };
  if (atStop) {
    const serving = trips.filter((t) => timeAt(t) != null);
    if (!serving.length) ambiguities.push({ param: "at_stop", code: "stop_not_served", message: tr(lang, "selection.stop_not_served", { stop: atStop.name }) });
    trips = serving;
  }

  // Pattern: the main one, or trips ending at / passing through a stop.
  if (p.pattern != null && p.pattern !== "" && p.pattern !== "all") {
    if (String(p.pattern).toLowerCase() === "main") {
      const main = new Map();
      const count = new Map();
      for (const t of trips) count.set(t.pattern, (count.get(t.pattern) || 0) + 1);
      for (const [k, n] of count) {
        const dir = model.patterns.get(k).direction_id;
        if (!main.has(dir) || n > count.get(main.get(dir))) main.set(dir, k);
      }
      trips = trips.filter((t) => main.get(t.direction_id) === t.pattern);
      parts.push(tr(lang, "selection.main_route"));
    } else {
      const s = R.stop(model, p.pattern, { routeId, allowMany: true, lang });
      if (s.ambiguity) ambiguities.push({ param: "pattern", ...s.ambiguity });
      else {
        const ids = new Set((s.many || [s.value]).map((x) => x.id));
        trips = trips.filter((t) => t.stops.some((id) => ids.has(id)));
        parts.push(tr(lang, "selection.via_to", { stop: s.value.name }));
        if (!trips.length) ambiguities.push({ param: "pattern", code: "pattern_none", message: tr(lang, "selection.pattern_none", { stop: s.value.name }) });
      }
    }
  }

  // Window.
  if ((p.from != null && p.from !== "") || (p.to != null && p.to !== "")) {
    const w = R.window(p.from, p.to, { required: false, lang });
    if (w.ambiguity) ambiguities.push({ param: "from", ...w.ambiguity });
    else {
      trips = trips.filter((t) => {
        const x = timeAt(t);
        return x != null && x >= w.value.from && x < w.value.to;
      });
      const from = hhmm(w.value.from);
      const to = hhmm(w.value.to);
      parts.push(p.from && p.to ? tr(lang, "selection.window_both", { from, to }) : p.from ? tr(lang, "selection.window_from", { from }) : p.to ? tr(lang, "selection.window_to", { to }) : "");
    }
  }

  // Explicit times: each must match. Times given as words (one answer clicked, « 08:00, 09:15 ») are those times —
  // never « every trip »: a string used to be passed over, and the operation reached every trip of the selection.
  const times = Array.isArray(p.times) ? p.times : typeof p.times === "string" ? p.times.split(/[,;]/).map((x) => x.trim()).filter(Boolean) : typeof p.times === "number" ? [String(p.times)] : [];
  if (times.length) {
    const picked = new Set();
    for (const raw of times) {
      const v = R.timeToSec(raw);
      if (v == null) {
        ambiguities.push({ param: "times", code: "time_invalid", message: tr(lang, "resolve.time_invalid", { value: String(raw) }) });
        continue;
      }
      const hits = trips.filter((t) => {
        const x = timeAt(t);
        return x != null && Math.abs(x - v) <= 60;
      });
      if (!hits.length) {
        const near = [...new Set(trips.map(timeAt).filter((x) => x != null))].sort((a, b) => Math.abs(a - v) - Math.abs(b - v)).slice(0, 3).sort((a, b) => a - b);
        const none = atStop ? tr(lang, "selection.time_no_trip_from", { time: String(raw), stop: atStop.name }) : tr(lang, "selection.time_no_trip", { time: String(raw) });
        // `time`: the time asked, as written — an answer replaces that one in the list, the others stay.
        ambiguities.push({ param: "times", code: "time_no_trip", time: String(raw), message: `${none}${near.length ? tr(lang, "selection.nearest", { times: near.map(hhmm).join(", ") }) : ""}`, options: near.map(hhmm) });
        continue;
      }
      const dirs = new Set(hits.map((t) => t.direction_id));
      if (dirs.size > 1 && direction === "both") {
        ambiguities.push({ param: "direction", code: "time_both_directions", message: tr(lang, "selection.time_both_directions", { time: String(raw) }), options: [...dirs] });
        continue;
      }
      hits.forEach((t) => picked.add(t.id));
    }
    trips = trips.filter((t) => picked.has(t.id));
    parts.push(tr(lang, "selection.n_departures", { count: times.length }));
  }

  // One out of N.
  if (p.every != null && p.every !== "") {
    const n = parseInt(p.every, 10);
    const off = parseInt(p.offset ?? 0, 10) || 0;
    if (!(n >= 2)) ambiguities.push({ param: "every", code: "every_invalid", message: tr(lang, "selection.every_invalid") });
    else {
      const byDir = new Map();
      for (const t of trips.sort((a, b) => (timeAt(a) ?? 0) - (timeAt(b) ?? 0))) {
        if (!byDir.has(t.direction_id)) byDir.set(t.direction_id, []);
        byDir.get(t.direction_id).push(t);
      }
      trips = [...byDir.values()].flatMap((list) => list.filter((_, i) => i % n === off % n));
      parts.push(tr(lang, "selection.one_in", { n }));
    }
  }
  return { value: { trips: trips.map((t) => t.id), describe: parts.filter(Boolean).join(", ") || tr(lang, "selection.all_trips"), atStop: atStop ? atStop.id : null }, ambiguities, warnings };
};

module.exports = { resolveSelection, SELECTION_PARAMS };
