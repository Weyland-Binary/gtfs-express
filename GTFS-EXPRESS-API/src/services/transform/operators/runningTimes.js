/**
 * adjust_running_times / set_dwell: the scheduled running times of a line's trips, chosen by line, direction, scope,
 * selection and bands of departures. Trips also running outside the scope are split first.
 * - A band or departure times on trips of several day types, `days` not given, is a question: a peak band is not the
 *   same on a weekday and a Sunday.
 * - adjust_running_times changes a stretch (default the whole trip; each pattern runs it in its own order, a loop's
 *   two runs are a question) by exactly one of factor, add_min or set_min, spread over the hops in proportion; dwells
 *   are kept unless scale_dwells. set_dwell sets the dwell at some stops, later stops shifting by the difference.
 * - The anchor (origin, destination or a stop) keeps its time. Times are cumulative and rounded once each, to the
 *   minute when the trip is in whole minutes. Calls without times stay without, except the stretch's ends and the
 *   anchor: interpolated, they would move with the change.
 * - A frequency-based trip's stop_times are offsets: they change the same way; a band that cuts a window splits it
 *   onto a copy of the trip.
 * - A changed trip overlapping its vehicle block's neighbour is re-chained within the layover, else asked.
 */

"use strict";

const R = require("../resolve");
const G = require("../gtfsOps");
const S = require("../scope");
const B = require("../blocking");
const { resolveSelection, SELECTION_PARAMS } = require("../selection");
const { formatTime, formatHm, parseFeedTime } = require("../../../utils/time");
const { tr, number } = require("../i18n");

const TABLES = ["trips", "stop_times", "frequencies", "calendar", "calendar_dates", "transfers"];
const CHANGE_KINDS = ["factor", "add_min", "set_min"];
const ANCHOR_START = ["origin", "start", "first", "departure", "depart", "origine", "départ"];
const ANCHOR_END = ["destination", "end", "last", "terminus", "arrival", "arrive", "arrivée"];
const MAX_FACTOR = 3;
const MAX_MIN = 300;
const WAS_TOLERANCE_S = 60;
const BIG_CHANGE_PCT = 30;
const LONE_TRIPS = 2; // a whole trip cut by more than BIG_CHANGE_PCT on this many trips at most is asked, not said

// ── small helpers

const given = (v) => v != null && v !== "" && !(Array.isArray(v) && !v.length);
const hhmm = (s) => formatHm(s);
const label = (r) => r.short_name || r.id;
const nameOf = (model, id) => model.stops.get(id)?.name || id;
const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const few = (xs, n = 6) => (xs.length > n ? `${xs.slice(0, n).join(", ")} … (+${xs.length - n})` : xs.join(", "));
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const duration = (sec) => {
  const s = Math.abs(Math.round(sec));
  const m = Math.floor(s / 60);
  if (!m) return `${s} s`;
  return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
};
const signed = (sec) => `${sec < 0 ? "−" : "+"}${duration(sec)}`;
const flag = (v) => {
  if (v === true || v === false) return v;
  const k = String(v ?? "").trim().toLowerCase();
  if (["true", "yes", "1", "oui"].includes(k)) return true;
  if (["false", "no", "0", "non"].includes(k)) return false;
  return null;
};
// "2", "+2", "-1.5", "2 min", "2,5" → minutes; null when unreadable.
const minutesOf = (v) => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const m = /^([-+−]?)\s*(\d+(?:[.,]\d+)?)\s*(?:min|mn|minutes?)?$/i.exec(String(v ?? "").trim());
  if (!m) return null;
  const n = parseFloat(m[2].replace(",", "."));
  return m[1] === "-" || m[1] === "−" ? -n : n;
};
// The same question once (several lines, several bands).
const unique = (ambiguities) => [...new Map(ambiguities.map((a) => [JSON.stringify([a.param, a.code, a.message]), a])).values()];
const timedSelection = (p) => ["from", "to", "bands", "times", "every"].some((k) => given(p[k]));
// `times` as the list selection.js reads: a string would be ignored there, and every trip of the line selected.
const normalize = (p) => {
  const out = { ...p };
  if (given(p.times) && !Array.isArray(p.times)) out.times = String(p.times).split(/[\s,;]+/).filter(Boolean);
  return out;
};
const scopeText = (scope, lang) => (S.isAll(scope) ? tr(lang, "scope.every_day") : S.describeScope(scope, lang));

// A stop's ids: the stops of one place (both sides of a road), a station's platforms.
const placeIds = (model, res) => {
  const ids = new Set((res.many || [res.value]).map((s) => s.id));
  for (const s of model.stops.values()) if (s.parent && ids.has(s.parent)) ids.add(s.id);
  return ids;
};
const occurrences = (stops, ids) => stops.map((s, k) => (ids.has(s) ? k : -1)).filter((k) => k >= 0);

// The model without frequency-based trips: what selection.js may take for single departures.
const _views = new WeakMap();
const explicitView = (model) => {
  if (!_views.has(model)) _views.set(model, { ...model, trips: new Map([...model.trips].filter(([id]) => !model.frequencies.has(id))) });
  return _views.get(model);
};

// ── day types

const DAY_WORDS = { "mon,tue,wed,thu,fri": "weekday", sat: "saturday", sun: "sunday", "sat,sun": "weekend", "mon,tue,wed,thu,fri,sat,sun": "daily" };
// The day labels (values of `days`) as words in a language; other labels are shown as they are.
const DAY_LABEL_WORDS = { weekday: "running_times.day_weekday", saturday: "running_times.day_saturday", sunday: "running_times.day_sunday", weekend: "running_times.day_weekend", daily: "running_times.day_daily" };
const dayLabelWord = (label, lang) => (DAY_LABEL_WORDS[label] ? tr(lang, DAY_LABEL_WORDS[label]) : label);
// The day types a service really runs on the dates of the scope (from its
// dates, not the weekdays its calendar row declares).
const _labels = new WeakMap();
const dayLabel = (model, sid, scope = null) => {
  if (!_labels.has(model)) _labels.set(model, new Map());
  const cache = _labels.get(model);
  const key = S.isAll(scope) ? sid : null;
  if (key != null && cache.has(key)) return cache.get(key);
  const dates = S.activeDates(model, sid).filter((d) => S.isAll(scope) || S.inScope(scope, d, model, sid));
  const dows = new Set(dates.map((d) => S.dayTypeOf(model, sid, d)));
  const k = G.DOW.filter((x) => dows.has(x)).join(",");
  const out = DAY_WORDS[k] || k || String(sid);
  if (key != null) cache.set(key, out);
  return out;
};

// ── parameters

const resolveRoutes = (model, p, ambiguities, lang) => {
  const refs = [];
  const all = [...model.routes.values()].sort((a, b) => byId(a.id, b.id));
  if (given(p.routes)) {
    const list = Array.isArray(p.routes) ? p.routes : String(p.routes).split(/[,;]/);
    if (list.some((x) => String(x).trim().toLowerCase() === "all")) return all;
    refs.push(...list.map((x) => (typeof x === "string" ? x.trim() : x)).filter(given));
  }
  if (given(p.route)) refs.unshift(p.route);
  if (!refs.length) {
    ambiguities.push({ param: "route", ...R.route(model, null, { lang }).ambiguity });
    return [];
  }
  const out = new Map();
  for (const ref of refs) {
    const r = R.route(model, ref, { lang });
    if (r.ambiguity) ambiguities.push({ param: given(p.routes) ? "routes" : "route", ...r.ambiguity });
    else out.set(r.value.id, r.value);
  }
  return [...out.values()];
};

// Bands of departures: `bands` plus from/to; each [from, to) in seconds.
const resolveBands = (p, ambiguities, lang) => {
  const out = [];
  if (given(p.bands)) {
    const list = Array.isArray(p.bands) ? p.bands : typeof p.bands === "object" ? [p.bands] : String(p.bands).split(/[;,]/);
    for (const b of list) {
      let from = null;
      let to = null;
      if (Array.isArray(b)) [from, to] = b;
      else if (b && typeof b === "object") ({ from, to } = b);
      else {
        const parts = String(b).split(/\s*(?:–|—|→|-)\s*|\s+(?:to|à)\s+/i).filter(Boolean);
        if (parts.length === 2) [from, to] = parts;
      }
      if (!given(from) || !given(to)) {
        ambiguities.push({ param: "bands", code: "bands_invalid", message: tr(lang, "running_times.band_invalid", { value: String(typeof b === "object" ? JSON.stringify(b) : b) }) });
        continue;
      }
      const w = R.window(from, to, { lang });
      if (w.ambiguity) ambiguities.push({ param: "bands", ...w.ambiguity });
      else out.push(w.value);
    }
  }
  if (given(p.from) || given(p.to)) {
    const w = R.window(p.from, p.to, { required: false, lang });
    if (w.ambiguity) ambiguities.push({ param: "from", ...w.ambiguity });
    else out.push(w.value);
  }
  return out.sort((a, b) => a.from - b.from);
};

const bandsText = (bands, lang) => bands.map((b) => (b.to >= 48 * 3600 ? tr(lang, "running_times.band_from", { from: hhmm(b.from) }) : b.from === 0 ? tr(lang, "running_times.band_before", { to: hhmm(b.to) }) : tr(lang, "running_times.band", { from: hhmm(b.from), to: hhmm(b.to) }))).join(tr(lang, "running_times.bands_sep"));

const parseAnchor = (p) => {
  if (!given(p.anchor)) return { kind: "origin" };
  const k = String(typeof p.anchor === "object" ? p.anchor.id || p.anchor.name || "" : p.anchor).trim().toLowerCase();
  if (ANCHOR_START.includes(k)) return { kind: "origin" };
  if (ANCHOR_END.includes(k)) return { kind: "destination" };
  return { kind: "stop", ref: p.anchor };
};

// "+10%" → 1.1, 1.1 → 1.1, "110%" → 1.1; an unsigned "10%" is a question.
const parseFactor = (v) => {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 && v <= MAX_FACTOR ? { value: v } : { code: "factor_invalid" };
  const s = String(v).trim().replace(",", ".").replace("−", "-");
  let m = /^([+-])\s*(\d+(?:\.\d+)?)\s*%$/.exec(s);
  if (m) {
    const f = 1 + ((m[1] === "-" ? -1 : 1) * parseFloat(m[2])) / 100;
    return f > 0 && f <= MAX_FACTOR ? { value: Math.round(f * 1e6) / 1e6 } : { code: "factor_invalid" };
  }
  m = /^(\d+(?:\.\d+)?)\s*%$/.exec(s);
  if (m) {
    const n = parseFloat(m[1]);
    if (n === 0) return { value: 1 };
    if (n >= 100 && n / 100 <= MAX_FACTOR) return { value: n / 100 };
    return { code: "factor_ambiguous", n };
  }
  m = /^[x×*]?\s*(\d+(?:\.\d+)?)$/i.exec(s);
  if (m) {
    const f = parseFloat(m[1]);
    return f > 0 && f <= MAX_FACTOR ? { value: f } : { code: "factor_invalid" };
  }
  return { code: "factor_invalid" };
};

const resolveChange = (p, ambiguities, lang) => {
  const kinds = CHANGE_KINDS.filter((k) => given(p[k]));
  if (!kinds.length) {
    ambiguities.push({ param: "factor", code: "change_missing", message: tr(lang, "running_times.change_missing"), options: CHANGE_KINDS });
    return null;
  }
  if (kinds.length > 1) {
    ambiguities.push({ param: kinds[1], code: "change_conflict", message: tr(lang, "running_times.change_conflict", { given: kinds.join(tr(lang, "common.and_sep")) }), options: kinds });
    return null;
  }
  const kind = kinds[0];
  if (kind === "factor") {
    const f = parseFactor(p.factor);
    if (f.code === "factor_ambiguous") {
      ambiguities.push({ param: "factor", code: "factor_ambiguous", message: tr(lang, "running_times.factor_ambiguous", { value: String(p.factor), n: f.n, longer: 1 + f.n / 100, shorter: 1 - f.n / 100 }), options: [`+${f.n}%`, `-${f.n}%`] });
      return null;
    }
    if (f.code) {
      ambiguities.push({ param: "factor", code: "factor_invalid", message: tr(lang, "running_times.factor_invalid", { value: String(p.factor), max: MAX_FACTOR }) });
      return null;
    }
    return { kind: "factor", value: f.value };
  }
  const n = minutesOf(p[kind]);
  if (kind === "add_min") {
    if (n == null || Math.abs(n) > MAX_MIN) {
      ambiguities.push({ param: "add_min", code: "add_min_invalid", message: tr(lang, "running_times.add_min_invalid", { value: String(p.add_min), max: MAX_MIN }) });
      return null;
    }
    return { kind: "add", value: Math.round(n * 60), minutes: n };
  }
  if (n == null || !(n > 0) || n > MAX_MIN * 4) {
    ambiguities.push({ param: "set_min", code: "set_min_invalid", message: tr(lang, "running_times.set_min_invalid", { value: String(p.set_min) }) });
    return null;
  }
  return { kind: "set", value: Math.round(n * 60), minutes: n };
};

const changeText = (c, lang) => {
  if (c.kind === "factor") {
    const pct = Math.round((c.value - 1) * 1000) / 10;
    return tr(lang, "running_times.change_factor", { pct: `${pct >= 0 ? "+" : ""}${number(lang, pct)}`, factor: c.value });
  }
  if (c.kind === "add") return `${c.value < 0 ? "−" : "+"}${duration(c.value)}`;
  return tr(lang, "running_times.change_set", { duration: duration(c.value) });
};

// segment: { from_stop, to_stop }, [from, to], "A → B", or top-level from_stop / to_stop.
const parseSegment = (p, ambiguities, lang) => {
  let s = p.segment;
  if (!given(s) && (given(p.from_stop) || given(p.to_stop))) s = { from_stop: p.from_stop, to_stop: p.to_stop };
  if (!given(s)) return null;
  if (Array.isArray(s)) s = { from_stop: s[0], to_stop: s[1] };
  else if (typeof s === "string") {
    const parts = s.split(/\s*(?:→|->)\s*|\s+(?:–|—|-|to|à)\s+/i).filter(Boolean);
    s = parts.length === 2 ? { from_stop: parts[0], to_stop: parts[1] } : null;
  }
  const from = s && typeof s === "object" ? s.from_stop ?? s.from : null;
  const to = s && typeof s === "object" ? s.to_stop ?? s.to : null;
  if (!given(from) && !given(to)) {
    ambiguities.push({ param: "segment", code: "segment_invalid", message: tr(lang, "running_times.segment_invalid") });
    return null;
  }
  return { from: given(from) ? from : null, to: given(to) ? to : null };
};

// ── selection

/** Single departures through selection.js (once per band); frequency-based trips by their windows' departures in the bands. */
const selectTrips = (model, p, { route, direction, scope, bands, lang }, ambiguities, warnings) => {
  const routeId = route.id;
  const view = explicitView(model);
  const base = { ...p, from: null, to: null, bands: null };
  const pick = (q) => {
    const s = resolveSelection(view, q, { routeId, direction, scope, lang });
    ambiguities.push(...s.ambiguities);
    warnings.push(...s.warnings);
    return new Set(s.value?.trips || []);
  };
  // Departure times are matched once (not once per band: a time outside one
  // band is not "no trip at that time"); the bands then filter them.
  const timed = given(p.times);
  let ids = timed ? [...pick(base)] : [];
  if (bands.length || !timed) {
    const inBands = new Set();
    for (const b of bands.length ? bands : [null]) {
      const q = b ? { ...base, from: formatTime(b.from), to: formatTime(b.to) } : base;
      pick(timed ? { ...q, times: null, every: null } : q).forEach((id) => inBands.add(id));
    }
    ids = timed ? ids.filter((id) => inBands.has(id)) : [...inBands];
  }
  const explicit = ids.sort(byId).map((id) => model.trips.get(id));

  const freqAll = S.tripsInScope(model, { routeId, direction }, scope).filter((t) => model.frequencies.has(t.id)).sort((a, b) => byId(a.id, b.id));
  const freq = [];
  if (!freqAll.length) return { explicit, freq };
  if (given(p.times) || given(p.every)) {
    warnings.push(tr(lang, "running_times.frequency_left", { line: label(route), count: freqAll.length, trips: few(freqAll.map((t) => t.id), 3) }));
    return { explicit, freq };
  }
  let pool = freqAll;
  if (given(p.pattern) && p.pattern !== "all") {
    if (String(p.pattern).toLowerCase() === "main") {
      const count = new Map();
      for (const t of S.tripsInScope(model, { routeId, direction }, scope)) count.set(t.pattern, (count.get(t.pattern) || 0) + 1);
      const main = new Map();
      for (const [k] of [...count.entries()].sort((a, b) => b[1] - a[1] || byId(a[0], b[0]))) {
        const dir = model.patterns.get(k).direction_id;
        if (!main.has(dir)) main.set(dir, k);
      }
      pool = pool.filter((t) => main.get(t.direction_id) === t.pattern);
    } else {
      const s = R.stop(model, p.pattern, { routeId, allowMany: true, lang });
      if (s.ambiguity) {
        ambiguities.push({ param: "pattern", ...s.ambiguity });
        return { explicit, freq };
      }
      const ids = placeIds(model, s);
      pool = pool.filter((t) => t.stops.some((x) => ids.has(x)));
    }
  }
  let atIds = null;
  if (given(p.at_stop)) {
    // As selection.js resolves it for single departures (a name shared by both sides of a road is one place).
    const s = R.stop(model, p.at_stop, { routeId, direction, group: true, lang });
    if (s.ambiguity) {
      ambiguities.push({ param: "at_stop", ...s.ambiguity });
      return { explicit, freq };
    }
    atIds = placeIds(model, s);
  }
  for (const t of pool) {
    if (!bands.length) {
      freq.push({ trip: t, runs: null });
      continue;
    }
    let off = 0;
    if (atIds) {
      const k = t.stops.findIndex((x) => atIds.has(x));
      if (k < 0) continue;
      off = (t.dep[k] ?? t.arr[k]) - t.first;
    }
    // Departures of each window in or out of the bands, as runs on the grid.
    const runs = [];
    let any = false;
    let all = true;
    for (const w of model.frequencies.get(t.id)) {
      let cur = null;
      for (let x = w.start; x < w.end; x += w.headway) {
        const inBand = bands.some((b) => x + off >= b.from && x + off < b.to);
        any = any || inBand;
        all = all && inBand;
        if (!cur || cur.in !== inBand) {
          if (cur) runs.push(cur);
          cur = { in: inBand, start: x, end: x + w.headway, headway: w.headway, src: w.start };
        } else cur.end = x + w.headway;
      }
      if (cur) {
        cur.end = Math.min(cur.end, w.end);
        runs.push(cur);
      }
    }
    if (any) freq.push({ trip: t, runs: all ? null : runs });
  }
  return { explicit, freq };
};

/** What both operators share: lines, scope, bands, direction, anchor and the trips selected on each line. */
const common = async (model, p, ctx, ambiguities, warnings) => {
  const lang = ctx?.lang;
  const start = ambiguities.length;
  const mine = () => ambiguities.length > start;
  const routes = resolveRoutes(model, p, ambiguities, lang);
  const sc = await S.resolveScope(model, p, ctx);
  ambiguities.push(...sc.ambiguities);
  warnings.push(...(sc.warnings || []));
  const bands = resolveBands(p, ambiguities, lang);
  const anchor = parseAnchor(p);
  const blocks = B.resolveBlocks(p, { lang });
  if (blocks.ambiguity) ambiguities.push(blocks.ambiguity);
  // Direction and anchor of each line (they do not need the scope).
  const lines = [];
  for (const route of routes) {
    const d = R.direction(model, route.id, p.direction, { lang });
    if (d.ambiguity) ambiguities.push({ param: "direction", ...d.ambiguity, message: tr(lang, "running_times.line_prefix", { line: label(route), message: d.ambiguity.message }) });
    let anchorIds = null;
    if (anchor.kind === "stop") {
      const s = R.stop(model, anchor.ref, { routeId: route.id, group: true, lang });
      if (s.ambiguity) ambiguities.push({ param: "anchor", ...s.ambiguity, message: tr(lang, "running_times.anchor_hint", { message: s.ambiguity.message }) });
      else anchorIds = placeIds(model, s);
    }
    lines.push({ route, direction: d.value, anchorIds, anchorName: anchorIds ? nameOf(model, [...anchorIds][0]) : null });
  }
  if (mine() || !routes.length) return null;
  const scope = sc.value;
  const selAmb = [];
  for (const l of lines) Object.assign(l, selectTrips(model, p, { route: l.route, direction: l.direction, scope, bands, lang }, selAmb, warnings));
  // selection.js is run once per band: the same question once.
  const seen = new Set();
  for (const a of selAmb) {
    const k = JSON.stringify([a.param, a.code, a.message]);
    if (!seen.has(k)) ambiguities.push(a);
    seen.add(k);
  }
  if (mine()) return null;

  // Nothing selected: a question when no line has anything, else a warning.
  const empty = lines.filter((l) => !l.explicit.length && !l.freq.length);
  const noneAt = (l) => !S.tripsInScope(model, { routeId: l.route.id, direction: l.direction }, scope).length;
  const why = (l) => {
    if (!noneAt(l)) return tr(lang, bands.length ? "running_times.no_match_bands" : "running_times.no_match", { line: label(l.route), bands: bands.length ? bandsText(bands, lang) : "" });
    const dir = l.direction !== "both";
    const days = !S.isAll(scope);
    const code = dir && days ? "running_times.no_trip_direction_days" : dir ? "running_times.no_trip_direction" : days ? "running_times.no_trip_days" : "running_times.no_trip";
    return tr(lang, code, { line: label(l.route), direction: l.direction, scope: days ? scopeText(scope, lang) : "" });
  };
  if (empty.length === lines.length) {
    const selParam = ["bands", "from", "to", "times", "pattern", "every", "at_stop"].find((k) => given(p[k])) || "days";
    for (const l of empty) ambiguities.push({ param: noneAt(l) ? "days" : selParam, code: noneAt(l) ? "no_service_on_days" : "no_trip_selected", message: tr(lang, "running_times.which_trips", { why: why(l) }) });
    return null;
  }
  for (const l of empty) warnings.push(tr(lang, "running_times.left_as_is", { why: why(l) }));

  // A band or departure times on trips of several day types, the days not
  // said: which days? A period or a from_date does not say them (a peak band
  // on a weekday is not the one of a Sunday); given dates do.
  if (!given(p.days) && !given(p.dates) && timedSelection(p)) {
    const labels = [...new Set(lines.flatMap((l) => [...l.explicit, ...l.freq.map((f) => f.trip)]).map((t) => dayLabel(model, t.service_id, scope)))].sort();
    if (labels.length > 1) {
      ambiguities.push({ param: "days", code: "days_missing", message: tr(lang, "running_times.days_missing", { days: labels.map((x) => dayLabelWord(x, lang)).join(", ") }), options: [...labels, "daily"] });
      return null;
    }
  }
  return { scope, bands, anchor, blocks: blocks.value, lines: lines.filter((l) => l.explicit.length || l.freq.length) };
};

// ── times

// All the trip's times are whole minutes — the calls the feed leaves without times (`untimed`: their
// indices) do not count: the model interpolates them to the second.
const wholeMinutes = (t, untimed = null) => t.arr.every((x, k) => x == null || x % 60 === 0 || (untimed && untimed.has(k))) && t.dep.every((x, k) => x == null || x % 60 === 0 || (untimed && untimed.has(k)));

/** The calls without times of these trips, read from the feed: Map(tripId → Set(call index)). */
const untimedCalls = (db, ids) => {
  const out = new Map();
  if (!db || !ids.length) return out;
  const some = new Set();
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const sql = `SELECT DISTINCT trip_id FROM stop_times WHERE trip_id IN (${chunk.map(() => "?").join(",")}) AND (arrival_time IS NULL OR arrival_time = '' OR departure_time IS NULL OR departure_time = '')`;
    db.prepare(sql).all(chunk).forEach((r) => some.add(r.trip_id));
  }
  for (const id of some) {
    const empty = (v) => v == null || v === "";
    out.set(id, new Set(G.stopTimesOf(db, id).map((r, k) => (empty(r.arrival_time) || empty(r.departure_time) ? k : -1)).filter((k) => k >= 0)));
  }
  return out;
};
const hasAllTimes = (t) => t.stops.length >= 2 && t.arr.every((x) => x != null) && t.dep.every((x) => x != null);

/** The stretch [i, j] of a stop sequence the segment names, run either way; a loop's two runs are ambiguous. */
const stretchOf = (stops, seg) => {
  const n = stops.length;
  if (!seg) return { i: 0, j: n - 1 };
  if (!seg.from || !seg.to) {
    const at = occurrences(stops, seg.from || seg.to);
    const runs = at.map((k) => (seg.from ? [k, n - 1] : [0, k])).filter(([a, b]) => a < b);
    if (!runs.length) return { skip: true };
    return runs.length > 1 ? { ambiguous: runs } : { i: runs[0][0], j: runs[0][1] };
  }
  const between = (F, T) => {
    const out = [];
    for (const f of F) {
      const t = T.find((x) => x > f);
      if (t == null || F.some((g) => g > f && g < t)) continue;
      out.push([f, t]);
    }
    return out;
  };
  const F = occurrences(stops, seg.from);
  const T = occurrences(stops, seg.to);
  let runs = between(F, T);
  let reversed = false;
  if (!runs.length) {
    runs = between(T, F);
    reversed = runs.length > 0;
  }
  if (!runs.length) return { skip: true };
  if (runs.length > 1) return { ambiguous: runs };
  return { i: runs[0][0], j: runs[0][1], reversed };
};

/**
 * New times of a trip whose stretch [i, j] changes (origin anchored): hops take the change in proportion to their
 * current time; dwells inside the stretch are kept unless scaleDwells.
 */
const retime = (t, i, j, change, { scaleDwells = false, minutes = false } = {}) => {
  const n = t.stops.length;
  const parts = [];
  for (let k = i; k < j; k++) {
    parts.push({ hop: true, s: t.arr[k + 1] - t.dep[k] });
    if (k + 1 < j) parts.push({ hop: false, s: t.dep[k + 1] - t.arr[k + 1] });
  }
  // A negative source part (times already going backwards) is left as it is.
  const scalable = (x) => x.s >= 0 && (x.hop || scaleDwells);
  const s0 = parts.filter(scalable).reduce((a, x) => a + x.s, 0);
  const fixed = parts.filter((x) => !scalable(x)).reduce((a, x) => a + x.s, 0);
  const count = parts.filter(scalable).length;
  const target = change.kind === "factor" ? s0 * change.value : change.kind === "add" ? s0 + change.value : change.value - fixed;
  if (target < 0 || (!count && target !== s0)) return { negative: { before: s0 + fixed, fixed } };
  const next = parts.map((x) => (!scalable(x) ? x.s : s0 > 0 ? (x.s * target) / s0 : target / count));
  const round = minutes ? (x) => Math.round(x / 60) * 60 : (x) => Math.round(x);
  const arr = t.arr.slice();
  const dep = t.dep.slice();
  let cum = t.dep[i];
  let q = 0;
  for (let k = i; k < j; k++) {
    cum += next[q++];
    arr[k + 1] = round(cum);
    if (k + 1 < j) {
      cum += next[q++];
      dep[k + 1] = round(cum);
    }
  }
  dep[j] = arr[j] + (t.dep[j] - t.arr[j]);
  const delta = arr[j] - t.arr[j];
  for (let k = j + 1; k < n; k++) {
    arr[k] = t.arr[k] + delta;
    dep[k] = t.dep[k] + delta;
  }
  return { arr, dep, before: t.arr[j] - t.dep[i], after: arr[j] - dep[i] };
};

/** New times of a trip whose dwell at `targets` (call indices) becomes `sec` (origin anchored). */
const redwell = (t, targets, sec) => {
  const n = t.stops.length;
  const arr = [];
  const dep = [];
  let delta = 0;
  for (let k = 0; k < n; k++) {
    let a = t.arr[k] + delta;
    let d = t.dep[k] + delta;
    if (targets.has(k)) {
      if (k === 0) a = d - sec;
      else if (k === n - 1) d = a + sec;
      else {
        delta += a + sec - d;
        d = a + sec;
      }
    }
    arr.push(a);
    dep.push(d);
  }
  return { arr, dep };
};

// The shift that keeps the anchor's time (0 for the origin).
const anchorShift = (t, arr, anchor, ax) => {
  if (anchor.kind === "origin") return 0;
  if (anchor.kind === "destination") return t.arr[t.stops.length - 1] - arr[t.stops.length - 1];
  return t.arr[ax] - arr[ax];
};
const shifted = (xs, s) => (s ? xs.map((x) => x + s) : xs);
const sameTimes = (t, x) => x.arr.every((v, k) => v === t.arr[k]) && x.dep.every((v, k) => v === t.dep[k]);

/** The pattern's call at the anchor stop (null for origin / destination); it must be called exactly once. */
const anchorIndex = (stops, line) => {
  if (!line.anchorIds) return { ax: null };
  const at = occurrences(stops, line.anchorIds);
  if (!at.length) return { problem: "not_served" };
  if (at.length > 1) return { problem: "ambiguous" };
  return { ax: at[0] };
};

/**
 * Turn per-trip computations into plans and the questions they raise.
 * `compute(t, pattern)` → { arr, dep, before?, after?, forced? } | { skip } | { problem }.
 */
const buildPlans = (model, c, compute, ambiguities, warnings, lang) => {
  const out = [];
  const early = [];
  for (const l of c.lines) {
    const plans = [];
    const freqPlans = [];
    const handle = (t, isFreq, runs) => {
      if (!hasAllTimes(t)) {
        warnings.push(tr(lang, "running_times.unreadable_times", { trip: t.id }));
        return;
      }
      const r = compute(t, l);
      if (!r || r.skip) return;
      if (r.problem) return;
      const ax = anchorIndex(t.stops, l).ax;
      const s = anchorShift(t, r.arr, c.anchor, ax);
      // Calls that must carry a time even when the feed leaves them empty: set_dwell's stops, the
      // stretch's ends and the anchor (else consumers interpolate them between the new times).
      const forced = [...new Set([...(r.forced || []), ...(ax != null ? [ax] : [])])].sort((a, b) => a - b);
      if (isFreq) {
        // The template keeps its first stop; the windows move by the anchor's shift.
        const wins = runs || model.frequencies.get(t.id).map((w) => ({ in: true, start: w.start, end: w.end, headway: w.headway, src: w.start }));
        if (s && wins.some((w) => w.in && w.start + s < 0)) early.push(tr(lang, "running_times.frequencies_item", { trip: t.id }));
        // Template times only count as offsets from its first departure: a dwell at its origin
        // that would put the first arrival before 00:00 lifts the whole template instead.
        const lift = Math.max(0, -Math.min(r.arr[0], r.dep[0]));
        const tpl = lift ? { arr: shifted(r.arr, lift), dep: shifted(r.dep, lift) } : r;
        freqPlans.push({ id: t.id, direction: t.direction_id, arr: tpl.arr, dep: tpl.dep, shift: s, runs: wins, split: Boolean(runs), before: r.before, after: r.after, forced, changed: !sameTimes(t, tpl) || s !== 0 });
        return;
      }
      const arr = shifted(r.arr, s);
      const dep = shifted(r.dep, s);
      if (Math.min(arr[0], dep[0]) < 0) early.push(`${hhmm(t.first)} (${t.id})`);
      plans.push({ id: t.id, direction: t.direction_id, arr, dep, before: r.before, after: r.after, forced, originShift: dep[0] - t.dep[0], changed: !sameTimes(t, { arr, dep }) });
    };
    for (const t of l.explicit) handle(t, false, null);
    for (const f of l.freq) handle(f.trip, true, f.runs);
    out.push({ ...l, plans, freqPlans });
  }
  if (early.length) ambiguities.push({ param: "anchor", code: "time_before_midnight", message: tr(lang, "running_times.before_midnight", { trips: few(early) }) });
  return out;
};

// Anchors every changed pattern must call once.
const checkAnchors = (model, c, patternKeys, ambiguities, lang) => {
  if (c.anchor.kind !== "stop") return;
  for (const l of c.lines) {
    for (const key of patternKeys(l)) {
      const pat = model.patterns.get(key);
      const a = anchorIndex(pat.stops, l);
      const what = tr(lang, "running_times.pattern_what", { line: label(l.route), direction: pat.direction_id, stop: nameOf(model, pat.stops[pat.stops.length - 1]) });
      if (a.problem === "not_served") ambiguities.push({ param: "anchor", code: "anchor_not_served", message: tr(lang, "running_times.anchor_not_served", { what, anchor: l.anchorName }), options: ["origin", "destination"] });
      if (a.problem === "ambiguous") ambiguities.push({ param: "anchor", code: "anchor_ambiguous", message: tr(lang, "running_times.anchor_ambiguous", { what, anchor: l.anchorName }), options: ["origin", "destination"] });
    }
  }
};

// ── consequences

// Vehicle blocks are the apply's (blocking.rechainBlocks, on the times written).
const consequences = (model, c, lines, warnings, lang) => {
  if (c.anchor.kind === "origin") return;
  for (const l of lines) {
    for (const dir of [...new Set(l.plans.map((pl) => pl.direction))].sort()) {
      const moves = [...new Set(l.plans.filter((pl) => pl.direction === dir && pl.changed).map((pl) => pl.originShift))].sort((a, b) => a - b);
      if (!moves.length || (moves.length === 1 && moves[0] === 0)) continue;
      const words = { line: label(l.route), direction: dir };
      if (moves.length === 1) warnings.push(tr(lang, "running_times.origin_all_move", { ...words, duration: duration(moves[0]), later: moves[0] >= 0 }));
      else warnings.push(tr(lang, "running_times.origin_moves", { ...words, from: signed(moves[0]), to: signed(moves[moves.length - 1]), spread: duration(moves[moves.length - 1] - moves[0]) }));
    }
  }
};

// Median before → after per line and direction.
const medians = (lines) =>
  lines.flatMap((l) => {
    const all = [...l.plans, ...l.freqPlans].filter((pl) => pl.before != null);
    return [...new Set(all.map((pl) => pl.direction))].sort().map((dir) => {
      const xs = all.filter((pl) => pl.direction === dir);
      return { line: label(l.route), dir, before: median(xs.map((x) => x.before)), after: median(xs.map((x) => x.after)) };
    });
  });
const mediansText = (ms, many, lang) => ms.map((m) => tr(lang, many ? "running_times.median_line_dir" : "running_times.median_dir", { line: m.line, direction: m.dir, before: duration(m.before), after: duration(m.after) })).join(", ");

// ── writing

const transferCount = (db, ids) => {
  if (!ids.length || !db.prepare("PRAGMA table_info(transfers)").all().some((c) => c.name === "from_trip_id")) return 0;
  let n = 0;
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const ph = chunk.map(() => "?").join(",");
    n += db.prepare(`SELECT COUNT(*) AS n FROM transfers WHERE from_trip_id IN (${ph}) OR to_trip_id IN (${ph})`).get([...chunk, ...chunk]).n;
  }
  return n;
};

/** Writes a trip's new times; empty times stay empty (consumers interpolate them) unless the call is forced. */
const writeTimes = (db, tripId, plan, forced = null) => {
  const rows = G.stopTimesOf(db, tripId);
  if (rows.length !== plan.arr.length) throw new Error(`trip ${tripId}: ${rows.length} stop_times rows, ${plan.arr.length} expected`);
  const upd = db.prepare("UPDATE stop_times SET arrival_time = ?, departure_time = ? WHERE trip_id = ? AND stop_sequence = ?");
  let timed = 0;
  rows.forEach((r, k) => {
    const force = forced && forced.has(k);
    const pick = (old, v) => {
      if (old == null || old === "") return force ? formatTime(v) : old;
      return parseFeedTime(old) === v ? old : formatTime(v);
    };
    const a = pick(r.arrival_time, plan.arr[k]);
    const d = pick(r.departure_time, plan.dep[k]);
    if (force && (r.arrival_time == null || r.arrival_time === "" || r.departure_time == null || r.departure_time === "")) timed += 1;
    if (a !== r.arrival_time || d !== r.departure_time) upd.run(a, d, tripId, r.stop_sequence);
  });
  return timed;
};

const writeWindows = (db, tripId, wins, sourceRows) => {
  db.prepare("DELETE FROM frequencies WHERE trip_id = ?").run(tripId);
  const ins = db.prepare("INSERT INTO frequencies (trip_id, start_time, end_time, headway_secs, exact_times) VALUES (?, ?, ?, ?, ?)");
  for (const w of [...wins].sort((a, b) => a.start - b.start)) {
    const src = sourceRows.find((r) => parseFeedTime(r.start_time) === w.src);
    ins.run(tripId, formatTime(w.start), formatTime(w.end), src ? src.headway_secs : w.headway, src ? src.exact_times : 0);
  }
};

const windowsText = (wins) => wins.map((w) => `${hhmm(w.start)}–${hhmm(w.end)}`).join(", ");

const writePlans = (db, model, v, lang) => {
  const ids = v.lines.flatMap((l) => [...l.plans.filter((pl) => pl.changed).map((pl) => pl.id), ...l.freqPlans.filter((pl) => pl.changed).map((pl) => pl.id)]);
  const inScope = new Set(S.isolateScope(db, model, ids, v.scope));
  let trips = 0;
  let freq = 0;
  let departures = 0;
  let timed = 0;
  const windows = [];
  const touched = [];
  const lines = new Set();
  for (const l of v.lines) {
    for (const pl of l.plans) {
      if (!pl.changed || !inScope.has(pl.id)) continue;
      timed += writeTimes(db, pl.id, pl, new Set(pl.forced));
      touched.push(pl.id);
      lines.add(l.route.id);
      trips += 1;
    }
    for (const pl of l.freqPlans) {
      if (!pl.changed || !inScope.has(pl.id)) continue;
      const rows = db.prepare("SELECT * FROM frequencies WHERE trip_id = ? ORDER BY start_time").all(pl.id);
      const moved = pl.runs.filter((w) => w.in).map((w) => ({ ...w, start: w.start + pl.shift, end: w.end + pl.shift }));
      let target = pl.id;
      if (pl.split) {
        target = G.cloneTrip(db, pl.id, { newId: G.uniqueId(db, "trips", "trip_id", `${pl.id}_rt`) });
        G.copyTripTransfers(db, pl.id, target);
        writeWindows(db, pl.id, pl.runs.filter((w) => !w.in), rows);
        windows.push(tr(lang, "running_times.windows_split", { trip: pl.id, moved: windowsText(moved), copy: target, kept: windowsText(pl.runs.filter((w) => !w.in)) }));
      } else if (pl.shift) windows.push(tr(lang, "running_times.windows_moved", { trip: pl.id, before: windowsText(pl.runs), after: windowsText(moved) }));
      if (pl.split || pl.shift) writeWindows(db, target, moved, rows);
      timed += writeTimes(db, target, pl, new Set(pl.forced));
      touched.push(target);
      lines.add(l.route.id);
      freq += 1;
      departures += moved.reduce((n, w) => n + Math.ceil((w.end - w.start) / w.headway), 0);
    }
  }
  const counted = [trips ? tr(lang, "running_times.n_trips", { count: trips }) : "", freq ? tr(lang, "running_times.n_frequency_trips", { count: freq, departures }) : ""].filter(Boolean).join(tr(lang, "common.and_sep")) || tr(lang, "running_times.n_trips", { count: 0 });
  const changed = v.lines.filter((l) => lines.has(l.route.id));
  return { trips: counted, lines: changed.length ? changed : v.lines, windows, timed, transfers: transferCount(db, [...new Set(touched)]), ids: [...new Set(touched)] };
};

const linesLabel = (lines, lang) => tr(lang, "running_times.lines", { count: lines.length, names: lines.map((l) => label(l.route)).join(", ") });
const anchorText = (c, lines, lang) => (c.anchor.kind === "origin" ? tr(lang, "running_times.anchor_origin") : c.anchor.kind === "destination" ? tr(lang, "running_times.anchor_destination") : tr(lang, "running_times.anchor_stop", { stop: lines[0].anchorName }));
const selectionText = (p, c, lang) => {
  const parts = [];
  if (c.bands.length) parts.push(tr(lang, "running_times.sel_departing", { bands: bandsText(c.bands, lang) }));
  if (given(p.times)) parts.push(tr(lang, "running_times.sel_times", { count: [].concat(p.times).length }));
  if (given(p.pattern) && p.pattern !== "all") parts.push(String(p.pattern).toLowerCase() === "main" ? tr(lang, "running_times.sel_main") : tr(lang, "running_times.sel_via", { stop: String(p.pattern) }));
  if (given(p.every)) parts.push(tr(lang, "running_times.sel_every", { n: String(p.every) }));
  return parts.join(", ");
};

// ── adjust_running_times

const resolveAdjust = async (model, params, ctx) => {
  const lang = ctx?.lang;
  const p = normalize(params);
  const ambiguities = [];
  const warnings = [];
  const change = resolveChange(p, ambiguities, lang);
  const seg = parseSegment(p, ambiguities, lang);
  const scaleDwells = given(p.scale_dwells) ? flag(p.scale_dwells) : false;
  if (scaleDwells == null) ambiguities.push({ param: "scale_dwells", code: "scale_dwells_invalid", message: tr(lang, "common.flag_invalid", { name: "scale_dwells" }), options: ["true", "false"] });
  let was = null;
  if (given(p.was_min)) {
    was = minutesOf(p.was_min);
    if (was == null || was <= 0) ambiguities.push({ param: "was_min", code: "was_min_invalid", message: tr(lang, "adjust_running_times.was_min_invalid", { value: String(p.was_min) }) });
  }
  const c = await common(model, p, ctx, ambiguities, warnings);
  if (!c) return { ambiguities: unique(ambiguities), warnings };

  // The stretch on each line (stops resolved on that line).
  for (const l of c.lines) {
    l.seg = null;
    if (!seg) continue;
    const ends = {};
    for (const k of ["from", "to"]) {
      if (!seg[k]) continue;
      const s = R.stop(model, seg[k], { routeId: l.route.id, group: true, lang });
      if (s.ambiguity) ambiguities.push({ param: "segment", ...s.ambiguity, message: tr(lang, "adjust_running_times.segment_prefix", { param: k === "from" ? "from_stop" : "to_stop", message: s.ambiguity.message }) });
      else ends[k] = placeIds(model, s);
    }
    if (ends.from && ends.to && [...ends.from].some((x) => ends.to.has(x))) ambiguities.push({ param: "segment", code: "segment_invalid", message: tr(lang, "adjust_running_times.segment_same_stop") });
    l.seg = { from: ends.from || null, to: ends.to || null, fromName: ends.from ? nameOf(model, [...ends.from][0]) : null, toName: ends.to ? nameOf(model, [...ends.to][0]) : null };
    const dirs = new Set([...l.explicit, ...l.freq.map((f) => f.trip)].map((t) => t.direction_id));
    if ((!seg.from || !seg.to) && dirs.size > 1) ambiguities.push({ param: "segment", code: "segment_end_missing", message: seg.from ? tr(lang, "adjust_running_times.segment_end_from", { line: label(l.route), stop: l.seg.fromName }) : tr(lang, "adjust_running_times.segment_end_to", { line: label(l.route), stop: l.seg.toName }), options: ["0", "1"] });
  }
  if (ambiguities.length) return { ambiguities: unique(ambiguities), warnings };

  // Stretches per pattern: skipped, ambiguous, reversed.
  const stretch = new Map();
  const changedPatterns = (l) => [...new Set([...l.explicit, ...l.freq.map((f) => f.trip)].map((t) => t.pattern))].filter((k) => stretch.get(k) && stretch.get(k).i != null).sort(byId);
  let served = 0;
  for (const l of c.lines) {
    const byPattern = new Map();
    for (const t of [...l.explicit, ...l.freq.map((f) => f.trip)]) byPattern.set(t.pattern, (byPattern.get(t.pattern) || 0) + 1);
    for (const [key, n] of [...byPattern.entries()].sort((a, b) => byId(a[0], b[0]))) {
      const pat = model.patterns.get(key);
      const st = stretchOf(pat.stops, l.seg);
      stretch.set(key, st);
      const words = { line: label(l.route), direction: pat.direction_id, count: n, stop: nameOf(model, pat.stops[pat.stops.length - 1]) };
      const what = tr(lang, "adjust_running_times.pattern_what", words);
      if (st.skip) warnings.push(tr(lang, l.seg.from && l.seg.to ? "adjust_running_times.skip_between" : l.seg.from ? "adjust_running_times.skip_from" : "adjust_running_times.skip_to", { ...words, from: l.seg.fromName || "", to: l.seg.toName || "" }));
      else if (st.ambiguous) ambiguities.push({ param: "segment", code: "segment_ambiguous", message: tr(lang, "adjust_running_times.segment_loop", { what, count: st.ambiguous.length, calls: st.ambiguous.map((r) => r[0] + 1).join(tr(lang, "common.or_sep")) }), options: st.ambiguous.map((r) => tr(lang, "adjust_running_times.call_option", { from: nameOf(model, pat.stops[r[0]]), i: r[0] + 1, to: nameOf(model, pat.stops[r[1]]), j: r[1] + 1 })) });
      else {
        served += n;
        if (st.reversed && l.direction !== "both") warnings.push(tr(lang, "adjust_running_times.reversed", { what, to: l.seg.toName, from: l.seg.fromName }));
      }
    }
  }
  if (!served && !ambiguities.length) {
    const l = c.lines[0];
    const main = l.route.patterns[0];
    const message = l.seg.from && l.seg.to ? tr(lang, "adjust_running_times.not_served_between", { from: l.seg.fromName, to: l.seg.toName, line: label(l.route) }) : tr(lang, "adjust_running_times.not_served_span", { from: l.seg.fromName || tr(lang, "adjust_running_times.origin"), to: l.seg.toName || tr(lang, "adjust_running_times.terminus"), line: label(l.route) });
    ambiguities.push({ param: "segment", code: "segment_not_served", message, options: main ? main.stops.map((s) => nameOf(model, s)) : [] });
  }
  checkAnchors(model, c, changedPatterns, ambiguities, lang);

  // set_min is one running time: every selected trip must run the same stops on the stretch.
  if (change.kind === "set") {
    for (const l of c.lines) {
      for (const dir of ["0", "1"]) {
        const seqs = new Map();
        for (const key of changedPatterns(l)) {
          const pat = model.patterns.get(key);
          if (pat.direction_id !== dir) continue;
          const st = stretch.get(key);
          const k = pat.stops.slice(st.i, st.j + 1).join(">");
          if (!seqs.has(k)) seqs.set(k, { pat, st, n: 0 });
          seqs.get(k).n += pat.trips.length;
        }
        if (seqs.size < 2) continue;
        const list = [...seqs.values()].sort((a, b) => b.n - a.n);
        const texts = list.map((x) => tr(lang, "adjust_running_times.sequence_item", { from: nameOf(model, x.pat.stops[x.st.i]), to: nameOf(model, x.pat.stops[x.st.j]), count: x.st.j - x.st.i + 1 }));
        // Answers: the main route, or a stop only one of the sequences passes.
        const inStretch = (x) => x.pat.stops.slice(x.st.i, x.st.j + 1);
        const own = list.map((x) => inStretch(x).find((sid) => list.every((y) => y === x || !inStretch(y).includes(sid)))).filter(Boolean);
        ambiguities.push({ param: "pattern", code: "patterns_mixed", message: tr(lang, "adjust_running_times.patterns_mixed", { line: label(l.route), direction: dir, count: seqs.size, sequences: texts.join(tr(lang, "common.semicolon")) }), options: ["main", ...new Set(own.map((sid) => nameOf(model, sid)))] });
      }
    }
  }
  if (ambiguities.length) return { ambiguities: unique(ambiguities), warnings };

  // New times, trip by trip.
  let rounded = 0;
  let dwells = false;
  const negative = [];
  const untimed = untimedCalls(ctx?.db, c.lines.flatMap((l) => [...l.explicit, ...l.freq.map((f) => f.trip)].map((t) => t.id)));
  const compute = (t) => {
    const st = stretch.get(t.pattern);
    if (!st || st.i == null) return { skip: true };
    for (let k = st.i + 1; k < st.j && !dwells; k++) dwells = t.dep[k] > t.arr[k];
    const minutes = wholeMinutes(t, untimed.get(t.id)) && (change.kind === "factor" || change.value % 60 === 0);
    const r = retime(t, st.i, st.j, change, { scaleDwells, minutes });
    if (r.negative) {
      negative.push({ t, ...r.negative });
      return { problem: true };
    }
    if (minutes && !sameTimes(t, r)) rounded += 1;
    return { ...r, forced: [st.i, st.j] };
  };
  const lines = buildPlans(model, c, compute, ambiguities, warnings, lang);
  if (negative.length) {
    const shortest = negative.reduce((a, x) => (x.before < a.before ? x : a));
    const what = change.kind === "set" ? tr(lang, "adjust_running_times.negative_set", { duration: duration(change.value), dwells: duration(shortest.fixed) }) : tr(lang, "adjust_running_times.negative_change", { change: changeText(change, lang), shortest: duration(shortest.before) });
    ambiguities.push({ param: change.kind === "set" ? "set_min" : change.kind === "add" ? "add_min" : "factor", code: "running_time_negative", message: tr(lang, "adjust_running_times.negative", { what, count: negative.length, trips: few(negative.map((x) => `${hhmm(x.t.first)} ${x.t.id}`), 3) }) });
  }
  if (ambiguities.length) return { ambiguities: unique(ambiguities), warnings };

  const ms = medians(lines);
  if (was != null) {
    const all = lines.flatMap((l) => [...l.plans, ...l.freqPlans]).map((pl) => pl.before);
    const m = median(all);
    if (Math.abs(m - was * 60) > WAS_TOLERANCE_S) warnings.push(tr(lang, "adjust_running_times.was_differs", { was: duration(was * 60), median: duration(m), min: duration(Math.min(...all)), max: duration(Math.max(...all)) }));
  }
  if (rounded) warnings.push(tr(lang, change.kind === "factor" ? "adjust_running_times.rounded" : "adjust_running_times.rounded_exact", { count: rounded }));
  // A running time changing by more than BIG_CHANGE_PCT is said, never asked: real briefs often change a third.
  // Except a whole trip, alone or with one other, cut that much: a bus does not run a third faster on one trip, so a
  // trip that must arrive at another time is moved (shift_trips) and this cut is asked unless confirmed.
  const confirmed = String(p.change_confirmed || "").trim().toLowerCase() === "confirm";
  const selected = lines.reduce((n, l) => n + l.plans.length + l.freqPlans.length, 0);
  for (const m of ms) {
    const pct = m.before ? Math.round(((m.after - m.before) / m.before) * 100) : 0;
    if (Math.abs(pct) <= BIG_CHANGE_PCT) continue;
    const words = { line: m.line, direction: m.dir, pct: `${pct > 0 ? "+" : ""}${number(lang, pct)}`, before: duration(m.before), after: duration(m.after) };
    if (selected <= LONE_TRIPS && !seg && pct < 0 && !confirmed) ambiguities.push({ param: "change_confirmed", code: "single_trip_big_change", message: tr(lang, "adjust_running_times.single_trip_big_change", { ...words, count: selected }), options: ["confirm"] });
    else warnings.push(tr(lang, "adjust_running_times.big_change", words));
  }
  if (ambiguities.length) return { ambiguities: unique(ambiguities), warnings };
  consequences(model, c, lines, warnings, lang);
  const noop = lines.every((l) => l.plans.every((pl) => !pl.changed) && l.freqPlans.every((pl) => !pl.changed));
  const s0 = lines[0].seg;
  const segText = seg ? (s0.from && s0.to ? tr(lang, "adjust_running_times.seg_both", { from: s0.fromName, to: s0.toName }) : s0.from ? tr(lang, "adjust_running_times.seg_from", { from: s0.fromName }) : tr(lang, "adjust_running_times.seg_to", { to: s0.toName })) : tr(lang, "adjust_running_times.seg_whole");
  const dwellsText = change.kind === "factor" && dwells && !scaleDwells ? tr(lang, "adjust_running_times.dwells_kept") : scaleDwells ? tr(lang, "adjust_running_times.dwells_scaled") : null;
  return {
    value: { kind: "adjust", scope: c.scope, anchor: c.anchor, blocks: c.blocks, lines, noop, texts: { change: changeText(change, lang), dwells: dwellsText, seg: segText, sel: selectionText(p, c, lang), anchor: anchorText(c, lines, lang), medians: mediansText(ms, lines.length > 1, lang) } },
    ambiguities: [],
    warnings: [...new Set(warnings)],
  };
};

const applyAdjust = (db, v, { model, lang } = {}) => {
  const which = [v.texts.seg, v.texts.sel, scopeText(v.scope, lang)].filter(Boolean).join(tr(lang, "common.semicolon"));
  if (v.noop) return { summary: tr(lang, "adjust_running_times.noop", { lines: linesLabel(v.lines, lang), change: v.texts.change, which }), noop: true };
  const where = [which, v.texts.dwells].filter(Boolean).join(tr(lang, "common.semicolon"));
  const out = writePlans(db, model, v, lang);
  const blocks = B.chainOutcome([B.rechainBlocks(db, model, out.ids, { policy: v.blocks })], { lang });
  const warnings = [];
  if (out.timed) warnings.push(tr(lang, "adjust_running_times.timed_calls", { count: out.timed }));
  if (out.windows.length) warnings.push(tr(lang, "running_times.frequency_service", { windows: out.windows.join(tr(lang, "common.semicolon")) }));
  if (out.transfers) warnings.push(tr(lang, "running_times.transfers_named", { count: out.transfers }));
  warnings.push(...blocks.warnings);
  // The lines really changed (a line whose trips all miss the segment is only warned).
  return {
    summary: tr(lang, "adjust_running_times.summary", { lines: linesLabel(out.lines, lang), change: v.texts.change, trips: out.trips, where, medians: v.texts.medians, anchor: v.texts.anchor }),
    warnings,
    ...(blocks.notes.length ? { notes: blocks.notes } : {}),
  };
};

// ── set_dwell

// "30", 30, "30 s", "1 min", "1:30" → seconds.
const secondsOf = (v) => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v ?? "").trim().toLowerCase().replace(",", ".");
  let m = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?)?$/.exec(s);
  if (m) return parseFloat(m[1]);
  m = /^(\d+(?:\.\d+)?)\s*(min|mn|minutes?)$/.exec(s);
  if (m) return parseFloat(m[1]) * 60;
  m = /^(\d+):(\d{2})$/.exec(s);
  if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  return null;
};

const resolveDwell = async (model, params, ctx) => {
  const lang = ctx?.lang;
  const p = normalize(params);
  const ambiguities = [];
  const warnings = [];
  let sec = null;
  if (!given(p.seconds)) ambiguities.push({ param: "seconds", code: "seconds_missing", message: tr(lang, "set_dwell.seconds_missing") });
  else {
    sec = secondsOf(p.seconds);
    if (sec == null || sec < 0 || sec > 3600) {
      ambiguities.push({ param: "seconds", code: "seconds_invalid", message: tr(lang, "set_dwell.seconds_invalid", { value: String(p.seconds) }) });
      sec = null;
    } else sec = Math.round(sec);
  }
  const c = await common(model, p, ctx, ambiguities, warnings);
  if (!c) return { ambiguities: unique(ambiguities), warnings };

  // The stops, resolved on each line; none listed = every intermediate stop.
  const refs = given(p.stops) ? (Array.isArray(p.stops) ? p.stops : [p.stops]).filter(given) : [];
  const names = [];
  for (const l of c.lines) {
    l.stopIds = null;
    if (!refs.length) continue;
    l.stopIds = new Set();
    for (const ref of refs) {
      const s = R.stop(model, ref, { routeId: l.route.id, group: true, lang });
      if (s.ambiguity) ambiguities.push({ param: "stops", ...s.ambiguity });
      else {
        placeIds(model, s).forEach((x) => l.stopIds.add(x));
        if (!names.includes(s.value.name)) names.push(s.value.name);
      }
    }
  }
  if (ambiguities.length) return { ambiguities: unique(ambiguities), warnings };
  const targetsOf = (t, l) => {
    const n = t.stops.length;
    if (!l.stopIds) return new Set(Array.from({ length: Math.max(0, n - 2) }, (_, k) => k + 1));
    return new Set(occurrences(t.stops, l.stopIds));
  };
  let calls = 0;
  const unserved = new Map();
  for (const l of c.lines) {
    for (const t of [...l.explicit, ...l.freq.map((f) => f.trip)]) {
      const n = targetsOf(t, l).size;
      calls += n;
      if (!n) unserved.set(t.pattern, (unserved.get(t.pattern) || 0) + 1);
    }
  }
  if (!calls) {
    ambiguities.push({ param: "stops", code: "stop_not_served", message: refs.length ? tr(lang, "set_dwell.stops_not_served", { stops: names.join(", "), count: names.length }) : tr(lang, "set_dwell.no_intermediate"), options: c.lines[0].route.patterns[0]?.stops.map((s) => nameOf(model, s)) || [] });
    return { ambiguities: unique(ambiguities), warnings };
  }
  for (const [key, n] of [...unserved.entries()].sort((a, b) => byId(a[0], b[0]))) {
    const pat = model.patterns.get(key);
    warnings.push(tr(lang, "set_dwell.pattern_skipped", { line: label(c.lines.find((l) => l.route.id === pat.route_id).route), direction: pat.direction_id, count: n, stop: nameOf(model, pat.stops[pat.stops.length - 1]), stops: names.join(", ") }));
  }
  checkAnchors(model, c, (l) => [...new Set([...l.explicit, ...l.freq.map((f) => f.trip)].filter((t) => targetsOf(t, l).size).map((t) => t.pattern))].sort(byId), ambiguities, lang);
  // A listed terminus: its dwell is not running time (the wait between trips is the block's layover).
  const termini = c.lines.flatMap((l) => [...l.explicit, ...l.freq.map((f) => f.trip)].filter((t) => l.stopIds && [...targetsOf(t, l)].some((k) => k === 0 || k === t.stops.length - 1)));
  if (termini.length) warnings.push(tr(lang, "set_dwell.termini", { stops: names.join(", "), count: names.length, trips: termini.length }));
  if (ambiguities.length) return { ambiguities: unique(ambiguities), warnings };

  const was = [];
  const compute = (t, l) => {
    const targets = targetsOf(t, l);
    if (!targets.size) return { skip: true };
    targets.forEach((k) => was.push(t.dep[k] - t.arr[k]));
    const r = redwell(t, targets, sec);
    return { ...r, forced: [...targets], before: t.arr[t.stops.length - 1] - t.dep[0], after: r.arr[t.stops.length - 1] - r.dep[0] };
  };
  const lines = buildPlans(model, c, compute, ambiguities, warnings, lang);
  if (ambiguities.length) return { ambiguities: unique(ambiguities), warnings };
  consequences(model, c, lines, warnings, lang);
  const noop = lines.every((l) => l.plans.every((pl) => !pl.changed) && l.freqPlans.every((pl) => !pl.changed));
  const perTrip = refs.length ? tr(lang, "set_dwell.at_stops", { stops: few(names, 4) }) : tr(lang, "set_dwell.at_every_stop");
  return {
    value: { kind: "dwell", scope: c.scope, anchor: c.anchor, blocks: c.blocks, lines, noop, texts: { seconds: sec, where: perTrip, was: median(was), sel: selectionText(p, c, lang), anchor: anchorText(c, lines, lang), medians: mediansText(medians(lines), lines.length > 1, lang) } },
    ambiguities: [],
    warnings: [...new Set(warnings)],
  };
};

const applyDwell = (db, v, { model, lang } = {}) => {
  const which = [v.texts.sel, scopeText(v.scope, lang)].filter(Boolean).join(tr(lang, "common.semicolon"));
  const words = { lines: linesLabel(v.lines, lang), duration: duration(v.texts.seconds), where: v.texts.where, which };
  if (v.noop) return { summary: tr(lang, "set_dwell.noop", words), noop: true };
  const out = writePlans(db, model, v, lang);
  const blocks = B.chainOutcome([B.rechainBlocks(db, model, out.ids, { policy: v.blocks })], { lang });
  const warnings = [];
  if (out.timed) warnings.push(tr(lang, "set_dwell.timed_calls", { count: out.timed }));
  if (out.windows.length) warnings.push(tr(lang, "running_times.frequency_service", { windows: out.windows.join(tr(lang, "common.semicolon")) }));
  if (out.transfers) warnings.push(tr(lang, "running_times.transfers_named", { count: out.transfers }));
  warnings.push(...blocks.warnings);
  return {
    summary: tr(lang, "set_dwell.summary", { ...words, lines: linesLabel(out.lines, lang), trips: out.trips, was: duration(v.texts.was), medians: v.texts.medians, anchor: v.texts.anchor }),
    warnings,
    ...(blocks.notes.length ? { notes: blocks.notes } : {}),
  };
};

// ── catalogue

const LINE_PARAMS = [
  { name: "route", type: "route", required: false, description: "The line (short name, id or long name); or give routes (one of the two: requires_one_of)." },
  { name: "routes", type: "routes", required: false, description: "Several lines at once (a list), or \"all\"." },
  { name: "direction", type: "direction", required: false, description: "0, 1, both (default) or a destination." },
  { name: "days", type: "days", required: false, description: "Only the trips of these days (weekday, saturday…). Required with a time band when the trips run on several day types." },
  ...S.SCOPE_PARAMS,
  ...SELECTION_PARAMS,
  { name: "bands", type: "list", required: false, description: "Several bands of departures at once: [{ from, to }] or [\"07:00-09:00\", \"16:30-19:00\"] (from/to count as one more band)." },
];
// route and routes stand in for each other: one of them is needed (asked as « which line? » when neither is given).
const LINE_ONE_OF = Object.freeze([Object.freeze(["route", "routes"])]);
const ANCHOR_PARAM = { name: "anchor", type: "string", required: false, description: "The time kept: origin (default: later stops move), destination (earlier stops move) or a stop (e.g. a school bell, a hub pulse)." };

module.exports = [
  {
    type: "adjust_running_times",
    title: "Adjust running times",
    category: "service",
    tables: TABLES,
    description: "Recalibrate the scheduled running times of a line's trips (a band of departures, some days, a segment or the whole trip) by a factor, minutes added or a new running time spread over the hops in proportion; the origin keeps its times unless another anchor is given. Dwells are kept; frequency templates change the same way.",
    params: [
      ...LINE_PARAMS,
      { name: "segment", type: "object", required: false, description: "{ from_stop, to_stop }: the stretch that changes (default the whole trip); in reverse order it is the same stretch in the other direction." },
      { name: "factor", type: "number", required: false, description: "Multiplier of the running time (1.1 = +10 %; \"+10%\" accepted). Exactly one of factor, add_min, set_min." },
      { name: "add_min", type: "number", required: false, description: "Minutes added (or removed, negative) to the stretch, spread over its hops in proportion." },
      { name: "set_min", type: "number", required: false, description: "The stretch's new running time in minutes (departure at from_stop → arrival at to_stop, dwells included)." },
      ANCHOR_PARAM,
      { name: "scale_dwells", type: "boolean", required: false, description: "Also scale the dwells inside the stretch (default false: dwells are kept)." },
      { name: "was_min", type: "number", required: false, description: "The running time the brief says the stretch had (checked against the feed)." },
      { name: "change_confirmed", type: "enum", enum: ["confirm"], required: false, description: "One or two trips alone whose whole running time is cut by more than 30 % are asked (single_trip_big_change): a trip that must arrive or leave at another time is moved with shift_trips instead; confirm only when the brief says this trip's running time itself changes." },
      B.BLOCKS_PARAM,
    ],
    requires_one_of: LINE_ONE_OF,
    example: { route: "S1", days: "weekday", from: "07:00", to: "09:00", factor: 1.1 },
    resolve: resolveAdjust,
    apply: applyAdjust,
  },
  {
    type: "set_dwell",
    title: "Set dwell times at stops",
    category: "service",
    tables: TABLES,
    description: "Set the dwell (seconds between arrival and departure) at some stops of a line (default every intermediate stop); later stops shift by the difference (origin kept unless another anchor is given). Skipped when the dwell is already so.",
    params: [
      ...LINE_PARAMS,
      { name: "stops", type: "stops", required: false, description: "The stops (names or ids; a station = its platforms). Default: every intermediate stop." },
      { name: "seconds", type: "number", required: true, description: "The dwell in seconds (0 or more; \"1 min\" accepted)." },
      ANCHOR_PARAM,
      B.BLOCKS_PARAM,
    ],
    requires_one_of: LINE_ONE_OF,
    example: { route: "S1", stops: ["Times Sq-42 St"], seconds: 60, days: "weekday" },
    resolve: resolveDwell,
    apply: applyDwell,
  },
];
